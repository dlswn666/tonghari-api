/**
 * LDAREG 분기 p_items 조립 (DESIGN §12·§13.4).
 *
 * 순수 함수: 외부 scan 결과(ldareg/expos rows)와 주입된 후보(building_unit/property_unit)를 받아
 * dedup·비율 parse·매칭·component 조립까지 하고 apply RPC p_items(LDAREG) 를 만든다.
 * DB·네트워크 호출은 하지 않는다(호출측 service 가 주입).
 *
 * 매칭·정규화·identity·ratio 는 Task 9 순수 모듈을 재사용한다. 이 모듈의 책임은:
 *  - ldareg raw row → LdaregObservationInput 정규화(clsSeCode→sourceState, floor 표기 정렬).
 *  - matcher 후보 조립(floor 표기 정규화 일치) + per-unit 결정.
 *  - property별 component 묶음 + expectedTargetPnus coverage 요건.
 *  - §7.3 source record allowlist 12필드 추출.
 */

import type { LdaregRow, BrExposRow, LandAreaSyncIssueCode } from '../../types/land-area-sync.types';
import type {
    LandAreaSyncApplyLdaregItem,
    LandAreaSyncApplyLdaregComponent,
    LandAreaSyncIssue,
} from '../../types/land-area-sync-job.types';
import { dedupLdaregObservations, type LdaregObservationInput } from './identity';
import { parseLdaQotaRate } from './ratio';
import {
    matchLdaregUnit,
    type ExposUnitCandidate,
    type BuildingUnitCandidate,
    type PropertyUnitCandidate,
    type MatchSource,
} from './matcher';
import { mapClsSeCodeToSourceState, normalizeFloorLabel } from './preview';

/** 한 대상 PNU 의 LDAREG·전유부 raw scan 묶음. */
export interface LdaregPnuScan {
    pnu: string;
    ldaregRows: LdaregRow[];
    exposRows: BrExposRow[];
}

export interface LdaregBranchInput {
    unionId: string;
    /** scope 내 정렬 대상 PNU 전체(각 property 의 expected coverage 이자 apply scanned scope). */
    scannedPnus: string[];
    /** 단일 root 관리번호(전유부 root identity 비교 기준). */
    rootIdentity: string;
    perPnu: LdaregPnuScan[];
    buildingUnits: BuildingUnitCandidate[];
    propertyUnits: PropertyUnitCandidate[];
}

export interface LdaregBranchResult {
    items: LandAreaSyncApplyLdaregItem[];
    issues: LandAreaSyncIssue[];
    matchedPropertyUnitIds: string[];
    counts: {
        landRegistryRows: number;
        exposureRows: number;
        parsedRows: number;
    };
    /** scopeHash 의 정렬 component/match digest 입력. */
    componentMatchDigest: unknown[];
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** §7.3 v1 allowlist 12필드만 typed string 으로 뽑는다(임의 필드 금지). */
function extractSourceRecord(row: LdaregRow): Record<string, string | null> {
    const pick = (k: string): string | null => {
        const v = (row as Record<string, unknown>)[k];
        if (v == null) return null;
        const s = String(v);
        return s.length === 0 ? null : s;
    };
    return {
        pnu: pick('pnu'),
        agbldgSn: pick('agbldgSn'),
        buldNm: pick('buldNm'),
        buldDongNm: pick('buldDongNm'),
        buldFloorNm: pick('buldFloorNm'),
        buldHoNm: pick('buldHoNm'),
        buldRoomNm: pick('buldRoomNm'),
        ldaQotaRate: pick('ldaQotaRate'),
        clsSeCode: pick('clsSeCode'),
        clsSeCodeNm: pick('clsSeCodeNm'),
        relateLdEmdLiCode: pick('relateLdEmdLiCode'),
        lastUpdtDt: pick('lastUpdtDt'),
    };
}

/** getBrExposInfo row 에서 동·층·호 후보를 방어적으로 뽑는다(층 표기 정렬). */
function toExposCandidate(row: BrExposRow): ExposUnitCandidate {
    const r = row as Record<string, unknown>;
    return {
        dong: str(r.dongNm ?? r.buldDongNm ?? r.dong) || null,
        floor: normalizeFloorLabel(str(r.flrNoNm ?? r.buldFloorNm ?? r.floor ?? r.flrNo)) || null,
        ho: str(r.hoNm ?? r.buldHoNm ?? r.ho) || null,
        rootIdentity: str(r.mgmBldrgstPk),
    };
}

/** building_unit 후보 floor 표기를 matcher 주입 전 정규화한다(integer ↔ '3층'). */
function normalizeBuildingUnitFloor(candidate: BuildingUnitCandidate): BuildingUnitCandidate {
    return { ...candidate, floor: candidate.floor == null ? null : normalizeFloorLabel(candidate.floor) || null };
}

/**
 * LDAREG 분기 p_items 를 조립한다.
 */
export function assembleLdaregApply(input: LdaregBranchInput): LdaregBranchResult {
    const { unionId, scannedPnus, rootIdentity, perPnu, propertyUnits } = input;
    const expectedTargetPnus = [...new Set(scannedPnus)].sort();
    const buildingUnits = input.buildingUnits.map(normalizeBuildingUnitFloor);

    const issues: LandAreaSyncIssue[] = [];
    let landRegistryRows = 0;
    let exposureRows = 0;
    let parsedRows = 0;

    // property_unit_id → component 목록.
    const byProperty = new Map<string, LandAreaSyncApplyLdaregComponent[]>();
    const componentMatchDigest: Array<Record<string, unknown>> = [];

    for (const scan of perPnu) {
        landRegistryRows += scan.ldaregRows.length;
        exposureRows += scan.exposRows.length;
        const exposUnits = scan.exposRows.map(toExposCandidate);

        // ldareg raw → observation(정규화·sourceState 매핑).
        const observations: LdaregObservationInput[] = scan.ldaregRows.map((row) => {
            const r = row as Record<string, unknown>;
            const decision = mapClsSeCodeToSourceState(str(r.clsSeCode), str(r.clsSeCodeNm));
            return {
                targetPnu: scan.pnu,
                agbldgSn: str(r.agbldgSn) || null,
                buildingName: str(r.buldNm) || null,
                dong: str(r.buldDongNm) || null,
                floor: normalizeFloorLabel(str(r.buldFloorNm)) || null,
                ho: str(r.buldHoNm) || null,
                room: str(r.buldRoomNm) || null,
                ldaQotaRate: str(r.ldaQotaRate) || null,
                clsSeCode: str(r.clsSeCode) || null,
                sourceState: decision.state,
            };
        });

        const dedup = dedupLdaregObservations(observations);
        for (const iss of dedup.issues) {
            issues.push({ code: iss.code, targetPnu: scan.pnu });
        }

        for (const record of dedup.records) {
            const rawRow = scan.ldaregRows.find(
                (row) => str((row as Record<string, unknown>).agbldgSn) === (record.identity.kind === 'PRIMARY'
                    ? record.identity.value.split('#').pop()
                    : str((row as Record<string, unknown>).agbldgSn))
            );
            const sourceRecord = rawRow ? extractSourceRecord(rawRow) : extractSourceRecord({} as LdaregRow);

            const source: MatchSource = {
                targetPnu: scan.pnu,
                dong: record.normalized.dong || null,
                floor: record.normalized.floor || null,
                ho: record.normalized.ho || null,
                room: record.normalized.room || null,
                registryExternalId: null,
                expectedPnuScope: expectedTargetPnus,
            };

            const decision = matchLdaregUnit({
                source,
                scopeRootIdentity: rootIdentity,
                exposUnits,
                buildingUnits,
                propertyUnits,
                unionId,
            });

            if (decision.kind === 'NO_CHANGE') {
                issues.push({ code: decision.issue, targetPnu: scan.pnu });
                continue;
            }

            // CLOSED 는 동일 source identity 의 기존 행에만 적용(retiredReason 필수).
            if (record.state === 'CLOSED') {
                const component: LandAreaSyncApplyLdaregComponent = {
                    targetPnu: scan.pnu,
                    sourceState: 'CLOSED',
                    matchMethod: decision.buildingUnitRef ? 'BUILDING_UNIT_ID' : 'PNU_DONG_HO',
                    matchedBuildingUnitId: decision.buildingUnitRef,
                    sourceIdentity: record.identity.value,
                    sourceAgbldgSn: str(record.identity.kind === 'PRIMARY' ? sourceRecord.agbldgSn : null) || null,
                    ratioRaw: str(record.ldaQotaRateRaw) || '0/1',
                    ratioNumerator: '0',
                    ratioDenominator: '1',
                    retiredReason: 'CLS_SE_CODE_CLOSED',
                    sourceRecord,
                };
                pushComponent(byProperty, decision.propertyUnitId, component);
                componentMatchDigest.push(digestOf(decision.propertyUnitId, component));
                continue;
            }

            // CURRENT 비율 parse(numeratorText/denominatorText 문자열 소비 — JS float 금지).
            const ratio = parseLdaQotaRate(record.ldaQotaRateRaw);
            if (!ratio.ok) {
                issues.push({ code: ratio.issue, propertyUnitId: decision.propertyUnitId, targetPnu: scan.pnu });
                continue;
            }
            parsedRows += 1;
            const component: LandAreaSyncApplyLdaregComponent = {
                targetPnu: scan.pnu,
                sourceState: 'CURRENT',
                matchMethod: decision.buildingUnitRef ? 'BUILDING_UNIT_ID' : 'PNU_DONG_HO',
                matchedBuildingUnitId: decision.buildingUnitRef,
                sourceIdentity: record.identity.value,
                sourceAgbldgSn: sourceRecord.agbldgSn,
                ratioRaw: ratio.raw,
                ratioNumerator: ratio.numeratorText,
                ratioDenominator: ratio.denominatorText,
                retiredReason: null,
                sourceRecord,
            };
            pushComponent(byProperty, decision.propertyUnitId, component);
            componentMatchDigest.push(digestOf(decision.propertyUnitId, component));
        }
    }

    const items: LandAreaSyncApplyLdaregItem[] = [...byProperty.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([propertyUnitId, components]) => ({
            propertyUnitId,
            expectedTargetPnus,
            components: components.sort((x, y) => (x.targetPnu < y.targetPnu ? -1 : x.targetPnu > y.targetPnu ? 1 : 0)),
        }));

    return {
        items,
        issues,
        matchedPropertyUnitIds: items.map((i) => i.propertyUnitId),
        counts: { landRegistryRows, exposureRows, parsedRows },
        componentMatchDigest: componentMatchDigest.sort((a, b) =>
            JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0
        ),
    };
}

function pushComponent(
    map: Map<string, LandAreaSyncApplyLdaregComponent[]>,
    propertyUnitId: string,
    component: LandAreaSyncApplyLdaregComponent
): void {
    const list = map.get(propertyUnitId) ?? [];
    list.push(component);
    map.set(propertyUnitId, list);
}

function digestOf(propertyUnitId: string, c: LandAreaSyncApplyLdaregComponent): Record<string, unknown> {
    return {
        propertyUnitId,
        targetPnu: c.targetPnu,
        sourceState: c.sourceState,
        sourceIdentity: c.sourceIdentity,
        ratioNumerator: c.ratioNumerator,
        ratioDenominator: c.ratioDenominator,
    };
}

export type { LandAreaSyncIssueCode };

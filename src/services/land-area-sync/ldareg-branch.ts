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
import { parseLdaQotaRate, checkDenominatorAgainstArea } from './ratio';
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
    /**
     * 같은 실행(same-run)에서 조회한 이 PNU 의 LADFRL 필지면적(㎡). 있으면 각 CURRENT component 의
     * 비율 분모와 §7.5 허용오차로 대조한다(I2). null 이면 same-run 대조를 건너뛰고 apply RPC 의
     * land_lots.area 검증(이중 검증)에 위임한다.
     */
    ladfrlArea?: number | null;
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
        // matcher 2단계 root identity 비교 축을 scope root(up-PK 우선)와 통일한다(C1).
        // 총괄표제부 있는 복수 동 집합건물은 mgmUpBldrgstPk(계열 root) ≠ mgmBldrgstPk(동별 self)이므로
        // self-PK 로 비교하면 ROOT_MISMATCH 로 전량 NO_CHANGE 된다. deriveRootPks 와 동일하게
        // up 우선(빈 문자열이면 self)으로 뽑는다.
        // ⚠️ expos row 의 root 식별 필드(up vs self)는 Phase 0 실측 확정 항목이다.
        rootIdentity: pickRootIdentity(str(r.mgmUpBldrgstPk), str(r.mgmBldrgstPk)),
    };
}

/** up-PK 우선(trim 후 비면 self) root 식별자 선택 — deriveRootPks(service)와 동일 규칙. */
function pickRootIdentity(up: string, self: string): string {
    const u = up.trim();
    return u.length > 0 ? u : self.trim();
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

        // ldareg raw → observation(정규화·sourceState 매핑). idx 를 함께 운반해 dedup 대표 record 가
        // 정확한 원본 row 를 가리키게 한다(I1). ambiguous flag 도 운반해 component review issue 로 쓴다.
        const observations: LdaregObservationInput[] = scan.ldaregRows.map((row, idx) => {
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
                sourceStateAmbiguous: decision.ambiguous,
                sourceIndex: idx,
            };
        });

        const dedup = dedupLdaregObservations(observations);
        for (const iss of dedup.issues) {
            issues.push({ code: iss.code, targetPnu: scan.pnu });
        }

        for (const record of dedup.records) {
            // I1/M5: dedup 이 운반한 원본 row 인덱스로 정확한 raw row 에서 §7.3 source_record 를 뽑는다.
            // (기존의 agbldgSn find 술어는 FALLBACK 에서 항상-true 가 돼 첫 row 로 오염됐다.)
            const rawRow =
                record.sourceRowIndex >= 0 ? scan.ldaregRows[record.sourceRowIndex] : undefined;
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

            // 원장 승격: clsSeCode 매핑이 불명확하면 자동 말소/유효 판정 불가 → CURRENT 유지(§13.4)하되
            // 해당 component 에 review issue 1건을 남긴다. §14.3 신규 코드 발명 금지 제약 하에,
            // clsSeCode 불명확은 "이 LDAREG source row 의 상태 해석이 확정 불가"인 source-record 수준
            // 이상이므로 identity.ts 가 여러 source 이상(중복·hash 충돌·property key 모호)에 공용으로 쓰는
            // LDAREG_IDENTITY_CONFLICT 를 재사용한다. PROVIDER_PROTOCOL_ERROR 는 전송/프로토콜 실패
            // 전용이라 상태 모호성에 부적절하다.
            if (record.sourceStateAmbiguous) {
                issues.push({
                    code: 'LDAREG_IDENTITY_CONFLICT',
                    propertyUnitId: decision.propertyUnitId,
                    targetPnu: scan.pnu,
                });
            }

            // CLOSED 는 동일 source identity 의 기존 행에만 적용(retiredReason 필수).
            if (record.state === 'CLOSED') {
                const component: LandAreaSyncApplyLdaregComponent = {
                    targetPnu: scan.pnu,
                    sourceState: 'CLOSED',
                    matchMethod: decision.buildingUnitRef ? 'BUILDING_UNIT_ID' : 'PNU_DONG_HO',
                    matchedBuildingUnitId: decision.buildingUnitRef,
                    sourceIdentity: record.identity.value,
                    // M5: identity 문자열 파싱 복원 대신 dedup 이 운반한 agbldgSn 사용(PRIMARY 만 보존).
                    sourceAgbldgSn: record.identity.kind === 'PRIMARY' ? record.agbldgSn : null,
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
            // I2(§12.1·§7.5): 분모를 같은 실행의 LADFRL 필지면적과 대조한다. 면적이 있고(>0) 허용오차를
            // 벗어나면 RATIO_DENOMINATOR_MISMATCH 로 해당 component 를 제외한다(자동 보정 아님, 검토 사유).
            // 면적이 없으면(null·0) same-run 대조를 건너뛰고 apply RPC 의 land_lots.area 검증에 위임한다.
            const sameRunArea = scan.ladfrlArea;
            if (sameRunArea != null && sameRunArea > 0) {
                const denomCheck = checkDenominatorAgainstArea(ratio.denominator, sameRunArea);
                if (!denomCheck.ok) {
                    issues.push({ code: denomCheck.issue, propertyUnitId: decision.propertyUnitId, targetPnu: scan.pnu });
                    continue;
                }
            }
            parsedRows += 1;
            const component: LandAreaSyncApplyLdaregComponent = {
                targetPnu: scan.pnu,
                sourceState: 'CURRENT',
                matchMethod: decision.buildingUnitRef ? 'BUILDING_UNIT_ID' : 'PNU_DONG_HO',
                matchedBuildingUnitId: decision.buildingUnitRef,
                sourceIdentity: record.identity.value,
                // M5: dedup 이 운반한 대표 agbldgSn(별도 필드) 사용.
                sourceAgbldgSn: record.agbldgSn,
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

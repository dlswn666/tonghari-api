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
import { createHash } from 'node:crypto';
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
import { normalizeRegistryManagementPk } from './registry-pk';
import type { ScopeLadfrlArea } from './ladfrl-scope';
import { normalizeUnitTuple } from './normalizer';

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
    /** 정렬된 distinct scope PNU별 same-run LADFRL 양수면적. */
    scopeLadfrlAreas: ScopeLadfrlArea[];
    /** 위 면적의 정확한 decimal 합계. 모든 CURRENT component 분모의 유일한 비교 기준. */
    scopeLadfrlTotal: string;
    /** scanned set에 포함된 base PNU 중 정렬 첫 값. */
    canonicalSourcePnu: string;
    buildingUnits: BuildingUnitCandidate[];
    propertyUnits: PropertyUnitCandidate[];
}

const LDAREG_REPEAT_FIELDS = [
    'agbldgSn',
    'buldNm',
    'buldDongNm',
    'buldFloorNm',
    'buldHoNm',
    'buldRoomNm',
    'ldaQotaRate',
    'clsSeCode',
    'clsSeCodeNm',
    'relateLdEmdLiCode',
    'lastUpdtDt',
] as const;

export interface LdaregReplicationEvidence {
    canonicalSourcePnu: string;
    comparedPnus: string[];
    exactReplica: true;
    /** canonical logical row multiset 수(중복 포함). */
    rowCount: number;
    rowMultisetDigest: string;
}

export type LdaregReplicationResult =
    | {
          ok: true;
          evidence: LdaregReplicationEvidence;
      }
    | { ok: false };

function canonicalLdaregScalar(value: unknown): string | null | undefined {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string') return value.normalize('NFKC').trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function canonicalDecimalToken(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    const canonicalWhole = whole.replace(/^0+(?=\d)/, '');
    const canonicalFraction = fraction.replace(/0+$/, '');
    return canonicalFraction ? `${canonicalWhole}.${canonicalFraction}` : canonicalWhole;
}

/**
 * query-dependent pnu를 제외한 LDAREG logical row v2. 고정 allowlist의 상태·기준일을
 * 보존하되 ratio와 unit tuple은 비교 의미에 맞게 canonicalize한다.
 */
function canonicalLdaregRowKey(row: LdaregRow): string | null {
    const record = row as Record<string, unknown>;
    const raw: Record<string, string | null> = {};
    for (const field of LDAREG_REPEAT_FIELDS.filter((field) => field !== 'ldaQotaRate')) {
        const value = canonicalLdaregScalar(record[field]);
        if (value === undefined) return null;
        raw[field] = value;
    }
    const ratio = parseLdaQotaRate(record.ldaQotaRate);
    const state = mapClsSeCodeToSourceState(raw.clsSeCode ?? '', raw.clsSeCodeNm ?? '');
    const normalized = normalizeUnitTuple({
        dong: raw.buldDongNm,
        floor: raw.buldFloorNm,
        ho: raw.buldHoNm,
        room: raw.buldRoomNm,
    });
    return JSON.stringify({
        v: 2,
        agbldgSn: raw.agbldgSn,
        buildingName: raw.buldNm,
        normalized,
        ratio: ratio.ok
            ? {
                  numerator: canonicalDecimalToken(ratio.numeratorText),
                  denominator: canonicalDecimalToken(ratio.denominatorText),
              }
            : { invalid: canonicalLdaregScalar(record.ldaQotaRate) ?? null },
        sourceState: state.state,
        sourceStateAmbiguous: state.ambiguous,
        clsSeCode: raw.clsSeCode,
        clsSeCodeNm: raw.clsSeCodeNm,
        relateLdEmdLiCode: raw.relateLdEmdLiCode,
        lastUpdtDt: raw.lastUpdtDt,
    });
}

/**
 * Phase 0 실측 계약: 동일 building의 LDAREG 전체 호/비율 집합이 scope의 각 PNU에서 반복된다.
 * 각 query 응답의 row.pnu만 query target에 맞게 달라진다. pnu를 제외한 canonical source
 * multiset(중복 개수 포함)이 모든 PNU에서 exact equal일 때만 replica로 인정한다.
 */
export function validateLdaregReplication(
    scannedPnus: string[],
    perPnu: LdaregPnuScan[],
    canonicalSourcePnu: string
): LdaregReplicationResult {
    const expected = [...new Set(scannedPnus)].sort();
    const actual = [...new Set(perPnu.map((scan) => scan.pnu))].sort();
    if (
        expected.length !== scannedPnus.length ||
        actual.length !== perPnu.length ||
        expected.length !== actual.length ||
        expected.some((pnu, index) => pnu !== actual[index]) ||
        !expected.includes(canonicalSourcePnu)
    ) {
        return { ok: false };
    }

    const keysByPnu = new Map<string, string[]>();
    for (const scan of perPnu) {
        const keys: string[] = [];
        for (const row of scan.ldaregRows) {
            if (typeof row.pnu !== 'string' || row.pnu.trim() !== scan.pnu) {
                return { ok: false };
            }
            const key = canonicalLdaregRowKey(row);
            if (key === null) return { ok: false };
            keys.push(key);
        }
        keysByPnu.set(scan.pnu, keys.sort());
    }

    const canonical = keysByPnu.get(canonicalSourcePnu);
    if (!canonical) return { ok: false };
    for (const pnu of expected) {
        const candidate = keysByPnu.get(pnu);
        if (
            !candidate ||
            candidate.length !== canonical.length ||
            candidate.some((key, index) => key !== canonical[index])
        ) {
            return { ok: false };
        }
    }

    const rowMultisetDigest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    return {
        ok: true,
        evidence: {
            canonicalSourcePnu,
            comparedPnus: expected,
            exactReplica: true,
            rowCount: canonical.length,
            rowMultisetDigest,
        },
    };
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
    /** immutable scope snapshot에 고정할 replica 근거. validation 실패면 null. */
    replicationEvidence: LdaregReplicationEvidence | null;
    /** 분모/ratio/replica/match 불일치로 apply RPC가 0회여야 하는 전역 gate. */
    blocking: boolean;
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
        rootIdentity: pickRootIdentity(r.mgmUpBldrgstPk, r.mgmBldrgstPk),
    };
}

/** up-PK 우선 root 식별자 선택 — deriveRootPks(service)와 동일 canonical 규칙. */
function pickRootIdentity(up: unknown, self: unknown): string {
    return normalizeRegistryManagementPk(up) ?? normalizeRegistryManagementPk(self) ?? '';
}

/**
 * match에 사용할 canonical Building HUB 전유부 dataset을 고른다. scanned base 중 strict
 * COMPLETE nonzero expos를 가진 PNU만 후보이며, 후보가 여러 개면 match에 쓰이는 canonical
 * expos multiset이 exact 같아야 한다.
 */
export function selectCanonicalExposSourcePnu(
    basePnus: string[],
    perPnu: LdaregPnuScan[]
): string | null {
    const scansByPnu = new Map(perPnu.map((scan) => [scan.pnu, scan]));
    const candidates = [...new Set(basePnus)].sort();
    if (
        candidates.length === 0 ||
        candidates.some((pnu) => (scansByPnu.get(pnu)?.exposRows.length ?? 0) === 0)
    ) {
        return null;
    }

    const digestFor = (pnu: string): string =>
        JSON.stringify(
            (scansByPnu.get(pnu)?.exposRows ?? [])
                .map((row) => toExposCandidate(row))
                .map((row) => ({
                    rootIdentity: row.rootIdentity,
                    normalized: normalizeUnitTuple(row),
                }))
                .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        );
    const reference = digestFor(candidates[0]);
    if (candidates.slice(1).some((pnu) => digestFor(pnu) !== reference)) return null;
    return candidates[0];
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
    const scopeLadfrlAreas = [...input.scopeLadfrlAreas].sort((a, b) => a.pnu.localeCompare(b.pnu));
    const scopeLadfrlTotal = Number(input.scopeLadfrlTotal);
    const buildingUnits = input.buildingUnits.map(normalizeBuildingUnitFloor);
    const rawLandRegistryRows = perPnu.reduce((sum, scan) => sum + scan.ldaregRows.length, 0);
    const rawExposureRows = perPnu.reduce((sum, scan) => sum + scan.exposRows.length, 0);
    const replication = validateLdaregReplication(
        scannedPnus,
        perPnu,
        input.canonicalSourcePnu
    );
    const canonicalScan = perPnu.find((scan) => scan.pnu === input.canonicalSourcePnu);
    if (!replication.ok || !canonicalScan || canonicalScan.exposRows.length === 0) {
        return {
            items: [],
            issues: [{ code: 'LDAREG_IDENTITY_CONFLICT' }],
            matchedPropertyUnitIds: [],
            counts: {
                landRegistryRows: rawLandRegistryRows,
                exposureRows: rawExposureRows,
                parsedRows: 0,
            },
            componentMatchDigest: [
                {
                    kind: 'SCOPE_LADFRL',
                    areas: scopeLadfrlAreas,
                    totalArea: input.scopeLadfrlTotal,
                },
            ],
            replicationEvidence: null,
            blocking: true,
        };
    }

    const issues: LandAreaSyncIssue[] = [];
    let parsedRows = 0;
    let denominatorMismatch = false;
    let ratioParseFailed = false;

    // property_unit_id → component 목록.
    const byProperty = new Map<string, LandAreaSyncApplyLdaregComponent[]>();
    const componentMatchDigest: Array<Record<string, unknown>> = [
        {
            kind: 'SCOPE_LADFRL',
            areas: scopeLadfrlAreas,
            totalArea: input.scopeLadfrlTotal,
        },
        {
            kind: 'LDAREG_REPLICATION',
            ...replication.evidence,
        },
    ];

    // canonical base LDAREG를 한 번만 dedup/match한다. attached PNU의 expos COMPLETE_ZERO는
    // 정상일 수 있으므로 per-PNU expos match equality를 요구하지 않는다.
    const exposUnits = canonicalScan.exposRows.map(toExposCandidate);
    const observations: LdaregObservationInput[] = canonicalScan.ldaregRows.map((row, idx) => {
        const r = row as Record<string, unknown>;
        const decision = mapClsSeCodeToSourceState(str(r.clsSeCode), str(r.clsSeCodeNm));
        return {
            targetPnu: canonicalScan.pnu,
            identityRoot: rootIdentity,
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
    const dedupConflict = dedup.issues.some(
        (issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'
    );
    for (const issue of dedup.issues) {
        issues.push({ code: issue.code, targetPnu: canonicalScan.pnu });
    }

    // exact multiset 검증을 통과했으므로 canonical logical key별 raw row가 모든 PNU에 존재한다.
    // sourceRecord.pnu provenance를 보존하기 위해 target별 대응 raw row를 별도로 꺼낸다.
    const rowsByPnuAndKey = new Map<string, Map<string, LdaregRow[]>>();
    for (const scan of perPnu) {
        const byKey = new Map<string, LdaregRow[]>();
        for (const row of scan.ldaregRows) {
            const key = canonicalLdaregRowKey(row);
            if (key === null) continue; // replication validation에서 이미 차단됨
            const list = byKey.get(key) ?? [];
            list.push(row);
            byKey.set(key, list);
        }
        rowsByPnuAndKey.set(scan.pnu, byKey);
    }

    for (const record of dedup.records) {
        const canonicalRaw =
            record.sourceRowIndex >= 0
                ? canonicalScan.ldaregRows[record.sourceRowIndex]
                : undefined;
        const canonicalKey = canonicalRaw ? canonicalLdaregRowKey(canonicalRaw) : null;
        if (canonicalKey === null) {
            issues.push({ code: 'LDAREG_IDENTITY_CONFLICT', targetPnu: canonicalScan.pnu });
            ratioParseFailed = true;
            continue;
        }

        const source: MatchSource = {
            targetPnu: canonicalScan.pnu,
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
            issues.push({ code: decision.issue, targetPnu: canonicalScan.pnu });
            continue;
        }

        if (record.sourceStateAmbiguous) {
            issues.push({
                code: 'LDAREG_IDENTITY_CONFLICT',
                propertyUnitId: decision.propertyUnitId,
                targetPnu: canonicalScan.pnu,
            });
        }

        let ratio:
            | {
                  raw: string;
                  numeratorText: string;
                  denominatorText: string;
              }
            | null = null;
        if (record.state === 'CURRENT') {
            const parsed = parseLdaQotaRate(record.ldaQotaRateRaw);
            if (!parsed.ok) {
                ratioParseFailed = true;
                issues.push({
                    code: parsed.issue,
                    propertyUnitId: decision.propertyUnitId,
                    targetPnu: canonicalScan.pnu,
                });
                continue;
            }
            const denomCheck = checkDenominatorAgainstArea(parsed.denominator, scopeLadfrlTotal);
            if (!denomCheck.ok) {
                denominatorMismatch = true;
                issues.push({
                    code: denomCheck.issue,
                    propertyUnitId: decision.propertyUnitId,
                    targetPnu: canonicalScan.pnu,
                });
                continue;
            }
            ratio = parsed;
            parsedRows += expectedTargetPnus.length;
        }

        for (const targetPnu of expectedTargetPnus) {
            const targetRaw = rowsByPnuAndKey.get(targetPnu)?.get(canonicalKey)?.[0];
            if (!targetRaw) {
                ratioParseFailed = true;
                issues.push({ code: 'LDAREG_IDENTITY_CONFLICT', targetPnu });
                continue;
            }
            const component: LandAreaSyncApplyLdaregComponent =
                record.state === 'CLOSED'
                    ? {
                          targetPnu,
                          sourceState: 'CLOSED',
                          matchMethod: decision.buildingUnitRef
                              ? 'BUILDING_UNIT_ID'
                              : 'PNU_DONG_HO',
                          matchedBuildingUnitId: decision.buildingUnitRef,
                          sourceIdentity: record.identity.value,
                          sourceAgbldgSn:
                              record.identity.kind === 'PRIMARY' ? record.agbldgSn : null,
                          ratioRaw: str(record.ldaQotaRateRaw) || '0/1',
                          ratioNumerator: '0',
                          ratioDenominator: '1',
                          retiredReason: 'CLS_SE_CODE_CLOSED',
                          sourceRecord: extractSourceRecord(targetRaw),
                      }
                    : {
                          targetPnu,
                          sourceState: 'CURRENT',
                          matchMethod: decision.buildingUnitRef
                              ? 'BUILDING_UNIT_ID'
                              : 'PNU_DONG_HO',
                          matchedBuildingUnitId: decision.buildingUnitRef,
                          sourceIdentity: record.identity.value,
                          sourceAgbldgSn: record.agbldgSn,
                          ratioRaw: ratio!.raw,
                          ratioNumerator: ratio!.numeratorText,
                          ratioDenominator: ratio!.denominatorText,
                          retiredReason: null,
                          sourceRecord: extractSourceRecord(targetRaw),
                      };
            pushComponent(byProperty, decision.propertyUnitId, component);
            componentMatchDigest.push(
                digestOf(decision.propertyUnitId, component, input.scopeLadfrlTotal)
            );
        }
    }

    // 모든 PNU가 strict COMPLETE_ZERO인 경우에만 scope property를 empty component item으로
    // 전달한다. 기존 rights의 STALE lifecycle 평가는 가능하지만 신규 0 면적을 만들지는 않는다.
    if (replication.evidence.rowCount === 0) {
        for (const property of propertyUnits) {
            if (property.unionId !== unionId || property.isDeleted) continue;
            if (!byProperty.has(property.id)) byProperty.set(property.id, []);
        }
    }

    const items: LandAreaSyncApplyLdaregItem[] = [...byProperty.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([propertyUnitId, components]) => ({
            propertyUnitId,
            expectedTargetPnus,
            components: components.sort((x, y) => {
                const pnuOrder = x.targetPnu.localeCompare(y.targetPnu);
                if (pnuOrder !== 0) return pnuOrder;
                const identityOrder = x.sourceIdentity.localeCompare(y.sourceIdentity);
                if (identityOrder !== 0) return identityOrder;
                return x.sourceState.localeCompare(y.sourceState);
            }),
        }));

    let ambiguousPropertyIdentity = false;
    for (const item of items) {
        const identities = new Set(
            item.components.map((component) => component.sourceIdentity)
        );
        const countByTarget = new Map<string, number>();
        for (const component of item.components) {
            countByTarget.set(
                component.targetPnu,
                (countByTarget.get(component.targetPnu) ?? 0) + 1
            );
        }
        if (
            identities.size < 2 &&
            ![...countByTarget.values()].some((count) => count > 1)
        ) {
            continue;
        }
        ambiguousPropertyIdentity = true;
        issues.push({
            code: 'LDAREG_IDENTITY_CONFLICT',
            propertyUnitId: item.propertyUnitId,
        });
    }

    // exact replica의 각 logical identity는 property별 모든 target PNU에 정확히 1개씩
    // 존재하고, query-specific targetPnu/sourceRecord.pnu를 제외한 payload가 같아야 한다.
    let componentReplicaMismatch = false;
    for (const item of items) {
        const byIdentity = new Map<string, LandAreaSyncApplyLdaregComponent[]>();
        for (const component of item.components) {
            const list = byIdentity.get(component.sourceIdentity) ?? [];
            list.push(component);
            byIdentity.set(component.sourceIdentity, list);
        }
        for (const components of byIdentity.values()) {
            const targets = components.map((component) => component.targetPnu).sort();
            const payloads = components.map(componentReplicaPayload);
            if (
                components.length !== expectedTargetPnus.length ||
                targets.some((pnu, index) => pnu !== expectedTargetPnus[index]) ||
                new Set(payloads).size !== 1
            ) {
                componentReplicaMismatch = true;
                break;
            }
        }
        if (componentReplicaMismatch) break;
    }

    if (componentReplicaMismatch) {
        issues.push({
            code: 'LDAREG_IDENTITY_CONFLICT',
        });
    }
    const nonzeroWithoutMatchedItem =
        replication.evidence.rowCount > 0 && items.length === 0;
    if (nonzeroWithoutMatchedItem && issues.length === 0) {
        issues.push({ code: 'PROPERTY_UNIT_NOT_FOUND' });
    }

    return {
        items,
        issues,
        matchedPropertyUnitIds: items.map((i) => i.propertyUnitId),
        counts: {
            landRegistryRows: rawLandRegistryRows,
            exposureRows: rawExposureRows,
            parsedRows,
        },
        componentMatchDigest: componentMatchDigest.sort((a, b) =>
            JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0
        ),
        replicationEvidence: replication.evidence,
        blocking:
            denominatorMismatch ||
            ratioParseFailed ||
            componentReplicaMismatch ||
            ambiguousPropertyIdentity ||
            nonzeroWithoutMatchedItem ||
            dedupConflict,
    };
}

function componentReplicaPayload(component: LandAreaSyncApplyLdaregComponent): string {
    const sourceRecord = { ...component.sourceRecord };
    delete sourceRecord.pnu;
    return JSON.stringify({
        sourceState: component.sourceState,
        matchMethod: component.matchMethod,
        matchedBuildingUnitId: component.matchedBuildingUnitId,
        sourceIdentity: component.sourceIdentity,
        sourceAgbldgSn: component.sourceAgbldgSn,
        ratioRaw: component.ratioRaw,
        ratioNumerator: component.ratioNumerator,
        ratioDenominator: component.ratioDenominator,
        retiredReason: component.retiredReason,
        sourceRecord,
    });
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

function digestOf(
    propertyUnitId: string,
    c: LandAreaSyncApplyLdaregComponent,
    scopeLadfrlTotal: string
): Record<string, unknown> {
    return {
        propertyUnitId,
        targetPnu: c.targetPnu,
        sourceState: c.sourceState,
        sourceIdentity: c.sourceIdentity,
        ratioNumerator: c.ratioNumerator,
        ratioDenominator: c.ratioDenominator,
        scopeLadfrlTotal,
    };
}

export type { LandAreaSyncIssueCode };

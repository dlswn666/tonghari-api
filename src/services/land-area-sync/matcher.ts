/**
 * LDAREG ↔ building_unit ↔ property_unit 매칭 (DESIGN §12.4).
 *
 * 7단계 순서를 그대로 구현한다:
 *  1. LDAREG ↔ complete Building HUB 전유부의 동·층·호 exact match
 *  2. 전유부 root identity와 scope root identity 일치
 *  3. `registry_external_id`로 기존 building_unit exact match
 *  4. 외부 ID가 없을 때만 같은 root 범위에서 normalized tuple exact match
 *  4a. DB 후보의 일부 컬럼이 비어 있으면, 값이 있는 컬럼이 source와 모두 exact 일치하고
 *      `ho`가 존재하는 후보를 같은 root 안에서 정확히 1건만 허용
 *  5. `union_id + building_unit_id + is_deleted=false`인 property_unit 정확히 1건
 *  6. 연결이 없을 때만 expected PNU scope + normalized tuple + building_unit_id IS NULL fallback
 *  7. 각 단계 0건 또는 2건 이상은 변경하지 않음
 *
 * 계약:
 *  - fuzzy 경로가 **존재하지 않는다**. 오직 정규화(normalizer) 후 exact 비교만 사용한다.
 *  - DB를 호출하지 않는 **순수 함수**다. 후보(building_unit/property_unit/전유부)는 호출측이
 *    조회해 주입한다(writer-guard). 이 함수는 입력을 변형하지 않고 결정만 반환한다.
 */

import type { LandAreaSyncIssueCode } from '../../types/land-area-sync.types';
import { normalizeUnitTuple, unitTupleKey } from './normalizer';

/** Building HUB 전유부 후보(1단계). */
export interface ExposUnitCandidate {
    dong?: string | null;
    floor?: string | null;
    ho?: string | null;
    /** 전유부 root identity(2단계 scope root와 비교). */
    rootIdentity: string;
}

/** 기존 building_unit 후보(3·4단계). */
export interface BuildingUnitCandidate {
    id: string;
    buildingId?: string | null;
    dong?: string | null;
    floor?: string | null;
    ho?: string | null;
    /** 등기 외부 식별자(3단계 exact match). */
    registryExternalId?: string | null;
}

/** 기존 property_unit 후보(5·6단계). */
export interface PropertyUnitCandidate {
    id: string;
    unionId: string;
    buildingUnitId: string | null;
    pnu: string | null;
    isDeleted: boolean;
    /** fallback tuple 매칭용(6단계). property_unit이 보유할 때만. */
    dong?: string | null;
    ho?: string | null;
}

/** 매칭 대상 source(LDAREG 단위). */
export interface MatchSource {
    targetPnu: string;
    dong?: string | null;
    floor?: string | null;
    ho?: string | null;
    room?: string | null;
    /** 등기 외부 식별자(있으면 3단계, 없으면 4단계). */
    registryExternalId?: string | null;
    /** 6단계 fallback에서 허용되는 expected PNU 집합. */
    expectedPnuScope: string[];
}

export interface MatchInput {
    source: MatchSource;
    scopeRootIdentity: string;
    exposUnits: ExposUnitCandidate[];
    /**
     * 후보 building_unit 목록. 4단계 "같은 root 범위"는 호출측(Task 10)이 이 배열을
     * 해소된 root 범위로 이미 좁혀 주입하는 것으로 보장한다(주입형 lookup·writer-guard).
     */
    buildingUnits: BuildingUnitCandidate[];
    /** 후보 property_unit 목록. union·scope 범위로 이미 좁혀 주입한다. */
    propertyUnits: PropertyUnitCandidate[];
    unionId: string;
}

/** 결정이 내려진(또는 무변경으로 끝난) 매칭 단계. */
export type MatchStage =
    | 'EXPOS_EXACT'
    | 'ROOT_IDENTITY'
    | 'REGISTRY_EXTERNAL_ID'
    | 'NORMALIZED_TUPLE_BU'
    | 'NORMALIZED_KNOWN_FIELDS_BU'
    | 'PROPERTY_UNIT_BY_BU'
    | 'PROPERTY_UNIT_FALLBACK';

/** 무변경 사유. */
export type MatchNoChangeReason = 'NONE' | 'AMBIGUOUS' | 'ROOT_MISMATCH' | 'COLLISION';

export type MatchDecision =
    // `buildingUnitRef`는 매칭이 해소한 building_unit 참조일 뿐이다(DB column write 아님).
    // 실제 building_unit_id 링크 write는 Phase F의 Task 10 원자 RPC가 수행한다(writer-guard).
    | { kind: 'MATCHED'; propertyUnitId: string; buildingUnitRef: string | null; via: MatchStage }
    | { kind: 'NO_CHANGE'; stage: MatchStage; reason: MatchNoChangeReason; issue: LandAreaSyncIssueCode };

function nonEmpty(v: string | null | undefined): string {
    return typeof v === 'string' ? v.trim() : '';
}

function noChange(stage: MatchStage, reason: MatchNoChangeReason, issue: LandAreaSyncIssueCode): MatchDecision {
    return { kind: 'NO_CHANGE', stage, reason, issue };
}

/** 동·층·호 3필드 정규화 key. */
function dfhKey(u: { dong?: string | null; floor?: string | null; ho?: string | null }): string {
    return unitTupleKey(normalizeUnitTuple(u), ['dong', 'floor', 'ho']);
}

/** 동·호 2필드 정규화 key(property fallback). */
function dhKey(u: { dong?: string | null; ho?: string | null }): string {
    return unitTupleKey(normalizeUnitTuple(u), ['dong', 'ho']);
}

/**
 * DB building_unit의 legacy 누락 컬럼을 위한 exact compatibility.
 *
 * source는 앞선 EXPOS exact 단계에서 층·호가 입증된 상태다. 후보는 호가 반드시 있어야 하고,
 * 후보에 실제 값이 있는 동/층/호는 source와 모두 같아야 한다. 비어 있는 DB 값을 추정해
 * 채우지는 않으며, 같은 root 후보가 정확히 1건일 때만 기존 링크를 읽어 사용한다.
 */
function matchesKnownBuildingUnitFields(
    source: MatchSource,
    candidate: BuildingUnitCandidate
): boolean {
    const normalizedSource = normalizeUnitTuple(source);
    const normalizedCandidate = normalizeUnitTuple(candidate);
    if (
        normalizedSource.floor === '' ||
        normalizedSource.ho === '' ||
        normalizedCandidate.ho === '' ||
        normalizedCandidate.ho !== normalizedSource.ho
    ) {
        return false;
    }
    for (const field of ['dong', 'floor'] as const) {
        const candidateValue = normalizedCandidate[field];
        if (
            candidateValue !== '' &&
            candidateValue !== normalizedSource[field]
        ) {
            return false;
        }
    }
    return true;
}

/**
 * LDAREG 단위를 property_unit(및 building_unit)에 매칭한다 (DESIGN §12.4).
 * 어떤 단계에서 0건/2건+이면 무변경(NO_CHANGE)으로 끝난다.
 */
export function matchLdaregUnit(input: MatchInput): MatchDecision {
    const { source, scopeRootIdentity, exposUnits, buildingUnits, propertyUnits, unionId } = input;
    const sourceDfh = dfhKey(source);

    // 1) Building HUB 전유부 동·층·호 exact match
    const exposMatches = exposUnits.filter((e) => dfhKey(e) === sourceDfh);
    if (exposMatches.length === 0) return noChange('EXPOS_EXACT', 'NONE', 'PROPERTY_UNIT_NOT_FOUND');
    if (exposMatches.length > 1) return noChange('EXPOS_EXACT', 'AMBIGUOUS', 'PROPERTY_UNIT_AMBIGUOUS');
    const expos = exposMatches[0];

    // 2) 전유부 root identity == scope root identity
    // 두 축 모두 up-PK 우선(`mgmUpBldrgstPk ?? mgmBldrgstPk`)으로 통일한다: scopeRootIdentity 는
    // 전 base title 계열 root, expos.rootIdentity 는 toExposCandidate 가 같은 축으로 뽑는다(C1).
    // ⚠️ expos row 의 root 식별 필드(up vs self)는 Phase 0 실측 확정 항목이다.
    if (nonEmpty(expos.rootIdentity) !== nonEmpty(scopeRootIdentity) || nonEmpty(scopeRootIdentity) === '') {
        return noChange('ROOT_IDENTITY', 'ROOT_MISMATCH', 'LDAREG_IDENTITY_CONFLICT');
    }

    // 3·4) building_unit 해소
    let resolvedBuildingUnitId: string | null = null;
    const externalId = nonEmpty(source.registryExternalId);

    if (externalId !== '') {
        // 3) registry_external_id exact — 외부 ID가 있으면 fallback 없이 여기서 확정/실패
        const byExtId = buildingUnits.filter((b) => nonEmpty(b.registryExternalId) === externalId);
        if (byExtId.length === 0) return noChange('REGISTRY_EXTERNAL_ID', 'NONE', 'PROPERTY_UNIT_NOT_FOUND');
        if (byExtId.length > 1) return noChange('REGISTRY_EXTERNAL_ID', 'AMBIGUOUS', 'PROPERTY_UNIT_AMBIGUOUS');
        resolvedBuildingUnitId = byExtId[0].id;
    } else {
        // 4) 외부 ID 없음 → normalized tuple exact match
        const byTuple = buildingUnits.filter((b) => dfhKey(b) === sourceDfh);
        if (byTuple.length > 1) {
            // 서로 다른 building_unit이 같은 정규화 key로 수렴 = 정규화 충돌
            return noChange('NORMALIZED_TUPLE_BU', 'COLLISION', 'UNIT_NORMALIZATION_COLLISION');
        }
        if (byTuple.length === 1) {
            resolvedBuildingUnitId = byTuple[0].id;
        }
        if (byTuple.length === 0) {
            const buildingIds = new Set(
                buildingUnits
                    .map((candidate) => nonEmpty(candidate.buildingId))
                    .filter(Boolean)
            );
            const oneProvenBuildingScope =
                buildingIds.size === 1 &&
                buildingUnits.every(
                    (candidate) => nonEmpty(candidate.buildingId) !== ''
                );
            const byKnownFields = oneProvenBuildingScope
                ? buildingUnits.filter((candidate) =>
                      matchesKnownBuildingUnitFields(source, candidate)
                  )
                : [];
            if (byKnownFields.length > 1) {
                return noChange(
                    'NORMALIZED_KNOWN_FIELDS_BU',
                    'COLLISION',
                    'UNIT_NORMALIZATION_COLLISION'
                );
            }
            if (byKnownFields.length === 1) {
                resolvedBuildingUnitId = byKnownFields[0].id;
            }
        }
        // exact 후보 0건이면 resolvedBuildingUnitId = null → 6단계 fallback
    }

    // 5) building_unit 링크가 있으면 property_unit 정확히 1건
    if (resolvedBuildingUnitId !== null) {
        const props = propertyUnits.filter(
            (p) => p.unionId === unionId && p.buildingUnitId === resolvedBuildingUnitId && !p.isDeleted
        );
        if (props.length === 0) return noChange('PROPERTY_UNIT_BY_BU', 'NONE', 'PROPERTY_UNIT_NOT_FOUND');
        if (props.length > 1) return noChange('PROPERTY_UNIT_BY_BU', 'AMBIGUOUS', 'PROPERTY_UNIT_AMBIGUOUS');
        return { kind: 'MATCHED', propertyUnitId: props[0].id, buildingUnitRef: resolvedBuildingUnitId, via: 'PROPERTY_UNIT_BY_BU' };
    }

    // 6) 연결 없음 → expected PNU scope + normalized tuple + building_unit_id IS NULL fallback
    const scope = new Set(source.expectedPnuScope);
    const sourceDh = dhKey(source);
    const fallback = propertyUnits.filter(
        (p) =>
            p.unionId === unionId &&
            p.buildingUnitId === null &&
            !p.isDeleted &&
            p.pnu != null &&
            scope.has(p.pnu) &&
            dhKey(p) === sourceDh
    );
    if (fallback.length === 0) return noChange('PROPERTY_UNIT_FALLBACK', 'NONE', 'PROPERTY_UNIT_NOT_FOUND');
    if (fallback.length > 1) return noChange('PROPERTY_UNIT_FALLBACK', 'AMBIGUOUS', 'PROPERTY_UNIT_AMBIGUOUS');
    return { kind: 'MATCHED', propertyUnitId: fallback[0].id, buildingUnitRef: null, via: 'PROPERTY_UNIT_FALLBACK' };
}

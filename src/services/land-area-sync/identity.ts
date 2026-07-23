/**
 * LDAREG source identity + dedup (DESIGN §12.2).
 *
 * identity 규칙:
 *  1. `agbldgSn`이 비어 있지 않고 PNU 내 유일하면 PRIMARY identity(`targetPnu + agbldgSn`).
 *  2. 그 외에는 versioned immutable-field fallback hash(대상 PNU·건축물명·정규화 동층호실만).
 *     비율·clsSeCode·데이터 기준일·관측시각처럼 변하는 필드는 identity hash에 넣지 않는다.
 *
 * dedup 규칙:
 *  - 동일 identity·동일 canonical payload → 1건 축약
 *  - 동일 identity·다른 payload → 전체 conflict(제외, last-write-wins 금지)
 *  - 같은 (property_unit + targetPnu) key에 서로 다른 CURRENT identity 2개+ → 해당 key 제외
 *  - fallback hash collision → 해당 key 제외
 *  - CLOSED(clsSeCode 말소)는 같은 source identity에만 적용. identity가 없으면 기존
 *    property×PNU key가 정확히 하나 증명될 때만 CLOSE, 모호하면 ACTIVE 유지 + issue.
 */

import { createHash } from 'node:crypto';
import type { LandAreaSyncIssueCode } from '../../types/land-area-sync.types';
import { normalizeUnitTuple, type NormalizedUnitTuple } from './normalizer';

/**
 * fallback identity hash 버전. immutable field 구성/직렬화가 바뀌면 이 값을 올려
 * 과거 identity와 명시적으로 구분한다(versioned immutable identity, §12.2).
 */
export const LDAREG_IDENTITY_HASH_VERSION = 1;

/** LDAREG 관측 1건의 상태(값이 변할 수 있는 필드). */
export type LdaregSourceState = 'CURRENT' | 'CLOSED';

/** 파싱된 LDAREG 관측 입력. 정규화·hash는 이 모듈 내부에서 수행한다. */
export interface LdaregObservationInput {
    targetPnu: string;
    /** 공식 응답 `agbldgSn`(집합건물 일련번호). 비어있으면 fallback hash 사용. */
    agbldgSn?: string | null;
    /** 건축물명(buldNm) — immutable identity 필드. */
    buildingName?: string | null;
    /** 정규화 전 동/층/호/실 원문(buldDongNm/buldFloorNm/buldHoNm/buldRoomNm). */
    dong?: string | null;
    floor?: string | null;
    ho?: string | null;
    room?: string | null;
    /** 이하 variable 필드 — identity hash에 포함하지 않는다. */
    ldaQotaRate?: string | null;
    clsSeCode?: string | null;
    dataBaseDate?: string | null;
    observedAt?: string | null;
    /** provider가 준 상태. clsSeCode→sourceState 매핑은 호출측(Task 10) 책임. 기본 CURRENT. */
    sourceState?: LdaregSourceState;
    /**
     * clsSeCode→sourceState 매핑이 불명확(자동 말소/유효 판정 불가)이었는지. dedup 대표 record 로
     * 운반해 호출측이 component 단위 review issue 를 push 하도록 한다(§13.4 "CURRENT 유지 + 표시").
     */
    sourceStateAmbiguous?: boolean;
    /**
     * 원본 scan row 인덱스(호출측 `ldaregRows[i]`). dedup 이 대표 record 로 이 인덱스를 운반해,
     * 호출측이 정확한 raw row 에서 §7.3 source_record 를 추출하게 한다(FALLBACK 오염 방지, I1).
     */
    sourceIndex?: number;
    /** 사전 해소된 property_unit 링크(있으면 property×PNU 모호성 검사 대상). */
    propertyUnitId?: string | null;
}

/** 확정된 source identity. */
export interface LdaregSourceIdentity {
    kind: 'PRIMARY' | 'FALLBACK';
    value: string;
    /** FALLBACK identity의 hash 버전. PRIMARY는 null. */
    version: number | null;
}

/** dedup 후 살아남은 source record 1건. */
export interface LdaregSourceRecord {
    identity: LdaregSourceIdentity;
    state: LdaregSourceState;
    targetPnu: string;
    buildingName: string;
    normalized: NormalizedUnitTuple;
    /** 대표 variable payload(다운스트림 참고용, identity 아님). */
    ldaQotaRateRaw: string | null;
    propertyUnitId: string | null;
    /**
     * 대표 관측의 원본 scan row 인덱스(호출측 `ldaregRows[sourceRowIndex]`). §7.3 source_record 를
     * fragile 한 find 대신 이 인덱스로 정확히 추출한다(I1). 운반값 없으면 -1.
     */
    sourceRowIndex: number;
    /** 대표 관측의 agbldgSn(별도 필드 운반 — identity 문자열 파싱 복원 제거, M5). */
    agbldgSn: string | null;
    /** clsSeCode 매핑 불명확 여부(§13.4 review 표시용). */
    sourceStateAmbiguous: boolean;
}

/** dedup/모호성 issue 1건. */
export interface DedupIssue {
    code: LandAreaSyncIssueCode;
    /** 영향받은 identity.value 또는 (property×PNU) key. */
    identity: string;
}

export interface LdaregDedupResult {
    records: LdaregSourceRecord[];
    excludedIdentities: string[];
    issues: DedupIssue[];
}

export interface DedupOptions {
    /** 테스트에서 fallback hash collision을 강제하기 위한 주입형 hash 함수. */
    hashFn?: (input: string) => string;
}

function sha256Hex(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

/** 결정론적 canonical JSON(객체 키 정렬). */
function canonicalStableStringify(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            out[k] = sortKeys((value as Record<string, unknown>)[k]);
        }
        return out;
    }
    return value;
}

function nfkcTrim(v: string | null | undefined): string {
    return (v == null ? '' : String(v)).normalize('NFKC').trim();
}

/** 복합 key 구분자 — PNU/id/sn에 등장할 수 없는 제어문자(필드 경계 모호성 방지). */
const KEY_DELIMITER = '';

interface Candidate {
    input: LdaregObservationInput;
    identity: LdaregSourceIdentity;
    normalized: NormalizedUnitTuple;
    buildingName: string;
    /** identity에 들어가는 immutable 필드의 canonical 직렬화(hash 원문). */
    immutableSource: string;
    /** conflict 판정용 canonical payload(immutable + 변할 수 있는 대표값). */
    payload: string;
    state: LdaregSourceState;
}

/**
 * LDAREG 관측 목록을 identity 기준으로 dedup한다 (DESIGN §12.2).
 */
export function dedupLdaregObservations(
    observations: LdaregObservationInput[],
    options: DedupOptions = {}
): LdaregDedupResult {
    const hashFn = options.hashFn ?? sha256Hex;

    // 1) PNU 내 agbldgSn 유일성 카운트
    const snCountByPnu = new Map<string, number>();
    for (const o of observations) {
        const sn = nfkcTrim(o.agbldgSn);
        if (sn === '') continue;
        const key = `${o.targetPnu}${KEY_DELIMITER}${sn}`;
        snCountByPnu.set(key, (snCountByPnu.get(key) ?? 0) + 1);
    }

    // 2) 각 관측 → candidate(identity/normalized/payload/state 계산)
    const candidates: Candidate[] = observations.map((o) => {
        const normalized = normalizeUnitTuple(o);
        const buildingName = nfkcTrim(o.buildingName);
        const sn = nfkcTrim(o.agbldgSn);
        const immutableSource = canonicalStableStringify({
            v: LDAREG_IDENTITY_HASH_VERSION,
            targetPnu: o.targetPnu,
            buildingName,
            dong: normalized.dong,
            floor: normalized.floor,
            ho: normalized.ho,
            room: normalized.room,
        });

        let identity: LdaregSourceIdentity;
        const snUnique = sn !== '' && snCountByPnu.get(`${o.targetPnu}${KEY_DELIMITER}${sn}`) === 1;
        if (snUnique) {
            identity = { kind: 'PRIMARY', value: `primary:${o.targetPnu}#${sn}`, version: null };
        } else {
            identity = {
                kind: 'FALLBACK',
                value: `fallback:v${LDAREG_IDENTITY_HASH_VERSION}:${hashFn(immutableSource)}`,
                version: LDAREG_IDENTITY_HASH_VERSION,
            };
        }

        const payload = canonicalStableStringify({
            targetPnu: o.targetPnu,
            buildingName,
            normalized,
            ldaQotaRate: nfkcTrim(o.ldaQotaRate),
        });

        return {
            input: o,
            identity,
            normalized,
            buildingName,
            immutableSource,
            payload,
            state: o.sourceState === 'CLOSED' ? 'CLOSED' : 'CURRENT',
        };
    });

    // 3) identity.value 기준 그룹핑
    const groups = new Map<string, Candidate[]>();
    for (const c of candidates) {
        const arr = groups.get(c.identity.value) ?? [];
        arr.push(c);
        groups.set(c.identity.value, arr);
    }

    const records: LdaregSourceRecord[] = [];
    const excludedIdentities: string[] = [];
    const issues: DedupIssue[] = [];

    for (const [value, members] of groups) {
        // fallback hash collision: 같은 identity.value인데 immutable source가 서로 다름
        const isFallback = members[0].identity.kind === 'FALLBACK';
        if (isFallback && new Set(members.map((m) => m.immutableSource)).size > 1) {
            excludedIdentities.push(value);
            issues.push({ code: 'LDAREG_IDENTITY_CONFLICT', identity: value });
            continue;
        }

        const current = members.filter((m) => m.state === 'CURRENT');
        const hasClosed = members.some((m) => m.state === 'CLOSED');

        if (current.length > 0) {
            // 동일 identity·다른 payload → 전체 conflict(last-write-wins 금지)
            if (new Set(current.map((m) => m.payload)).size > 1) {
                excludedIdentities.push(value);
                issues.push({ code: 'LDAREG_IDENTITY_CONFLICT', identity: value });
                continue;
            }
            const rep = current[0];
            records.push(buildRecord(rep, hasClosed ? 'CLOSED' : 'CURRENT'));
        } else {
            // CLOSED-only identity → 닫을 대상(동일 identity)만 CLOSED record로 표현
            records.push(buildRecord(members[0], 'CLOSED'));
        }
    }

    return { records, excludedIdentities, issues };
}

function buildRecord(c: Candidate, state: LdaregSourceState): LdaregSourceRecord {
    return {
        identity: c.identity,
        state,
        targetPnu: c.input.targetPnu,
        buildingName: c.buildingName,
        normalized: c.normalized,
        ldaQotaRateRaw: c.input.ldaQotaRate ?? null,
        propertyUnitId: c.input.propertyUnitId ?? null,
        sourceRowIndex: typeof c.input.sourceIndex === 'number' ? c.input.sourceIndex : -1,
        agbldgSn: nfkcTrim(c.input.agbldgSn) || null,
        sourceStateAmbiguous: c.input.sourceStateAmbiguous === true,
    };
}

/** (property×PNU) key 모호성 검사 결과. */
export interface AmbiguousPropertyKeyResult {
    excludedKeys: string[];
    issues: DedupIssue[];
}

/**
 * 같은 (property_unit + targetPnu) key에 서로 다른 CURRENT identity가 2개 이상이면
 * 그 key 전체를 제외한다 (DESIGN §12.2). property linkage가 해소된 뒤(matcher 이후)
 * 호출한다.
 */
export function detectAmbiguousPropertyKeys(records: LdaregSourceRecord[]): AmbiguousPropertyKeyResult {
    const identitiesByKey = new Map<string, Set<string>>();
    for (const r of records) {
        if (r.state !== 'CURRENT' || r.propertyUnitId == null) continue;
        const key = `${r.propertyUnitId}${KEY_DELIMITER}${r.targetPnu}`;
        const set = identitiesByKey.get(key) ?? new Set<string>();
        set.add(r.identity.value);
        identitiesByKey.set(key, set);
    }
    const excludedKeys: string[] = [];
    const issues: DedupIssue[] = [];
    for (const [key, ids] of identitiesByKey) {
        if (ids.size >= 2) {
            excludedKeys.push(key);
            issues.push({ code: 'LDAREG_IDENTITY_CONFLICT', identity: key });
        }
    }
    return { excludedKeys, issues };
}

/**
 * identity 없는 CLOSED 관측을 기존 property×PNU key로 해소한다 (DESIGN §12.2).
 * 정확히 하나의 key가 증명될 때만 CLOSE, 모호하면 기존 ACTIVE 유지 + issue.
 */
export function resolveClosedWithoutIdentity(
    provenKeys: Array<{ propertyUnitId: string; targetPnu: string }>
):
    | { action: 'CLOSE_ONE'; propertyUnitId: string; targetPnu: string }
    | { action: 'KEEP_ACTIVE'; issue: Extract<LandAreaSyncIssueCode, 'LDAREG_IDENTITY_CONFLICT'> } {
    if (provenKeys.length === 1) {
        return { action: 'CLOSE_ONE', propertyUnitId: provenKeys[0].propertyUnitId, targetPnu: provenKeys[0].targetPnu };
    }
    return { action: 'KEEP_ACTIVE', issue: 'LDAREG_IDENTITY_CONFLICT' };
}

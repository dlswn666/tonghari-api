/**
 * `bylotCnt`(외필지 수) 원천 판정 (DESIGN §10.4).
 *
 * 순수 로직만 담당한다(네트워크 없음). strict scan은 orchestrator가 먼저 수행하고,
 * 이 모듈은 확정된 row 데이터를 입력받아 관리 PK별 최종 `bylotCnt` 근거를 계산한다.
 *
 * 핵심 계약:
 *  - parser: 공백 제거 0 이상 safe integer만 valid. 빈·null·음수·소수·비숫자·overflow는
 *    invalid이며 절대 0으로 변환하지 않는다.
 *  - exact `mgmBldrgstPk`별 reduce: 동일 valid 반복 허용, 서로 다른 valid 또는 valid+invalid
 *    혼재는 `BYLOT_COUNT_SOURCE_CONFLICT`.
 *  - policy: `TITLE_ONLY`(기본) / `TITLE_WITH_BASIS_FALLBACK`. env로 바꾸지 않고 소스 상수로만.
 *  - fallback: title COMPLETE + 해당 PK 유효값 0개일 때만, exact-PK basis 유효 1건만 채택.
 *  - cross-check 상태 6종은 BylotCrossCheckState 참조.
 */

import type {
    BrTitleRow,
    BrBasisOulnRow,
    BylotSourcePolicy,
    BylotEvidence,
    LandAreaSyncIssueCode,
} from '../../types/land-area-sync.types';

/**
 * Phase 0에서 확정한 production `bylotCnt` 원천 정책 (DESIGN §10.4).
 * 검토 가능한 versioned 상수. 환경변수로 조용히 바꾸지 않는다. 변경은 이 상수/커밋으로만.
 */
export interface BylotSourcePolicyConfig {
    readonly version: string;
    readonly policy: BylotSourcePolicy;
}
export const BYLOT_SOURCE_POLICY: BylotSourcePolicyConfig = {
    version: 'land-area-sync/bylot-source-policy@1',
    policy: 'TITLE_ONLY',
};

// ── 파서 ─────────────────────────────────────────────────────────

export type BylotParseResult =
    | { valid: true; count: number; raw: string }
    | { valid: false; raw: string | null };

/**
 * `bylotCnt` 원본 값을 파싱한다. 공백 제거 후 0 이상의 safe integer 문자열만 유효.
 * 빈 값·null·음수·소수·지수·비숫자·overflow는 invalid이며 0으로 변환하지 않는다.
 */
export function parseBylotCnt(value: unknown): BylotParseResult {
    if (value === null || value === undefined) {
        return { valid: false, raw: null };
    }
    // 숫자 타입 방어: 정수·0 이상·safe integer만 허용
    if (typeof value === 'number') {
        if (Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value)) {
            return { valid: true, count: value, raw: String(value) };
        }
        return { valid: false, raw: String(value) };
    }
    if (typeof value !== 'string') {
        return { valid: false, raw: null };
    }
    const raw = value;
    const trimmed = value.trim();
    // 부호·소수점·지수·구분자·비숫자 전부 배제: 순수 숫자만
    if (!/^\d+$/.test(trimmed)) {
        return { valid: false, raw };
    }
    const count = Number(trimmed);
    if (!Number.isSafeInteger(count)) {
        // overflow 등 safe integer 초과
        return { valid: false, raw };
    }
    return { valid: true, count, raw };
}

// ── 관리 PK별 title reduce ────────────────────────────────────────

export type TitlePkReduce =
    /** 모든 row가 유효하고 같은 정규화 값 */
    | { kind: 'RESOLVED'; count: number; raw: string }
    /** 서로 다른 valid 또는 valid+invalid 혼재 */
    | { kind: 'CONFLICT' }
    /** row는 있으나 전부 invalid (fallback 후보) */
    | { kind: 'NO_VALID' };

/** 비어있지 않은 정규화 PK를 추출한다(공백 trim). 없으면 null. */
function normalizedPk(pk: unknown): string | null {
    if (typeof pk !== 'string') return null;
    const t = pk.trim();
    return t.length > 0 ? t : null;
}

/**
 * title row들을 exact `mgmBldrgstPk`별로 reduce한다 (DESIGN §10.4).
 * PK가 없는 row는 어느 PK 그룹에도 기여하지 않는다(expected PK도 정의하지 않음).
 */
export function reduceTitleBylotByPk(titleRows: BrTitleRow[]): Map<string, TitlePkReduce> {
    const byPk = new Map<string, BrTitleRow[]>();
    for (const row of titleRows) {
        const pk = normalizedPk(row.mgmBldrgstPk);
        if (!pk) continue;
        const list = byPk.get(pk) ?? [];
        list.push(row);
        byPk.set(pk, list);
    }

    const out = new Map<string, TitlePkReduce>();
    for (const [pk, rows] of byPk) {
        out.set(pk, reduceRows(rows.map((r) => r.bylotCnt)));
    }
    return out;
}

/** 한 PK의 bylotCnt 값 배열을 판정한다. */
function reduceRows(values: unknown[]): TitlePkReduce {
    const validCounts = new Set<number>();
    let firstValidRaw: string | null = null;
    let hasInvalid = false;
    for (const v of values) {
        const p = parseBylotCnt(v);
        if (p.valid) {
            validCounts.add(p.count);
            if (firstValidRaw === null) firstValidRaw = p.raw;
        } else {
            hasInvalid = true;
        }
    }
    if (validCounts.size === 0) return { kind: 'NO_VALID' };
    if (validCounts.size >= 2 || hasInvalid) return { kind: 'CONFLICT' };
    const [count] = [...validCounts];
    return { kind: 'RESOLVED', count, raw: firstValidRaw ?? String(count) };
}

// ── fallback plan (orchestrator 용) ───────────────────────────────

/**
 * basis fallback을 호출해야 하는 PNU 목록을 계산한다 (DESIGN §10.4).
 * - policy가 TITLE_WITH_BASIS_FALLBACK이 아니면 항상 빈 배열(basis 호출 0).
 * - 한 PNU의 title reduce에서 NO_VALID PK가 하나라도 있으면 그 PNU를 정확히 1회 조회.
 * 반환은 정렬·중복 제거된 PNU 목록.
 */
export function bylotBasisFallbackPlan(
    titleByPnu: Array<{ pnu: string; titleRows: BrTitleRow[] }>,
    policy: BylotSourcePolicy
): string[] {
    if (policy !== 'TITLE_WITH_BASIS_FALLBACK') return [];
    const need = new Set<string>();
    for (const { pnu, titleRows } of titleByPnu) {
        const reduced = reduceTitleBylotByPk(titleRows);
        for (const r of reduced.values()) {
            if (r.kind === 'NO_VALID') {
                need.add(pnu);
                break;
            }
        }
    }
    return [...need].sort();
}

// ── 최종 resolver ─────────────────────────────────────────────────

export interface BylotResolverInput {
    policy: BylotSourcePolicy;
    /** 채택된 base PNU들의 title row 전체 */
    titleRows: BrTitleRow[];
    /** fallback으로 조회한 basis scan의 row 전체(미조회면 빈 배열) */
    basisRows: BrBasisOulnRow[];
    /** attached row에서 추출한 관리 PK 집합(expected PK 합집합·orphan 판정용) */
    attachedPks: string[];
    /** basis fallback scan을 실제 1회라도 호출했는지(교차검증 활성 여부) */
    basisFallbackInvoked: boolean;
}

export interface BylotResolution {
    /** title PK ∪ attached PK, 정렬됨 */
    expectedPks: string[];
    /** expectedPks와 동일 순서의 최종 근거 */
    evidence: BylotEvidence[];
    status: 'RESOLVED' | 'REVIEW_REQUIRED';
    /** 정렬·중복 제거된 issue code */
    issues: LandAreaSyncIssueCode[];
}

/** 한 PK에 대한 exact-PK basis 유효값 판정 */
type BasisPick =
    | { kind: 'ONE'; count: number; raw: string }
    | { kind: 'NONE' }
    | { kind: 'MANY' };

function pickExactBasis(basisRows: BrBasisOulnRow[], pk: string): BasisPick {
    const validCounts = new Set<number>();
    let firstRaw: string | null = null;
    let firstCount = 0;
    for (const row of basisRows) {
        if (normalizedPk(row.mgmBldrgstPk) !== pk) continue;
        const p = parseBylotCnt(row.bylotCnt);
        if (p.valid) {
            if (validCounts.size === 0) {
                firstRaw = p.raw;
                firstCount = p.count;
            }
            validCounts.add(p.count);
        }
    }
    if (validCounts.size === 0) return { kind: 'NONE' };
    if (validCounts.size >= 2) return { kind: 'MANY' };
    return { kind: 'ONE', count: firstCount, raw: firstRaw ?? String(firstCount) };
}

/**
 * 관리 PK별 최종 `bylotCnt` 근거를 계산한다 (DESIGN §10.4).
 *
 * scan 상태(FAILED/INCOMPLETE)는 이 함수 이전에 gate가 처리한다. 여기서는 COMPLETE row
 * 데이터의 값 판정만 수행한다(RESOLVED 또는 REVIEW_REQUIRED).
 */
export function resolveBylotCounts(input: BylotResolverInput): BylotResolution {
    const { policy, titleRows, basisRows, attachedPks, basisFallbackInvoked } = input;

    const titleReduce = reduceTitleBylotByPk(titleRows);
    const attachedPkSet = new Set<string>();
    for (const pk of attachedPks) {
        const n = normalizedPk(pk);
        if (n) attachedPkSet.add(n);
    }

    // expected PK = title PK ∪ attached PK
    const expectedPks = [...new Set<string>([...titleReduce.keys(), ...attachedPkSet])].sort();

    const evidence: BylotEvidence[] = [];
    const issues = new Set<LandAreaSyncIssueCode>();

    for (const pk of expectedPks) {
        const reduced = titleReduce.get(pk);
        const ev = resolvePk(pk, reduced, basisRows, policy, basisFallbackInvoked);
        evidence.push(ev.evidence);
        for (const i of ev.issues) issues.add(i);
    }

    const status = issues.size > 0 ? 'REVIEW_REQUIRED' : 'RESOLVED';
    return {
        expectedPks,
        evidence,
        status,
        issues: [...issues].sort(),
    };
}

function unavailable(pk: string): BylotEvidence {
    return { mgmBldrgstPk: pk, source: null, rawValue: null, count: null, crossCheckState: 'UNAVAILABLE' };
}
function conflict(pk: string, count: number | null, raw: string | null, source: BylotEvidence['source']): BylotEvidence {
    return { mgmBldrgstPk: pk, source, rawValue: raw, count, crossCheckState: 'CONFLICT' };
}

function resolvePk(
    pk: string,
    reduced: TitlePkReduce | undefined,
    basisRows: BrBasisOulnRow[],
    policy: BylotSourcePolicy,
    basisFallbackInvoked: boolean
): { evidence: BylotEvidence; issues: LandAreaSyncIssueCode[] } {
    // orphan PK(title row 없음) → UNAVAILABLE
    if (!reduced) {
        return { evidence: unavailable(pk), issues: ['BYLOT_COUNT_UNAVAILABLE'] };
    }

    // title 자체 충돌 → basis로 덮지 않는다
    if (reduced.kind === 'CONFLICT') {
        return { evidence: conflict(pk, null, null, 'TITLE'), issues: ['BYLOT_COUNT_SOURCE_CONFLICT'] };
    }

    // title에 유효값 존재
    if (reduced.kind === 'RESOLVED') {
        if (!basisFallbackInvoked) {
            return {
                evidence: {
                    mgmBldrgstPk: pk,
                    source: 'TITLE',
                    rawValue: reduced.raw,
                    count: reduced.count,
                    crossCheckState: 'TITLE_ONLY',
                },
                issues: [],
            };
        }
        // fallback을 호출했으면 title-valid PK도 방어적 교차검증
        const pick = pickExactBasis(basisRows, pk);
        if (pick.kind === 'NONE') {
            return {
                evidence: {
                    mgmBldrgstPk: pk,
                    source: 'TITLE',
                    rawValue: reduced.raw,
                    count: reduced.count,
                    crossCheckState: 'CROSS_CHECK_NOT_AVAILABLE',
                },
                issues: [],
            };
        }
        if (pick.kind === 'MANY') {
            return { evidence: conflict(pk, reduced.count, reduced.raw, 'TITLE'), issues: ['BYLOT_COUNT_SOURCE_CONFLICT'] };
        }
        // exact-PK basis 유효 1건 → 비교
        if (pick.count === reduced.count) {
            return {
                evidence: {
                    mgmBldrgstPk: pk,
                    source: 'TITLE',
                    rawValue: reduced.raw,
                    count: reduced.count,
                    crossCheckState: 'MATCHED',
                },
                issues: [],
            };
        }
        return { evidence: conflict(pk, reduced.count, reduced.raw, 'TITLE'), issues: ['BYLOT_COUNT_SOURCE_CONFLICT'] };
    }

    // reduced.kind === 'NO_VALID' — title 유효값 0개
    if (policy !== 'TITLE_WITH_BASIS_FALLBACK') {
        // TITLE_ONLY: basis 호출 0, UNAVAILABLE
        return { evidence: unavailable(pk), issues: ['BYLOT_COUNT_UNAVAILABLE'] };
    }
    // fallback 정책: exact-PK basis 유효 1건만 채택
    const pick = pickExactBasis(basisRows, pk);
    if (pick.kind === 'ONE') {
        return {
            evidence: {
                mgmBldrgstPk: pk,
                source: 'BASIS_FALLBACK',
                rawValue: pick.raw,
                count: pick.count,
                crossCheckState: 'FALLBACK_RESOLVED',
            },
            issues: [],
        };
    }
    if (pick.kind === 'MANY') {
        return { evidence: conflict(pk, null, null, null), issues: ['BYLOT_COUNT_SOURCE_CONFLICT'] };
    }
    // NONE — BASIS_COMPLETE_ZERO 포함
    return { evidence: unavailable(pk), issues: ['BYLOT_COUNT_UNAVAILABLE'] };
}

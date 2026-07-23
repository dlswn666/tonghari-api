/**
 * 동·층·호·실 exact normalizer (DESIGN §12.3).
 *
 * 허용 변환만 수행한다:
 *  1. Unicode NFKC
 *  2. 양끝 trim + 허용 공백 제거
 *  3. 정확한 `제` 접두사 제거
 *  4. 정확한 `동`/`호` 접미사 제거
 *  5. codebook에 정의한 지하 표기만 `B`로 통일
 *  6. 숫자 segment leading zero 정규화
 *
 * 금지: `contains`/`endsWith` 기반 축약, 건물명 임의 제거, fuzzy score, 다른 동의 같은
 * 호 추론(DESIGN §12.3). 서로 다른 원문이 같은 normalized key로 충돌하면 자동 매칭하지
 * 않는다 — 충돌 감지는 `detectUnitNormalizationCollisions`가 담당한다.
 */

import { BASEMENT_PREFIX_CODEBOOK } from './unit-normalization.fixture';

/** codebook을 길이 내림차순으로 정렬(더 긴 `지하`를 짧은 `지`보다 먼저 검사). */
const BASEMENT_PREFIXES_LONGEST_FIRST = [...BASEMENT_PREFIX_CODEBOOK].sort((a, b) => b.length - a.length);

/** 정규화된 동·층·호·실 tuple. */
export interface NormalizedUnitTuple {
    dong: string;
    floor: string;
    ho: string;
    room: string;
}

/** 정규화 입력 tuple(각 필드는 원문 문자열 또는 null). */
export interface RawUnitTuple {
    dong?: string | null;
    floor?: string | null;
    ho?: string | null;
    room?: string | null;
}

/** tuple key 구분자 — 정규화 결과에 등장할 수 없는 제어문자. */
export const UNIT_KEY_DELIMITER = '';

/** codebook에 정의한 지하 표기 prefix 뒤가 숫자일 때만 `B`로 통일한다. */
function applyBasementCodebook(segment: string): string {
    for (const prefix of BASEMENT_PREFIXES_LONGEST_FIRST) {
        if (segment.length > prefix.length && segment.startsWith(prefix)) {
            const nextChar = segment.charAt(prefix.length);
            // prefix 바로 뒤가 숫자여야 지하 표기로 인정한다(숫자 없으면 매핑 금지).
            if (nextChar >= '0' && nextChar <= '9') {
                return 'B' + segment.slice(prefix.length);
            }
        }
    }
    return segment;
}

/** 각 최대 숫자 run의 leading zero를 제거한다(최소 한 자리 유지). */
function normalizeLeadingZeros(segment: string): string {
    return segment.replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ''));
}

/**
 * 단일 세그먼트(동/층/호/실)를 허용 변환만으로 정규화한다 (DESIGN §12.3).
 */
export function normalizeUnitSegment(raw: string | null | undefined): string {
    if (raw == null) return '';

    // 1) NFKC
    let s = String(raw).normalize('NFKC');
    // 2) 양끝 trim + 허용 공백(모든 공백) 제거
    s = s.replace(/\s+/g, '');
    if (s === '') return '';
    // 3) 정확한 `제` 접두사 제거(1회)
    if (s.startsWith('제')) s = s.slice(1);
    // 4) 정확한 `동`/`호` 접미사 제거(1회)
    if (s.endsWith('동') || s.endsWith('호')) s = s.slice(0, -1);
    // 5) 지하 codebook → B
    s = applyBasementCodebook(s);
    // 6) 숫자 leading zero 정규화
    s = normalizeLeadingZeros(s);
    return s;
}

/** 동·층·호·실 tuple을 정규화한다. */
export function normalizeUnitTuple(raw: RawUnitTuple): NormalizedUnitTuple {
    return {
        dong: normalizeUnitSegment(raw.dong),
        floor: normalizeUnitSegment(raw.floor),
        ho: normalizeUnitSegment(raw.ho),
        room: normalizeUnitSegment(raw.room),
    };
}

/**
 * 정규화 tuple을 지정 필드 부분집합으로 결합해 key를 만든다.
 * 기본은 4필드 전체. Building HUB 전유부·building_unit 매칭은 `['dong','floor','ho']`,
 * property fallback은 `['dong','ho']` 등 호출측에서 부분집합을 지정한다.
 */
export function unitTupleKey(
    tuple: NormalizedUnitTuple,
    fields: (keyof NormalizedUnitTuple)[] = ['dong', 'floor', 'ho', 'room']
): string {
    return fields.map((f) => tuple[f]).join(UNIT_KEY_DELIMITER);
}

/** 정규화 충돌 1건: 같은 normalized key로 수렴하는 서로 다른 원문들. */
export interface NormalizationCollision {
    key: string;
    rawVariants: string[];
}

/**
 * 서로 다른 원문이 같은 normalized key로 충돌하는 경우를 감지한다 (DESIGN §12.3).
 * 동일 원문 반복은 충돌이 아니다. 반환된 key는 자동 매칭에서 제외해야 한다.
 */
export function detectUnitNormalizationCollisions(
    entries: Array<{ raw: string; normalized: string }>
): NormalizationCollision[] {
    const byKey = new Map<string, Set<string>>();
    for (const e of entries) {
        const set = byKey.get(e.normalized) ?? new Set<string>();
        set.add(e.raw);
        byKey.set(e.normalized, set);
    }
    const collisions: NormalizationCollision[] = [];
    for (const [key, rawSet] of byKey) {
        if (rawSet.size > 1) {
            collisions.push({ key, rawVariants: [...rawSet] });
        }
    }
    return collisions;
}

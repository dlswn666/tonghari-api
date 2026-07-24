/**
 * 건축물대장 기타용도 문자열에서 허용된 주택 유형 토큰만 추출한다.
 *
 * substring/contains 분류를 금지한다. 괄호·쉼표·공백 같은 구분자로 나눈 뒤
 * codebook의 전체 토큰과 정확히 같은 경우만 신호로 인정한다.
 */

export const HOUSING_OTHER_PURPOSE_SIGNAL_RULES = [
    ['DETACHED_HOUSE', '단독주택'],
    ['MULTI_UNIT_HOUSE', '다가구주택'],
    ['MULTIPLEX_HOUSE', '다세대주택'],
    ['ROW_HOUSE', '연립주택'],
    ['APARTMENT', '아파트'],
    ['NEIGHBORHOOD_LIVING', '근린생활시설'],
] as const;

export type HousingOtherPurposeSignal =
    (typeof HOUSING_OTHER_PURPOSE_SIGNAL_RULES)[number][0];

export function housingOtherPurposeSignals(
    value: unknown
): HousingOtherPurposeSignal[] {
    if (typeof value !== 'string') return [];
    const tokens = new Set(
        value
            .normalize('NFKC')
            .split(/[\s,;|/()[\]{}·ㆍ:]+/u)
            .map((token) => token.trim())
            .filter(Boolean)
    );
    return HOUSING_OTHER_PURPOSE_SIGNAL_RULES.filter(([, token]) =>
        tokens.has(token)
    ).map(([signal]) => signal);
}

/**
 * 조합원 명부 update/import 경로의 land_area canonical 비교 헬퍼 (DESIGN §16).
 *
 * property_units.land_area는 DB provenance trigger가 감시한다. 일반 writer가 값을
 * "실제로" 바꾸면 trigger가 MANUAL로 전환하고 synced_at/land_area_sync_job_id를 초기화한다.
 * 값이 같은데도 UPDATE/INSERT payload에 land_area를 매번 포함하면 trigger가 no-op으로
 * 평가되긴 하지만 의도가 불명확해지고 불필요한 트리거 평가가 늘어난다. 이 모듈은
 * 소수점 4자리로 정규화한 canonical 문자열을 기준으로 "실제 변경" 여부만 판정하는
 * 순수 함수를 제공한다 — writer 호출부는 이 함수가 true를 반환할 때만 land_area를
 * payload에서 제외한다.
 *
 * `19.70`과 `19.7`처럼 표현만 다른 같은 값은 동일하게 취급한다.
 */

/**
 * land_area 값을 소수점 4자리 canonical decimal 문자열로 정규화한다.
 * null/undefined/파싱 불가(NaN) 입력은 null을 반환한다.
 */
export function normalizeLandAreaDecimal(value: number | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    // 빈 문자열은 Number('') === 0 으로 파싱되어 유효한 0㎡와 구분되지 않으므로 null로 취급한다.
    if (typeof value === 'string' && value.trim() === '') return null;
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return null;
    return num.toFixed(4);
}

/**
 * 두 land_area 값이 canonical 기준으로 동일한지(=실질적으로 변경되지 않았는지) 비교한다.
 * 양쪽 다 정규화 결과가 null이면(둘 다 없음) 변경 없음으로 판정한다.
 */
export function isLandAreaUnchanged(
    current: number | string | null | undefined,
    incoming: number | string | null | undefined
): boolean {
    return normalizeLandAreaDecimal(current) === normalizeLandAreaDecimal(incoming);
}

/**
 * 건축HUB 관리 PK 정규화.
 *
 * 실응답은 관리 PK를 숫자 또는 숫자 문자열로 반환할 수 있다. 숫자는 IEEE-754에서
 * 정확히 표현되는 0 이상 safe integer만 허용하고, 문자열은 공백을 제거한 순수 숫자만
 * 허용한다. 두 표현은 선행 0을 제거한 같은 canonical string으로 수렴한다.
 *
 * 관리 PK는 식별자이므로 unsafe number를 String()으로 복구하지 않는다. 이미 정밀도가
 * 손실됐을 수 있기 때문이다.
 */

export function normalizeRegistryManagementPk(value: unknown): string | null {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) return null;
        return String(value);
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    return trimmed.replace(/^0+(?=\d)/, '');
}

/**
 * 선택 필드의 유효성. 누락/null/빈 문자열은 absent로 허용하지만 값이 있으면 canonical
 * 관리 PK여야 한다.
 */
export function isOptionalRegistryManagementPkValid(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string' && value.trim() === '') return true;
    return normalizeRegistryManagementPk(value) !== null;
}


/**
 * 쓰기 기능 플래그는 정확한 소문자 `true`일 때만 활성화한다.
 * 누락·빈 값·대소문자 차이·공백·다른 truthy 표현은 모두 OFF로 처리한다.
 */
export function parseExactTrueFeatureFlag(value: string | undefined): boolean {
    return value === 'true';
}

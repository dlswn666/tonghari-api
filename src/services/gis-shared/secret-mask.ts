/**
 * 요청 파라미터 secret 마스킹 공용 순수 함수.
 *
 * gis-inspect.service.ts에서 검증된 로직을 그대로 옮긴 것이다 (DESIGN §10.6).
 * inspector와 land-area-sync 어댑터가 함께 import한다.
 */

const SECRET_PARAM_KEYS = new Set(['key', 'servicekey']);

/** 요청 파라미터에서 API 키를 마스킹한다 (응답에 그대로 노출되므로 필수) */
export function maskSecretParams(params: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
        masked[k] = SECRET_PARAM_KEYS.has(k.toLowerCase()) ? '***' : v;
    }
    return masked;
}

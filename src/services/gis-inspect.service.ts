import { KakaoInspectAddress } from '../types/gis-inspect.types';

/**
 * 카카오 우편번호 위젯 데이터로 PNU(19자리)를 로컬 생성한다.
 * 법정동코드(10) + 대지구분(1: 일반=1, 산=2) + 본번(4) + 부번(4)
 */
export function buildPnuFromKakaoAddress(address: KakaoInspectAddress): string | null {
    const bcode = (address.bcode || '').trim();
    const mainNo = (address.mainNo || '').trim();
    const subNo = (address.subNo || '').trim() || '0';

    if (!/^\d{10}$/.test(bcode)) return null;
    if (!/^\d{1,4}$/.test(mainNo)) return null;
    if (!/^\d{1,4}$/.test(subNo)) return null;

    const landType = address.mountainYn === 'Y' ? '2' : '1';
    return `${bcode}${landType}${mainNo.padStart(4, '0')}${subNo.padStart(4, '0')}`;
}

const SECRET_PARAM_KEYS = new Set(['key', 'servicekey']);

/** 요청 파라미터에서 API 키를 마스킹한다 (응답에 그대로 노출되므로 필수) */
export function maskSecretParams(params: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
        masked[k] = SECRET_PARAM_KEYS.has(k.toLowerCase()) ? '***' : v;
    }
    return masked;
}

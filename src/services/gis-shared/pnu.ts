/**
 * PNU(필지고유번호) 관련 공용 순수 함수.
 *
 * gis-inspect.service.ts에서 검증된 로직을 그대로 옮긴 것이다 (DESIGN §10.6).
 * inspector와 land-area-sync 어댑터가 함께 import한다.
 */

/** PNU 로컬 생성에 필요한 카카오 우편번호 위젯 주소 필드만 담은 최소 입력 타입 */
export interface KakaoAddressPnuInput {
    /** 법정동코드 10자리 */
    bcode: string;
    /** 지번 본번 */
    mainNo: string;
    /** 지번 부번 (없으면 빈 문자열) */
    subNo: string;
    /** 산 여부 */
    mountainYn: string;
}

/**
 * 카카오 우편번호 위젯 데이터로 PNU(19자리)를 로컬 생성한다.
 * 법정동코드(10) + 대지구분(1: 일반=1, 산=2) + 본번(4) + 부번(4)
 */
export function buildPnuFromKakaoAddress(address: KakaoAddressPnuInput): string | null {
    const bcode = (address.bcode || '').trim();
    const mainNo = (address.mainNo || '').trim();
    const subNo = (address.subNo || '').trim() || '0';

    if (!/^\d{10}$/.test(bcode)) return null;
    if (!/^\d{1,4}$/.test(mainNo)) return null;
    if (!/^\d{1,4}$/.test(subNo)) return null;

    const landType = address.mountainYn === 'Y' ? '2' : '1';
    return `${bcode}${landType}${mainNo.padStart(4, '0')}${subNo.padStart(4, '0')}`;
}

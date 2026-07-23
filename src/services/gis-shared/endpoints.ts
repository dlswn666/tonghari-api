/**
 * land-area-sync 전용 외부 API endpoint 상수 (공용 순수 모듈).
 *
 * 계약: 아래 URL은 전부 HTTPS다. gis-inspect.service.ts의 file-local http:// 상수와는
 * 별개이며 서로 공유하지 않는다 (DESIGN §10.3, §10.6). land-area-sync 쪽 코드는
 * 반드시 이 모듈만 사용한다.
 */

/** 건축물대장 정보 서비스 (공공데이터포털) — HTTPS */
export const BUILDING_HUB_BASE_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService';

/** V-World 국토정보플랫폼 NED 속성 API — HTTPS */
export const VWORLD_NED_BASE_URL = 'https://api.vworld.kr/ned/data';

export const GIS_SHARED_ENDPOINTS = {
    /** 표제부 조회 */
    getBrTitleInfo: `${BUILDING_HUB_BASE_URL}/getBrTitleInfo`,
    /** 부속지번 조회 */
    getBrAtchJibunInfo: `${BUILDING_HUB_BASE_URL}/getBrAtchJibunInfo`,
    /** 전유부 조회 */
    getBrExposInfo: `${BUILDING_HUB_BASE_URL}/getBrExposInfo`,
    /** 기본개요 조회 */
    getBrBasisOulnInfo: `${BUILDING_HUB_BASE_URL}/getBrBasisOulnInfo`,
    /** 토지대장 조회 */
    ladfrlList: `${VWORLD_NED_BASE_URL}/ladfrlList`,
    /** 대지권등록부 조회 */
    ldaregList: `${VWORLD_NED_BASE_URL}/ldaregList`,
} as const;

export type GisSharedEndpointName = keyof typeof GIS_SHARED_ENDPOINTS;

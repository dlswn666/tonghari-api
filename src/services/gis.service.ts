import axios from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';

const logger = createLogger('GIS-API');

/**
 * GIS 및 공공데이터 수집 서비스
 */
class GisService {
    private vworldApiKey: string;
    private dataPortalApiKey: string;

    constructor() {
        this.vworldApiKey = env.VWORLD_API_KEY;
        this.dataPortalApiKey = env.DATA_PORTAL_API_KEY;
    }

    /**
     * 주소 -> PNU 변환 및 좌표 획득 (Vworld Geocoder)
     * 지번/도로명 주소 모두 지원
     */
    async getPNUFromAddress(address: string): Promise<{ pnu: string; x: string; y: string } | null> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY is not configured.');

        try {
            // 1단계: 지번 주소로 먼저 시도
            let response = await axios.get('https://api.vworld.kr/req/address', {
                params: {
                    service: 'address',
                    request: 'getcoord',
                    version: '2.0',
                    address: address,
                    type: 'PARCEL', // 지번 주소 기반
                    key: this.vworldApiKey,
                    format: 'json',
                },
            });

            let data = response.data;

            // 지번 주소로 실패 시 도로명 주소로 재시도
            if (data.response?.status !== 'OK') {
                logger.debug(`PARCEL type failed for "${address}", trying ROAD type`);
                response = await axios.get('https://api.vworld.kr/req/address', {
                    params: {
                        service: 'address',
                        request: 'getcoord',
                        version: '2.0',
                        address: address,
                        type: 'ROAD', // 도로명 주소 기반
                        key: this.vworldApiKey,
                        format: 'json',
                    },
                });
                data = response.data;
            }

            if (data.response?.status === 'OK') {
                const { x, y } = data.response.result.point;

                // 2단계: 좌표 기반으로 PNU 조회
                const pnu = await this.getPNUFromCoordinates(x, y);

                return { pnu: pnu || '', x, y };
            }

            logger.debug(`Geocoding failed for address: ${address}, status: ${data.response?.status}`);
            return null;
        } catch (error) {
            logger.error(`Geocoder API error (address: ${address})`, error);
            return null;
        }
    }

    /**
     * 좌표 -> PNU 조회 (연속지적도 기반)
     */
    async getPNUFromCoordinates(x: string, y: string): Promise<string | null> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY is not configured.');

        try {
            // 연속지적도(LP_PA_CBND_BUBUN) 레이어에서 해당 좌표의 필지 정보 조회
            const response = await axios.get('https://api.vworld.kr/req/data', {
                params: {
                    service: 'data',
                    request: 'GetFeature',
                    data: 'LP_PA_CBND_BUBUN', // 연속지적도_법정동
                    key: this.vworldApiKey,
                    format: 'json',
                    domain: 'localhost',
                    geomFilter: `POINT(${x} ${y})`, // WKT 형식 포인트
                    geometry: true,
                    size: 1,
                },
            });

            const data = response.data;
            if (data.response?.status === 'OK' && data.response.result?.featureCollection?.features?.length > 0) {
                const feature = data.response.result.featureCollection.features[0];
                const pnu = feature.properties?.pnu;
                if (pnu) {
                    logger.debug(`PNU found from coordinates (${x}, ${y}): ${pnu}`);
                    return pnu;
                }
            }

            // 연속지적도에서 못 찾으면 역지오코딩으로 PNU 생성 시도
            return await this.getPNUFromReverseGeocode(x, y);
        } catch (error) {
            logger.error(`PNU lookup from coordinates error (${x}, ${y})`, error);
            return null;
        }
    }

    /**
     * 역지오코딩으로 PNU 생성
     */
    async getPNUFromReverseGeocode(x: string, y: string): Promise<string | null> {
        try {
            const response = await axios.get('https://api.vworld.kr/req/address', {
                params: {
                    service: 'address',
                    request: 'getAddress',
                    version: '2.0',
                    point: `${x},${y}`,
                    type: 'PARCEL',
                    key: this.vworldApiKey,
                    format: 'json',
                },
            });

            const data = response.data;
            if (data.response?.status === 'OK' && data.response.result?.length > 0) {
                const result = data.response.result[0];
                // 결과에서 PNU 관련 정보 추출
                // 법정동코드(10자리) + 대지구분(1자리) + 본번(4자리) + 부번(4자리) = 19자리
                if (result.structure) {
                    const struct = result.structure;
                    const bjdCode = struct.level4L?.split(' ')[0] || ''; // 법정동 코드
                    // level0(시도) + level1(시군구) + level2(읍면동) 에서 코드 조합
                    // 실제로는 별도의 법정동코드 매핑이 필요할 수 있음
                    logger.debug(`Reverse geocode result for (${x}, ${y}):`, result);
                }
            }
            return null;
        } catch (error) {
            logger.error(`Reverse geocoding error (${x}, ${y})`, error);
            return null;
        }
    }

    /**
     * PNU 기반 필지 경계(Polygon) 조회 (연속지적도)
     * @param pnu 필지 고유번호 (19자리)
     * @returns GeoJSON Geometry (Polygon 또는 MultiPolygon) 또는 null
     */
    async getParcelBoundary(pnu: string): Promise<GeoJSON.Geometry | null> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY is not configured.');
        if (!pnu || pnu.length < 19) {
            logger.debug(`Invalid PNU for boundary lookup: ${pnu}`);
            return null;
        }

        try {
            // 연속지적도(LP_PA_CBND_BUBUN) 레이어에서 PNU로 필지 경계 조회
            const response = await axios.get('https://api.vworld.kr/req/data', {
                params: {
                    service: 'data',
                    request: 'GetFeature',
                    data: 'LP_PA_CBND_BUBUN', // 연속지적도_법정동
                    key: this.vworldApiKey,
                    format: 'json',
                    domain: 'localhost',
                    attrFilter: `pnu:=:${pnu}`, // PNU로 필터
                    geometry: true,
                    size: 1,
                },
            });

            const data = response.data;
            if (data.response?.status === 'OK' && data.response.result?.featureCollection?.features?.length > 0) {
                const feature = data.response.result.featureCollection.features[0];
                const geometry = feature.geometry;
                if (geometry) {
                    logger.debug(`Boundary found for PNU ${pnu}: ${geometry.type}`);
                    return geometry as GeoJSON.Geometry;
                }
            }

            logger.debug(`No boundary found for PNU: ${pnu}`);
            return null;
        } catch (error) {
            logger.error(`Parcel boundary lookup error (PNU: ${pnu})`, error);
            return null;
        }
    }

    /**
     * 좌표 기반 필지 경계 조회 (좌표가 포함된 필지의 경계)
     * getPNUFromCoordinates와 함께 사용하여 PNU와 경계를 동시에 가져올 수 있음
     */
    async getParcelBoundaryFromCoordinates(x: string, y: string): Promise<{ pnu: string; boundary: GeoJSON.Geometry } | null> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY is not configured.');

        try {
            // 연속지적도(LP_PA_CBND_BUBUN) 레이어에서 해당 좌표의 필지 정보 조회
            const response = await axios.get('https://api.vworld.kr/req/data', {
                params: {
                    service: 'data',
                    request: 'GetFeature',
                    data: 'LP_PA_CBND_BUBUN',
                    key: this.vworldApiKey,
                    format: 'json',
                    domain: 'localhost',
                    geomFilter: `POINT(${x} ${y})`, // WKT 형식 포인트
                    geometry: true,
                    size: 1,
                },
            });

            const data = response.data;
            if (data.response?.status === 'OK' && data.response.result?.featureCollection?.features?.length > 0) {
                const feature = data.response.result.featureCollection.features[0];
                const pnu = feature.properties?.pnu;
                const geometry = feature.geometry;

                if (pnu && geometry) {
                    logger.debug(`PNU and boundary found from coordinates (${x}, ${y}): ${pnu}`);
                    return { pnu, boundary: geometry as GeoJSON.Geometry };
                }
            }

            return null;
        } catch (error) {
            logger.error(`Parcel boundary from coordinates error (${x}, ${y})`, error);
            return null;
        }
    }

    /**
     * PNU -> GeoJSON 경계 데이터 획득 (Vworld Data API)
     */
    async getGeoJSON(pnu: string): Promise<any> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY is not configured.');

        try {
            const response = await axios.get('https://api.vworld.kr/req/data', {
                params: {
                    service: 'data',
                    request: 'GetFeature',
                    data: 'LP_PA_CBND_BU_INFO', // 건축물 정보 포함 필지 경계 (예시 레이어)
                    key: this.vworldApiKey,
                    format: 'json',
                    domain: 'localhost',
                    attrFilter: `pnu:like:${pnu}`,
                },
            });
            return response.data;
        } catch (error) {
            logger.error(`Vworld Data API error (PNU: ${pnu})`, error);
            return null;
        }
    }

    /**
     * 표제부 조회 (공공데이터포털)
     */
    async getBuildingTitle(pnu: string): Promise<any[]> {
        if (!this.dataPortalApiKey) throw new Error('DATA_PORTAL_API_KEY is not configured.');

        try {
            const bcode = pnu.substring(0, 10);
            const bun = pnu.substring(11, 15);
            const ji = pnu.substring(15, 19);

            const response = await axios.get('http://apis.data.go.kr/1613000/BldrgstService_V2/getBrTitleInfo', {
                params: {
                    serviceKey: this.dataPortalApiKey,
                    sigunguCd: bcode.substring(0, 5),
                    bjdongCd: bcode.substring(5, 10),
                    bun: bun,
                    ji: ji,
                    numOfRows: 100,
                    _type: 'json',
                },
            });
            return response.data.response?.body?.items?.item || [];
        } catch (error) {
            logger.error(`Building registry title info fetch error (PNU: ${pnu})`, error);
            return [];
        }
    }

    /**
     * 전유부 조회 (호수 리스트)
     */
    async getBuildingUnits(pnu: string): Promise<any[]> {
        if (!this.dataPortalApiKey) throw new Error('DATA_PORTAL_API_KEY is not configured.');

        try {
            const bcode = pnu.substring(0, 10);
            const bun = pnu.substring(11, 15);
            const ji = pnu.substring(15, 19);

            const response = await axios.get('http://apis.data.go.kr/1613000/BldrgstService_V2/getBrExposInfo', {
                params: {
                    serviceKey: this.dataPortalApiKey,
                    sigunguCd: bcode.substring(0, 5),
                    bjdongCd: bcode.substring(5, 10),
                    bun: bun,
                    ji: ji,
                    numOfRows: 1000, // 최대치
                    _type: 'json',
                },
            });
            return response.data.response?.body?.items?.item || [];
        } catch (error) {
            logger.error(`Building registry unit info fetch error (PNU: ${pnu})`, error);
            return [];
        }
    }

    /**
     * 토지/건축물 소유자 정보 수집
     */
    async getOwnerInfo(pnu: string, type: 'LAND' | 'BUILDING'): Promise<any[]> {
        const endpoint =
            type === 'LAND'
                ? 'http://apis.data.go.kr/1611000/LndkndOwnerInfoService/getLndkndOwnerInfo'
                : 'http://apis.data.go.kr/1611000/ArchOwnerInfoService/getArchOwnerInfo';

        try {
            const response = await axios.get(endpoint, {
                params: {
                    serviceKey: this.dataPortalApiKey,
                    pnu: pnu,
                    numOfRows: 100,
                    _type: 'json',
                },
            });
            return response.data.response?.body?.items?.item || [];
        } catch (error) {
            logger.error(`${type} owner info fetch error (PNU: ${pnu})`, error);
            return [];
        }
    }
}

export const gisService = new GisService();
export default gisService;

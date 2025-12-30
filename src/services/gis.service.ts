import axios from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';

const logger = createLogger('GIS-API');

/**
 * GIS 및 공공데이터 수집 서비스
 *
 * API 소스:
 * 1. Vworld (브이월드) - 지오코딩, 역지오코딩
 * 2. 공공데이터포털 (data.go.kr) - PNU 조회, 필지 경계, 건축물대장, 소유자 정보
 */
class GisService {
    private vworldApiKey: string;
    private dataPortalApiKey: string;

    constructor() {
        this.vworldApiKey = env.VWORLD_API_KEY;
        this.dataPortalApiKey = env.DATA_PORTAL_API_KEY;
    }

    /**
     * 주소 -> PNU 변환 및 좌표 획득
     * 1차: Vworld Geocoder로 좌표 획득
     * 2차: 공공데이터포털 API로 PNU 조회
     */
    async getPNUFromAddress(address: string): Promise<{ pnu: string; x: string; y: string } | null> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY is not configured.');

        try {
            // 1단계: Vworld로 지오코딩 (주소 -> 좌표)
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
                        type: 'ROAD',
                        key: this.vworldApiKey,
                        format: 'json',
                    },
                });
                data = response.data;
            }

            if (data.response?.status === 'OK') {
                const { x, y } = data.response.result.point;

                // 2단계: 주소에서 PNU 추출 시도 (공공데이터포털 API)
                const pnu = (await this.getPNUFromAddressInfo(address)) || (await this.getPNUFromCoordinates(x, y));

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
     * 주소 정보에서 PNU 생성 (주소 파싱 방식)
     * 지번 주소에서 법정동코드, 본번, 부번을 파싱하여 PNU 생성
     */
    async getPNUFromAddressInfo(address: string): Promise<string | null> {
        try {
            // 주소에서 시도, 시군구, 읍면동, 지번 추출
            const match = address.match(/(.+?[시도])\s+(.+?[시군구])\s+(.+?[동리읍면])\s+(?:산\s*)?(\d+)(?:-(\d+))?/);

            if (!match) {
                logger.debug(`주소 파싱 실패: ${address}`);
                return null;
            }

            const [, sido, sigungu, dong, mainNum, subNum] = match;
            const isMountain = address.includes('산');

            // 법정동코드 조회를 위해 행정표준코드 API 사용
            const bjdCode = await this.getBjdCode(sido, sigungu, dong);
            if (!bjdCode) {
                logger.debug(`법정동코드 조회 실패: ${sido} ${sigungu} ${dong}`);
                return null;
            }

            // PNU 생성: 법정동코드(10) + 대지구분(1) + 본번(4) + 부번(4) = 19자리
            const landType = isMountain ? '2' : '1'; // 1: 대지, 2: 산
            const mainNumPadded = mainNum.padStart(4, '0');
            const subNumPadded = (subNum || '0').padStart(4, '0');

            const pnu = `${bjdCode}${landType}${mainNumPadded}${subNumPadded}`;
            logger.debug(`PNU generated from address: ${address} -> ${pnu}`);

            return pnu;
        } catch (error) {
            logger.error(`PNU generation from address error: ${address}`, error);
            return null;
        }
    }

    /**
     * 법정동코드 조회 (행정표준코드관리시스템 API)
     */
    async getBjdCode(sido: string, sigungu: string, dong: string): Promise<string | null> {
        if (!this.dataPortalApiKey) return null;

        try {
            // 법정동코드 조회 API
            const response = await axios.get('http://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList', {
                params: {
                    serviceKey: this.dataPortalApiKey,
                    pageNo: 1,
                    numOfRows: 10,
                    type: 'json',
                    locatadd_nm: `${sido} ${sigungu} ${dong}`.trim(),
                },
            });

            const items = response.data?.StanReginCd?.[1]?.row;
            if (items && items.length > 0) {
                // 법정동코드 반환 (10자리)
                const code = items[0].region_cd;
                if (code && code.length >= 10) {
                    return code.substring(0, 10);
                }
            }

            return null;
        } catch (error) {
            logger.error(`법정동코드 조회 오류: ${sido} ${sigungu} ${dong}`, error);
            return null;
        }
    }

    /**
     * 좌표 -> PNU 조회 (Vworld 연속지적도 기반)
     * Vworld API가 실패할 경우를 대비한 fallback 포함
     */
    async getPNUFromCoordinates(x: string, y: string): Promise<string | null> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY is not configured.');

        try {
            // 1차: Vworld 연속지적도(LP_PA_CBND_BUBUN) 조회
            const response = await axios.get('https://api.vworld.kr/req/data', {
                params: {
                    service: 'data',
                    request: 'GetFeature',
                    data: 'LP_PA_CBND_BUBUN',
                    key: this.vworldApiKey,
                    format: 'json',
                    domain: 'localhost',
                    geomFilter: `POINT(${x} ${y})`,
                    geometry: true,
                    size: 1,
                },
            });

            const data = response.data;
            if (data.response?.status === 'OK' && data.response.result?.featureCollection?.features?.length > 0) {
                const feature = data.response.result.featureCollection.features[0];
                const pnu = feature.properties?.pnu;
                if (pnu) {
                    logger.debug(`PNU found from Vworld coordinates (${x}, ${y}): ${pnu}`);
                    return pnu;
                }
            }

            // 2차: 역지오코딩으로 PNU 생성 시도
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
                const text = result.text; // 전체 주소

                // 주소에서 PNU 생성 시도
                if (text) {
                    return await this.getPNUFromAddressInfo(text);
                }
            }
            return null;
        } catch (error) {
            logger.error(`Reverse geocoding error (${x}, ${y})`, error);
            return null;
        }
    }

    /**
     * PNU 기반 필지 경계(Polygon) 조회
     * 1차: 공공데이터포털 연속지적도형정보 API
     * 2차: Vworld 연속지적도 API (fallback)
     */
    async getParcelBoundary(pnu: string): Promise<GeoJSON.Geometry | null> {
        if (!pnu || pnu.length < 19) {
            logger.debug(`Invalid PNU for boundary lookup: ${pnu}`);
            return null;
        }

        // 1차: 공공데이터포털 연속지적도형정보 API
        const boundaryFromDataPortal = await this.getParcelBoundaryFromDataPortal(pnu);
        if (boundaryFromDataPortal) {
            return boundaryFromDataPortal;
        }

        // 2차: Vworld API (fallback)
        return await this.getParcelBoundaryFromVworld(pnu);
    }

    /**
     * 공공데이터포털 연속지적도형정보 조회 서비스
     * https://www.data.go.kr - 연속지적도형정보조회서비스
     */
    async getParcelBoundaryFromDataPortal(pnu: string): Promise<GeoJSON.Geometry | null> {
        if (!this.dataPortalApiKey) {
            logger.debug('DATA_PORTAL_API_KEY is not configured, skipping data.go.kr API');
            return null;
        }

        try {
            // PNU 파싱
            const pnuParts = this.parsePNU(pnu);
            if (!pnuParts) return null;

            // 연속지적도형정보 조회 API
            const response = await axios.get(
                'http://apis.data.go.kr/1611000/nsdi/ContinuousLandInfoService/getContinuousLandInfoWFS',
                {
                    params: {
                        serviceKey: this.dataPortalApiKey,
                        pnu: pnu,
                        format: 'json',
                        numOfRows: 1,
                        pageNo: 1,
                    },
                    timeout: 10000,
                }
            );

            const data = response.data;

            // GeoJSON 형식으로 응답이 오는 경우
            if (data?.features && data.features.length > 0) {
                const geometry = data.features[0].geometry;
                if (geometry) {
                    logger.debug(`Boundary found from data.go.kr for PNU ${pnu}`);
                    return geometry as GeoJSON.Geometry;
                }
            }

            // 다른 형식의 응답 처리 (XML to JSON 변환된 경우)
            if (data?.response?.body?.items?.item) {
                const item = Array.isArray(data.response.body.items.item)
                    ? data.response.body.items.item[0]
                    : data.response.body.items.item;

                if (item?.geom) {
                    // WKT를 GeoJSON으로 변환
                    const geometry = this.wktToGeoJSON(item.geom);
                    if (geometry) {
                        logger.debug(`Boundary converted from WKT for PNU ${pnu}`);
                        return geometry;
                    }
                }
            }

            logger.debug(`No boundary from data.go.kr for PNU: ${pnu}`);
            return null;
        } catch (error) {
            logger.error(`data.go.kr boundary API error (PNU: ${pnu})`, error);
            return null;
        }
    }

    /**
     * Vworld 연속지적도 API로 필지 경계 조회 (fallback)
     */
    async getParcelBoundaryFromVworld(pnu: string): Promise<GeoJSON.Geometry | null> {
        if (!this.vworldApiKey) {
            logger.debug('VWORLD_API_KEY is not configured');
            return null;
        }

        try {
            const response = await axios.get('https://api.vworld.kr/req/data', {
                params: {
                    service: 'data',
                    request: 'GetFeature',
                    data: 'LP_PA_CBND_BUBUN',
                    key: this.vworldApiKey,
                    format: 'json',
                    domain: 'localhost',
                    attrFilter: `pnu:=:${pnu}`,
                    geometry: true,
                    size: 1,
                },
                timeout: 10000,
            });

            const data = response.data;
            if (data.response?.status === 'OK' && data.response.result?.featureCollection?.features?.length > 0) {
                const feature = data.response.result.featureCollection.features[0];
                const geometry = feature.geometry;
                if (geometry) {
                    logger.debug(`Boundary found from Vworld for PNU ${pnu}: ${geometry.type}`);
                    return geometry as GeoJSON.Geometry;
                }
            }

            logger.debug(`No boundary from Vworld for PNU: ${pnu}`);
            return null;
        } catch (error) {
            logger.error(`Vworld boundary API error (PNU: ${pnu})`, error);
            return null;
        }
    }

    /**
     * 좌표 기반 필지 경계 조회 (좌표가 포함된 필지의 경계)
     */
    async getParcelBoundaryFromCoordinates(
        x: string,
        y: string
    ): Promise<{ pnu: string; boundary: GeoJSON.Geometry } | null> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY is not configured.');

        try {
            const response = await axios.get('https://api.vworld.kr/req/data', {
                params: {
                    service: 'data',
                    request: 'GetFeature',
                    data: 'LP_PA_CBND_BUBUN',
                    key: this.vworldApiKey,
                    format: 'json',
                    domain: 'localhost',
                    geomFilter: `POINT(${x} ${y})`,
                    geometry: true,
                    size: 1,
                },
                timeout: 10000,
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
     * PNU 파싱 유틸리티
     * PNU(19자리): 법정동코드(10) + 대지구분(1) + 본번(4) + 부번(4)
     */
    parsePNU(pnu: string): {
        bjdCode: string;
        sigunguCd: string;
        bjdongCd: string;
        landGbn: string;
        bun: string;
        ji: string;
    } | null {
        if (!pnu || pnu.length < 19) return null;

        return {
            bjdCode: pnu.substring(0, 10),
            sigunguCd: pnu.substring(0, 5),
            bjdongCd: pnu.substring(5, 10),
            landGbn: pnu.substring(10, 11),
            bun: pnu.substring(11, 15),
            ji: pnu.substring(15, 19),
        };
    }

    /**
     * WKT를 GeoJSON Geometry로 변환
     */
    wktToGeoJSON(wkt: string): GeoJSON.Geometry | null {
        if (!wkt) return null;

        try {
            // MULTIPOLYGON 처리
            if (wkt.startsWith('MULTIPOLYGON')) {
                const coordsStr = wkt.replace('MULTIPOLYGON(((', '').replace(')))', '');
                const rings = coordsStr.split(')),((').map((ring) => {
                    return ring.split(',').map((coord) => {
                        const [x, y] = coord.trim().split(' ').map(Number);
                        return [x, y];
                    });
                });
                return {
                    type: 'MultiPolygon',
                    coordinates: rings.map((ring) => [ring]),
                };
            }

            // POLYGON 처리
            if (wkt.startsWith('POLYGON')) {
                const coordsStr = wkt.replace('POLYGON((', '').replace('))', '');
                const rings = coordsStr.split('),(').map((ring) => {
                    return ring.split(',').map((coord) => {
                        const [x, y] = coord.trim().split(' ').map(Number);
                        return [x, y];
                    });
                });
                return {
                    type: 'Polygon',
                    coordinates: rings,
                };
            }

            return null;
        } catch (error) {
            logger.error('WKT to GeoJSON conversion error', error);
            return null;
        }
    }

    /**
     * PNU -> GeoJSON 경계 데이터 획득 (Vworld Data API) - Legacy
     */
    async getGeoJSON(pnu: string): Promise<unknown> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY is not configured.');

        try {
            const response = await axios.get('https://api.vworld.kr/req/data', {
                params: {
                    service: 'data',
                    request: 'GetFeature',
                    data: 'LP_PA_CBND_BU_INFO',
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
    async getBuildingTitle(pnu: string): Promise<unknown[]> {
        if (!this.dataPortalApiKey) throw new Error('DATA_PORTAL_API_KEY is not configured.');

        try {
            const pnuParts = this.parsePNU(pnu);
            if (!pnuParts) return [];

            const response = await axios.get('http://apis.data.go.kr/1613000/BldrgstService_V2/getBrTitleInfo', {
                params: {
                    serviceKey: this.dataPortalApiKey,
                    sigunguCd: pnuParts.sigunguCd,
                    bjdongCd: pnuParts.bjdongCd,
                    bun: pnuParts.bun,
                    ji: pnuParts.ji,
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
    async getBuildingUnits(pnu: string): Promise<unknown[]> {
        if (!this.dataPortalApiKey) throw new Error('DATA_PORTAL_API_KEY is not configured.');

        try {
            const pnuParts = this.parsePNU(pnu);
            if (!pnuParts) return [];

            const response = await axios.get('http://apis.data.go.kr/1613000/BldrgstService_V2/getBrExposInfo', {
                params: {
                    serviceKey: this.dataPortalApiKey,
                    sigunguCd: pnuParts.sigunguCd,
                    bjdongCd: pnuParts.bjdongCd,
                    bun: pnuParts.bun,
                    ji: pnuParts.ji,
                    numOfRows: 1000,
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
    async getOwnerInfo(pnu: string, type: 'LAND' | 'BUILDING'): Promise<unknown[]> {
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
                timeout: 15000,
            });

            // 상세 로깅 추가
            const resultCode = response.data?.response?.header?.resultCode;
            const resultMsg = response.data?.response?.header?.resultMsg;

            if (resultCode && resultCode !== '00') {
                logger.warn(`${type} owner info API returned code ${resultCode}: ${resultMsg} (PNU: ${pnu})`);
            }

            return response.data.response?.body?.items?.item || [];
        } catch (error: any) {
            // 상세 에러 로깅
            const status = error.response?.status;
            const statusText = error.response?.statusText;
            const errorData = error.response?.data;

            logger.error(`${type} owner info fetch error (PNU: ${pnu})`, {
                status,
                statusText,
                errorData: typeof errorData === 'string' ? errorData.substring(0, 500) : errorData,
                message: error.message,
            });
            return [];
        }
    }

    /**
     * Vworld 개별공시지가 조회
     * @param pnu 필지고유번호 (19자리)
     * @returns 공시지가 (원/m²) 또는 null
     */
    async getOfficialLandPrice(pnu: string): Promise<number | null> {
        if (!this.vworldApiKey) {
            logger.debug('VWORLD_API_KEY is not configured for land price lookup');
            return null;
        }

        if (!pnu || pnu.length < 19) {
            logger.debug(`Invalid PNU for land price lookup: ${pnu}`);
            return null;
        }

        try {
            // Vworld 개별공시지가 WFS API
            const response = await axios.get('https://api.vworld.kr/ned/wfs/getIndvdLandPriceWFS', {
                params: {
                    service: 'WFS',
                    version: '1.1.0',
                    request: 'GetFeature',
                    typeName: 'lt_c_pse_landprice',
                    maxFeatures: 1,
                    outputFormat: 'application/json',
                    filter: `<Filter><PropertyIsEqualTo><PropertyName>pnu</PropertyName><Literal>${pnu}</Literal></PropertyIsEqualTo></Filter>`,
                    key: this.vworldApiKey,
                },
                timeout: 15000,
            });

            const data = response.data;

            // GeoJSON FeatureCollection 응답 처리
            if (data?.features && data.features.length > 0) {
                const feature = data.features[0];
                const price = feature.properties?.pblntfPclnd; // 개별공시지가 (원/m²)

                if (price !== undefined && price !== null) {
                    logger.debug(`Land price found for PNU ${pnu}: ${price} 원/m²`);
                    return Number(price);
                }
            }

            logger.debug(`No land price found for PNU: ${pnu}`);
            return null;
        } catch (error: any) {
            logger.error(`Vworld land price API error (PNU: ${pnu})`, {
                status: error.response?.status,
                message: error.message,
            });
            return null;
        }
    }

    /**
     * 주소 검색 (Vworld 기반)
     * 지오코딩 + PNU 조회만 수행
     */
    async searchAddressByVworld(
        address: string
    ): Promise<{ address: string; pnu: string; x: string; y: string } | null> {
        try {
            const result = await this.getPNUFromAddress(address);
            if (result && result.pnu) {
                return {
                    address,
                    pnu: result.pnu,
                    x: result.x,
                    y: result.y,
                };
            }
            return null;
        } catch (error) {
            logger.error(`Vworld address search error: ${address}`, error);
            return null;
        }
    }

    /**
     * 주소 검색 (공공데이터포털 기반)
     * 법정동코드 기반 PNU 생성
     */
    async searchAddressByDataPortal(address: string): Promise<{ address: string; pnu: string } | null> {
        try {
            const pnu = await this.getPNUFromAddressInfo(address);
            if (pnu) {
                return { address, pnu };
            }
            return null;
        } catch (error) {
            logger.error(`DataPortal address search error: ${address}`, error);
            return null;
        }
    }

    /**
     * 수동 주소 추가 - 전체 데이터 조회
     * PNU를 기반으로 경계, 공시지가, 소유자 수 등 모든 정보 조회
     */
    async getFullLandInfo(
        pnu: string,
        address: string
    ): Promise<{
        pnu: string;
        address: string;
        boundary: GeoJSON.Geometry | null;
        area: number | null;
        officialPrice: number | null;
        ownerCount: number;
    }> {
        logger.info(`Fetching full land info for PNU: ${pnu}`);

        // 1. 경계 데이터 조회
        const boundary = await this.getParcelBoundary(pnu);

        // 2. 개별공시지가 조회
        const officialPrice = await this.getOfficialLandPrice(pnu);

        // 3. 소유자 수 조회
        let ownerCount = 0;
        try {
            const landOwners = await this.getOwnerInfo(pnu, 'LAND');
            if (Array.isArray(landOwners) && landOwners.length > 0) {
                ownerCount = landOwners.length;
            } else {
                const buildingOwners = await this.getOwnerInfo(pnu, 'BUILDING');
                if (Array.isArray(buildingOwners) && buildingOwners.length > 0) {
                    ownerCount = buildingOwners.length;
                }
            }
        } catch (error) {
            logger.warn(`Owner info fetch failed for PNU ${pnu}, continuing with ownerCount=0`);
        }

        // 4. 면적 계산 (boundary에서 추출하거나 별도 API로 조회)
        let area: number | null = null;
        // 면적은 건축물대장이나 토지대장에서 가져올 수 있음
        // 여기서는 간단히 null로 처리

        logger.info(
            `Full land info fetched for PNU ${pnu}: boundary=${!!boundary}, price=${officialPrice}, owners=${ownerCount}`
        );

        return {
            pnu,
            address,
            boundary,
            area,
            officialPrice,
            ownerCount,
        };
    }
}

export const gisService = new GisService();
export default gisService;

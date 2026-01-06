import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import iconv from 'iconv-lite';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';

const logger = createLogger('GIS-API');

// 시도명 정규화 매핑 (짧은 이름 -> 전체 이름)
const SIDO_NORMALIZE_MAP: Record<string, string> = {
    // 짧은 형식
    서울: '서울특별시',
    부산: '부산광역시',
    대구: '대구광역시',
    인천: '인천광역시',
    광주: '광주광역시',
    대전: '대전광역시',
    울산: '울산광역시',
    세종: '세종특별자치시',
    경기: '경기도',
    강원: '강원특별자치도',
    충북: '충청북도',
    충남: '충청남도',
    전북: '전북특별자치도',
    전남: '전라남도',
    경북: '경상북도',
    경남: '경상남도',
    제주: '제주특별자치도',
    // 중간 형식
    서울시: '서울특별시',
    부산시: '부산광역시',
    대구시: '대구광역시',
    인천시: '인천광역시',
    광주시: '광주광역시',
    대전시: '대전광역시',
    울산시: '울산광역시',
    세종시: '세종특별자치시',
    경기도: '경기도',
    강원도: '강원특별자치도',
    충청북도: '충청북도',
    충청남도: '충청남도',
    전라북도: '전북특별자치도',
    전라남도: '전라남도',
    경상북도: '경상북도',
    경상남도: '경상남도',
    제주도: '제주특별자치도',
    제주시: '제주특별자치도',
};

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
    private bjdCodeMap: Map<string, string> = new Map();

    constructor() {
        this.vworldApiKey = env.VWORLD_API_KEY;
        this.dataPortalApiKey = env.DATA_PORTAL_API_KEY;
        this.loadBjdCodeFromCSV();
    }

    /**
     * 법정동코드 CSV 파일 로드 (서버 시작 시 1회 실행)
     * CSV 구조: 법정동코드,법정동명,폐지여부
     * 예시: 1130510100,서울특별시 강북구 미아동,존재
     */
    private loadBjdCodeFromCSV(): void {
        try {
            const csvPath = path.join(__dirname, '../../data/bjd_code.csv');

            if (!fs.existsSync(csvPath)) {
                logger.warn(`법정동코드 CSV 파일이 없습니다: ${csvPath}`);
                return;
            }

            // EUC-KR (CP949) 인코딩으로 파일 읽기
            const buffer = fs.readFileSync(csvPath);
            const content = iconv.decode(buffer, 'euc-kr');
            const lines = content.split('\n');

            let loadedCount = 0;
            for (let i = 1; i < lines.length; i++) {
                // 헤더 제외
                const line = lines[i].trim();
                if (!line) continue;

                const [code, name, status] = line.split(',');

                // 폐지된 법정동 제외, 10자리 코드만 (읍면동 단위)
                if (status === '존재' && code && code.length === 10 && name) {
                    // 전체 주소로 매핑 (예: "서울특별시 강북구 미아동" -> "1130510100")
                    this.bjdCodeMap.set(name.trim(), code);
                    loadedCount++;
                }
            }

            logger.info(`법정동코드 CSV 로드 완료: ${loadedCount}건`);
        } catch (error) {
            logger.error('법정동코드 CSV 로드 오류', error);
        }
    }

    /**
     * 시도명 정규화 (짧은 이름 -> 전체 이름)
     */
    private normalizeSido(sido: string): string {
        return SIDO_NORMALIZE_MAP[sido] || sido;
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
    /**
     * 법정동코드 조회 (CSV 메모리 기반)
     * @param sido - 시도 (예: 서울시, 서울특별시)
     * @param sigungu - 시군구 (예: 강북구)
     * @param dong - 읍면동 (예: 미아동)
     * @returns 10자리 법정동코드 또는 null
     */
    async getBjdCode(sido: string, sigungu: string, dong: string): Promise<string | null> {
        try {
            // 시도명 정규화
            const normalizedSido = this.normalizeSido(sido);

            // 전체 주소 조합하여 검색
            const fullAddress = `${normalizedSido} ${sigungu} ${dong}`.trim();
            const code = this.bjdCodeMap.get(fullAddress);

            if (code) {
                logger.debug(`법정동코드 찾음 (CSV): ${fullAddress} -> ${code}`);
                return code;
            }

            // 원본 시도명으로 재시도
            if (normalizedSido !== sido) {
                const originalAddress = `${sido} ${sigungu} ${dong}`.trim();
                const originalCode = this.bjdCodeMap.get(originalAddress);
                if (originalCode) {
                    logger.debug(`법정동코드 찾음 (CSV, 원본): ${originalAddress} -> ${originalCode}`);
                    return originalCode;
                }
            }

            logger.warn(`법정동코드 조회 실패 (CSV): ${fullAddress}`);
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
     * 주소를 구성요소로 파싱
     * 다양한 형태의 주소를 지원
     */
    parseAddressToComponents(address: string): {
        sido: string;
        sigungu: string;
        dong: string;
        isMountain: boolean;
        mainNum: string;
        subNum: string;
    } | null {
        if (!address || address.trim() === '') {
            return null;
        }

        const cleanAddress = address.trim();

        // 산 여부 확인
        const isMountain = /산\s*\d/.test(cleanAddress);

        // 패턴 1: 시도 시군구 읍면동 (산) 본번-부번
        // 예: 서울특별시 강북구 미아동 123-45, 서울시 강북구 미아동 산 123-45
        const pattern1 =
            /^(.+?(?:특별시|광역시|특별자치시|특별자치도|도|시))\s+(.+?(?:시|군|구))\s+(.+?(?:동|리|읍|면|가))\s+(?:산\s*)?(\d+)(?:-(\d+))?$/;

        // 패턴 2: 짧은 시도명 (서울, 부산 등)
        // 예: 서울 강북구 미아동 123-45
        const pattern2 =
            /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\s+(.+?(?:시|군|구))\s+(.+?(?:동|리|읍|면|가))\s+(?:산\s*)?(\d+)(?:-(\d+))?$/;

        // 패턴 3: 시군구가 없는 경우 (특별자치시, 특별자치도)
        // 예: 세종특별자치시 조치원읍 123-45
        const pattern3 = /^(.+?(?:특별자치시|특별자치도))\s+(.+?(?:동|리|읍|면|가))\s+(?:산\s*)?(\d+)(?:-(\d+))?$/;

        let match = cleanAddress.match(pattern1);
        if (match) {
            const [, sido, sigungu, dong, mainNum, subNum] = match;
            return {
                sido: this.normalizeSido(sido),
                sigungu: sigungu.trim(),
                dong: dong.trim(),
                isMountain,
                mainNum: mainNum,
                subNum: subNum || '0',
            };
        }

        match = cleanAddress.match(pattern2);
        if (match) {
            const [, sido, sigungu, dong, mainNum, subNum] = match;
            return {
                sido: this.normalizeSido(sido),
                sigungu: sigungu.trim(),
                dong: dong.trim(),
                isMountain,
                mainNum: mainNum,
                subNum: subNum || '0',
            };
        }

        match = cleanAddress.match(pattern3);
        if (match) {
            const [, sido, dong, mainNum, subNum] = match;
            return {
                sido: this.normalizeSido(sido),
                sigungu: '', // 세종시 등은 시군구가 없음
                dong: dong.trim(),
                isMountain,
                mainNum: mainNum,
                subNum: subNum || '0',
            };
        }

        logger.debug(`주소 파싱 실패 (지원하지 않는 형식): ${address}`);
        return null;
    }

    /**
     * 법정동코드 + 지번으로 PNU 생성
     * @param address 전체 주소
     * @returns PNU 정보 또는 null
     */
    async generatePNUFromAddress(address: string): Promise<{
        pnu: string;
        sido: string;
        sigungu: string;
        dong: string;
        bjdCode: string;
        mainNum: string;
        subNum: string;
    } | null> {
        // 1. 주소 파싱
        const components = this.parseAddressToComponents(address);
        if (!components) {
            logger.debug(`PNU 생성 실패 - 주소 파싱 실패: ${address}`);
            return null;
        }

        const { sido, sigungu, dong, isMountain, mainNum, subNum } = components;

        // 2. 법정동코드 조회
        const bjdCode = await this.getBjdCode(sido, sigungu, dong);
        if (!bjdCode) {
            logger.debug(`PNU 생성 실패 - 법정동코드 조회 실패: ${sido} ${sigungu} ${dong}`);
            return null;
        }

        // 3. PNU 생성: 법정동코드(10) + 대지구분(1) + 본번(4) + 부번(4) = 19자리
        const landType = isMountain ? '2' : '1'; // 1: 대지, 2: 산
        const mainNumPadded = mainNum.padStart(4, '0');
        const subNumPadded = subNum.padStart(4, '0');

        const pnu = `${bjdCode}${landType}${mainNumPadded}${subNumPadded}`;

        logger.info(`PNU 생성 성공: ${address} -> ${pnu}`);

        return {
            pnu,
            sido,
            sigungu,
            dong,
            bjdCode,
            mainNum,
            subNum,
        };
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

            const response = await axios.get('http://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo', {
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

            const response = await axios.get('http://apis.data.go.kr/1613000/BldRgstHubService/getBrExposInfo', {
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
     * Vworld 토지대장 정보 조회 (면적 + 소유자수)
     * @param pnu 필지고유번호 (19자리)
     * @returns 면적(㎡), 소유자수(명) 또는 null
     */
    async getLandRegistryInfo(pnu: string): Promise<{ area: number; ownerCount: number } | null> {
        if (!this.vworldApiKey) {
            logger.debug('VWORLD_API_KEY is not configured for land registry lookup');
            return null;
        }

        if (!pnu || pnu.length < 19) {
            logger.debug(`Invalid PNU for land registry lookup: ${pnu}`);
            return null;
        }

        try {
            // Vworld 토지대장 API (ladfrlList)
            const response = await axios.get('https://api.vworld.kr/ned/data/ladfrlList', {
                params: {
                    pnu: pnu,
                    format: 'json',
                    numOfRows: 10,
                    pageNo: 1,
                    key: this.vworldApiKey,
                    domain: 'johapon.kr',
                },
                timeout: 15000,
            });

            const data = response.data;

            // 응답 에러 체크
            if (data?.ladfrlVOList?.error) {
                logger.warn(
                    `Land registry API error for PNU ${pnu}: ${data.ladfrlVOList.error} - ${data.ladfrlVOList.message}`
                );
                return null;
            }

            // 토지대장 정보 추출
            const list = data?.ladfrlVOList?.ladfrlVOList;
            if (list && list.length > 0) {
                const item = list[0];
                const area = item.lndpclAr ? Number(item.lndpclAr) : 0;
                const ownerCount = item.cnrsPsnCo ? Number(item.cnrsPsnCo) : 0;

                logger.debug(`Land registry info found for PNU ${pnu}: area=${area}㎡, ownerCount=${ownerCount}명`);
                return { area, ownerCount };
            }

            logger.debug(`No land registry info found for PNU: ${pnu}`);
            return null;
        } catch (error: any) {
            logger.error(`Vworld land registry API error (PNU: ${pnu})`, {
                status: error.response?.status,
                message: error.message,
            });
            return null;
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
            // Vworld 개별공시지가 WFS API (typeName: dt_d150)
            // filter 파라미터의 슬래시(/)를 인코딩하지 않도록 수동으로 URL 구성
            const filter = `<Filter><PropertyIsEqualTo><PropertyName>pnu</PropertyName><Literal>${pnu}</Literal></PropertyIsEqualTo></Filter>`;
            // 슬래시를 제외하고 인코딩 (Vworld API 요구사항)
            const encodedFilter = encodeURIComponent(filter).replace(/%2F/g, '/');

            const url = `https://api.vworld.kr/ned/wfs/getIndvdLandPriceWFS?service=WFS&version=1.1.0&request=GetFeature&typeName=dt_d150&maxFeatures=1&outputFormat=application/json&filter=${encodedFilter}&key=${this.vworldApiKey}`;

            const response = await axios.get(url, {
                timeout: 15000,
            });

            const data = response.data;

            // JSON 응답 처리 (GeoJSON FeatureCollection)
            if (data?.features && data.features.length > 0) {
                const feature = data.features[0];
                const price = feature.properties?.pblntf_pclnd;

                if (price !== undefined && price !== null) {
                    logger.debug(`Land price found for PNU ${pnu}: ${price} 원/m²`);
                    return Number(price);
                }
            }

            // XML 응답 처리 (WFS 기본 응답)
            if (typeof data === 'string' && data.includes('pblntf_pclnd')) {
                const priceMatch = data.match(/<sop:pblntf_pclnd>(\d+)<\/sop:pblntf_pclnd>/);
                if (priceMatch && priceMatch[1]) {
                    const price = Number(priceMatch[1]);
                    logger.debug(`Land price found (XML) for PNU ${pnu}: ${price} 원/m²`);
                    return price;
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

    // ============================================================
    // 건물 정보 조회 (건축물대장 API)
    // ============================================================

    /**
     * 건물 유형 분류
     * 건축물대장 주용도 코드를 기반으로 건물 유형을 분류합니다.
     */
    private classifyBuildingType(
        mainPurpose: string | null
    ): 'DETACHED_HOUSE' | 'VILLA' | 'APARTMENT' | 'COMMERCIAL' | 'MIXED' | 'NONE' {
        if (!mainPurpose) return 'NONE';

        const purpose = mainPurpose.toLowerCase();

        // 아파트
        if (purpose.includes('아파트')) {
            return 'APARTMENT';
        }

        // 단독주택 계열
        if (
            purpose.includes('단독주택') ||
            purpose.includes('다중주택') ||
            purpose.includes('다가구주택') ||
            purpose.includes('다가구')
        ) {
            return 'DETACHED_HOUSE';
        }

        // 빌라 계열 (연립/다세대)
        if (purpose.includes('연립주택') || purpose.includes('다세대주택') || purpose.includes('다세대')) {
            return 'VILLA';
        }

        // 상업 건물
        if (
            purpose.includes('근린생활시설') ||
            purpose.includes('업무시설') ||
            purpose.includes('판매시설') ||
            purpose.includes('상가') ||
            purpose.includes('오피스')
        ) {
            return 'COMMERCIAL';
        }

        // 복합 건물 (주거+상업)
        if (purpose.includes('주상복합') || purpose.includes('복합')) {
            return 'MIXED';
        }

        // 기타 주거
        if (purpose.includes('주택') || purpose.includes('공동주택')) {
            return 'VILLA'; // 기본적으로 공동주택은 빌라로 분류
        }

        return 'NONE';
    }

    /**
     * 건물 정보 조회 (표제부 + 전유부)
     * PNU를 기반으로 건물 유형, 건물명, 동/호수 정보를 조회합니다.
     *
     * @param pnu 필지고유번호 (19자리)
     * @returns 건물 정보 (유형, 건물명, 세대 목록)
     */
    async getBuildingInfo(pnu: string): Promise<{
        buildingType: 'DETACHED_HOUSE' | 'VILLA' | 'APARTMENT' | 'COMMERCIAL' | 'MIXED' | 'NONE';
        buildingName: string | null;
        mainPurpose: string | null;
        floorCount: number;
        units: Array<{
            dong: string | null;
            ho: string | null;
            floor: number | null;
            area: number | null;
        }>;
    }> {
        logger.info(`Fetching building info for PNU: ${pnu}`);

        // 기본 반환값
        const defaultResult = {
            buildingType: 'NONE' as const,
            buildingName: null,
            mainPurpose: null,
            floorCount: 0,
            units: [] as Array<{ dong: string | null; ho: string | null; floor: number | null; area: number | null }>,
        };

        try {
            // 1. 표제부 조회 (건물 기본 정보)
            const titleInfoList = await this.getBuildingTitle(pnu);

            if (!titleInfoList || titleInfoList.length === 0) {
                logger.debug(`No building title info found for PNU: ${pnu}`);
                return defaultResult;
            }

            // 첫 번째 표제부 정보 사용 (대표 건물)
            const titleInfo = titleInfoList[0] as Record<string, unknown>;
            const mainPurpose = (titleInfo.mainPurpsCdNm as string) || (titleInfo.etcPurps as string) || null;
            const buildingName = (titleInfo.bldNm as string) || null;
            const floorCount = Number(titleInfo.grndFlrCnt) || 0;

            // 건물 유형 분류
            const buildingType = this.classifyBuildingType(mainPurpose);

            logger.debug(
                `Building title info: name=${buildingName}, purpose=${mainPurpose}, type=${buildingType}, floors=${floorCount}`
            );

            // 2. 전유부 조회 (동/호수 정보)
            const unitInfoList = await this.getBuildingUnits(pnu);

            // 세대 정보 파싱
            const units: Array<{ dong: string | null; ho: string | null; floor: number | null; area: number | null }> =
                [];

            if (unitInfoList && unitInfoList.length > 0) {
                for (const unit of unitInfoList) {
                    const unitData = unit as Record<string, unknown>;
                    const dongNm = (unitData.dongNm as string) || null;
                    const hoNm = (unitData.hoNm as string) || null;
                    const flrNo = unitData.flrNo ? Number(unitData.flrNo) : null;
                    const area = unitData.area ? Number(unitData.area) : null;

                    units.push({
                        dong: dongNm,
                        ho: hoNm,
                        floor: flrNo,
                        area: area,
                    });
                }
            }

            // 단독주택인 경우 세대 정보가 없으면 단일 세대로 처리
            if (units.length === 0 && buildingType !== 'NONE') {
                units.push({
                    dong: null,
                    ho: null,
                    floor: null,
                    area: null,
                });
            }

            logger.info(
                `Building info fetched for PNU ${pnu}: type=${buildingType}, name=${buildingName}, units=${units.length}`
            );

            return {
                buildingType,
                buildingName,
                mainPurpose,
                floorCount,
                units,
            };
        } catch (error) {
            logger.error(`Building info fetch error for PNU ${pnu}:`, error);
            return defaultResult;
        }
    }

    // ============================================================
    // 전체 토지+건물 정보 조회
    // ============================================================

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

        // 3. 토지대장 정보 조회 (면적 + 소유자수)
        let area: number | null = null;
        let ownerCount = 0;
        try {
            const registryInfo = await this.getLandRegistryInfo(pnu);
            if (registryInfo) {
                area = registryInfo.area;
                ownerCount = registryInfo.ownerCount;
            }
        } catch (error) {
            logger.warn(`Land registry info fetch failed for PNU ${pnu}, continuing with defaults`);
        }

        logger.info(
            `Full land info fetched for PNU ${pnu}: boundary=${!!boundary}, price=${officialPrice}, owners=${ownerCount}, area=${area}`
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

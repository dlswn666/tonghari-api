import axios from 'axios';
import { env } from '../config/env';
import supabaseService from './supabase.service';

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
     */
    async getPNUFromAddress(address: string): Promise<{ pnu: string; x: string; y: string } | null> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY가 설정되지 않았습니다.');

        try {
            const response = await axios.get('https://api.vworld.kr/req/address', {
                params: {
                    service: 'address',
                    request: 'getcoord',
                    version: '2.0',
                    address: address,
                    type: 'ROAD', // 도로명 주소 기반
                    key: this.vworldApiKey,
                    format: 'json'
                }
            });

            const data = response.data;
            if (data.response?.status === 'OK') {
                const { x, y } = data.response.result.point;
                // PNU는 Geocoder 응답에 없을 수 있으므로 Data API로 재조회 필요할 수 있음
                // 하지만 주소 검색 결과에 파라미터로 pnu를 요청할 수 있는지 확인 필요
                // 실제로는 브이월드 검색 API나 데이터 API의 주소 필터 등을 병행 사용
                return { pnu: '', x, y }; // 일단 뼈대만 구축
            }
            return null;
        } catch (error) {
            console.error('Geocoder API 오류:', error);
            return null;
        }
    }

    /**
     * PNU -> GeoJSON 경계 데이터 획득 (Vworld Data API)
     */
    async getGeoJSON(pnu: string): Promise<any> {
        if (!this.vworldApiKey) throw new Error('VWORLD_API_KEY가 설정되지 않았습니다.');

        try {
            const response = await axios.get('https://api.vworld.kr/req/data', {
                params: {
                    service: 'data',
                    request: 'GetFeature',
                    data: 'LP_PA_CBND_BU_INFO', // 건축물 정보 포함 필지 경계 (예시 레이어)
                    key: this.vworldApiKey,
                    format: 'json',
                    domain: 'localhost',
                    attrFilter: `pnu:like:${pnu}`
                }
            });
            return response.data;
        } catch (error) {
            console.error('Vworld Data API 오류:', error);
            return null;
        }
    }

    /**
     * 표제부 조회 (공공데이터포털)
     */
    async getBuildingTitle(pnu: string): Promise<any[]> {
        if (!this.dataPortalApiKey) throw new Error('DATA_PORTAL_API_KEY가 설정되지 않았습니다.');
        
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
                    _type: 'json'
                }
            });
            return response.data.response?.body?.items?.item || [];
        } catch (error) {
            console.error('건축물대장 표제부 조회 오류:', error);
            return [];
        }
    }

    /**
     * 전유부 조회 (호수 리스트)
     */
    async getBuildingUnits(pnu: string): Promise<any[]> {
        if (!this.dataPortalApiKey) throw new Error('DATA_PORTAL_API_KEY가 설정되지 않았습니다.');

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
                    _type: 'json'
                }
            });
            return response.data.response?.body?.items?.item || [];
        } catch (error) {
            console.error('건축물대장 전유부 조회 오류:', error);
            return [];
        }
    }

    /**
     * 토지/건축물 소유자 정보 수집
     */
    async getOwnerInfo(pnu: string, type: 'LAND' | 'BUILDING'): Promise<any[]> {
        const endpoint = type === 'LAND' 
            ? 'http://apis.data.go.kr/1611000/LndkndOwnerInfoService/getLndkndOwnerInfo'
            : 'http://apis.data.go.kr/1611000/ArchOwnerInfoService/getArchOwnerInfo';

        try {
            const response = await axios.get(endpoint, {
                params: {
                    serviceKey: this.dataPortalApiKey,
                    pnu: pnu,
                    numOfRows: 100,
                    _type: 'json'
                }
            });
            return response.data.response?.body?.items?.item || [];
        } catch (error) {
            console.error(`${type} 소유자 정보 조회 오류:`, error);
            return [];
        }
    }
}

export const gisService = new GisService();
export default gisService;

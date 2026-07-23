import axios from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import {
    InspectResponse,
    InspectStep,
    KakaoInspectAddress,
} from '../types/gis-inspect.types';
import { buildPnuFromKakaoAddress } from './gis-shared/pnu';
import { maskSecretParams } from './gis-shared/secret-mask';

const logger = createLogger('GIS-INSPECT');

// gis-shared 공용 모듈로 이전됨 (DESIGN §10.6) — 기존 import 경로 호환을 위해 재노출한다.
export { buildPnuFromKakaoAddress, maskSecretParams };

const VWORLD_ADDRESS_URL = 'https://api.vworld.kr/req/address';
const VWORLD_DATA_URL = 'https://api.vworld.kr/req/data';
const VWORLD_NED_BASE = 'https://api.vworld.kr/ned/data';
const DATA_PORTAL_BOUNDARY_URL =
    'http://apis.data.go.kr/1611000/nsdi/ContinuousLandInfoService/getContinuousLandInfoWFS';
const DATA_PORTAL_BLDRGST_BASE = 'http://apis.data.go.kr/1613000/BldRgstHubService';
const REQUEST_TIMEOUT_MS = 15000;

/** 응답 steps 배열의 고정 순서 */
const STEP_DEFS: Array<{ id: string; name: string; provider: 'VWORLD' | 'DATA_GO_KR' }> = [
    { id: 'geocode', name: '지오코딩 (주소→좌표)', provider: 'VWORLD' },
    { id: 'coord_to_pnu', name: '좌표→PNU (연속지적도 조회)', provider: 'VWORLD' },
    { id: 'reverse_geocode', name: '역지오코딩 (좌표→도로명주소)', provider: 'VWORLD' },
    { id: 'boundary_dataportal', name: '필지 경계 — 연속지적도형정보 (1차 소스)', provider: 'DATA_GO_KR' },
    { id: 'boundary_vworld', name: '필지 경계 — 연속지적도 (폴백 소스)', provider: 'VWORLD' },
    { id: 'land_registry', name: '토지대장 (ladfrlList)', provider: 'VWORLD' },
    { id: 'land_price', name: '개별공시지가', provider: 'VWORLD' },
    { id: 'apart_price', name: '공동주택가격', provider: 'VWORLD' },
    { id: 'indiv_house_price', name: '개별주택가격', provider: 'VWORLD' },
    { id: 'building_title', name: '건축물대장 표제부', provider: 'DATA_GO_KR' },
    { id: 'building_units', name: '건축물대장 전유부', provider: 'DATA_GO_KR' },
    { id: 'land_share_registry', name: '대지권등록부 (ldaregList)', provider: 'VWORLD' },
    { id: 'building_ho_land_share', name: '집합건물 호별 대지권 (buldHoCoList)', provider: 'VWORLD' },
];

type HttpGet = (
    url: string,
    config: { params: Record<string, unknown>; timeout: number }
) => Promise<{ data: unknown }>;

export class GisInspectService {
    constructor(
        private readonly httpGet: HttpGet = (url, config) => axios.get(url, config)
    ) {}

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private get nedIntervalMs(): number {
        return Math.max(env.VWORLD_ATTR_REQUEST_INTERVAL_MS, 0);
    }

    private stepMeta(id: string) {
        const def = STEP_DEFS.find((d) => d.id === id);
        if (!def) throw new Error(`Unknown inspect step: ${id}`);
        return def;
    }

    /** 외부 API 1회 호출을 InspectStep으로 감싼다 — 실패해도 throw하지 않는다 */
    /**
     * VWorld는 호출량 제한(레이트리밋)에 걸리면 정상 요청에도 본문에
     * INCORRECT_KEY 에러를 돌려준다 (HTTP 200). 재시도·실패 표시 대상으로 판별한다.
     */
    private hasIncorrectKeyBody(data: unknown): boolean {
        if (!data || typeof data !== 'object') return false;
        try {
            return JSON.stringify(data).includes('INCORRECT_KEY');
        } catch {
            return false;
        }
    }

    private async callStep(
        id: string,
        endpoint: string,
        params: Record<string, unknown>
    ): Promise<InspectStep> {
        const meta = this.stepMeta(id);
        const startedAt = Date.now();
        // 레이트리밋 추정 상황에서 연사 증폭을 피하기 위해 재시도는 1회만, 충분히 쉬고 한다
        const maxBodyErrorAttempts = 2;
        const bodyErrorRetryDelayMs = 1500;
        let bodyErrorRetries = 0;

        try {
            let data: unknown;
            for (let attempt = 1; attempt <= maxBodyErrorAttempts; attempt++) {
                const response = await this.httpGet(endpoint, { params, timeout: REQUEST_TIMEOUT_MS });
                data = response.data;
                if (!this.hasIncorrectKeyBody(data)) break;
                if (attempt < maxBodyErrorAttempts) {
                    bodyErrorRetries += 1;
                    logger.warn(`inspect step ${id}: INCORRECT_KEY 응답(레이트리밋 추정) — ${bodyErrorRetryDelayMs}ms 후 재시도`);
                    await this.sleep(bodyErrorRetryDelayMs);
                }
            }

            const requestParams = {
                ...maskSecretParams(params),
                ...(bodyErrorRetries > 0 ? { bodyErrorRetries } : {}),
            };

            if (this.hasIncorrectKeyBody(data)) {
                return {
                    id, name: meta.name, provider: meta.provider, endpoint,
                    requestParams,
                    status: 'ERROR', durationMs: Date.now() - startedAt, rawJson: data,
                    error: 'VWorld 인증키 오류 응답 — 연속 호출 제한(레이트리밋)으로 추정됩니다. 1분 정도 후 다시 검색해 보세요.',
                };
            }

            return {
                id, name: meta.name, provider: meta.provider, endpoint,
                requestParams,
                status: 'SUCCESS', durationMs: Date.now() - startedAt, rawJson: data,
            };
        } catch (error) {
            const err = error as { message?: string; response?: { data?: unknown } };
            logger.warn(`inspect step ${id} failed: ${err?.message}`);
            return {
                id, name: meta.name, provider: meta.provider, endpoint,
                requestParams: maskSecretParams(params),
                status: 'ERROR', durationMs: Date.now() - startedAt,
                rawJson: err?.response?.data ?? null,
                error: err?.message || '알 수 없는 오류',
            };
        }
    }

    private skippedStep(id: string, endpoint: string, reason: string): InspectStep {
        const meta = this.stepMeta(id);
        return {
            id, name: meta.name, provider: meta.provider, endpoint,
            requestParams: {}, status: 'SKIPPED', durationMs: 0, rawJson: null, error: reason,
        };
    }

    /** VWorld NED 속성 API 공통 파라미터 */
    private nedParams(extra: Record<string, unknown>): Record<string, unknown> {
        return {
            ...extra,
            format: 'json',
            numOfRows: 1000,
            pageNo: 1,
            key: env.VWORLD_API_KEY,
            domain: env.VWORLD_API_DOMAIN,
        };
    }

    /** 공시가격 API — 연도 폴백(현재→-1→-2). 비어있지 않은 첫 응답을 채택 */
    private async callNedPriceStep(
        id: string,
        endpointPath: string,
        containerKey: string,
        pnu: string
    ): Promise<InspectStep> {
        const meta = this.stepMeta(id);
        const endpoint = `${VWORLD_NED_BASE}/${endpointPath}`;
        const currentYear = new Date().getFullYear();
        const years = [currentYear, currentYear - 1, currentYear - 2].map(String);
        const startedAt = Date.now();

        let lastStep: InspectStep | null = null;
        const triedYears: string[] = [];

        for (const year of years) {
            await this.sleep(this.nedIntervalMs);
            triedYears.push(year);
            const step = await this.callStep(id, endpoint, this.nedParams({ pnu, stdrYear: year }));
            lastStep = step;
            if (step.status === 'ERROR') break;
            const raw = step.rawJson as Record<string, { field?: unknown[] } | undefined> | null;
            const fieldCount = raw?.[containerKey]?.field?.length ?? 0;
            if (fieldCount > 0) break;
        }

        // 시도한 연도 목록을 요청 파라미터에 남긴다
        return {
            ...(lastStep ?? this.skippedStep(id, endpoint, '호출되지 않음')),
            name: meta.name,
            durationMs: Date.now() - startedAt,
            requestParams: { ...(lastStep?.requestParams ?? {}), triedYears },
        };
    }

    async inspect(address: KakaoInspectAddress): Promise<InspectResponse> {
        const t0 = Date.now();
        const byId = new Map<string, InspectStep>();

        // ── 1. 지오코딩: 지번(PARCEL) 우선, 실패 시 도로명(ROAD) 재시도 (기존 파이프라인과 동일)
        const geocodeBase = {
            service: 'address', request: 'getcoord', version: '2.0',
            key: env.VWORLD_API_KEY, format: 'json',
        };
        const parcelAddress = address.jibunAddress || address.roadAddress;
        let geocodeStep = await this.callStep('geocode', VWORLD_ADDRESS_URL, {
            ...geocodeBase, address: parcelAddress, type: 'PARCEL',
        });
        const isGeocodeOk = (s: InspectStep) =>
            s.status === 'SUCCESS' &&
            (s.rawJson as { response?: { status?: string } } | null)?.response?.status === 'OK';
        if (!isGeocodeOk(geocodeStep) && address.roadAddress) {
            const retry = await this.callStep('geocode', VWORLD_ADDRESS_URL, {
                ...geocodeBase, address: address.roadAddress, type: 'ROAD',
            });
            retry.requestParams = { ...retry.requestParams, triedTypes: ['PARCEL', 'ROAD'] };
            geocodeStep = retry;
        }
        byId.set('geocode', geocodeStep);

        const point = (geocodeStep.rawJson as {
            response?: { status?: string; result?: { point?: { x?: string; y?: string } } };
        } | null)?.response;
        const coord =
            point?.status === 'OK' && point.result?.point?.x && point.result?.point?.y
                ? { x: String(point.result.point.x), y: String(point.result.point.y) }
                : null;

        // ── 2·3. 좌표 의존 스텝
        if (coord) {
            byId.set('coord_to_pnu', await this.callStep('coord_to_pnu', VWORLD_DATA_URL, {
                service: 'data', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN',
                key: env.VWORLD_API_KEY, format: 'json', domain: env.VWORLD_API_DOMAIN,
                geomFilter: `POINT(${coord.x} ${coord.y})`, geometry: true, size: 1,
            }));
            byId.set('reverse_geocode', await this.callStep('reverse_geocode', VWORLD_ADDRESS_URL, {
                service: 'address', request: 'getAddress', version: '2.0',
                point: `${coord.x},${coord.y}`, type: 'ROAD',
                key: env.VWORLD_API_KEY, format: 'json',
            }));
        } else {
            byId.set('coord_to_pnu', this.skippedStep('coord_to_pnu', VWORLD_DATA_URL, '지오코딩 좌표를 확보하지 못했습니다.'));
            byId.set('reverse_geocode', this.skippedStep('reverse_geocode', VWORLD_ADDRESS_URL, '지오코딩 좌표를 확보하지 못했습니다.'));
        }

        // ── PNU 확정: 로컬 생성 우선, 실패 시 좌표→PNU 응답에서 추출
        let pnu = buildPnuFromKakaoAddress(address);
        let pnuSource: InspectResponse['pnuSource'] = pnu ? 'LOCAL' : null;
        if (!pnu) {
            const coordPnu = (byId.get('coord_to_pnu')?.rawJson as {
                response?: { result?: { featureCollection?: { features?: Array<{ properties?: { pnu?: string } }> } } };
            } | null)?.response?.result?.featureCollection?.features?.[0]?.properties?.pnu;
            if (coordPnu && String(coordPnu).length === 19) {
                pnu = String(coordPnu);
                pnuSource = 'VWORLD_COORD';
            }
        }

        // ── 4~13. PNU 의존 스텝
        if (!pnu) {
            const reason = '주소에서 PNU를 확보하지 못했습니다.';
            byId.set('boundary_dataportal', this.skippedStep('boundary_dataportal', DATA_PORTAL_BOUNDARY_URL, reason));
            byId.set('boundary_vworld', this.skippedStep('boundary_vworld', VWORLD_DATA_URL, reason));
            byId.set('land_registry', this.skippedStep('land_registry', `${VWORLD_NED_BASE}/ladfrlList`, reason));
            byId.set('land_price', this.skippedStep('land_price', `${VWORLD_NED_BASE}/getIndvdLandPriceAttr`, reason));
            byId.set('apart_price', this.skippedStep('apart_price', `${VWORLD_NED_BASE}/getApartHousingPriceAttr`, reason));
            byId.set('indiv_house_price', this.skippedStep('indiv_house_price', `${VWORLD_NED_BASE}/getIndvdHousingPriceAttr`, reason));
            byId.set('building_title', this.skippedStep('building_title', `${DATA_PORTAL_BLDRGST_BASE}/getBrTitleInfo`, reason));
            byId.set('building_units', this.skippedStep('building_units', `${DATA_PORTAL_BLDRGST_BASE}/getBrExposInfo`, reason));
            byId.set('land_share_registry', this.skippedStep('land_share_registry', `${VWORLD_NED_BASE}/ldaregList`, reason));
            byId.set('building_ho_land_share', this.skippedStep('building_ho_land_share', `${VWORLD_NED_BASE}/buldHoCoList`, reason));
        } else {
            const sigunguCd = pnu.substring(0, 5);
            const bjdongCd = pnu.substring(5, 10);
            const bun = pnu.substring(11, 15);
            const ji = pnu.substring(15, 19);

            // data.go.kr 3종은 병렬 (레이트리밋 없음)
            const dataPortalPromise = Promise.all([
                this.callStep('boundary_dataportal', DATA_PORTAL_BOUNDARY_URL, {
                    serviceKey: env.DATA_PORTAL_API_KEY, pnu, format: 'json', numOfRows: 1, pageNo: 1,
                }),
                this.callStep('building_title', `${DATA_PORTAL_BLDRGST_BASE}/getBrTitleInfo`, {
                    serviceKey: env.DATA_PORTAL_API_KEY, sigunguCd, bjdongCd, bun, ji,
                    numOfRows: 100, _type: 'json',
                }),
                this.callStep('building_units', `${DATA_PORTAL_BLDRGST_BASE}/getBrExposInfo`, {
                    serviceKey: env.DATA_PORTAL_API_KEY, sigunguCd, bjdongCd, bun, ji,
                    numOfRows: 1000, _type: 'json',
                }),
            ]);

            // VWorld는 순차 (NED 호출 전 interval 준수)
            byId.set('boundary_vworld', await this.callStep('boundary_vworld', VWORLD_DATA_URL, {
                service: 'data', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN',
                key: env.VWORLD_API_KEY, format: 'json', domain: env.VWORLD_API_DOMAIN,
                attrFilter: `pnu:=:${pnu}`, geometry: true, size: 1,
            }));

            await this.sleep(this.nedIntervalMs);
            byId.set('land_registry', await this.callStep('land_registry', `${VWORLD_NED_BASE}/ladfrlList`,
                this.nedParams({ pnu })));

            byId.set('land_price', await this.callNedPriceStep('land_price', 'getIndvdLandPriceAttr', 'indvdLandPrices', pnu));
            byId.set('apart_price', await this.callNedPriceStep('apart_price', 'getApartHousingPriceAttr', 'apartHousingPrices', pnu));
            byId.set('indiv_house_price', await this.callNedPriceStep('indiv_house_price', 'getIndvdHousingPriceAttr', 'indvdHousingPrices', pnu));

            await this.sleep(this.nedIntervalMs);
            byId.set('land_share_registry', await this.callStep('land_share_registry', `${VWORLD_NED_BASE}/ldaregList`,
                this.nedParams({ pnu })));

            await this.sleep(this.nedIntervalMs);
            byId.set('building_ho_land_share', await this.callStep('building_ho_land_share', `${VWORLD_NED_BASE}/buldHoCoList`,
                this.nedParams({ pnu })));

            const [boundaryStep, titleStep, unitsStep] = await dataPortalPromise;
            byId.set('boundary_dataportal', boundaryStep);
            byId.set('building_title', titleStep);
            byId.set('building_units', unitsStep);
        }

        return {
            address,
            pnu,
            pnuSource,
            steps: STEP_DEFS.map((d) => byId.get(d.id)!),
            totalDurationMs: Date.now() - t0,
        };
    }
}

export const gisInspectService = new GisInspectService();

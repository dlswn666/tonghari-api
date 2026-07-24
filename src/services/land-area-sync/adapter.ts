/**
 * 대지권면적 자동 동기화 — strict API adapter 엔진 + 6 endpoint adapter.
 *
 * 권위 스펙: docs/2026-07-23-land-area-sync-design.md §10.1~10.3, §10.5, §10.7.
 *
 * 설계 원칙:
 *  - HTTPS endpoint 상수(gis-shared/endpoints.ts)만 사용한다. inspector의 http:// 상수는 공유 금지.
 *  - COMPLETE / COMPLETE_ZERO / FAILED / INCOMPLETE 4상태를 엄격히 분리한다.
 *  - pagination 완전성을 확인한 뒤에만 dedup한다.
 *  - retry는 timeout/429/5xx만, page loop·retry delay 모두 같은 AbortSignal을 확인한다.
 *  - http client / sleep / random을 주입 가능하게 하여 mock 테스트를 가능케 한다.
 */

import axios from 'axios';
import { GIS_SHARED_ENDPOINTS, type GisSharedEndpointName } from '../gis-shared/endpoints';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    BrTitleRow,
    EndpointZeroLabel,
    EnvelopeParser,
    HttpClient,
    HttpRequest,
    HttpResponse,
    LadfrlRow,
    LdaregRow,
    ParsedEnvelope,
    ProviderIssue,
    ProviderIssueKind,
    ProviderSchemaErrorCode,
    StrictScan,
} from '../../types/land-area-sync.types';
import { convertPlatGbCdToLandGbn } from '../gis-shared/pnu';

/** 모든 strict scan은 numOfRows=1000으로 페이지네이션한다 (표제부 포함, DESIGN §10.2) */
export const STRICT_SCAN_PAGE_SIZE = 1000;
/** timeout/429/5xx 재시도 최대 횟수 (DESIGN §10.3) */
export const STRICT_SCAN_MAX_ATTEMPTS = 3;
/** 페이지 상한 (totalCount 계산 오류에 대한 방어적 절단; 50k row 대응) */
const STRICT_SCAN_MAX_PAGES = 500;
/** exponential backoff 기준 지연(ms) */
const BACKOFF_BASE_MS = 500;
/** jitter 폭(ms) */
const BACKOFF_JITTER_MS = 250;
/** Retry-After 상한(ms) — 이 이상은 대기하지 않는다 */
const RETRY_AFTER_CAP_MS = 30_000;
/** HTTP 요청 timeout(ms) */
const REQUEST_TIMEOUT_MS = 15_000;

export interface BuildingHubAuth {
    serviceKey: string;
}

export interface VworldAuth {
    key: string;
    domain: string;
}

export interface StrictScanDeps {
    httpClient?: HttpClient;
    /** 재시도 지연. 테스트는 no-op로 주입해 결정론적으로 만든다 */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** jitter 난수(0~1). 테스트는 () => 0 로 주입 */
    random?: () => number;
}

export interface StrictScanOptions {
    signal?: AbortSignal;
}

// ── 기본 주입물 ──────────────────────────────────────────────────

const defaultHttpClient: HttpClient = async ({ url, params, timeout, signal }) => {
    // validateStatus: 모든 상태코드를 그대로 받아 adapter가 분류한다 (4xx/5xx에서 throw 금지)
    const res = await axios.get(url, { params, timeout, signal, validateStatus: () => true });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
    }
    return { status: res.status, data: res.data, headers };
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true }
        );
    });

// ── 순수 헬퍼 ────────────────────────────────────────────────────

/** 0 이상의 safe integer만 허용. 그 외(음수·소수·비숫자·null)는 null */
function parseNonNegInt(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        const n = Number(trimmed);
        return Number.isSafeInteger(n) ? n : null;
    }
    return null;
}

/** items.item / VOList 내부 배열을 배열로 정규화. 단건 객체는 [obj], 빈 값은 [] */
function normalizeItems(raw: unknown): unknown[] {
    if (raw === undefined || raw === null || raw === '') return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') return [raw];
    return [];
}

/** Retry-After 헤더(초 또는 HTTP-date)를 ms로 파싱. 상한 적용은 호출측 */
function parseRetryAfterMs(header: string | undefined, now: number): number | null {
    if (!header) return null;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now);
    return null;
}

function isTimeoutError(err: unknown): boolean {
    const e = err as { code?: string; name?: string; message?: string };
    return (
        e?.code === 'ECONNABORTED' ||
        e?.code === 'ETIMEDOUT' ||
        e?.name === 'TimeoutError' ||
        (typeof e?.message === 'string' && /timeout/i.test(e.message))
    );
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    const e = err as { code?: string; name?: string };
    return e?.name === 'AbortError' || e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED';
}

// ── envelope 파서 ────────────────────────────────────────────────

/**
 * 건축물대장(공공데이터포털) 응답 envelope 파서.
 * shape: response.header.resultCode / response.body.{totalCount, items.item}
 */
export function parseBuildingHubEnvelope<T = Record<string, unknown>>(
    data: unknown
): ParsedEnvelope<T> {
    const root = (data as { response?: unknown } | null)?.response as
        | { header?: { resultCode?: unknown; resultMsg?: unknown }; body?: { totalCount?: unknown; items?: { item?: unknown } } }
        | undefined;
    if (!root || typeof root !== 'object') {
        return {
            kind: 'SCHEMA_ERROR',
            message: 'response 컨테이너가 없습니다.',
            schemaErrorCode: 'RESPONSE_CONTAINER_MISSING',
        };
    }
    const resultCode = root.header?.resultCode;
    if (resultCode === undefined || resultCode === null) {
        return {
            kind: 'SCHEMA_ERROR',
            message: 'resultCode가 없습니다.',
            schemaErrorCode: 'RESULT_CODE_MISSING',
        };
    }
    if (String(resultCode) !== '00') {
        return { kind: 'PROVIDER_ERROR', providerCode: String(resultCode), message: 'provider 오류 응답입니다.' };
    }
    const body = root.body;
    if (!body || typeof body !== 'object') {
        return {
            kind: 'SCHEMA_ERROR',
            message: 'body가 없습니다.',
            schemaErrorCode: 'BODY_MISSING',
        };
    }
    const totalCount = parseNonNegInt(body.totalCount);
    if (totalCount === null) {
        return {
            kind: 'SCHEMA_ERROR',
            message: 'totalCount가 0 이상의 정수가 아닙니다.',
            schemaErrorCode: 'TOTAL_COUNT_INVALID',
        };
    }
    return { kind: 'SUCCESS', totalCount, rows: normalizeItems(body.items?.item) as T[] };
}

/**
 * V-World NED(ladfrlList/ldaregList) 응답 envelope 파서.
 * shape: data[containerKey].{totalCount, error?, resultCode?, [itemKey]: rows}
 * ladfrl/ldareg 모두 wrapper 키와 내부 배열 키가 동일하다(예: ladfrlVOList.ladfrlVOList).
 */
export function parseVworldEnvelope<T = Record<string, unknown>>(
    containerKey: string,
    itemKey: string,
    data: unknown
): ParsedEnvelope<T> {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return {
            kind: 'SCHEMA_ERROR',
            message: 'endpoint 응답이 객체가 아닙니다.',
            schemaErrorCode: 'ENDPOINT_RESPONSE_NON_OBJECT',
        };
    }
    const root = data as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(root, containerKey)) {
        const keys = Object.keys(root);
        const schemaErrorCode: ProviderSchemaErrorCode =
            keys.length === 0
                ? 'ENDPOINT_CONTAINER_MISSING_EMPTY_OBJECT'
                : keys.includes('response')
                  ? 'ENDPOINT_CONTAINER_MISSING_RESPONSE'
                  : 'ENDPOINT_CONTAINER_MISSING_OTHER';
        return {
            kind: 'SCHEMA_ERROR',
            message: `${containerKey} 컨테이너가 없습니다.`,
            schemaErrorCode,
        };
    }
    const container = root[containerKey] as
        | { totalCount?: unknown; error?: unknown; message?: unknown; resultCode?: unknown; [k: string]: unknown }
        | undefined;
    if (!container || typeof container !== 'object') {
        return {
            kind: 'SCHEMA_ERROR',
            message: `${containerKey} 컨테이너가 객체가 아닙니다.`,
            schemaErrorCode: 'ENDPOINT_CONTAINER_INVALID',
        };
    }
    // V-World 오류 envelope (INVALID_KEY, OVER_REQUEST_LIMIT 등)은 HTTP 200 이지만 즉시 실패다.
    if (container.error !== undefined && container.error !== null && container.error !== '') {
        return { kind: 'PROVIDER_ERROR', providerCode: String(container.error), message: 'provider 오류 응답입니다.' };
    }
    if (
        container.resultCode !== undefined &&
        container.resultCode !== null &&
        String(container.resultCode) !== '00'
    ) {
        return { kind: 'PROVIDER_ERROR', providerCode: String(container.resultCode), message: 'provider 오류 응답입니다.' };
    }
    const totalCount = parseNonNegInt(container.totalCount);
    if (totalCount === null) {
        return {
            kind: 'SCHEMA_ERROR',
            message: 'totalCount가 0 이상의 정수가 아닙니다.',
            schemaErrorCode: 'TOTAL_COUNT_INVALID',
        };
    }
    return { kind: 'SUCCESS', totalCount, rows: normalizeItems(container[itemKey]) as T[] };
}

// ── endpoint별 zero 라벨 (DESIGN §10.7) ──────────────────────────

const ZERO_LABEL: Record<GisSharedEndpointName, EndpointZeroLabel> = {
    getBrTitleInfo: 'TITLE_COMPLETE_ZERO',
    getBrAtchJibunInfo: 'ATTACHED_COMPLETE_ZERO',
    getBrExposInfo: 'EXPOS_COMPLETE_ZERO',
    getBrBasisOulnInfo: 'BASIS_COMPLETE_ZERO',
    ladfrlList: 'LADFRL_COMPLETE_ZERO',
    ldaregList: 'LDAREG_COMPLETE_ZERO',
};

/** endpoint 이름을 COMPLETE_ZERO 라벨로 매핑한다. zero 의미 부여는 호출측이지만 라벨은 여기서 확정 */
export function endpointZeroLabel(endpoint: GisSharedEndpointName): EndpointZeroLabel {
    return ZERO_LABEL[endpoint];
}

// ── 내부 페이지 조회 결과 ────────────────────────────────────────

type PageFetch<T> = { ok: true; parsed: ParsedEnvelope<T> & { kind: 'SUCCESS' }; attempts: number }
    | { ok: false; issue: ProviderIssue };

// ── adapter ──────────────────────────────────────────────────────

export class LandAreaSyncAdapter {
    private readonly httpClient: HttpClient;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    private readonly random: () => number;

    constructor(deps: StrictScanDeps = {}) {
        this.httpClient = deps.httpClient ?? defaultHttpClient;
        this.sleep = deps.sleep ?? defaultSleep;
        this.random = deps.random ?? Math.random;
    }

    // ── 6 endpoint adapter ──────────────────────────────────────

    /** 표제부 strict 전체 페이지 (getBrTitleInfo) */
    scanTitle(pnu: string, auth: BuildingHubAuth, opts: StrictScanOptions = {}): Promise<StrictScan<BrTitleRow>> {
        return this.scanBuildingHub<BrTitleRow>('getBrTitleInfo', pnu, auth, opts);
    }

    /** 부속지번 strict 전체 페이지 (getBrAtchJibunInfo) */
    scanAttached(pnu: string, auth: BuildingHubAuth, opts: StrictScanOptions = {}): Promise<StrictScan<BrAtchJibunRow>> {
        return this.scanBuildingHub<BrAtchJibunRow>('getBrAtchJibunInfo', pnu, auth, opts);
    }

    /** 전유부 strict 전체 페이지 (getBrExposInfo) */
    scanExpos(pnu: string, auth: BuildingHubAuth, opts: StrictScanOptions = {}): Promise<StrictScan<BrExposRow>> {
        return this.scanBuildingHub<BrExposRow>('getBrExposInfo', pnu, auth, opts);
    }

    /** 기본개요 strict 전체 페이지 (getBrBasisOulnInfo) — bylotCnt basis fallback 원천 */
    scanBasis(pnu: string, auth: BuildingHubAuth, opts: StrictScanOptions = {}): Promise<StrictScan<BrBasisOulnRow>> {
        return this.scanBuildingHub<BrBasisOulnRow>('getBrBasisOulnInfo', pnu, auth, opts);
    }

    /** 토지대장 strict 전체 페이지 (ladfrlList) */
    scanLadfrl(pnu: string, auth: VworldAuth, opts: StrictScanOptions = {}): Promise<StrictScan<LadfrlRow>> {
        return this.scanVworld<LadfrlRow>('ladfrlList', 'ladfrlVOList', pnu, auth, opts);
    }

    /** 대지권등록부 strict 전체 페이지 (ldaregList) */
    scanLdareg(pnu: string, auth: VworldAuth, opts: StrictScanOptions = {}): Promise<StrictScan<LdaregRow>> {
        return this.scanVworld<LdaregRow>('ldaregList', 'ldaregVOList', pnu, auth, opts);
    }

    // ── endpoint 그룹별 파라미터 조립 ───────────────────────────

    private scanBuildingHub<T>(
        endpoint: GisSharedEndpointName,
        pnu: string,
        auth: BuildingHubAuth,
        opts: StrictScanOptions
    ): Promise<StrictScan<T>> {
        if (!/^\d{10}[12]\d{8}$/.test(pnu)) {
            return Promise.resolve(this.schemaFailure<T>(endpoint, 'PNU 형식이 올바르지 않습니다.'));
        }
        const sigunguCd = pnu.slice(0, 5);
        const bjdongCd = pnu.slice(5, 10);
        const landGbn = pnu.slice(10, 11);
        const bun = pnu.slice(11, 15);
        const ji = pnu.slice(15, 19);
        const baseParams: Record<string, unknown> = {
            serviceKey: auth.serviceKey,
            sigunguCd,
            bjdongCd,
            platGbCd: landGbn === '2' ? '1' : '0',
            bun,
            ji,
            _type: 'json',
        };
        return this.scan<T>(
            endpoint,
            GIS_SHARED_ENDPOINTS[endpoint],
            baseParams,
            (data) => parseBuildingHubEnvelope<T>(data),
            opts
        );
    }

    private scanVworld<T>(
        endpoint: GisSharedEndpointName,
        containerKey: string,
        pnu: string,
        auth: VworldAuth,
        opts: StrictScanOptions
    ): Promise<StrictScan<T>> {
        const baseParams: Record<string, unknown> = {
            pnu,
            key: auth.key,
            domain: auth.domain,
            format: 'json',
        };
        return this.scan<T>(
            endpoint,
            GIS_SHARED_ENDPOINTS[endpoint],
            baseParams,
            (data) => parseVworldEnvelope<T>(containerKey, containerKey, data),
            opts
        );
    }

    // ── strict scan 엔진 (pagination + 완전성 + dedup) ───────────

    private async scan<T>(
        endpoint: GisSharedEndpointName,
        url: string,
        baseParams: Record<string, unknown>,
        parser: EnvelopeParser<T>,
        opts: StrictScanOptions
    ): Promise<StrictScan<T>> {
        const signal = opts.signal;
        const allRows: T[] = [];
        const pageSignatures = new Set<string>();
        let expectedTotal: number | null = null;
        let totalPages: number | null = null;
        let pagesFetched = 0;

        for (let pageNo = 1; pageNo <= STRICT_SCAN_MAX_PAGES; pageNo++) {
            // page loop에서 AbortSignal 확인
            if (signal?.aborted) {
                return this.abortedFailure(endpoint, pagesFetched);
            }

            const fetched = await this.fetchPageWithRetry<T>(endpoint, url, baseParams, parser, pageNo, signal);
            if (!fetched.ok) {
                return { state: 'FAILED', issue: { ...fetched.issue, pagesFetched } };
            }
            pagesFetched++;
            const { totalCount, rows } = fetched.parsed;

            // ── 첫 페이지: totalCount 검증 + COMPLETE_ZERO 판정
            if (pageNo === 1) {
                expectedTotal = totalCount;
                if (expectedTotal === 0) {
                    // success envelope + 명시적 totalCount=0. rows가 있으면 zero가 아니라 불일치
                    if (rows.length !== 0) {
                        return this.paginationMismatch(endpoint, 'totalCount=0 인데 row가 존재합니다.', {
                            pagesFetched,
                            expectedTotalCount: 0,
                            receivedRows: rows.length,
                        });
                    }
                    return { state: 'COMPLETE_ZERO', rows: [], totalCount: 0, pagesFetched };
                }
                totalPages = Math.ceil(expectedTotal / STRICT_SCAN_PAGE_SIZE);
            } else if (totalCount !== expectedTotal) {
                // 모든 page가 같은 totalCount를 반환해야 한다
                return this.paginationMismatch(endpoint, '페이지마다 totalCount가 다릅니다.', {
                    pagesFetched,
                    expectedTotalCount: expectedTotal ?? undefined,
                    receivedRows: allRows.length,
                });
            }

            const isLastPage = pageNo === totalPages;
            const expectedThisPage = isLastPage
                ? (expectedTotal as number) - STRICT_SCAN_PAGE_SIZE * ((totalPages as number) - 1)
                : STRICT_SCAN_PAGE_SIZE;

            // 중간 빈 페이지 / 예상보다 짧은 중간 페이지 / 마지막 페이지 개수 불일치
            if (rows.length === 0) {
                return this.paginationMismatch(endpoint, '중간 페이지가 비어 있습니다.', {
                    pagesFetched,
                    expectedTotalCount: expectedTotal ?? undefined,
                    receivedRows: allRows.length,
                });
            }
            if (!isLastPage && rows.length < STRICT_SCAN_PAGE_SIZE) {
                return this.paginationMismatch(endpoint, '중간 페이지가 예상보다 짧습니다.', {
                    pagesFetched,
                    expectedTotalCount: expectedTotal ?? undefined,
                    receivedRows: allRows.length + rows.length,
                });
            }
            if (rows.length !== expectedThisPage) {
                return this.paginationMismatch(endpoint, '페이지 row 수가 기대치와 다릅니다.', {
                    pagesFetched,
                    expectedTotalCount: expectedTotal ?? undefined,
                    receivedRows: allRows.length + rows.length,
                });
            }

            // 반복 페이지(동일 내용) 탐지
            const signature = this.pageSignature(rows);
            if (pageSignatures.has(signature)) {
                return this.paginationMismatch(endpoint, '동일한 페이지가 반복되었습니다.', {
                    pagesFetched,
                    expectedTotalCount: expectedTotal ?? undefined,
                    receivedRows: allRows.length + rows.length,
                });
            }
            pageSignatures.add(signature);

            allRows.push(...rows);

            // 누적 초과
            if (allRows.length > (expectedTotal as number)) {
                return this.paginationMismatch(endpoint, '누적 row 수가 totalCount를 초과했습니다.', {
                    pagesFetched,
                    expectedTotalCount: expectedTotal ?? undefined,
                    receivedRows: allRows.length,
                });
            }

            if (isLastPage) break;
        }

        // 페이지 상한을 넘겼으면(totalCount 대비 미완) INCOMPLETE
        if (expectedTotal === null || totalPages === null || pagesFetched < totalPages) {
            return this.paginationMismatch(endpoint, '페이지 상한을 초과했습니다.', {
                pagesFetched,
                expectedTotalCount: expectedTotal ?? undefined,
                receivedRows: allRows.length,
            });
        }

        // 전체 raw row 수로 완전성 확인 (누적 부족)
        if (allRows.length !== expectedTotal) {
            return this.paginationMismatch(endpoint, '누적 row 수가 totalCount와 다릅니다.', {
                pagesFetched,
                expectedTotalCount: expectedTotal,
                receivedRows: allRows.length,
            });
        }

        return { state: 'COMPLETE', rows: allRows, totalCount: expectedTotal, pagesFetched };
    }

    /** 한 페이지를 retry 정책에 따라 조회한다 */
    private async fetchPageWithRetry<T>(
        endpoint: GisSharedEndpointName,
        url: string,
        baseParams: Record<string, unknown>,
        parser: EnvelopeParser<T>,
        pageNo: number,
        signal?: AbortSignal
    ): Promise<PageFetch<T>> {
        const params = { ...baseParams, numOfRows: STRICT_SCAN_PAGE_SIZE, pageNo };

        for (let attempt = 1; attempt <= STRICT_SCAN_MAX_ATTEMPTS; attempt++) {
            if (signal?.aborted) {
                return { ok: false, issue: this.abortIssue(endpoint) };
            }

            let res: HttpResponse;
            try {
                res = await this.httpClient({ url, params, timeout: REQUEST_TIMEOUT_MS, signal });
            } catch (err) {
                if (isAbortError(err, signal)) {
                    return { ok: false, issue: this.abortIssue(endpoint) };
                }
                if (isTimeoutError(err)) {
                    // timeout만 재시도
                    if (attempt < STRICT_SCAN_MAX_ATTEMPTS) {
                        const cont = await this.backoff(attempt, undefined, signal);
                        if (!cont) return { ok: false, issue: this.abortIssue(endpoint) };
                        continue;
                    }
                    return {
                        ok: false,
                        issue: this.issue('TIMEOUT', endpoint, 'timeout으로 조회에 실패했습니다.', { attempts: attempt }),
                    };
                }
                // timeout이 아닌 transport 오류(DNS 등)는 즉시 실패
                return {
                    ok: false,
                    issue: this.issue('TRANSPORT_ERROR', endpoint, '네트워크 오류로 조회에 실패했습니다.', { attempts: attempt }),
                };
            }

            const status = res.status;

            // 429 / 5xx 만 재시도
            if (status === 429 || (status >= 500 && status <= 599)) {
                if (attempt < STRICT_SCAN_MAX_ATTEMPTS) {
                    const cont = await this.backoff(attempt, res.headers['retry-after'], signal);
                    if (!cont) return { ok: false, issue: this.abortIssue(endpoint) };
                    continue;
                }
                return {
                    ok: false,
                    issue: this.issue('HTTP_ERROR', endpoint, 'HTTP 오류로 조회에 실패했습니다.', {
                        httpStatus: status,
                        attempts: attempt,
                    }),
                };
            }

            // 401/403/기타 4xx/비정상 상태는 즉시 실패
            if (status < 200 || status >= 300) {
                return {
                    ok: false,
                    issue: this.issue('HTTP_ERROR', endpoint, 'HTTP 오류로 조회에 실패했습니다.', {
                        httpStatus: status,
                        attempts: attempt,
                    }),
                };
            }

            // 2xx → envelope 파싱
            const parsed = parser(res.data);
            if (parsed.kind === 'PROVIDER_ERROR') {
                // HTTP 200 provider error envelope는 즉시 실패
                return {
                    ok: false,
                    issue: this.issue('PROVIDER_ERROR_ENVELOPE', endpoint, 'provider 오류 응답으로 실패했습니다.', {
                        providerCode: parsed.providerCode,
                        attempts: attempt,
                    }),
                };
            }
            if (parsed.kind === 'SCHEMA_ERROR') {
                return {
                    ok: false,
                    issue: this.issue('SCHEMA_ERROR', endpoint, parsed.message, {
                        attempts: attempt,
                        schemaErrorCode: parsed.schemaErrorCode,
                    }),
                };
            }
            return { ok: true, parsed, attempts: attempt };
        }

        // 도달 불가(루프 내에서 항상 return)
        return { ok: false, issue: this.issue('HTTP_ERROR', endpoint, '재시도가 소진되었습니다.') };
    }

    /**
     * 재시도 지연을 수행한다. Retry-After가 있으면 상한 내에서 준수하고,
     * 없으면 exponential backoff + jitter를 적용한다. 지연 전후로 AbortSignal을 확인한다.
     * @returns 계속 진행 가능하면 true, 취소되었으면 false
     */
    private async backoff(attempt: number, retryAfter: string | undefined, signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) return false;
        let delayMs: number;
        const retryAfterMs = parseRetryAfterMs(retryAfter, Date.now());
        if (retryAfterMs !== null) {
            // Retry-After 준수하되 상한 초과 금지
            delayMs = Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
        } else {
            const expo = BACKOFF_BASE_MS * 2 ** (attempt - 1);
            const jitter = Math.floor(this.random() * BACKOFF_JITTER_MS);
            delayMs = expo + jitter;
        }
        await this.sleep(delayMs, signal);
        return !signal?.aborted;
    }

    /** 페이지 내용 서명(반복 페이지 탐지용) */
    private pageSignature(rows: unknown[]): string {
        try {
            return JSON.stringify(rows);
        } catch {
            // 순환참조 등은 개수+타입 기반 fallback
            return `len:${rows.length}`;
        }
    }

    // ── issue/failure 생성 헬퍼 ─────────────────────────────────

    private issue(
        kind: ProviderIssueKind,
        endpoint: GisSharedEndpointName,
        message: string,
        extra: Partial<ProviderIssue> = {}
    ): ProviderIssue {
        return { kind, endpoint, message, ...extra };
    }

    private abortIssue(endpoint: GisSharedEndpointName): ProviderIssue {
        return this.issue('ABORTED', endpoint, '요청이 취소되었습니다.');
    }

    private abortedFailure<T>(endpoint: GisSharedEndpointName, pagesFetched: number): StrictScan<T> {
        return { state: 'FAILED', issue: { ...this.abortIssue(endpoint), pagesFetched } };
    }

    private schemaFailure<T>(
        endpoint: GisSharedEndpointName,
        message: string,
        schemaErrorCode: ProviderSchemaErrorCode = 'INPUT_PNU_INVALID'
    ): StrictScan<T> {
        return {
            state: 'FAILED',
            issue: this.issue('SCHEMA_ERROR', endpoint, message, {
                schemaErrorCode,
            }),
        };
    }

    private paginationMismatch<T>(
        endpoint: GisSharedEndpointName,
        message: string,
        extra: Partial<ProviderIssue>
    ): StrictScan<T> {
        return { state: 'INCOMPLETE', issue: this.issue('PAGINATION_MISMATCH', endpoint, message, extra) };
    }
}

/** 기본 주입물(axios)로 만든 싱글턴 */
export const landAreaSyncAdapter = new LandAreaSyncAdapter();

// env는 지연 로드한다 — adapter 모듈을 import하는 것만으로 env 검증을 강제하지 않기 위함.
// (순수 엔진 테스트가 env 스텁 없이 adapter를 정적 import할 수 있게 한다)
function readEnv(): typeof import('../../config/env').env {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../config/env').env;
}

/** env에서 건축HUB serviceKey를 읽는다 (DATA_PORTAL_API_KEY) */
export function buildingHubAuthFromEnv(): BuildingHubAuth {
    return { serviceKey: readEnv().DATA_PORTAL_API_KEY };
}

/** env에서 V-World 인증(key + domain)을 읽는다 */
export function vworldAuthFromEnv(): VworldAuth {
    const env = readEnv();
    return { key: env.VWORLD_API_KEY, domain: env.VWORLD_API_DOMAIN };
}

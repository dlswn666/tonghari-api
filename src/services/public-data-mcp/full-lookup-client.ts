import axios from 'axios';
import { createHash } from 'node:crypto';
import { normalizeDataPortalApiKey } from '../../utils/data-portal-api-key';
import { parseVworldRequestIntervalMs } from '../../utils/vworld-request-interval';
import {
    FULL_GIS_SOURCE_META, emptyFullGisStep,
    type FullGisClient, type FullGisSourceId, type FullGisSourceQuery, type FullGisStep,
} from './full-lookup-contract';
import { FullGisProjectionError, projectFullGisGeometry, projectFullGisRecord } from './full-lookup-projection';

type Row = Record<string, unknown>;
const PAGE_SIZE = 100;
const RESPONSE_MAX_BYTES = 512 * 1024;
const SOURCE_MAX_BYTES = 24 * 1024;
const PNU = /^\d{10}[12]\d{8}$/;

export interface FullGisHttpRequest {
    url: string;
    params: Record<string, string | number | boolean>;
    timeout: number;
    maxContentLength: number;
    maxRedirects: 0;
    signal: AbortSignal;
}
export interface FullGisHttpResponse { status: number; data: unknown }
export interface FullGisClientDependencies {
    httpGet?: (request: FullGisHttpRequest) => Promise<FullGisHttpResponse>;
    vworldKey?: string;
    vworldDomain?: string;
    dataPortalKey?: string;
    intervalMs?: number;
    now?: () => number;
}

class SourceError extends Error {
    constructor(readonly code: string, readonly status: 'FAILED' | 'INCOMPLETE' = 'INCOMPLETE') {
        super(code);
    }
}
function object(value: unknown): Row | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function integer(value: unknown): number | null {
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' && value.length <= 300 ? value.trim() : null;
}
function registryIdentifier(value: unknown): string | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? String(value) : text(value);
}
function numeric(value: unknown): number | null {
    if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function present(value: unknown): boolean { return value !== undefined && value !== null && value !== ''; }
function rows(value: unknown): Row[] {
    if (value === undefined || value === null || value === '') return [];
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((value) => object(value) !== null)) throw new SourceError('ROWS_INVALID');
    return values as Row[];
}
function byteLength(value: unknown): number {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized === undefined) throw new SourceError('PROVIDER_RESPONSE_INVALID');
    return Buffer.byteLength(serialized, 'utf8');
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    // socket이 늦게 실패해도 rejection은 항상 소비한다.
    operation.catch(() => undefined);
    if (signal.aborted) return Promise.reject(new SourceError('REQUEST_ABORTED'));
    return new Promise<T>((resolve, reject) => {
        const aborted = () => { cleanup(); reject(new SourceError('REQUEST_ABORTED')); };
        const cleanup = () => signal.removeEventListener('abort', aborted);
        signal.addEventListener('abort', aborted, { once: true });
        operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new SourceError('REQUEST_ABORTED'));
    return new Promise((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(new SourceError('REQUEST_ABORTED')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
        signal.addEventListener('abort', aborted, { once: true });
    });
}

// 전체 조회와 건물 윤곽 client가 VWorld의 같은 호출 간격과 실제 socket 직렬화를 공유한다.
let vworldTail: Promise<void> = Promise.resolve();
let vworldLastStartedAt = 0;
export async function inVworldSlot<T>(operation: () => Promise<T>, interval: number, signal: AbortSignal): Promise<T> {
    const previous = vworldTail;
    let release!: () => void;
    vworldTail = new Promise<void>((resolve) => { release = resolve; });
    let acquired = false;
    let active: Promise<T> | undefined;
    try {
        await abortable(previous, signal);
        acquired = true;
        await delay(Math.max(0, vworldLastStartedAt + interval - Date.now()), signal);
        signal.throwIfAborted();
        vworldLastStartedAt = Date.now();
        active = Promise.resolve().then(operation);
        return await abortable(active, signal);
    } finally {
        if (active) void active.then(release, release);
        else if (acquired) release();
        else void previous.then(release, release);
    }
}

const defaultHttpGet = async (request: FullGisHttpRequest): Promise<FullGisHttpResponse> => {
    const response = await axios.get(request.url, {
        params: request.params, timeout: request.timeout, signal: request.signal,
        maxContentLength: request.maxContentLength, maxRedirects: request.maxRedirects,
        responseType: 'text', transformResponse: [(value) => value], validateStatus: () => true,
    });
    return { status: response.status, data: response.data };
};

const containers: Partial<Record<FullGisSourceId, { container: string; field: string }>> = {
    land_registry: { container: 'ladfrlVOList', field: 'ladfrlVOList' },
    land_share_registry: { container: 'ldaregVOList', field: 'ldaregVOList' },
    // 공식 건물호수조회도 대지권등록부와 동일한 envelope 이름을 사용한다.
    building_ho_land_share: { container: 'ldaregVOList', field: 'ldaregVOList' },
    land_price: { container: 'indvdLandPrices', field: 'field' },
    apart_price: { container: 'apartHousingPrices', field: 'field' },
    indiv_house_price: { container: 'indvdHousingPrices', field: 'field' },
};
function building(id: FullGisSourceId): boolean {
    return id === 'building_title' || id === 'building_units' || id === 'building_floors';
}
interface Page { rows: Row[]; total: number; pageSize: number; pageNo: number }
function parsePage(id: FullGisSourceId, data: Row, requestedPage: number): Page {
    let envelope: Row | null;
    let values: unknown;
    if (building(id)) {
        const response = object(data.response);
        const header = object(response?.header);
        if (!header || String(header.resultCode) !== '00') throw new SourceError('PROVIDER_ERROR', 'FAILED');
        envelope = object(response?.body);
        values = object(envelope?.items)?.item;
        if (present(envelope?.items) && !object(envelope?.items)) throw new SourceError('ROWS_INVALID');
    } else {
        const definition = containers[id]!;
        envelope = object(data[definition.container]);
        values = envelope?.[definition.field];
        if (present(data.error)) throw new SourceError('PROVIDER_ERROR', 'FAILED');
        if (!envelope && id === 'indiv_house_price') {
            // 개별주택 무자료 실응답은 가격 container 대신 명시적인 0건 response를 준다.
            const empty = object(data.response);
            const allowed = new Set(['pageNo', 'resultCode', 'totalCount', 'numOfRows', 'resultMsg', 'error', 'message']);
            const size = integer(empty?.numOfRows);
            if (empty && Object.keys(empty).every((key) => allowed.has(key))
                && integer(empty.totalCount) === 0 && integer(empty.pageNo) === requestedPage
                && size !== null && size > 0 && !present(empty.error) && !present(empty.message)
                && !present(empty.resultMsg) && (!present(empty.resultCode) || String(empty.resultCode) === '00')) {
                return { rows: [], total: 0, pageSize: Math.min(PAGE_SIZE, size), pageNo: requestedPage };
            }
        }
    }
    if (!envelope) throw new SourceError('ENDPOINT_CONTAINER_INVALID');
    if (present(envelope.error)
        || (present(envelope.resultCode) && String(envelope.resultCode) !== '00')) {
        throw new SourceError('PROVIDER_ERROR', 'FAILED');
    }
    const total = integer(envelope.totalCount);
    if (total === null) throw new SourceError('TOTAL_COUNT_INVALID');
    const pageNo = present(envelope.pageNo) ? integer(envelope.pageNo) : requestedPage;
    const declaredSize = present(envelope.numOfRows) ? integer(envelope.numOfRows) : PAGE_SIZE;
    if (pageNo !== requestedPage || !declaredSize) throw new SourceError('PAGINATION_MISMATCH');
    // 건축HUB의 numOfRows 1000 표기에도 실제 요청/응답 상한은 100행이다.
    const pageSize = Math.min(PAGE_SIZE, declaredSize);
    const result = rows(values);
    const expected = Math.min(pageSize, Math.max(0, total - (requestedPage - 1) * pageSize));
    if (result.length !== expected) throw new SourceError('PAGINATION_MISMATCH');
    return { rows: result, total, pageSize, pageNo: requestedPage };
}

function validateRow(id: FullGisSourceId, row: Row, query: FullGisSourceQuery): void {
    if (building(id)) {
        if (!registryIdentifier(row.mgmBldrgstPk)) throw new SourceError('ROWS_INVALID');
        const expected = [query.pnu!.slice(0, 5), query.pnu!.slice(5, 10),
            query.pnu![10] === '2' ? '1' : '0', query.pnu!.slice(11, 15), query.pnu!.slice(15, 19)];
        const keys = ['sigunguCd', 'bjdongCd', 'platGbCd', 'bun', 'ji'];
        for (let i = 0; i < keys.length; i++) {
            const value = row[keys[i]];
            const normalized = typeof value === 'number' || typeof value === 'string'
                ? String(value).padStart(expected[i].length, '0') : null;
            if (normalized !== expected[i]) throw new SourceError('ROW_PNU_MISMATCH');
        }
    } else if (text(row.pnu) !== query.pnu) throw new SourceError('ROW_PNU_MISMATCH');
    if (present(row.pnu) && text(row.pnu) !== query.pnu) throw new SourceError('ROW_PNU_MISMATCH');
    if (id === 'land_price' || id === 'apart_price' || id === 'indiv_house_price') {
        if (String(row.stdrYear) !== String(query.year)) throw new SourceError('ROW_YEAR_MISMATCH');
        const price = numeric(row[id === 'land_price' ? 'pblntfPclnd' : id === 'apart_price' ? 'pblntfPc' : 'housePc']);
        if (price === null || price < 0) throw new SourceError('ROWS_INVALID');
    }
}
function fingerprint(row: Row): string {
    return createHash('sha256').update(JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key]]))).digest('hex');
}

/** endpoint는 고정 manifest에서만 선택하며 DB/인스펙터 원문과 연결하지 않는다. */
export function createFullGisClient(deps: FullGisClientDependencies = {}): FullGisClient {
    const httpGet = deps.httpGet ?? defaultHttpGet;
    const now = deps.now ?? Date.now;
    let configured: { VWORLD_API_KEY: string; VWORLD_API_DOMAIN: string; DATA_PORTAL_API_KEY: string; VWORLD_ATTR_REQUEST_INTERVAL_MS: number } | undefined;
    const config = () => configured ??= (require('../../config/env') as { env: NonNullable<typeof configured> }).env;
    const auth = (id: FullGisSourceId): FullGisHttpRequest['params'] => {
        if (building(id)) {
            const serviceKey = normalizeDataPortalApiKey(deps.dataPortalKey ?? config().DATA_PORTAL_API_KEY);
            if (!serviceKey) throw new SourceError('PROVIDER_NOT_CONFIGURED', 'FAILED');
            return { serviceKey };
        }
        const key = deps.vworldKey ?? config().VWORLD_API_KEY;
        const domain = deps.vworldDomain ?? config().VWORLD_API_DOMAIN;
        if (!key || !domain) throw new SourceError('PROVIDER_NOT_CONFIGURED', 'FAILED');
        return { key, domain };
    };
    const request = async (id: FullGisSourceId, params: FullGisHttpRequest['params'], signal: AbortSignal): Promise<Row> => {
        signal.throwIfAborted();
        const credentials = auth(id);
        const input: FullGisHttpRequest = {
            url: FULL_GIS_SOURCE_META[id].source, params: { ...params, ...credentials },
            signal, timeout: 10_000, maxContentLength: RESPONSE_MAX_BYTES, maxRedirects: 0,
        };
        const operation = () => httpGet(input);
        const response = building(id) ? await abortable(operation(), signal)
            : await inVworldSlot(operation,
                parseVworldRequestIntervalMs(deps.intervalMs ?? config().VWORLD_ATTR_REQUEST_INTERVAL_MS), signal);
        if (response.status !== 200) throw new SourceError('HTTP_ERROR', 'FAILED');
        if (byteLength(response.data) > RESPONSE_MAX_BYTES) throw new SourceError('LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED');
        let data = response.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { throw new SourceError('PROVIDER_RESPONSE_INVALID'); }
        }
        const result = object(data);
        if (!result) throw new SourceError('ENDPOINT_RESPONSE_NON_OBJECT');
        return result;
    };

    const finish = (id: FullGisSourceId, query: FullGisSourceQuery, records: Row[], total: number): FullGisStep => {
        const result = emptyFullGisStep(id, query, total === 0 ? 'NO_DATA' : 'SUCCESS', total === 0 ? 'NO_DATA' : undefined, now);
        const nextOffset = query.offset + records.length;
        result.records = records;
        result.pagination = { offset: query.offset, limit: query.limit, returned: records.length,
            total, hasMore: nextOffset < total, nextOffset: nextOffset < total ? nextOffset : null };
        if (result.pagination.hasMore) result.warnings.push('MORE_RECORDS_AVAILABLE');
        if (id === 'building_floors') result.warnings.push('FLOOR_AREA_IS_NOT_TITLE_TOTAL_AREA', 'BLANK_AREA_EXCLUSION_IS_UNKNOWN');
        if (id === 'building_ho_land_share') result.warnings.push('SEPARATE_PROVIDER_PERMISSION_APPLIES');
        if (byteLength(result) > SOURCE_MAX_BYTES) throw new SourceError('OUTPUT_TOO_LARGE');
        return result;
    };
    const one = (id: FullGisSourceId, query: FullGisSourceQuery, row: Row): FullGisStep =>
        finish(id, query, query.offset === 0 ? [row] : [], 1);

    const lookupSpatial = async (id: FullGisSourceId, query: FullGisSourceQuery, signal: AbortSignal): Promise<FullGisStep> => {
        if (id === 'geocode') {
            if (!query.address) return emptyFullGisStep(id, query, 'SKIPPED', 'ADDRESS_REQUIRED', now);
            let lastFailure: SourceError | undefined;
            for (const type of ['PARCEL', 'ROAD']) {
                try {
                    const data = await request(id, { service: 'address', request: 'getcoord', version: '2.0',
                        format: 'json', address: query.address, type, crs: 'EPSG:4326' }, signal);
                    const response = object(data.response);
                    if (response?.status === 'NOT_FOUND') continue;
                    if (response?.status !== 'OK') throw new SourceError('PROVIDER_ERROR', 'FAILED');
                    const point = object(object(response.result)?.point);
                    const longitude = numeric(point?.x);
                    const latitude = numeric(point?.y);
                    if (longitude === null || latitude === null || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
                        throw new SourceError('PROVIDER_RESPONSE_INVALID');
                    }
                    const result = one(id, query, { longitude, latitude, crs: 'EPSG:4326' });
                    if (type === 'ROAD') result.warnings.push('GEOCODE_ROAD_FALLBACK_USED');
                    return result;
                } catch (error) {
                    if (signal.aborted) throw error;
                    if (!(error instanceof SourceError)) throw error;
                    lastFailure = error;
                }
            }
            if (lastFailure) throw lastFailure;
            return finish(id, query, [], 0);
        }
        if (id === 'coord_to_pnu' || id === 'reverse_geocode') {
            if (!query.coordinates) return emptyFullGisStep(id, query, 'SKIPPED', 'COORDINATES_UNAVAILABLE', now);
            const { longitude, latitude } = query.coordinates;
            if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
                throw new SourceError('COORDINATES_INVALID');
            }
            const data = await request(id, id === 'coord_to_pnu'
                ? { service: 'data', request: 'GetFeature', version: '2.0', data: 'LP_PA_CBND_BUBUN', format: 'json',
                    geomFilter: `POINT(${longitude} ${latitude})`, geometry: false, attribute: true, size: 1, page: 1, crs: 'EPSG:4326' }
                : { service: 'address', request: 'getAddress', version: '2.0', format: 'json',
                    point: `${longitude},${latitude}`, type: 'ROAD', crs: 'EPSG:4326' }, signal);
            const response = object(data.response);
            if (response?.status === 'NOT_FOUND') return finish(id, query, [], 0);
            if (response?.status !== 'OK') throw new SourceError('PROVIDER_ERROR', 'FAILED');
            if (id === 'coord_to_pnu') {
                const features = rows(object(object(response.result)?.featureCollection)?.features);
                if (features.length !== 1) throw new SourceError('PROVIDER_RESPONSE_INVALID');
                const pnu = text(object(features[0].properties)?.pnu);
                if (!pnu || !PNU.test(pnu)) throw new SourceError('PNU_RESOLUTION_INCOMPLETE');
                return one(id, query, { pnu });
            }
            const addresses = rows(response.result);
            const values = addresses.map((row) => ({
                type: text(row.type), address: text(row.text), zipcode: text(row.zipcode),
            }));
            if (values.length === 0 || values.some((value) => value.address === null)) throw new SourceError('PROVIDER_RESPONSE_INVALID');
            return finish(id, query, values.slice(query.offset, query.offset + query.limit), values.length);
        }
        if (!query.pnu) return emptyFullGisStep(id, query, 'SKIPPED', 'PNU_RESOLUTION_INCOMPLETE', now);
        const wfs = id === 'boundary_vworld_wfs';
        const data = await request(id, wfs
            ? { typename: 'dt_d002', pnu: query.pnu, maxFeatures: 1, resultType: 'results', srsName: 'EPSG:4326', output: 'application/json' }
            : { service: 'data', request: 'GetFeature', version: '2.0', data: 'LP_PA_CBND_BUBUN', format: 'json',
                attrFilter: `pnu:=:${query.pnu}`, geometry: true, attribute: true, size: 1, page: 1, crs: 'EPSG:4326' }, signal);
        const response = object(data.response);
        if (!wfs && response?.status === 'NOT_FOUND') return finish(id, query, [], 0);
        if ((!wfs && response?.status !== 'OK') || present(data.error)) throw new SourceError('PROVIDER_ERROR', 'FAILED');
        const collection = wfs ? data : object(object(response?.result)?.featureCollection);
        if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new SourceError('PROVIDER_RESPONSE_INVALID');
        const features = rows(collection.features);
        if (features.length === 0 && (integer(collection.totalFeatures) === 0 || integer(collection.numberMatched) === 0)) {
            return finish(id, query, [], 0);
        }
        if (features.length !== 1) throw new SourceError('PROVIDER_RESPONSE_INVALID');
        if (text(object(features[0].properties)?.pnu) !== query.pnu) throw new SourceError('ROW_PNU_MISMATCH');
        const geometry = projectFullGisGeometry(features[0].geometry);
        if (!geometry) throw new SourceError('GEOMETRY_INVALID');
        return one(id, query, { pnu: query.pnu, geometry });
    };

    return {
        async lookup(id, query, signal) {
            try {
                signal.throwIfAborted();
                if (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > 1_000_000
                    || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 20
                    || (query.pnu !== undefined && !PNU.test(query.pnu))) throw new SourceError('INPUT_INVALID');
                if (!containers[id] && !building(id)) return await lookupSpatial(id, query, signal);
                if (!query.pnu) return emptyFullGisStep(id, query, 'SKIPPED', 'PNU_RESOLUTION_INCOMPLETE', now);
                const pnu = query.pnu;
                const baseParams: FullGisHttpRequest['params'] = building(id)
                    ? { sigunguCd: pnu.slice(0, 5), bjdongCd: pnu.slice(5, 10), platGbCd: pnu[10] === '2' ? '1' : '0',
                        bun: pnu.slice(11, 15), ji: pnu.slice(15, 19), _type: 'json' }
                    : { pnu, format: 'json',
                        ...((id === 'land_price' || id === 'apart_price' || id === 'indiv_house_price') ? { stdrYear: query.year } : {}),
                        ...(id === 'building_ho_land_share' && query.buildingHo ? { buldHoNm: query.buildingHo } : {}) };
                const getPage = async (pageNo: number) => parsePage(id,
                    await request(id, { ...baseParams, numOfRows: PAGE_SIZE, pageNo }, signal), pageNo);
                const first = await getPage(1);
                for (const row of first.rows) validateRow(id, row, query);
                if (first.total === 0) return finish(id, query, [], 0);
                if (query.offset >= first.total) return finish(id, query, [], first.total);
                const firstPage = Math.floor(query.offset / first.pageSize) + 1;
                const lastPage = Math.floor((Math.min(first.total, query.offset + query.limit) - 1) / first.pageSize) + 1;
                // 매우 작은 provider page에도 무제한 추가 호출은 하지 않는다.
                if (lastPage - firstPage + 1 > 3) throw new SourceError('PAGE_LIMIT_EXCEEDED');
                const seen = new Set(first.rows.map(fingerprint));
                const pageSignatures = new Set([JSON.stringify(first.rows.map(fingerprint).sort())]);
                let hasDuplicates = seen.size !== first.rows.length;
                const collected: Row[] = [];
                for (let pageNo = firstPage; pageNo <= lastPage; pageNo++) {
                    const page = pageNo === 1 ? first : await getPage(pageNo);
                    if (page.total !== first.total || page.pageSize !== first.pageSize) throw new SourceError('PAGINATION_MISMATCH');
                    if (pageNo !== 1) {
                        const signature = JSON.stringify(page.rows.map(fingerprint).sort());
                        if (pageSignatures.has(signature)) throw new SourceError('PAGE_REPEATED');
                        pageSignatures.add(signature);
                        for (const row of page.rows) {
                            validateRow(id, row, query);
                            const signature = fingerprint(row);
                            if (seen.has(signature)) hasDuplicates = true;
                            seen.add(signature);
                        }
                    }
                    const start = (pageNo - 1) * first.pageSize;
                    collected.push(...page.rows.slice(Math.max(0, query.offset - start),
                        Math.min(page.rows.length, query.offset + query.limit - start)));
                }
                const result = finish(id, query, collected.map((row) => projectFullGisRecord(id, row)), first.total);
                // 공급자가 중복 행을 totalCount에 포함한 경우 임의 삭제/합산하지 않는다.
                if (hasDuplicates) result.warnings.push('DUPLICATE_SOURCE_ROWS');
                return result;
            } catch (error) {
                if (signal.aborted) return emptyFullGisStep(id, query, 'INCOMPLETE', 'REQUEST_ABORTED', now);
                if (error instanceof SourceError) return emptyFullGisStep(id, query, error.status, error.code, now);
                if (error instanceof FullGisProjectionError) return emptyFullGisStep(id, query, 'INCOMPLETE', 'ROWS_INVALID', now);
                // 키와 provider error body/message/stack은 이 경계 밖으로 내보내지 않는다.
                return emptyFullGisStep(id, query, 'FAILED', 'PROVIDER_REQUEST_FAILED', now);
            }
        },
    };
}

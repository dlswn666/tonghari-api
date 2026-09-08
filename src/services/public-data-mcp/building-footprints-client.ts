import axios from 'axios';
import { parseVworldRequestIntervalMs } from '../../utils/vworld-request-interval';
import { inVworldSlot, type FullGisHttpRequest, type FullGisHttpResponse } from './full-lookup-client';
import {
    BUILDING_FOOTPRINTS_LAYER, BUILDING_FOOTPRINTS_PROPERTY_KEYS, BUILDING_FOOTPRINTS_SOURCE,
    BuildingFootprintFeatureSchema, LookupBuildingFootprintsInputV1Schema,
    type BuildingFootprintsClient, type BuildingFootprintsPage, type LookupBuildingFootprintsInputV1,
} from './building-footprints-contract';
import type { PublicDataMcpSafeCode } from './policy';

type Row = Record<string, unknown>;
const MAX_RESPONSE_BYTES = 512 * 1024;
export class BuildingFootprintsError extends Error {
    constructor(readonly code: PublicDataMcpSafeCode, readonly status: 'FAILED' | 'INCOMPLETE' = 'INCOMPLETE') {
        super(code);
    }
}
export interface BuildingFootprintsClientDependencies {
    httpGet?: (request: FullGisHttpRequest) => Promise<FullGisHttpResponse>;
    vworldKey?: string;
    vworldDomain?: string;
    intervalMs?: number;
}
const object = (value: unknown): Row | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
function integer(value: unknown): number | null {
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
const invalid = (): never => { throw new BuildingFootprintsError('PROVIDER_RESPONSE_INVALID'); };
const mismatch = (): never => { throw new BuildingFootprintsError('PAGINATION_MISMATCH'); };
function parsePage(data: unknown, input: LookupBuildingFootprintsInputV1): BuildingFootprintsPage {
    const response = object(object(data)?.response);
    if (!response) return invalid();
    if (response.status === 'ERROR' || response.error != null) throw new BuildingFootprintsError('PROVIDER_ERROR', 'FAILED');
    const record = object(response.record);
    const page = object(response.page);
    const collection = object(object(response.result)?.featureCollection);
    // 첫 페이지의 명시적 무자료만 0건으로 확정한다. 후속 페이지의 NOT_FOUND는 전체 0건을 뜻하지 않는다.
    if (response.status === 'NOT_FOUND') {
        if (input.page !== 1 || (response.record !== undefined && (!record || integer(record.total) !== 0 || integer(record.current) !== 0))
            || (response.page !== undefined && (!page || integer(page.current) !== 1 || integer(page.total) !== 0
                || integer(page.size) !== input.limit))
            || (response.result !== undefined && (!collection || collection.type !== 'FeatureCollection'
                || !Array.isArray(collection.features) || collection.features.length !== 0))) return mismatch();
        return { features: [], total: 0 };
    }
    if (response.status !== 'OK') return invalid();
    const total = integer(record?.total);
    if (total === null || total === 0 || !page || !collection || collection.type !== 'FeatureCollection'
        || !Array.isArray(collection.features)) return invalid();
    const expected = Math.min(input.limit, Math.max(0, total - (input.page - 1) * input.limit));
    if (integer(page.current) !== input.page || integer(page.size) !== input.limit
        || integer(page.total) !== Math.ceil(total / input.limit)
        || integer(record?.current) !== expected || collection.features.length !== expected || expected === 0) return mismatch();
    const declaredCrs = collection.crs;
    if (declaredCrs !== undefined) {
        const crs = object(declaredCrs); const name = object(crs?.properties)?.name;
        if (crs?.type !== 'name' || !['EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'urn:ogc:def:crs:OGC:1.3:CRS84'].includes(String(name))) return invalid();
    }
    const ids = new Set<string>();
    const features = collection.features.map((value) => {
        const feature = object(value); const originalProperties = object(feature?.properties);
        const originalGeometry = object(feature?.geometry);
        if (!feature || !originalProperties || !originalGeometry) return invalid();
        const properties: Row = {};
        for (const key of BUILDING_FOOTPRINTS_PROPERTY_KEYS) {
            if (Object.hasOwn(originalProperties, key)) properties[key] = originalProperties[key];
        }
        const parsed = BuildingFootprintFeatureSchema.safeParse({
            type: feature.type, id: feature.id, properties,
            geometry: { type: originalGeometry.type, coordinates: originalGeometry.coordinates },
        });
        if (!parsed.success) return invalid();
        if (ids.has(parsed.data.id)) throw new BuildingFootprintsError('PAGE_RECORD_OVERLAP');
        ids.add(parsed.data.id);
        // 완전히 다른 지역 응답을 성공으로 넘기지 않는다. 경계에 걸친 실제 건물 도형은 보존한다.
        const polygons = parsed.data.geometry.type === 'Polygon' ? [parsed.data.geometry.coordinates] : parsed.data.geometry.coordinates;
        let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
        for (const rings of polygons) for (const ring of rings) for (const [x, y] of ring) {
            west = Math.min(west, x); south = Math.min(south, y); east = Math.max(east, x); north = Math.max(north, y);
        }
        if (east < input.bbox[0] || west > input.bbox[2] || north < input.bbox[1] || south > input.bbox[3]) return invalid();
        return parsed.data;
    });
    return { features, total };
}

/** 고정 레이어 읽기 전용 조회. 내부 DB나 임의 URL/필터를 입력받지 않는다. */
export function createBuildingFootprintsClient(deps: BuildingFootprintsClientDependencies = {}): BuildingFootprintsClient {
    const httpGet = deps.httpGet ?? (async (request: FullGisHttpRequest): Promise<FullGisHttpResponse> => {
        const response = await axios.get(request.url, {
            params: request.params, timeout: request.timeout, signal: request.signal,
            maxContentLength: request.maxContentLength, maxRedirects: 0,
            responseType: 'text', transformResponse: [(value) => value], validateStatus: () => true,
        });
        return { status: response.status, data: response.data };
    });
    let configured: { VWORLD_API_KEY: string; VWORLD_API_DOMAIN: string; VWORLD_ATTR_REQUEST_INTERVAL_MS: number } | undefined;
    const config = () => configured ??= (require('../../config/env') as { env: NonNullable<typeof configured> }).env;
    return {
        async lookup(candidate, signal) {
            try {
                const validated = LookupBuildingFootprintsInputV1Schema.safeParse(candidate);
                if (!validated.success) throw new BuildingFootprintsError('PROVIDER_RESPONSE_INVALID', 'FAILED');
                const input = validated.data;
                if (signal.aborted) throw new BuildingFootprintsError('REQUEST_ABORTED');
                const key = deps.vworldKey ?? config().VWORLD_API_KEY;
                const domain = deps.vworldDomain ?? config().VWORLD_API_DOMAIN;
                if (!key || !domain) throw new BuildingFootprintsError('PROVIDER_NOT_CONFIGURED', 'FAILED');
                const request: FullGisHttpRequest = {
                    url: BUILDING_FOOTPRINTS_SOURCE,
                    params: { key, domain, service: 'data', version: '2.0', request: 'GetFeature',
                        data: BUILDING_FOOTPRINTS_LAYER, geomFilter: `BOX(${input.bbox.join(',')})`,
                        crs: 'EPSG:4326', format: 'json', errorFormat: 'json', geometry: true, attribute: true,
                        columns: BUILDING_FOOTPRINTS_PROPERTY_KEYS.join(','), buffer: 0, page: input.page, size: input.limit },
                    signal, timeout: 10_000, maxContentLength: MAX_RESPONSE_BYTES, maxRedirects: 0,
                };
                const response = await inVworldSlot(() => httpGet(request),
                    parseVworldRequestIntervalMs(deps.intervalMs ?? config().VWORLD_ATTR_REQUEST_INTERVAL_MS), signal);
                if (response.status !== 200) throw new BuildingFootprintsError('HTTP_ERROR', 'FAILED');
                let data = response.data;
                const serialized = typeof data === 'string' ? data : JSON.stringify(data);
                if (serialized === undefined) return invalid();
                if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) throw new BuildingFootprintsError('LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED');
                if (typeof data === 'string') {
                    try { data = JSON.parse(data); } catch { return invalid(); }
                }
                return parsePage(data, input);
            } catch (error) {
                if (signal.aborted) throw new BuildingFootprintsError('REQUEST_ABORTED');
                if (error instanceof BuildingFootprintsError) throw error;
                if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') throw new BuildingFootprintsError('PROVIDER_TIMEOUT');
                throw new BuildingFootprintsError('PROVIDER_REQUEST_FAILED', 'FAILED');
            }
        },
    };
}

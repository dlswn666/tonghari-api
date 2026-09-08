import assert from 'node:assert/strict';
import test from 'node:test';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import {
    BUILDING_FOOTPRINTS_LAYER, BUILDING_FOOTPRINTS_PROPERTY_KEYS, BUILDING_FOOTPRINTS_SOURCE,
    BuildingFootprintGeometrySchema, LookupBuildingFootprintsInputV1Schema,
    type BuildingFootprintFeature, type LookupBuildingFootprintsInputV1,
} from '../src/services/public-data-mcp/building-footprints-contract';
import { createBuildingFootprintsClient } from '../src/services/public-data-mcp/building-footprints-client';
import { createBuildingFootprintsProvider } from '../src/services/public-data-mcp/building-footprints-provider';
import { createFullGisClient, type FullGisHttpRequest, type FullGisHttpResponse } from '../src/services/public-data-mcp/full-lookup-client';
import { createPublicDataMcpProviderV1 } from '../src/services/public-data-mcp/provider';
import { PublicDataMcpResultV1Schema } from '../src/services/public-data-mcp/policy';
import { createPublicDataMcpServer } from '../src/services/public-data-mcp/server';

const input = LookupBuildingFootprintsInputV1Schema.parse({ bbox: [127.0523, 37.6613, 127.0584, 37.6645] });
const signal = new AbortController().signal;
const ring = [[127.053, 37.662], [127.054, 37.662], [127.054, 37.663], [127.053, 37.662]];
const feature = (id = 'LT_C_BLDGINFO.1001') => ({ type: 'Feature', id,
    properties: { dong_nm: '1001동', bld_nm: '상계주공10단지', grnd_flr: '15', ugrnd_flr: 1,
        archarea: '321.70', useapr_day: '19880916', ownerName: 'owner-canary', pnu: 'fake-canary',
        mgmBldrgstPk: 'wrong-key-canary', apiKey: 'key-canary' },
    geometry: { type: 'MultiPolygon', coordinates: [[ring]], ownerName: 'geometry-canary' } });
const envelope = (features = [feature()], total = features.length, page = 1, size = 20) => ({ response: {
    status: 'OK', record: { total: String(total), current: String(features.length) },
    page: { total: String(Math.ceil(total / size)), current: String(page), size: String(size) },
    result: { featureCollection: { type: 'FeatureCollection', features,
        crs: { type: 'name', properties: { name: 'EPSG:4326' } } } },
} });
function client(httpGet: (request: FullGisHttpRequest) => Promise<FullGisHttpResponse> | FullGisHttpResponse) {
    return createBuildingFootprintsClient({ httpGet: async (request) => httpGet(request),
        vworldKey: 'secret-canary', vworldDomain: 'www.tonghari.kr', intervalMs: 0 });
}
const provider = (data: unknown, query = input) => createBuildingFootprintsProvider({
    client: client(() => ({ status: 200, data })), now: () => Date.parse('2026-09-08T00:00:00Z'),
}).execute(query, { signal });

test('동별 윤곽 입력은 숫자 BBOX·page·limit만 받으며 지역 범위와 기본값을 제한한다', () => {
    assert.equal(input.page, 1); assert.equal(input.limit, 20);
    for (const candidate of [
        { ...input, bbox: [127, 37, 128, 38] }, { ...input, bbox: [127, 37, 127.05, 37.05] },
        { ...input, bbox: [127, 37, 127, 37.001] }, { ...input, bbox: [127.1, 37, 127, 37.001] },
        { ...input, bbox: [127, 37, 127.051, 37.000001] },
        { ...input, bbox: ['127', 37, 127.001, 37.001] }, { ...input, bbox: [127, 37, 127.001] },
        { ...input, bbox: [127, 90, 127.001, 90.001] }, { ...input, bbox: [127, 37, Infinity, 38] },
        { ...input, page: 0 }, { ...input, page: 10_001 }, { ...input, page: 1.2 },
        { ...input, limit: 101 }, { ...input, limit: 0 },
        { ...input, endpoint: 'https://attacker.test' }, { ...input, data: 'OTHER_LAYER' },
        { ...input, pnu: '1135010500106660000' }, { ...input, attrFilter: 'x:=:y' },
    ]) assert.equal(LookupBuildingFootprintsInputV1Schema.safeParse(candidate).success, false, JSON.stringify(candidate));
});

test('고정 공식 API와 실제 필드만 조회하고 도형·원값·출처를 보존한다', async () => {
    let requested: FullGisHttpRequest | undefined;
    const result = await createBuildingFootprintsProvider({
        client: client((request) => { requested = request; return { status: 200, data: JSON.stringify(envelope()) }; }),
        now: () => Date.parse('2026-09-08T00:00:00Z'),
    }).execute(input, { signal });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(PublicDataMcpResultV1Schema.safeParse(result).success, true);
    assert.equal(requested!.url, BUILDING_FOOTPRINTS_SOURCE);
    assert.equal(requested!.params.data, BUILDING_FOOTPRINTS_LAYER);
    assert.equal(requested!.params.geomFilter, 'BOX(127.0523,37.6613,127.0584,37.6645)');
    assert.equal(requested!.params.columns, BUILDING_FOOTPRINTS_PROPERTY_KEYS.join(','));
    assert.equal(requested!.params.crs, 'EPSG:4326'); assert.equal(requested!.params.size, 20);
    assert.equal(requested!.params.page, 1); assert.equal(requested!.maxRedirects, 0);
    assert.equal(requested!.maxContentLength, 512 * 1024); assert.equal(requested!.timeout, 10_000);
    const output = (result.data.features as BuildingFootprintFeature[])[0];
    assert.deepEqual(output.geometry, { type: 'MultiPolygon', coordinates: [[ring]] });
    assert.equal(output.properties.grnd_flr, '15'); assert.equal(output.properties.archarea, '321.70');
    assert.equal(output.id, 'LT_C_BLDGINFO.1001');
    assert.equal(JSON.stringify(result).includes('canary'), false);
    assert.equal(result.asOf, '2026-09-08T00:00:00.000Z'); assert.ok(result.attribution);
    assert.deepEqual(result.pagination, { offset: 0, limit: 20, returned: 1, total: 1, hasMore: false });
});

test('페이지 응답은 마지막 페이지까지 정확한 건수와 hasMore를 보존한다', async () => {
    const first = await provider(envelope([feature('one'), feature('two')], 3, 1, 2), { ...input, limit: 2 });
    assert.equal(first.status, 'SUCCESS'); assert.equal(first.pagination!.hasMore, true);
    assert.ok(first.warnings.includes('MORE_RECORDS_AVAILABLE'));
    const second = await provider(envelope([feature('three')], 3, 2, 2), { ...input, page: 2, limit: 2 });
    assert.deepEqual(second.pagination, { offset: 2, limit: 2, returned: 1, total: 3, hasMore: false });
});

test('NOT_FOUND는 첫 페이지의 명시적 무자료만 허용하고 모순이나 후속 무자료를 숨기지 않는다', async () => {
    const empty = await provider({ response: { status: 'NOT_FOUND' } });
    assert.equal(empty.status, 'NO_DATA'); assert.equal(empty.pagination!.total, 0);
    assert.equal(PublicDataMcpResultV1Schema.safeParse(empty).success, true);
    const explicit = await provider({ response: { status: 'NOT_FOUND', record: { total: '0', current: '0' },
        page: { total: '0', current: '1', size: '20' },
        result: { featureCollection: { type: 'FeatureCollection', features: [] } } } });
    assert.equal(explicit.status, 'NO_DATA');
    for (const data of [
        { response: { status: 'NOT_FOUND', record: { total: '1', current: '0' } } },
        { response: { ...envelope().response, status: 'NOT_FOUND' } },
        { response: { status: 'NOT_FOUND', result: {} } },
        { response: { status: 'OK', record: { total: '0', current: '0' } } },
    ]) assert.equal((await provider(data)).status, 'INCOMPLETE');
    assert.equal((await provider({ response: { status: 'NOT_FOUND' } }, { ...input, page: 2 })).status, 'INCOMPLETE');
});

test('누락·모순된 페이지 및 중복 원천 ID는 실패로 닫는다', async () => {
    for (const modify of [
        (data: ReturnType<typeof envelope>) => { data.response.page.current = '2'; },
        (data: ReturnType<typeof envelope>) => { data.response.page.total = '2'; },
        (data: ReturnType<typeof envelope>) => { data.response.page.size = '10'; },
        (data: ReturnType<typeof envelope>) => { data.response.record.current = '0'; },
        (data: ReturnType<typeof envelope>) => { data.response.record.total = '2'; },
        (data: ReturnType<typeof envelope>) => { data.response.record.total = '-1'; },
        (data: ReturnType<typeof envelope>) => { data.response.result.featureCollection.features = []; },
    ]) {
        const data = envelope(); modify(data);
        const result = await provider(data);
        assert.equal(result.status, 'INCOMPLETE'); assert.deepEqual(result.data, {});
    }
    const duplicate = await provider(envelope([feature(), feature()]));
    assert.equal(duplicate.code, 'PAGE_RECORD_OVERLAP'); assert.deepEqual(duplicate.data, {});
});

test('도형은 Polygon/MultiPolygon의 정확한 2차원 닫힌 비퇴화 링만 허용한다', () => {
    assert.equal(BuildingFootprintGeometrySchema.safeParse({ type: 'Polygon', coordinates: [ring] }).success, true);
    for (const geometry of [
        { type: 'Point', coordinates: ring[0] }, { type: 'Polygon', coordinates: [] },
        { type: 'Polygon', coordinates: [ring.slice(0, 3)] },
        { type: 'Polygon', coordinates: [[...ring.slice(0, 3), [127.06, 37.666]]] },
        { type: 'Polygon', coordinates: [ring.map((point) => [...point, 0])] },
        { type: 'Polygon', coordinates: [ring.map(() => [127, 37])] },
        { type: 'Polygon', coordinates: [ring.map(([x]) => [x, 91])] },
        { type: 'Polygon', coordinates: [ring.map(([x]) => [x, Infinity])] },
        { type: 'MultiPolygon', coordinates: Array.from({ length: 251 }, () => [ring]) },
        { type: 'Polygon', coordinates: [ring], raw: 'canary' },
    ]) assert.equal(BuildingFootprintGeometrySchema.safeParse(geometry).success, false);
});

test('잘못된 도형·지역·CRS·속성·ID가 한 건이라도 있으면 부분 성공하지 않는다', async () => {
    for (const modify of [
        (data: ReturnType<typeof envelope>) => { data.response.result.featureCollection.crs.properties.name = 'EPSG:3857'; },
        (data: ReturnType<typeof envelope>) => { data.response.result.featureCollection.features[0].id = ''; },
        (data: ReturnType<typeof envelope>) => { data.response.result.featureCollection.features[0].id = 'key=canary'; },
        (data: ReturnType<typeof envelope>) => { data.response.result.featureCollection.features[0].properties.dong_nm = 'x'.repeat(301); },
        (data: ReturnType<typeof envelope>) => { data.response.result.featureCollection.features[0].geometry.coordinates = []; },
        (data: ReturnType<typeof envelope>) => { data.response.result.featureCollection.features[0].geometry.coordinates = [[ring.map(([x, y]) => [x - 1, y])]]; },
    ]) {
        const data = envelope(); modify(data);
        const result = await provider(data);
        assert.equal(result.status, 'INCOMPLETE'); assert.deepEqual(result.data, {});
        assert.equal(JSON.stringify(result).includes('canary'), false);
    }
});

test('공급자 오류·예외·HTTP 오류·잘못된 JSON·512KB 응답은 비밀 없이 구분한다', async () => {
    for (const [data, status] of [[{ response: { status: 'ERROR', error: { text: 'secret-canary' } } }, 'FAILED'],
        ['<error>secret-canary</error>', 'INCOMPLETE'], [{}, 'INCOMPLETE'],
        ['x'.repeat(513 * 1024), 'INCOMPLETE']] as const) {
        const result = await provider(data); assert.equal(result.status, status);
        assert.equal(JSON.stringify(result).includes('canary'), false);
    }
    for (const httpGet of [async () => ({ status: 500, data: 'secret-canary' }),
        async (): Promise<FullGisHttpResponse> => { throw new Error('secret-canary'); }]) {
        const result = await createBuildingFootprintsProvider({ client: client(httpGet) }).execute(input, { signal });
        assert.equal(result.status, 'FAILED'); assert.equal(JSON.stringify(result).includes('canary'), false);
    }
});

test('입력·자격증명 누락·취소는 HTTP 요청 전에 차단한다', async () => {
    let calls = 0;
    const httpGet = async () => { calls++; return { status: 200, data: envelope() }; };
    await assert.rejects(client(httpGet).lookup({ ...input, limit: 101 }, signal), /PROVIDER_RESPONSE_INVALID/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client(httpGet).lookup(input, controller.signal), /REQUEST_ABORTED/);
    await assert.rejects(createBuildingFootprintsClient({ httpGet, vworldKey: '', vworldDomain: '', intervalMs: 0 })
        .lookup(input, signal), /PROVIDER_NOT_CONFIGURED/);
    assert.equal(calls, 0);
});

test('출력 128KB 초과는 도형을 단순화하거나 일부만 반환하지 않는다', async () => {
    const many = Array.from({ length: 100 }, (_, i) => {
        const row = feature(`feature.${i}`);
        row.geometry.coordinates = [[Array.from({ length: 60 }, (_, j) => {
            const angle = j / 59 * Math.PI * 2;
            return j === 59 ? [127.0531, 37.662] : [127.053 + Math.cos(angle) * 0.0001, 37.662 + Math.sin(angle) * 0.0001];
        })]];
        return row;
    });
    const result = await provider(envelope(many, 100, 1, 100), { ...input, limit: 100 });
    assert.equal(result.code, 'OUTPUT_TOO_LARGE'); assert.equal(result.status, 'INCOMPLETE'); assert.deepEqual(result.data, {});
});

test('전체 조회와 윤곽 조회는 같은 VWorld socket 직렬화 슬롯을 공유한다', async () => {
    let release!: (response: FullGisHttpResponse) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const first = client(async () => { started(); return new Promise((resolve) => { release = resolve; }); }).lookup(input, signal);
    await firstStarted;
    let secondCalled = false;
    const second = createFullGisClient({ vworldKey: 'canary', vworldDomain: 'www.tonghari.kr', intervalMs: 0,
        dataPortalKey: '', httpGet: async () => { secondCalled = true; return { status: 200, data: { response: { status: 'NOT_FOUND' } } }; },
    }).lookup('geocode', { address: '서울특별시 노원구 상계동 666', offset: 0, limit: 1 }, signal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondCalled, false);
    release({ status: 200, data: envelope() }); await first; await second;
    assert.equal(secondCalled, true);
});

test('동별 윤곽은 기존 provider에 주입 가능하고 내부 GIS·NED writer를 호출하지 않는다', async () => {
    const prohibited = async (): Promise<never> => { throw new Error('UNEXPECTED_CALL'); };
    const lookup = createPublicDataMcpProviderV1({
        gis: { getPNUFromAddress: prohibited, getParcelBoundary: prohibited, getLandRegistryInfo: prohibited,
            getOfficialLandPriceRecord: prohibited, getBuildingDongs: prohibited,
            getApartmentHousePrices: prohibited, getIndividualHousingPrice: prohibited },
        landRight: { fetchLdareg: prohibited, fetchLadfrl: prohibited },
        vworldAuth: { key: 'canary', domain: 'www.tonghari.kr' }, buildingFootprints: client(() => ({ status: 200, data: envelope() })),
    });
    const result = await lookup.execute('lookup_building_footprints_v1', input, { signal });
    assert.equal(result.status, 'SUCCESS');
});

test('신규 도구도 gis:read 인증과 output schema를 우회할 수 없다', async () => {
    const valid = await provider(envelope());
    type Registered = { _registeredTools: Record<string, {
        handler(input: LookupBuildingFootprintsInputV1, context: ServerContext): Promise<CallToolResult>;
    }> };
    const context = (authorized: boolean) => ({ http: { authInfo: {
        token: 'canary', clientId: 'test', scopes: authorized ? ['gis:read'] : [], extra: { tokenId: 'a'.repeat(64) },
    } }, mcpReq: { signal } }) as ServerContext;
    let calls = 0;
    const server = createPublicDataMcpServer({ execute: async () => { calls++; return valid; } }) as unknown as Registered;
    const denied = await server._registeredTools.lookup_building_footprints_v1.handler(input, context(false));
    assert.equal(denied.structuredContent!.code, 'INSUFFICIENT_SCOPE'); assert.equal(calls, 0);
    const allowed = await server._registeredTools.lookup_building_footprints_v1.handler(input, context(true));
    assert.equal(allowed.structuredContent!.status, 'SUCCESS'); assert.equal(calls, 1);
    for (const candidate of [{ ...valid, data: {} }, { ...valid, pagination: undefined },
        { ...valid, pagination: { ...valid.pagination, total: 2 } },
        { ...valid, data: { ...valid.data, pnu: 'not-in-this-layer' } }]) {
        assert.equal(PublicDataMcpResultV1Schema.safeParse(candidate).success, false);
    }
});

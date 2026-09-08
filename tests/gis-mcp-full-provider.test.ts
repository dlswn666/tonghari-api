import assert from 'node:assert/strict';
import test from 'node:test';
import {
    FULL_GIS_SOURCE_IDS,
    FullGisDataSchema,
    LookupFullGisPublicDataInputV1Schema,
    emptyFullGisStep,
    type FullGisClient,
    type FullGisSourceId,
    type FullGisSourceQuery,
    type FullGisStep,
} from '../src/services/public-data-mcp/full-lookup-contract';
import { createFullGisLookupProvider } from '../src/services/public-data-mcp/full-lookup-provider';
import { PUBLIC_DATA_MCP_MAX_OUTPUT_BYTES } from '../src/services/public-data-mcp/policy';

const PNU = '1130510100107490004';
const OTHER_PNU = '1114010300100310000';
const NOW = () => Date.parse('2026-09-06T00:00:00.000Z');
const ADDRESS = '서울특별시 강북구 미아동 749-4';

function sourceRecords(id: FullGisSourceId): Record<string, unknown>[] {
    if (id === 'geocode') return [{ longitude: 127.01, latitude: 37.61, crs: 'EPSG:4326' }];
    if (id === 'coord_to_pnu') return [{ pnu: PNU }];
    if (id === 'reverse_geocode') return [{ address: ADDRESS }];
    return [{ pnu: PNU, area: 123.4 }];
}

function success(id: FullGisSourceId, query: FullGisSourceQuery, options: {
    total?: number;
    records?: Record<string, unknown>[];
} = {}): FullGisStep {
    const total = options.total ?? 1;
    const records = options.records ?? (query.offset < total ? sourceRecords(id) : []);
    const hasMore = query.offset + records.length < total;
    return {
        ...emptyFullGisStep(id, query, 'SUCCESS', undefined, NOW),
        records,
        pagination: { offset: query.offset, limit: query.limit, returned: records.length,
            total, hasMore, nextOffset: hasMore ? query.offset + records.length : null },
    };
}

function fixture(handler?: (
    id: FullGisSourceId, query: FullGisSourceQuery, signal: AbortSignal,
) => FullGisStep | Promise<FullGisStep>) {
    const calls: { id: FullGisSourceId; query: FullGisSourceQuery; signal: AbortSignal }[] = [];
    const client: FullGisClient = {
        async lookup(id, query, signal) {
            calls.push({ id, query, signal });
            return handler ? handler(id, query, signal) : success(id, query);
        },
    };
    return { calls, provider: createFullGisLookupProvider({ client, now: NOW }) };
}

function input(values: Record<string, unknown> = {}) {
    return LookupFullGisPublicDataInputV1Schema.parse({ address: ADDRESS, ...values });
}

test('전체 조회는 14 source를 정해진 순서로 반환하고 좌표/PNU 의존성을 전달한다', async () => {
    const { calls, provider } = fixture();
    const signal = new AbortController().signal;
    const result = await provider.execute(input(), { signal });
    const data = FullGisDataSchema.parse(result.data);

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.code, undefined);
    assert.deepEqual(calls.map((call) => call.id), FULL_GIS_SOURCE_IDS);
    assert.deepEqual(data.steps.map((step) => step.id), FULL_GIS_SOURCE_IDS);
    assert.equal(data.pnu, PNU);
    assert.equal(data.allSourcesQueried, true);
    assert.equal(data.allRecordsReturned, true);
    assert.equal(data.hasMore, false);
    assert.deepEqual(calls[1].query.coordinates, { longitude: 127.01, latitude: 37.61 });
    assert.deepEqual(calls[2].query.coordinates, calls[1].query.coordinates);
    for (const call of calls.slice(3)) {
        assert.equal(call.query.pnu, PNU);
        assert.equal(call.query.year, 2026);
        assert.equal(call.signal, signal);
    }
});

test('전체 조회는 저장 금지 경고만 제거하고 출처·기준일·권리·가격 경고를 보존한다', async () => {
    const { provider } = fixture();
    const result = await provider.execute(input(), { signal: new AbortController().signal });
    const data = FullGisDataSchema.parse(result.data);
    assert.equal(result.tool, 'lookup_full_gis_public_data_v1');
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.asOf, new Date(NOW()).toISOString());
    assert.ok(result.provider && result.source && result.attribution);
    assert.equal(data.steps.length, 14);
    for (const step of data.steps) {
        assert.ok(step.provider && step.source && step.asOf && step.attribution);
        assert.deepEqual(step.pagination, { offset: 0, limit: 10, returned: 1, total: 1, hasMore: false, nextOffset: null });
    }
    for (const warning of ['DATA_REFERENCE_DATE_MUST_BE_CONFIRMED',
        'PUBLIC_RECORD_DOES_NOT_CONFIRM_REGISTERED_RIGHTS', 'OFFICIAL_PRICE_IS_NOT_APPRAISAL']) {
        assert.ok(result.warnings.includes(warning));
    }
    assert.equal(result.warnings.includes('VWORLD_RESULT_MUST_NOT_BE_STORED'), false);
});

test('PNU 불일치는 종속 11개 조회를 차단하고 양쪽 조회 증거를 보존한다', async () => {
    const { calls, provider } = fixture();
    const result = await provider.execute(input({ pnu: OTHER_PNU }), {
        signal: new AbortController().signal,
    });
    const data = FullGisDataSchema.parse(result.data);

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PNU_MISMATCH');
    assert.equal(data.pnu, null);
    assert.equal(result.query.pnu, OTHER_PNU);
    assert.equal(data.steps[1].records[0].pnu, PNU);
    assert.deepEqual(calls.map((call) => call.id), FULL_GIS_SOURCE_IDS.slice(0, 3));
    assert.ok(data.steps.slice(3).every((step) => step.status === 'SKIPPED' && step.code === 'PNU_MISMATCH'));
    assert.equal(data.allSourcesQueried, false);
    assert.equal(data.allRecordsReturned, false);
});

test('주소가 없으면 앞 3개만 ADDRESS_REQUIRED로 남기고 11개 PNU source를 조회한다', async () => {
    const { calls, provider } = fixture();
    const result = await provider.execute(input({ address: undefined, pnu: PNU }), {
        signal: new AbortController().signal,
    });
    const data = FullGisDataSchema.parse(result.data);

    assert.equal(result.status, 'PARTIAL');
    assert.equal(data.pnu, PNU);
    assert.deepEqual(calls.map((call) => call.id), FULL_GIS_SOURCE_IDS.slice(3));
    assert.ok(data.steps.slice(0, 3).every((step) => step.status === 'SKIPPED' && step.code === 'ADDRESS_REQUIRED'));
    assert.equal(data.allSourcesQueried, false);
    assert.equal(data.allRecordsReturned, false);
});

test('개별 source 예외와 명시 무자료를 격리해 성공한 나머지 자료를 보존한다', async () => {
    const { calls, provider } = fixture((id, query) => {
        if (id === 'building_floors') throw new Error('secret-provider-body-canary');
        if (id === 'indiv_house_price') return emptyFullGisStep(id, query, 'NO_DATA', undefined, NOW);
        return success(id, query);
    });
    const result = await provider.execute(input(), { signal: new AbortController().signal });
    const data = FullGisDataSchema.parse(result.data);

    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.code, 'FULL_GIS_PARTIAL');
    assert.equal(calls.length, 14);
    assert.equal(data.allSourcesQueried, true);
    assert.equal(data.allRecordsReturned, false);
    assert.equal(data.steps.find((step) => step.id === 'building_floors')?.code, 'PROVIDER_REQUEST_FAILED');
    assert.equal(data.steps.find((step) => step.id === 'indiv_house_price')?.status, 'NO_DATA');
    assert.equal(data.steps.find((step) => step.id === 'building_units')?.records.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret-provider-body-canary/);
});

test('source별 페이지를 전달하고 주소 의존성은 항상 offset 0에서 확인한다', async () => {
    const { calls, provider } = fixture((id, query) => success(id, query, {
        total: FULL_GIS_SOURCE_IDS.indexOf(id) < 3 ? 1 : 50,
    }));
    const result = await provider.execute(input({ offset: 10, offsets: { building_units: 30 }, year: 2025, limit: 2 }), {
        signal: new AbortController().signal,
    });
    const data = FullGisDataSchema.parse(result.data);

    assert.equal(data.allSourcesQueried, true);
    assert.equal(data.allRecordsReturned, false);
    assert.equal(data.hasMore, true);
    assert.equal(result.status, 'PARTIAL');
    assert.ok(calls.slice(0, 3).every((call) => call.query.offset === 0));
    assert.equal(calls.find((call) => call.id === 'building_units')?.query.offset, 30);
    assert.equal(calls.find((call) => call.id === 'building_title')?.query.offset, 10);
    const units = data.steps.find((step) => step.id === 'building_units')!;
    assert.equal(units.pagination.total, 50);
    assert.equal(units.pagination.nextOffset, 31);
    assert.equal(units.pagination.limit, 2);
    assert.ok(calls.every((call) => call.query.year === 2025));
});

test('다음 페이지의 마지막 행만 반환해도 전량 수집 완료로 표시하지 않는다', async () => {
    const { provider } = fixture((id, query) => success(id, query, {
        total: FULL_GIS_SOURCE_IDS.indexOf(id) < 3 ? 1 : 2,
    }));
    const result = await provider.execute(input({ offset: 1 }), { signal: new AbortController().signal });
    const data = FullGisDataSchema.parse(result.data);
    assert.equal(data.hasMore, false);
    assert.equal(data.allRecordsReturned, false);
    assert.equal(result.status, 'PARTIAL');
});

test('동시 upstream 조회는 최대 3개이며 모든 항목을 한 번씩 호출한다', async () => {
    let active = 0;
    let maximum = 0;
    const { calls, provider } = fixture(async (id, query) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        return success(id, query);
    });
    await provider.execute(input(), { signal: new AbortController().signal });
    assert.equal(maximum, 3);
    assert.equal(calls.length, new Set(calls.map((call) => call.id)).size);
});

test('성공으로 포장된 잘못된 pagination과 좌표를 불완전 응답으로 차단한다', async () => {
    const badPage = fixture((id, query) => {
        const step = success(id, query);
        if (id === 'building_units') step.pagination.returned = 0;
        if (id === 'land_price') step.pagination.total = 0;
        return step;
    });
    const result = await badPage.provider.execute(input(), { signal: new AbortController().signal });
    const data = FullGisDataSchema.parse(result.data);
    for (const id of ['building_units', 'land_price']) {
        const step = data.steps.find((item) => item.id === id)!;
        assert.equal(step.status, 'INCOMPLETE');
        assert.equal(step.code, 'PROVIDER_RESPONSE_INVALID');
    }
    const badPoint = fixture((id, query) => success(id, query, {
        records: id === 'geocode' ? [{ longitude: 200, latitude: 38, crs: 'EPSG:4326' }] : undefined,
    }));
    const invalid = await badPoint.provider.execute(input(), { signal: new AbortController().signal });
    assert.equal(badPoint.calls.length, 1);
    assert.equal(invalid.status, 'INCOMPLETE');
    assert.equal(FullGisDataSchema.parse(invalid.data).pnu, null);
});

test('전체 출력 초과 시 큰 source 행만 제외하고 재조회 offset과 다른 source를 보존한다', async () => {
    const { provider } = fixture((id, query) => success(id, query, {
        records: id === 'building_floors' ? [{ pnu: PNU, value: '가'.repeat(50_000) }] : undefined,
    }));
    const result = await provider.execute(input(), { signal: new AbortController().signal });
    const data = FullGisDataSchema.parse(result.data);
    const floors = data.steps.find((step) => step.id === 'building_floors')!;
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= PUBLIC_DATA_MCP_MAX_OUTPUT_BYTES);
    assert.equal(result.status, 'PARTIAL');
    assert.equal(floors.status, 'INCOMPLETE');
    assert.equal(floors.code, 'OUTPUT_TOO_LARGE');
    assert.deepEqual(floors.records, []);
    assert.equal(floors.pagination.total, 1);
    assert.equal(floors.pagination.nextOffset, 0);
    assert.equal(floors.pagination.hasMore, true);
    assert.equal(data.hasMore, true);
    assert.equal(data.allRecordsReturned, false);
    assert.equal(data.allSourcesQueried, true);
    assert.equal(data.steps.find((step) => step.id === 'building_units')?.status, 'SUCCESS');
});

test('요청 전 취소 시 upstream을 호출하지 않고 14개 상태를 반환한다', async () => {
    const { calls, provider } = fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await provider.execute(input(), { signal: controller.signal });
    const data = FullGisDataSchema.parse(result.data);
    assert.equal(calls.length, 0);
    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(data.steps.length, 14);
    assert.ok(data.steps.every((step) => step.code === 'REQUEST_ABORTED'));
    assert.equal(data.allSourcesQueried, false);
});

test('호출 중 취소는 뒤 source를 시작하지 않고 완료된 자료를 보존한다', async () => {
    const controller = new AbortController();
    const { calls, provider } = fixture(async (id, query) => {
        if (id === 'boundary_vworld') {
            controller.abort('REQUEST_DEADLINE_EXCEEDED');
            throw new Error('cancel-canary');
        }
        return success(id, query);
    });
    const result = await provider.execute(input(), { signal: controller.signal });
    const data = FullGisDataSchema.parse(result.data);
    assert.equal(calls.length, 4);
    assert.equal(result.status, 'PARTIAL');
    assert.ok(data.steps.slice(0, 3).every((step) => step.status === 'SUCCESS'));
    assert.ok(data.steps.slice(3).every((step) => step.status === 'INCOMPLETE'
        && step.code === 'REQUEST_DEADLINE_EXCEEDED'));
    assert.equal(data.allSourcesQueried, false);
    assert.equal(data.allRecordsReturned, false);
    assert.doesNotMatch(JSON.stringify(result), /cancel-canary/);
});

test('주소와 PNU가 모두 없으면 client 호출 전에 입력을 거부한다', async () => {
    const { calls, provider } = fixture();
    await assert.rejects(provider.execute({ offset: 0, limit: 10 }, {
        signal: new AbortController().signal,
    }));
    assert.equal(calls.length, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    LandAreaSyncAdapter,
    parseBuildingHubEnvelope,
    parseVworldEnvelope,
    endpointZeroLabel,
    STRICT_SCAN_PAGE_SIZE,
    type BuildingHubAuth,
    type VworldAuth,
} from '../src/services/land-area-sync/adapter';
import type { HttpRequest, HttpResponse } from '../src/types/land-area-sync.types';

const HUB_AUTH: BuildingHubAuth = { serviceKey: 'test-service-key' };
const VWORLD_AUTH: VworldAuth = { key: 'test-vworld-key', domain: 'test.example.com' };
const PNU = '1168010100107360024';

// ── 스크립트 기반 가짜 httpClient ────────────────────────────────

interface Call {
    url: string;
    params: Record<string, unknown>;
}

/** pageNo → HttpResponse(또는 throw) 스크립트 */
function scripted(
    handler: (req: HttpRequest, call: Call) => HttpResponse | Promise<HttpResponse>
) {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const httpClient = async (req: HttpRequest): Promise<HttpResponse> => {
        const call = { url: req.url, params: req.params };
        calls.push(call);
        return handler(req, call);
    };
    const sleep = async (ms: number) => {
        sleeps.push(ms);
    };
    return { httpClient, sleep, calls, sleeps };
}

function ok(data: unknown, headers: Record<string, string> = {}): HttpResponse {
    return { status: 200, data, headers };
}

/** Building HUB 성공 envelope */
function hubBody(totalCount: number, rows: unknown[]): unknown {
    return {
        response: {
            header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
            body: {
                totalCount,
                pageNo: 1,
                numOfRows: STRICT_SCAN_PAGE_SIZE,
                items: rows.length === 0 ? '' : { item: rows.length === 1 ? rows[0] : rows },
            },
        },
    };
}

/** V-World 성공 envelope */
function vworldBody(containerKey: string, totalCount: number, rows: unknown[]): unknown {
    return {
        [containerKey]: {
            totalCount,
            pageNo: 1,
            numOfRows: STRICT_SCAN_PAGE_SIZE,
            [containerKey]: rows,
        },
    };
}

function rowsOf(n: number, prefix = 'r'): Array<{ id: string }> {
    return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
}

function makeAdapter(httpClient: any, sleep: any) {
    return new LandAreaSyncAdapter({ httpClient, sleep, random: () => 0 });
}

// ── envelope 파서 단위 테스트 ────────────────────────────────────

test('parseBuildingHubEnvelope: 정상 → SUCCESS + totalCount + rows', () => {
    const parsed = parseBuildingHubEnvelope(hubBody(2, rowsOf(2)));
    assert.equal(parsed.kind, 'SUCCESS');
    if (parsed.kind === 'SUCCESS') {
        assert.equal(parsed.totalCount, 2);
        assert.equal(parsed.rows.length, 2);
    }
});

test('parseBuildingHubEnvelope: 단건 item 객체는 배열로 정규화', () => {
    const parsed = parseBuildingHubEnvelope(hubBody(1, [{ id: 'only' }]));
    assert.equal(parsed.kind, 'SUCCESS');
    if (parsed.kind === 'SUCCESS') assert.equal(parsed.rows.length, 1);
});

test('parseBuildingHubEnvelope: totalCount=0 성공은 SUCCESS(빈 rows) — COMPLETE_ZERO 후보', () => {
    const parsed = parseBuildingHubEnvelope(hubBody(0, []));
    assert.equal(parsed.kind, 'SUCCESS');
    if (parsed.kind === 'SUCCESS') {
        assert.equal(parsed.totalCount, 0);
        assert.equal(parsed.rows.length, 0);
    }
});

test('parseBuildingHubEnvelope: resultCode!=00 은 PROVIDER_ERROR(즉시 실패)', () => {
    const bad = { response: { header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED.' }, body: {} } };
    const parsed = parseBuildingHubEnvelope(bad);
    assert.equal(parsed.kind, 'PROVIDER_ERROR');
    if (parsed.kind === 'PROVIDER_ERROR') assert.equal(parsed.providerCode, '30');
});

test('parseBuildingHubEnvelope: response 컨테이너 누락은 SCHEMA_ERROR', () => {
    const parsed = parseBuildingHubEnvelope({ foo: 1 });
    assert.equal(parsed.kind, 'SCHEMA_ERROR');
    if (parsed.kind === 'SCHEMA_ERROR') {
        assert.equal(
            parsed.schemaErrorCode,
            'RESPONSE_CONTAINER_MISSING'
        );
    }
    assert.equal(parseBuildingHubEnvelope(null).kind, 'SCHEMA_ERROR');
});

test('parseBuildingHubEnvelope: totalCount 비정수/음수는 SCHEMA_ERROR(zero 아님)', () => {
    const neg = { response: { header: { resultCode: '00' }, body: { totalCount: -1, items: '' } } };
    assert.equal(parseBuildingHubEnvelope(neg).kind, 'SCHEMA_ERROR');
    const nan = { response: { header: { resultCode: '00' }, body: { totalCount: 'abc', items: '' } } };
    assert.equal(parseBuildingHubEnvelope(nan).kind, 'SCHEMA_ERROR');
});

test('parseVworldEnvelope: error envelope는 PROVIDER_ERROR', () => {
    const bad = { ldaregVOList: { error: 'INVALID_KEY', message: 'bad key' } };
    const parsed = parseVworldEnvelope('ldaregVOList', 'ldaregVOList', bad);
    assert.equal(parsed.kind, 'PROVIDER_ERROR');
    if (parsed.kind === 'PROVIDER_ERROR') assert.equal(parsed.providerCode, 'INVALID_KEY');
});

test('parseVworldEnvelope: 정상 → SUCCESS + rows', () => {
    const parsed = parseVworldEnvelope('ladfrlVOList', 'ladfrlVOList', vworldBody('ladfrlVOList', 3, rowsOf(3)));
    assert.equal(parsed.kind, 'SUCCESS');
    if (parsed.kind === 'SUCCESS') assert.equal(parsed.totalCount, 3);
});

test('parseVworldEnvelope: 컨테이너 누락은 SCHEMA_ERROR', () => {
    const parsed = parseVworldEnvelope(
        'ldaregVOList',
        'ldaregVOList',
        { other: 1 }
    );
    assert.equal(parsed.kind, 'SCHEMA_ERROR');
    if (parsed.kind === 'SCHEMA_ERROR') {
        assert.equal(
            parsed.schemaErrorCode,
            'ENDPOINT_CONTAINER_MISSING_OTHER'
        );
    }
});

// ── pagination 경계 ─────────────────────────────────────────────

test('pagination: totalCount 1,000 → 1 페이지 COMPLETE', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok(hubBody(1000, rowsOf(1000))));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'COMPLETE');
    if (res.state === 'COMPLETE') {
        assert.equal(res.totalCount, 1000);
        assert.equal(res.rows.length, 1000);
        assert.equal(res.pagesFetched, 1);
    }
    assert.equal(calls.length, 1);
});

test('pagination: totalCount 1,001 → 2 페이지(1000+1) COMPLETE', async () => {
    const { httpClient, sleep, calls } = scripted((req) => {
        const page = Number(req.params.pageNo);
        return ok(hubBody(1001, page === 1 ? rowsOf(1000, 'p1') : rowsOf(1, 'p2')));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'COMPLETE');
    if (res.state === 'COMPLETE') {
        assert.equal(res.rows.length, 1001);
        assert.equal(res.pagesFetched, 2);
    }
    assert.equal(calls.length, 2);
});

test('pagination: totalCount 2,000 → 2 페이지(1000+1000) COMPLETE', async () => {
    const { httpClient, sleep } = scripted((req) => {
        const page = Number(req.params.pageNo);
        return ok(hubBody(2000, rowsOf(1000, `p${page}`)));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'COMPLETE');
    if (res.state === 'COMPLETE') assert.equal(res.rows.length, 2000);
});

test('pagination: totalCount 2,001 → 3 페이지(1000+1000+1) COMPLETE', async () => {
    const { httpClient, sleep, calls } = scripted((req) => {
        const page = Number(req.params.pageNo);
        const n = page === 3 ? 1 : 1000;
        return ok(hubBody(2001, rowsOf(n, `p${page}`)));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'COMPLETE');
    if (res.state === 'COMPLETE') {
        assert.equal(res.rows.length, 2001);
        assert.equal(res.pagesFetched, 3);
    }
    assert.equal(calls.length, 3);
});

test('pagination: totalCount=0 성공 → COMPLETE_ZERO', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok(hubBody(0, [])));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'COMPLETE_ZERO');
    if (res.state === 'COMPLETE_ZERO') {
        assert.equal(res.totalCount, 0);
        assert.equal(res.rows.length, 0);
    }
    assert.equal(calls.length, 1);
});

test('pagination: totalCount=0 인데 rows 존재 → INCOMPLETE(zero 축약 금지)', async () => {
    const { httpClient, sleep } = scripted(() => ok(hubBody(0, rowsOf(1))));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'INCOMPLETE');
});

test('pagination: 페이지마다 totalCount 변경 → INCOMPLETE', async () => {
    const { httpClient, sleep } = scripted((req) => {
        const page = Number(req.params.pageNo);
        const tc = page === 1 ? 1001 : 1500;
        return ok(hubBody(tc, page === 1 ? rowsOf(1000, 'p1') : rowsOf(1, 'p2')));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'INCOMPLETE');
    if (res.state === 'INCOMPLETE') assert.equal(res.issue.kind, 'PAGINATION_MISMATCH');
});

test('pagination: 중간 빈 페이지 → INCOMPLETE', async () => {
    const { httpClient, sleep } = scripted((req) => {
        const page = Number(req.params.pageNo);
        // 3페이지 기대인데 2페이지가 비어있음
        const n = page === 1 ? 1000 : page === 2 ? 0 : 1;
        return ok(hubBody(2001, rowsOf(n, `p${page}`)));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'INCOMPLETE');
});

test('pagination: 예상보다 짧은 중간 페이지 → INCOMPLETE', async () => {
    const { httpClient, sleep } = scripted((req) => {
        const page = Number(req.params.pageNo);
        const n = page === 1 ? 1000 : page === 2 ? 500 : 1;
        return ok(hubBody(2001, rowsOf(n, `p${page}`)));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'INCOMPLETE');
});

test('pagination: 반복 페이지(동일 내용) → INCOMPLETE', async () => {
    const { httpClient, sleep } = scripted((req) => {
        const page = Number(req.params.pageNo);
        // page2가 page1과 완전히 동일
        const n = page === 3 ? 1 : 1000;
        return ok(hubBody(2001, rowsOf(n, 'same')));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'INCOMPLETE');
});

test('pagination: 마지막 페이지 누적 초과 → INCOMPLETE', async () => {
    const { httpClient, sleep } = scripted((req) => {
        const page = Number(req.params.pageNo);
        // tc 1001, 마지막 페이지가 5건(기대 1건)
        return ok(hubBody(1001, page === 1 ? rowsOf(1000, 'p1') : rowsOf(5, 'p2')));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'INCOMPLETE');
});

// ── retry / no-retry ────────────────────────────────────────────

test('retry: timeout 1회 후 성공 → COMPLETE, sleep 1회', async () => {
    let attempt = 0;
    const { httpClient, sleep, sleeps } = scripted(() => {
        attempt += 1;
        if (attempt === 1) {
            const err: any = new Error('timeout of 15000ms exceeded');
            err.code = 'ECONNABORTED';
            throw err;
        }
        return ok(hubBody(1, rowsOf(1)));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'COMPLETE');
    assert.equal(sleeps.length, 1);
});

test('retry: HTTP 429 후 성공, Retry-After 상한 내 준수', async () => {
    let attempt = 0;
    const { httpClient, sleep, sleeps } = scripted(() => {
        attempt += 1;
        if (attempt === 1) return { status: 429, data: {}, headers: { 'retry-after': '2' } };
        return ok(hubBody(1, rowsOf(1)));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'COMPLETE');
    assert.equal(sleeps.length, 1);
    // Retry-After 2초(2000ms)를 준수, 상한(30s) 이내
    assert.equal(sleeps[0], 2000);
});

test('retry: HTTP 429 + Retry-After 상한 초과(120초) → 30초로 클램프', async () => {
    let attempt = 0;
    const { httpClient, sleep, sleeps } = scripted(() => {
        attempt += 1;
        if (attempt === 1) return { status: 429, data: {}, headers: { 'retry-after': '120' } };
        return ok(hubBody(1, rowsOf(1)));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'COMPLETE');
    assert.equal(sleeps.length, 1);
    // Retry-After 120초(120000ms)를 요청했으나 상한 30s(30000ms)로 클램프
    assert.equal(sleeps[0], 30000);
});

test('retry: HTTP 429 + Retry-After HTTP-date 형식(상한 초과) → 30초로 클램프', async () => {
    let attempt = 0;
    const now = Date.now();
    const futureDate = new Date(now + 120 * 1000).toUTCString(); // 현재시각 + 120초
    const { httpClient, sleep, sleeps } = scripted(() => {
        attempt += 1;
        if (attempt === 1) return { status: 429, data: {}, headers: { 'retry-after': futureDate } };
        return ok(hubBody(1, rowsOf(1)));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'COMPLETE');
    assert.equal(sleeps.length, 1);
    // Retry-After HTTP-date가 120초 뒤인데 상한 30s(30000ms)로 클램프됨
    // 부동소수점 오차를 고려하여 ±100ms 범위 허용
    assert.ok(sleeps[0] <= 30000, `Expected sleep <= 30000ms, got ${sleeps[0]}ms`);
    assert.ok(sleeps[0] >= 29900, `Expected sleep >= 29900ms, got ${sleeps[0]}ms`);
});

test('retry: HTTP 503 최대 3회 소진 후 FAILED', async () => {
    const { httpClient, sleep, calls, sleeps } = scripted(() => ({ status: 503, data: {}, headers: {} }));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'FAILED');
    if (res.state === 'FAILED') assert.equal(res.issue.kind, 'HTTP_ERROR');
    assert.equal(calls.length, 3);
    assert.equal(sleeps.length, 2);
});

test('no-retry: HTTP 401 즉시 FAILED (재시도 없음)', async () => {
    const { httpClient, sleep, calls, sleeps } = scripted(() => ({ status: 401, data: {}, headers: {} }));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'FAILED');
    assert.equal(calls.length, 1);
    assert.equal(sleeps.length, 0);
});

test('no-retry: HTTP 403 즉시 FAILED', async () => {
    const { httpClient, sleep, calls } = scripted(() => ({ status: 403, data: {}, headers: {} }));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'FAILED');
    assert.equal(calls.length, 1);
});

test('no-retry: 기타 4xx(400) 즉시 FAILED', async () => {
    const { httpClient, sleep, calls } = scripted(() => ({ status: 400, data: {}, headers: {} }));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'FAILED');
    assert.equal(calls.length, 1);
});

test('no-retry: HTTP 200 provider error envelope 즉시 FAILED', async () => {
    const bad = { response: { header: { resultCode: '30', resultMsg: 'NO KEY' }, body: {} } };
    const { httpClient, sleep, calls } = scripted(() => ok(bad));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'FAILED');
    if (res.state === 'FAILED') assert.equal(res.issue.kind, 'PROVIDER_ERROR_ENVELOPE');
    assert.equal(calls.length, 1);
});

test('no-retry: schema 오류 즉시 FAILED', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok({ garbage: true }));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'FAILED');
    if (res.state === 'FAILED') {
        assert.equal(res.issue.kind, 'SCHEMA_ERROR');
        assert.equal(
            res.issue.schemaErrorCode,
            'RESPONSE_CONTAINER_MISSING'
        );
    }
    assert.equal(calls.length, 1);
});

test('no-retry: 비-timeout transport 오류(DNS)는 즉시 FAILED', async () => {
    const { httpClient, sleep, calls, sleeps } = scripted(() => {
        const err: any = new Error('getaddrinfo ENOTFOUND');
        err.code = 'ENOTFOUND';
        throw err;
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.equal(res.state, 'FAILED');
    assert.equal(calls.length, 1);
    assert.equal(sleeps.length, 0);
});

// ── AbortSignal ────────────────────────────────────────────────

test('abort: 시작 전 취소되면 호출 없이 FAILED(ABORTED)', async () => {
    const controller = new AbortController();
    controller.abort();
    const { httpClient, sleep, calls } = scripted(() => ok(hubBody(1, rowsOf(1))));
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH, { signal: controller.signal });
    assert.equal(res.state, 'FAILED');
    if (res.state === 'FAILED') assert.equal(res.issue.kind, 'ABORTED');
    assert.equal(calls.length, 0);
});

test('abort: 페이지 루프 중 취소되면 다음 페이지 조회 없이 FAILED(ABORTED)', async () => {
    const controller = new AbortController();
    const { httpClient, sleep, calls } = scripted((req) => {
        const page = Number(req.params.pageNo);
        if (page === 1) {
            controller.abort(); // page1 응답 후 취소
            return ok(hubBody(2001, rowsOf(1000, 'p1')));
        }
        return ok(hubBody(2001, rowsOf(1000, `p${page}`)));
    });
    const res = await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH, { signal: controller.signal });
    assert.equal(res.state, 'FAILED');
    if (res.state === 'FAILED') assert.equal(res.issue.kind, 'ABORTED');
    assert.equal(calls.length, 1);
});

test('abort: 재시도 지연(backoff) 중 취소되면 재조회 없이 FAILED(ABORTED)', async () => {
    const controller = new AbortController();
    const calls: Array<Record<string, unknown>> = [];
    // 첫 요청은 503(재시도 유발), 재시도 backoff 중 취소
    const httpClient = async (req: HttpRequest): Promise<HttpResponse> => {
        calls.push(req.params);
        return { status: 503, data: {}, headers: {} };
    };
    const sleep = async (_ms: number, signal?: AbortSignal) => {
        controller.abort(); // 지연 중 취소 발생을 흉내
        void signal;
    };
    const adapter = new LandAreaSyncAdapter({ httpClient, sleep, random: () => 0 });
    const res = await adapter.scanTitle(PNU, HUB_AUTH, { signal: controller.signal });
    assert.equal(res.state, 'FAILED');
    if (res.state === 'FAILED') assert.equal(res.issue.kind, 'ABORTED');
    // 첫 조회 1회만, 재시도 조회는 없어야 한다
    assert.equal(calls.length, 1);
});

// ── endpoint별 파라미터 / envelope / zero label ──────────────────

test('scanTitle: Building HUB URL + exact 필지 파라미터', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok(hubBody(0, [])));
    await makeAdapter(httpClient, sleep).scanTitle(PNU, HUB_AUTH);
    assert.match(calls[0].url, /apis\.data\.go\.kr\/1613000\/BldRgstHubService\/getBrTitleInfo$/);
    assert.equal(calls[0].params.serviceKey, 'test-service-key');
    assert.equal(calls[0].params.sigunguCd, '11680');
    assert.equal(calls[0].params.bjdongCd, '10100');
    assert.equal(calls[0].params.platGbCd, '0');
    assert.equal(calls[0].params.bun, '0736');
    assert.equal(calls[0].params.ji, '0024');
    assert.equal(calls[0].params.numOfRows, 1000);
    assert.equal(calls[0].params.pageNo, 1);
    assert.equal(calls[0].params._type, 'json');
});

test('scanAttached: platGbCd 파라미터를 PNU 토지구분에서 역변환(landGbn 1→platGbCd 0)', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok(hubBody(0, [])));
    await makeAdapter(httpClient, sleep).scanAttached(PNU, HUB_AUTH);
    assert.match(calls[0].url, /getBrAtchJibunInfo$/);
    assert.equal(calls[0].params.platGbCd, '0');
});

test('scanAttached: 산(landGbn 2) PNU는 platGbCd 1', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok(hubBody(0, [])));
    const mountainPnu = '1168010100207360024';
    await makeAdapter(httpClient, sleep).scanAttached(mountainPnu, HUB_AUTH);
    assert.equal(calls[0].params.platGbCd, '1');
});

test('scanLdareg: V-World URL + key/domain/pnu, ldaregVOList envelope', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok(vworldBody('ldaregVOList', 2, rowsOf(2))));
    const res = await makeAdapter(httpClient, sleep).scanLdareg(PNU, VWORLD_AUTH);
    assert.match(calls[0].url, /api\.vworld\.kr\/ned\/data\/ldaregList$/);
    assert.equal(calls[0].params.key, 'test-vworld-key');
    assert.equal(calls[0].params.domain, 'test.example.com');
    assert.equal(calls[0].params.pnu, PNU);
    assert.equal(calls[0].params.format, 'json');
    assert.equal(res.state, 'COMPLETE');
    if (res.state === 'COMPLETE') assert.equal(res.rows.length, 2);
});

test('scanLadfrl: V-World ladfrlList URL + ladfrlVOList envelope', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok(vworldBody('ladfrlVOList', 0, [])));
    const res = await makeAdapter(httpClient, sleep).scanLadfrl(PNU, VWORLD_AUTH);
    assert.match(calls[0].url, /ladfrlList$/);
    assert.equal(res.state, 'COMPLETE_ZERO');
});

test('scanExpos / scanBasis: Building HUB endpoint URL과 exact platGbCd', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok(hubBody(0, [])));
    const adapter = makeAdapter(httpClient, sleep);
    await adapter.scanExpos(PNU, HUB_AUTH);
    await adapter.scanBasis(PNU, HUB_AUTH);
    assert.match(calls[0].url, /getBrExposInfo$/);
    assert.match(calls[1].url, /getBrBasisOulnInfo$/);
    assert.equal(calls[0].params.platGbCd, '0');
    assert.equal(calls[1].params.platGbCd, '0');
});

test('잘못된 PNU 형식은 호출 없이 FAILED(SCHEMA_ERROR)', async () => {
    const { httpClient, sleep, calls } = scripted(() => ok(hubBody(0, [])));
    const res = await makeAdapter(httpClient, sleep).scanTitle('123', HUB_AUTH);
    assert.equal(res.state, 'FAILED');
    if (res.state === 'FAILED') {
        assert.equal(res.issue.schemaErrorCode, 'INPUT_PNU_INVALID');
    }
    assert.equal(calls.length, 0);
});

test('endpointZeroLabel: 6개 endpoint별 zero 의미 분리 (§10.7)', () => {
    assert.equal(endpointZeroLabel('getBrTitleInfo'), 'TITLE_COMPLETE_ZERO');
    assert.equal(endpointZeroLabel('getBrAtchJibunInfo'), 'ATTACHED_COMPLETE_ZERO');
    assert.equal(endpointZeroLabel('getBrExposInfo'), 'EXPOS_COMPLETE_ZERO');
    assert.equal(endpointZeroLabel('getBrBasisOulnInfo'), 'BASIS_COMPLETE_ZERO');
    assert.equal(endpointZeroLabel('ladfrlList'), 'LADFRL_COMPLETE_ZERO');
    assert.equal(endpointZeroLabel('ldaregList'), 'LDAREG_COMPLETE_ZERO');
});

test('COMPLETE 결과는 endpoint별 rows 를 반환(zero 상태 6종 분리 검증)', async () => {
    // 각 endpoint가 COMPLETE_ZERO를 정확히 판별하는지 (동일 엔진, 다른 envelope)
    const hub = scripted(() => ok(hubBody(0, [])));
    const vworld = scripted(() => ok(vworldBody('ldaregVOList', 0, [])));
    const a1 = await makeAdapter(hub.httpClient, hub.sleep).scanExpos(PNU, HUB_AUTH);
    const a2 = await makeAdapter(vworld.httpClient, vworld.sleep).scanLdareg(PNU, VWORLD_AUTH);
    assert.equal(a1.state, 'COMPLETE_ZERO');
    assert.equal(a2.state, 'COMPLETE_ZERO');
});

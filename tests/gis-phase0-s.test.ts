import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateGisAuthenticatedScope } from '../src/security/gis-access-policy';
import {
    persistSyncJobOrThrow,
    SyncJobPersistenceError,
} from '../src/services/sync-job-admission';
import { FixedWindowRateLimiter } from '../src/security/fixed-window-rate-limiter';

test('GIS 토큰 scope는 system 또는 요청 union과 정확히 일치해야 한다', () => {
    assert.equal(validateGisAuthenticatedScope(undefined, 'union-a')?.code, 'UNAUTHORIZED');
    assert.equal(
        validateGisAuthenticatedScope({
            unionId: 'union-a',
            userId: 'auth-1',
            databaseTarget: 'production',
            legacyProductionToken: true,
        }, 'union-b')?.code,
        'UNION_SCOPE_MISMATCH'
    );
    assert.equal(validateGisAuthenticatedScope({
        unionId: 'union-a',
        userId: 'auth-1',
        databaseTarget: 'production',
        legacyProductionToken: true,
    }, 'union-a'), null);
    assert.equal(validateGisAuthenticatedScope({
        unionId: 'system',
        userId: 'auth-1',
        databaseTarget: 'production',
        legacyProductionToken: true,
    }, 'union-b'), null);
});

test('sync_jobs는 반환 id와 union_id가 일치할 때만 admission된다', async () => {
    await persistSyncJobOrThrow('job-1', 'union-a', async () => ({
        data: { id: 'job-1', union_id: 'union-a' },
        error: null,
    }));

    for (const result of [
        { data: null, error: null },
        { data: { id: 'job-x', union_id: 'union-a' }, error: null },
        { data: { id: 'job-1', union_id: 'union-b' }, error: null },
        { data: null, error: { message: 'db unavailable', code: '08006' } },
    ]) {
        await assert.rejects(
            () => persistSyncJobOrThrow('job-1', 'union-a', async () => result),
            (error: unknown) =>
                error instanceof SyncJobPersistenceError && error.code === 'SYNC_JOB_PERSIST_FAILED'
        );
    }
});

test('모든 GIS 변경·가격·상태 route에 시스템관리자 middleware가 고정된다', async () => {
    const source = await readFile('src/routes/gis.ts', 'utf8');
    for (const route of [
        "router.post('/sync', authMiddleware, gisSystemAdminMiddleware",
        "router.post('/sync-apartment-prices', authMiddleware, gisSystemAdminMiddleware",
        "router.post('/sync-individual-housing-prices', authMiddleware, gisSystemAdminMiddleware",
        "router.post('/sync-land-prices', authMiddleware, gisSystemAdminMiddleware",
        "router.post('/sync-official-prices', authMiddleware, gisSystemAdminMiddleware",
        "router.get('/status/:jobId', authMiddleware, gisSystemAdminMiddleware",
        "router.post('/diagnose-price-api', authMiddleware, gisSystemAdminMiddleware",
        "router.post('/add-address', authMiddleware, gisSystemAdminMiddleware",
        "router.post('/manual-add', authMiddleware, gisSystemAdminMiddleware",
    ]) {
        assert.ok(source.includes(route), `missing GIS access boundary: ${route}`);
    }

    assert.ok(
        source.includes("router.post('/search-address', authMiddleware, gisAddressReadRateLimitMiddleware"),
        'read-only address search must be authenticated and rate limited'
    );

    const middlewareSource = await readFile('src/middleware/gis-system-admin.ts', 'utf8');
    assert.ok(
        middlewareSource.includes(".in('job_type', [...GIS_JOB_TYPES])"),
        'GIS status authorization must reject non-GIS sync jobs'
    );
    assert.ok(
        source.includes(".in('job_type', ["),
        'persisted GIS status fallback must reject non-GIS sync jobs'
    );
});

test('주소 검색 limiter는 사용자별 허용량 초과 시 다음 구간까지 거부한다', () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);

    assert.equal(limiter.consume('user-a', 0).allowed, true);
    assert.equal(limiter.consume('user-a', 100).allowed, true);
    const rejected = limiter.consume('user-a', 200);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.retryAfterSeconds, 1);
    assert.equal(limiter.consume('user-b', 200).allowed, true);
    assert.equal(limiter.consume('user-a', 1_000).allowed, true);
});

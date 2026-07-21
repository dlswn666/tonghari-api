import assert from 'node:assert/strict';
import test from 'node:test';

Object.assign(process.env, {
    JWT_SECRET: 'test-production-jwt-secret',
    ALIGO_API_KEY: 'test-aligo-key',
    ALIGO_USER_ID: 'test-aligo-user',
    ALIGO_SENDER_PHONE: '0212345678',
    DEFAULT_SENDER_KEY: 'test-sender-key',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'test-production-service-role-key',
    DEV_API_JWT_SECRET: 'test-development-jwt-secret',
    DEV_SUPABASE_URL: 'http://127.0.0.1:54322',
    DEV_SUPABASE_SERVICE_ROLE_KEY: 'test-development-service-role-key',
});

const supabaseModule = import('../src/services/supabase.service');

type QueryResult = {
    data: { id: string } | null;
    error: { message: string } | null;
};

async function serviceWithUpdateResult(result: QueryResult) {
    const { SupabaseService } = await supabaseModule;
    const service = new SupabaseService('http://localhost:54321', 'test-service-role-key');
    const filters: Array<[string, string]> = [];
    let selectedColumns: string | null = null;

    const query = {
        update: () => query,
        eq: (column: string, value: string) => {
            filters.push([column, value]);
            return query;
        },
        select: (columns: string) => {
            selectedColumns = columns;
            return query;
        },
        maybeSingle: async () => result,
    };

    Object.defineProperty(service, 'client', {
        value: { from: () => query },
    });

    return {
        service,
        filters,
        selectedColumns: () => selectedColumns,
    };
}

test('sync_jobs UPDATE 0행은 성공으로 처리하지 않는다', async () => {
    const { service } = await serviceWithUpdateResult({ data: null, error: null });

    assert.equal(
        await service.updateSyncJobStatus('job-missing', 'FAILED', 10, 'failure'),
        false
    );
});

test('sync_jobs는 요청 job id가 반환된 경우에만 성공한다', async () => {
    const jobId = '00000000-0000-4000-a000-000000000001';
    const { service, filters, selectedColumns } = await serviceWithUpdateResult({
        data: { id: jobId },
        error: null,
    });

    assert.equal(await service.updateSyncJobStatus(jobId, 'FAILED', 10, 'failure'), true);
    assert.deepEqual(filters, [['id', jobId]]);
    assert.equal(selectedColumns(), 'id');
});

test('sync_jobs가 다른 id를 반환하면 fail-closed한다', async () => {
    const { service } = await serviceWithUpdateResult({
        data: { id: '00000000-0000-4000-a000-000000000099' },
        error: null,
    });

    assert.equal(
        await service.updateSyncJobStatus(
            '00000000-0000-4000-a000-000000000001',
            'FAILED',
            10,
            'failure'
        ),
        false
    );
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    emptyCounts,
    normalizeStoredCounts,
    normalizeStoredIssues,
} from '../src/services/land-area-sync/preview';
import {
    markScopedFailed,
    writeDiscoveryTerminal,
} from '../src/services/land-area-sync/finalizer';
import type { SupabaseService } from '../src/services/supabase.service';
import type { FinalizeLandAreaSyncJobParams } from '../src/types/land-area-sync-job.types';

Object.assign(process.env, {
    JWT_SECRET: 'test-production-jwt-secret',
    ALIGO_API_KEY: 'test-aligo-key',
    ALIGO_USER_ID: 'test-aligo-user',
    ALIGO_SENDER_PHONE: '0212345678',
    DEFAULT_SENDER_KEY: 'test-sender-key',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY:
        'test-production-service-role-key',
    DEV_API_JWT_SECRET: 'test-development-jwt-secret',
    DEV_SUPABASE_URL: 'http://127.0.0.1:54322',
    DEV_SUPABASE_SERVICE_ROLE_KEY:
        'test-development-service-role-key',
});

const UNION = '00000000-0000-4000-a000-0000000000aa';
const JOB = '00000000-0000-4000-a000-000000000001';

function finalizerDatabase(
    landAreaSync: Record<string, unknown>
): {
    database: SupabaseService;
    calls: FinalizeLandAreaSyncJobParams[];
} {
    const calls: FinalizeLandAreaSyncJobParams[] = [];
    const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
            data: {
                id: JOB,
                union_id: UNION,
                status: 'PROCESSING',
                progress: 0,
                preview_data: { landAreaSync },
                created_at: '',
                updated_at: '',
                error_log: null,
            },
            error: null,
        }),
    };
    return {
        database: {
            getClient: () => ({
                from: () => query,
            }),
            finalizeLandAreaSyncJob: async (
                params: FinalizeLandAreaSyncJobParams
            ) => {
                calls.push(params);
                return { data: true, error: null };
            },
        } as unknown as SupabaseService,
        calls,
    };
}

test('finalizer wrapper는 public RPC exact 10-arg 계약만 전달한다', async () => {
    const { SupabaseService } = await import(
        '../src/services/supabase.service'
    );
    const service = new SupabaseService(
        'http://localhost:54321',
        'test-service-role-key'
    );
    const calls: Array<{
        name: string;
        params: Record<string, unknown>;
    }> = [];
    Object.defineProperty(service, 'client', {
        value: {
            rpc: async (
                name: string,
                params: Record<string, unknown>
            ) => {
                calls.push({ name, params });
                return { data: true, error: null };
            },
        },
    });
    const params: FinalizeLandAreaSyncJobParams = {
        p_union_id: UNION,
        p_sync_job_id: JOB,
        p_status: 'COMPLETED',
        p_scope_state: 'REVIEW_REQUIRED',
        p_outcome: 'REVIEW_REQUIRED',
        p_counts: emptyCounts(),
        p_issues: [{ code: 'SCOPE_NOT_LINKED' }],
        p_issues_total: 1,
        p_issues_truncated: false,
        p_error_log: null,
    };

    assert.deepEqual(
        await service.finalizeLandAreaSyncJob(params),
        { data: true, error: null }
    );
    assert.deepEqual(calls, [
        {
            name: 'finalize_land_area_sync_job_v1',
            params,
        },
    ]);
});

test('FAILED metadata 정규화는 malformed counts를 zero로 닫고 fixed issue code/필드만 cap한다', () => {
    const validCounts = { ...emptyCounts(), titleRows: 2 };
    assert.deepEqual(
        normalizeStoredCounts(validCounts),
        validCounts
    );
    assert.deepEqual(
        normalizeStoredCounts({
            ...emptyCounts(),
            unexpected: 1,
        }),
        emptyCounts()
    );
    const normalized = normalizeStoredIssues([
        {
            code: 'SCOPE_NOT_LINKED',
            targetPnu: '1168010100107360024',
            rawOwnerName: '저장 금지',
        },
        {
            code: 'NOT_ALLOWED_CODE',
            targetPnu: '1168010100107360024',
        },
    ]);
    assert.deepEqual(normalized, {
        issues: [
            {
                code: 'SCOPE_NOT_LINKED',
                targetPnu: '1168010100107360024',
            },
        ],
        issuesTotal: 1,
        issuesTruncated: false,
    });
});

test('초기 INSERT 직후 FAILED도 zero counts와 빈 issues를 finalizer RPC 한 번으로 종결한다', async () => {
    const { database, calls } = finalizerDatabase({
        schemaVersion: 2,
        anchorPnu: '1168010100107360024',
        sourceDiscoveryJobId: null,
        admissionKey: JOB,
    });

    assert.equal(
        await markScopedFailed(
            database,
            JOB,
            UNION,
            'queue admission 실패'
        ),
        true
    );
    assert.deepEqual(calls, [
        {
            p_union_id: UNION,
            p_sync_job_id: JOB,
            p_status: 'FAILED',
            p_scope_state: 'FAILED',
            p_outcome: 'FAILED',
            p_counts: emptyCounts(),
            p_issues: [],
            p_issues_total: 0,
            p_issues_truncated: false,
            p_error_log: 'queue admission 실패',
        },
    ]);
});

test('FAILED finalizer는 기존 valid counts/issues를 정제해 보존하고 total/truncated를 재계산한다', async () => {
    const counts = { ...emptyCounts(), titleRows: 2 };
    const { database, calls } = finalizerDatabase({
        schemaVersion: 2,
        anchorPnu: '1168010100107360024',
        counts,
        issues: [
            {
                code: 'SCOPE_NOT_LINKED',
                targetPnu: '1168010100107360024',
                raw: 'drop-me',
            },
            { code: 'NOT_ALLOWED_CODE' },
        ],
        issuesTotal: 99,
        issuesTruncated: true,
    });

    assert.equal(
        await markScopedFailed(
            database,
            JOB,
            UNION,
            'worker failure'
        ),
        true
    );
    assert.deepEqual(calls[0], {
        p_union_id: UNION,
        p_sync_job_id: JOB,
        p_status: 'FAILED',
        p_scope_state: 'FAILED',
        p_outcome: 'FAILED',
        p_counts: counts,
        p_issues: [
            {
                code: 'SCOPE_NOT_LINKED',
                targetPnu: '1168010100107360024',
            },
        ],
        p_issues_total: 1,
        p_issues_truncated: false,
        p_error_log: 'worker failure',
    });
});

test('FAILED finalizer는 strict capped 200/201/true issue metadata를 축소하지 않는다', async () => {
    const cappedIssues = Array.from(
        { length: 200 },
        () => ({ code: 'SCOPE_NOT_LINKED' as const })
    );
    const { database, calls } = finalizerDatabase({
        schemaVersion: 2,
        anchorPnu: '1168010100107360024',
        counts: emptyCounts(),
        issues: cappedIssues,
        issuesTotal: 201,
        issuesTruncated: true,
    });

    assert.equal(
        await markScopedFailed(
            database,
            JOB,
            UNION,
            'worker failure'
        ),
        true
    );
    assert.deepEqual(calls[0].p_issues, cappedIssues);
    assert.equal(calls[0].p_issues_total, 201);
    assert.equal(calls[0].p_issues_truncated, true);
});

test('discovery terminal은 supplied metadata를 finalizer RPC에 그대로 전달한다', async () => {
    const { database, calls } = finalizerDatabase({
        schemaVersion: 2,
        anchorPnu: '1168010100107360024',
    });
    const counts = { ...emptyCounts(), titleRows: 1 };
    assert.equal(
        await writeDiscoveryTerminal(
            database,
            JOB,
            UNION,
            {
                status: 'COMPLETED',
                scopeState: 'REVIEW_REQUIRED',
                outcome: 'REVIEW_REQUIRED',
                counts,
                issues: [{ code: 'SCOPE_NOT_LINKED' }],
                issuesTotal: 1,
                issuesTruncated: false,
            }
        ),
        true
    );
    assert.deepEqual(calls[0], {
        p_union_id: UNION,
        p_sync_job_id: JOB,
        p_status: 'COMPLETED',
        p_scope_state: 'REVIEW_REQUIRED',
        p_outcome: 'REVIEW_REQUIRED',
        p_counts: counts,
        p_issues: [{ code: 'SCOPE_NOT_LINKED' }],
        p_issues_total: 1,
        p_issues_truncated: false,
        p_error_log: null,
    });
});

test('discovery/FAILED terminal은 repository direct UPDATE가 아니라 finalizer RPC만 사용한다', async () => {
    const repository = await readFile(
        'src/services/land-area-sync/repository.ts',
        'utf8'
    );
    const finalizer = await readFile(
        'src/services/land-area-sync/finalizer.ts',
        'utf8'
    );
    assert.doesNotMatch(
        repository,
        /writeDiscoveryTerminal|markScopedFailed|workerFinalization/
    );
    assert.match(
        finalizer,
        /database\.finalizeLandAreaSyncJob\(\{/
    );
    assert.match(
        finalizer,
        /p_outcome: 'FAILED'/
    );
    assert.match(
        finalizer,
        /normalizeStoredCounts\(current\?\.counts\)/
    );
    assert.match(
        finalizer,
        /normalizeStoredIssues\([\s\S]*current\?\.issues,[\s\S]*current\?\.issuesTotal,[\s\S]*current\?\.issuesTruncated/
    );
});

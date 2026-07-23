import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    insertDiscoveryJob,
    getScopedJob,
    getLatestScopedJob,
    freezeScopeSnapshot,
    writeDiscoveryTerminal,
    writeAppliedIssues,
    markScopedFailed,
    type LandAreaSyncJobRow,
} from '../src/services/land-area-sync/repository';

interface CallRecord {
    table: string;
    op: 'select' | 'insert' | 'update' | null;
    filters: Array<[string, unknown]>;
    order: [string, { ascending: boolean }] | null;
    value?: unknown;
}

function fakeClient(config: {
    selectResult?: { data: unknown; error: unknown };
    updateResult?: { data: unknown; error: unknown };
    insertResult?: { data: unknown; error: unknown };
}) {
    const calls: CallRecord[] = [];
    const client = {
        from(table: string) {
            const rec: CallRecord = { table, op: null, filters: [], order: null };
            calls.push(rec);
            const b: Record<string, unknown> = {
                select(cols: string) {
                    if (rec.op === null) rec.op = 'select';
                    void cols;
                    return b;
                },
                insert(v: unknown) { rec.op = 'insert'; rec.value = v; return b; },
                update(v: unknown) { rec.op = 'update'; rec.value = v; return b; },
                eq(col: string, val: unknown) { rec.filters.push([col, val]); return b; },
                in(col: string, val: unknown) { rec.filters.push([col, val]); return b; },
                order(col: string, o: { ascending: boolean }) { rec.order = [col, o]; return b; },
                limit() { return b; },
                single: async () => config.insertResult ?? { data: null, error: null },
                maybeSingle: async () =>
                    rec.op === 'update'
                        ? config.updateResult ?? { data: null, error: null }
                        : config.selectResult ?? { data: null, error: null },
            };
            return b;
        },
    } as unknown as SupabaseClient;
    return { client, calls };
}

const JOB = '00000000-0000-4000-a000-000000000001';
const UNION = '00000000-0000-4000-a000-0000000000aa';

test('insertDiscoveryJob 은 LAND_AREA_SYNC job_type 과 seed preview 로 INSERT 한다', async () => {
    const { client, calls } = fakeClient({ insertResult: { data: { id: JOB, union_id: UNION }, error: null } });
    const { data } = await insertDiscoveryJob(client, JOB, { unionId: UNION, anchorPnu: '1168010100107360024', actorUserId: 'admin-1' });
    assert.deepEqual(data, { id: JOB, union_id: UNION });
    const rec = calls[0];
    assert.equal(rec.op, 'insert');
    const value = rec.value as { job_type: string; preview_data: { landAreaSync: { schemaVersion: number; anchorPnu: string; sourceDiscoveryJobId: null } } };
    assert.equal(value.job_type, 'LAND_AREA_SYNC');
    assert.equal(value.preview_data.landAreaSync.schemaVersion, 2);
    assert.equal(value.preview_data.landAreaSync.anchorPnu, '1168010100107360024');
    assert.equal(value.preview_data.landAreaSync.sourceDiscoveryJobId, null);
});

test('getScopedJob 은 id+union+type 로 스코프한다', async () => {
    const row: LandAreaSyncJobRow = { id: JOB, union_id: UNION, status: 'PROCESSING', progress: 0, preview_data: {}, created_at: '', updated_at: '', error_log: null };
    const { client, calls } = fakeClient({ selectResult: { data: row, error: null } });
    const got = await getScopedJob(client, JOB, UNION);
    assert.equal(got?.id, JOB);
    assert.deepEqual(calls[0].filters, [['id', JOB], ['union_id', UNION], ['job_type', 'LAND_AREA_SYNC']]);
});

test('getLatestScopedJob 은 union+type+anchorPnu 로 스코프하고 created_at 내림차순 정렬한다', async () => {
    const { client, calls } = fakeClient({ selectResult: { data: null, error: null } });
    await getLatestScopedJob(client, UNION, '1168010100107360024');
    assert.deepEqual(calls[0].filters, [
        ['union_id', UNION],
        ['job_type', 'LAND_AREA_SYNC'],
        ['preview_data->landAreaSync->>anchorPnu', '1168010100107360024'],
    ]);
    assert.deepEqual(calls[0].order, ['created_at', { ascending: false }]);
});

test('writeDiscoveryTerminal 은 status=PROCESSING 에서만 전이한다(id+union+type+status)', async () => {
    const { client, calls } = fakeClient({
        selectResult: { data: { preview_data: { landAreaSync: { schemaVersion: 2, anchorPnu: 'x' } } }, error: null },
        updateResult: { data: { id: JOB }, error: null },
    });
    const ok = await writeDiscoveryTerminal(client, JOB, UNION, {
        status: 'COMPLETED', scopeState: 'REVIEW_REQUIRED', outcome: 'REVIEW_REQUIRED',
        counts: {} as never, issues: [], issuesTotal: 0, issuesTruncated: false,
    });
    assert.equal(ok, true);
    const update = calls.find((c) => c.op === 'update')!;
    assert.deepEqual(update.filters, [['id', JOB], ['union_id', UNION], ['job_type', 'LAND_AREA_SYNC'], ['status', 'PROCESSING']]);
});

test('writeAppliedIssues 는 status 를 건드리지 않고 id+union+type 스코프로 병합 issues 를 반영한다', async () => {
    const { client, calls } = fakeClient({
        // 보호 대상 6키가 이미 있는 preview 를 읽어 병합(guard 키 보존 확인).
        selectResult: {
            data: { preview_data: { landAreaSync: { schemaVersion: 2, anchorPnu: 'x', branch: 'LDAREG', scopeSnapshot: { scopeHash: 'h' } } } },
            error: null,
        },
        updateResult: { data: { id: JOB }, error: null },
    });
    const ok = await writeAppliedIssues(client, JOB, UNION, {
        scopeState: 'LINKED_SCOPE_RESOLVED',
        issues: [{ code: 'PROPERTY_UNIT_NOT_FOUND', targetPnu: '1168010100107360024' }],
        issuesTotal: 1,
        issuesTruncated: false,
    });
    assert.equal(ok, true);
    const update = calls.find((c) => c.op === 'update')!;
    // apply RPC 가 이미 COMPLETED 로 만들었으므로 status=PROCESSING 필터를 걸지 않는다.
    assert.deepEqual(update.filters, [['id', JOB], ['union_id', UNION], ['job_type', 'LAND_AREA_SYNC']]);
    const value = update.value as { preview_data: { landAreaSync: Record<string, unknown> } };
    const land = value.preview_data.landAreaSync;
    assert.equal(land.scopeState, 'LINKED_SCOPE_RESOLVED');
    assert.equal(land.issuesTotal, 1);
    assert.equal(land.issuesTruncated, false);
    assert.deepEqual(land.issues, [{ code: 'PROPERTY_UNIT_NOT_FOUND', targetPnu: '1168010100107360024' }]);
    // 보호 대상 키는 병합으로 보존된다.
    assert.equal(land.branch, 'LDAREG');
    assert.deepEqual(land.scopeSnapshot, { scopeHash: 'h' });
});

test('freezeScopeSnapshot 은 status=PROCESSING 스코프에서만 CAS 한다', async () => {
    const { client, calls } = fakeClient({
        selectResult: { data: { preview_data: { landAreaSync: { schemaVersion: 2, anchorPnu: 'x' } } }, error: null },
        updateResult: { data: { id: JOB }, error: null },
    });
    const ok = await freezeScopeSnapshot(client, JOB, UNION, {
        scopeState: 'LINKED_SCOPE_RESOLVED', scopeEvidence: {} as never, scopeSnapshot: {} as never, branch: 'LDAREG',
    });
    assert.equal(ok, true);
    const update = calls.find((c) => c.op === 'update')!;
    assert.ok(update.filters.some((f) => f[0] === 'status' && f[1] === 'PROCESSING'));
    assert.ok(update.filters.some((f) => f[0] === 'job_type' && f[1] === 'LAND_AREA_SYNC'));
});

test('markScopedFailed 은 id+union+type+status=PROCESSING 로 FAILED 를 기록한다(COMPLETED 뒤집기 차단, I3)', async () => {
    const { client, calls } = fakeClient({
        selectResult: { data: { preview_data: {} }, error: null },
        updateResult: { data: { id: JOB }, error: null },
    });
    const ok = await markScopedFailed(client, JOB, UNION, 'boom');
    assert.equal(ok, true);
    const update = calls.find((c) => c.op === 'update')!;
    const value = update.value as { status: string; error_log: string };
    assert.equal(value.status, 'FAILED');
    assert.equal(value.error_log, 'boom');
    // status=PROCESSING 스코프가 있어야 이미 COMPLETED 된 job 이 사후 조회 실패로 FAILED 로 뒤집히지 않는다.
    assert.deepEqual(update.filters, [['id', JOB], ['union_id', UNION], ['job_type', 'LAND_AREA_SYNC'], ['status', 'PROCESSING']]);
});

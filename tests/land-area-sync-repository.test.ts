import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    insertDiscoveryJob,
    getScopedJob,
    getLatestScopedJob,
    getScopedAdmissionJob,
    freezeScopeSnapshot,
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
                is(col: string, val: unknown) { rec.filters.push([col, val]); return b; },
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
    const value = rec.value as { job_type: string; preview_data: { landAreaSync: { schemaVersion: number; anchorPnu: string; sourceDiscoveryJobId: null; admissionKey: string; workerFinalization?: unknown } } };
    assert.equal(value.job_type, 'LAND_AREA_SYNC');
    assert.equal(value.preview_data.landAreaSync.schemaVersion, 2);
    assert.equal(value.preview_data.landAreaSync.anchorPnu, '1168010100107360024');
    assert.equal(value.preview_data.landAreaSync.sourceDiscoveryJobId, null);
    assert.equal(value.preview_data.landAreaSync.admissionKey, JOB);
    assert.equal(value.preview_data.landAreaSync.workerFinalization, undefined);
});

test('getScopedJob 은 id+union+type 로 스코프한다', async () => {
    const row: LandAreaSyncJobRow = { id: JOB, union_id: UNION, status: 'PROCESSING', progress: 0, preview_data: {}, created_at: '', updated_at: '', error_log: null };
    const { client, calls } = fakeClient({ selectResult: { data: row, error: null } });
    const got = await getScopedJob(client, JOB, UNION);
    assert.equal(got?.id, JOB);
    assert.deepEqual(calls[0].filters, [['id', JOB], ['union_id', UNION], ['job_type', 'LAND_AREA_SYNC']]);
});

test('getLatestScopedJob 은 활성 union+type+anchorPnu 로 스코프하고 created_at 내림차순 정렬한다', async () => {
    const { client, calls } = fakeClient({ selectResult: { data: null, error: null } });
    await getLatestScopedJob(client, UNION, '1168010100107360024');
    assert.deepEqual(calls[0].filters, [
        ['union_id', UNION],
        ['job_type', 'LAND_AREA_SYNC'],
        ['preview_data->landAreaSync->>anchorPnu', '1168010100107360024'],
        ['archived_at', null],
    ]);
    assert.deepEqual(calls[0].order, ['created_at', { ascending: false }]);
});

test('getScopedAdmissionJob 은 actual job id와 분리된 union+admissionKey로 exact 조회한다', async () => {
    const { client, calls } = fakeClient({
        selectResult: { data: null, error: null },
    });
    await getScopedAdmissionJob(client, JOB, UNION);
    assert.deepEqual(calls[0].filters, [
        ['union_id', UNION],
        ['job_type', 'LAND_AREA_SYNC'],
        ['preview_data->landAreaSync->>admissionKey', JOB],
    ]);
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

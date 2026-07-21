import assert from 'node:assert/strict';
import test from 'node:test';

import {
    persistSyncJobOrThrow,
    SyncJobPersistenceError,
    toSyncJobRouteFailure,
    verifyPersistedSyncJobOrThrow,
} from '../src/services/sync-job-admission';

const jobId = 'job-1';
const unionId = 'union-1';

async function expectPersistenceFailure(run: () => Promise<void>): Promise<void> {
    await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof SyncJobPersistenceError);
        assert.equal(error.code, 'SYNC_JOB_PERSIST_FAILED');
        assert.equal(error.jobId, jobId);
        return true;
    });
}

test('sync_jobs insert error를 fail-closed 오류로 변환한다', async () => {
    await expectPersistenceFailure(() =>
        persistSyncJobOrThrow(jobId, unionId, async () => ({
            data: null,
            error: { message: 'insert failed', code: '42501' },
        }))
    );
});

test('sync_jobs 호출 예외를 fail-closed 오류로 변환한다', async () => {
    await expectPersistenceFailure(() =>
        persistSyncJobOrThrow(jobId, unionId, async () => {
            throw new Error('network failed');
        })
    );
});

test('sync_jobs insert 결과가 없거나 id/union이 다르면 거부한다', async () => {
    const invalidRows = [
        null,
        { id: 'other-job', union_id: unionId },
        { id: jobId, union_id: 'other-union' },
    ];

    for (const data of invalidRows) {
        await expectPersistenceFailure(() =>
            persistSyncJobOrThrow(jobId, unionId, async () => ({ data, error: null }))
        );
    }
});

test('Web이 만든 기존 sync_jobs도 exact id+union 행만 admission한다', async () => {
    await verifyPersistedSyncJobOrThrow(jobId, unionId, async () => ({
        data: { id: jobId, union_id: unionId },
        error: null,
    }));

    await expectPersistenceFailure(() =>
        verifyPersistedSyncJobOrThrow(jobId, unionId, async () => ({
            data: { id: jobId, union_id: 'other-union' },
            error: null,
        }))
    );
});

test('sync_jobs 영속 실패는 모든 route에서 503과 안정된 오류 코드를 유지한다', () => {
    const persistenceError = new SyncJobPersistenceError('job-1', { message: 'db unavailable' });
    assert.deepEqual(toSyncJobRouteFailure(persistenceError), {
        status: 503,
        code: 'SYNC_JOB_PERSIST_FAILED',
        message: persistenceError.message,
    });

    assert.deepEqual(toSyncJobRouteFailure(new Error('queue failed'), 'TEST_QUEUE_FAILED'), {
        status: 500,
        code: 'TEST_QUEUE_FAILED',
        message: 'queue failed',
    });

    for (const code of [
        'BUILDING_OPERATION_ADMISSION_FINALIZE_FAILED',
        'DEFERRED_QUEUE_ADMISSION_FINALIZE_FAILED',
    ]) {
        const error = Object.assign(new Error(`${code} message`), { code });
        assert.deepEqual(toSyncJobRouteFailure(error), {
            status: 503,
            code,
            message: `${code} message`,
        });
    }
});

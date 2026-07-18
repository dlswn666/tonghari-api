import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SyncJobPersistenceError } from '../src/services/sync-job-admission';
import type { ConsentBulkUpdateRequest, ConsentUploadRequest } from '../src/types/consent.types';

process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.ALIGO_API_KEY ||= 'test-aligo-api-key';
process.env.ALIGO_USER_ID ||= 'test-aligo-user';
process.env.ALIGO_SENDER_PHONE ||= '01000000000';
process.env.DEFAULT_SENDER_KEY ||= 'test-sender-key';
process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.DEV_API_JWT_SECRET ||= 'test-development-jwt-secret';
process.env.DEV_SUPABASE_URL ||= 'http://127.0.0.1:54322';
process.env.DEV_SUPABASE_SERVICE_ROLE_KEY ||= 'test-development-service-role-key';

const consentModule = import('../src/services/consent.queue.service');

const bulkRequest: ConsentBulkUpdateRequest = {
    jobId: 'bulk-job',
    unionId: 'union-a',
    stageId: 'stage-1',
    actorUserId: 'actor-a',
    memberIds: ['member-1'],
    status: 'AGREED',
    databaseTarget: 'production',
};

const uploadRequest: ConsentUploadRequest = {
    jobId: 'upload-job',
    unionId: 'union-a',
    stageId: 'stage-1',
    actorUserId: 'actor-a',
    data: [{ rowNumber: 2, name: '홍길동', address: '미아동 1-1', status: '동의' }],
    databaseTarget: 'production',
};

test('persisted consent job 검증 실패 시 두 producer 모두 map/queue에 admission하지 않는다', async () => {
    const { ConsentQueueService } = await consentModule;

    for (const request of [bulkRequest, uploadRequest]) {
        let queueAddCount = 0;
        const service = new ConsentQueueService({
            scheduleCleanup: false,
            queue: {
                add: async () => {
                    queueAddCount += 1;
                    return undefined;
                },
            } as never,
            verifyPersistedSyncJob: (async (jobId: string) => {
                throw new SyncJobPersistenceError(jobId, { message: 'persisted row missing' });
            }) as never,
        });

        const run = 'memberIds' in request
            ? () => service.addBulkUpdateJob(request)
            : () => service.addUploadJob(request);

        await assert.rejects(run, (error: unknown) => {
            assert.ok(error instanceof SyncJobPersistenceError);
            assert.equal(error.code, 'SYNC_JOB_PERSIST_FAILED');
            return true;
        });
        assert.equal(queueAddCount, 0);
        assert.equal(service.getJobStatus(request.jobId, request.databaseTarget), undefined);
    }
});

test('persisted consent job 검증 성공 후에만 map과 queue에 admission한다', async () => {
    const { ConsentQueueService } = await consentModule;
    const callOrder: string[] = [];
    const service = new ConsentQueueService({
        scheduleCleanup: false,
        queue: {
            add: async () => {
                callOrder.push('queue');
                return undefined;
            },
        } as never,
        verifyPersistedSyncJob: (async () => {
            callOrder.push('verify');
        }) as never,
    });

    await service.addBulkUpdateJob(bulkRequest);

    assert.deepEqual(callOrder, ['verify', 'queue']);
    assert.equal(service.getJobStatus(bulkRequest.jobId, bulkRequest.databaseTarget)?.status, 'pending');
});

test('동일 job UUID도 production/development 메모리 상태를 서로 격리한다', async () => {
    const { ConsentQueueService } = await consentModule;
    const service = new ConsentQueueService({
        scheduleCleanup: false,
        queue: { add: async () => undefined } as never,
        verifyPersistedSyncJob: (async () => undefined) as never,
    });
    const jobId = 'same-job-id';

    await service.addBulkUpdateJob({
        ...bulkRequest,
        jobId,
        databaseTarget: 'production',
        memberIds: ['production-member-a', 'production-member-b'],
    });
    await service.addBulkUpdateJob({
        ...bulkRequest,
        jobId,
        databaseTarget: 'development',
        memberIds: ['development-member'],
    });

    assert.equal(service.getJobStatus(jobId, 'production')?.totalCount, 2);
    assert.equal(service.getJobStatus(jobId, 'development')?.totalCount, 1);
    assert.equal(service.getJobStatus(jobId, 'production')?.jobId, jobId);
    assert.equal(service.getJobStatus(jobId, 'development')?.jobId, jobId);
});

test('같은 target과 jobId는 두 번째 queue admission을 fail-closed한다', async () => {
    const { ConsentQueueService } = await consentModule;
    let queueAddCount = 0;
    const service = new ConsentQueueService({
        scheduleCleanup: false,
        queue: {
            add: async () => {
                queueAddCount += 1;
                return undefined;
            },
        } as never,
        verifyPersistedSyncJob: (async () => undefined) as never,
    });

    await service.addBulkUpdateJob(bulkRequest);
    await assert.rejects(
        () => service.addBulkUpdateJob(bulkRequest),
        (error: Error & { code?: string }) => error.code === 'CONSENT_JOB_ALREADY_ADMITTED'
    );
    assert.equal(queueAddCount, 1);
});

test('worker 실행 직전 권한 재검증 실패는 consent mutation 전에 job을 실패 종결한다', async () => {
    const { ConsentQueueService } = await consentModule;
    let durableFailureCount = 0;

    let authorizationChecks = 0;
    const service = new ConsentQueueService({
        scheduleCleanup: false,
        queue: {
            add: async (run: () => Promise<void>) => run(),
        } as never,
        verifyPersistedSyncJob: (async () => undefined) as never,
        assertAuthorizedAtExecution: async () => {
            authorizationChecks += 1;
            throw Object.assign(new Error('actor blocked'), {
                code: 'CONSENT_EXECUTION_FORBIDDEN',
            });
        },
        updatePersistedJob: async (_request, status) => {
            assert.equal(status, 'FAILED');
            durableFailureCount += 1;
            return true;
        },
    });

    await service.addBulkUpdateJob(bulkRequest);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const failed = service.getJobStatus(bulkRequest.jobId, bulkRequest.databaseTarget);
    assert.equal(authorizationChecks, 1);
    assert.equal(durableFailureCount, 1);
    assert.equal(failed?.status, 'failed');
    assert.ok(failed?.completedAt instanceof Date);
    assert.equal(failed?.processedCount, 0);
});

test('terminal sync_job은 consent 실패 CAS로 COMPLETED에서 FAILED로 되돌아가지 않는다', async () => {
    const { ConsentQueueService } = await consentModule;
    const { getSupabaseService } = await import('../src/services/supabase.service');
    const database = getSupabaseService('production');
    const originalGetClient = database.getClient;
    const terminalRow: Record<string, unknown> = {
        id: bulkRequest.jobId,
        union_id: bulkRequest.unionId,
        job_type: 'CONSENT_UPLOAD',
        status: 'COMPLETED',
        progress: 100,
    };
    let updatePayload: Record<string, unknown> | undefined;
    const filters: Array<[string, unknown]> = [];
    const builder = {
        update(payload: Record<string, unknown>) {
            updatePayload = payload;
            return builder;
        },
        eq(column: string, value: unknown) {
            filters.push([column, value]);
            return builder;
        },
        select() {
            return builder;
        },
        async maybeSingle() {
            const matches = filters.every(([column, value]) => terminalRow[column] === value);
            if (!matches) return { data: null, error: null };
            Object.assign(terminalRow, updatePayload);
            return { data: { ...terminalRow }, error: null };
        },
    };
    (database as unknown as { getClient: () => unknown }).getClient = () => ({
        from: () => builder,
    });
    const service = new ConsentQueueService({ scheduleCleanup: false });
    const internal = service as unknown as {
        updatePersistedSyncJobIfProcessing: (
            request: ConsentBulkUpdateRequest,
            status: 'FAILED',
            progress: number,
            errorLog: string
        ) => Promise<boolean>;
    };

    try {
        const updated = await internal.updatePersistedSyncJobIfProcessing(
            bulkRequest,
            'FAILED',
            0,
            'worker rejected'
        );
        assert.equal(updated, false);
        assert.equal(terminalRow.status, 'COMPLETED');
        assert.equal(terminalRow.progress, 100);
        assert.ok(filters.some(([column, value]) => column === 'status' && value === 'PROCESSING'));
    } finally {
        (database as unknown as { getClient: typeof originalGetClient }).getClient = originalGetClient;
    }
});

test('consent producer source가 id+union exact 조회 뒤 map/queue 순서를 지킨다', () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, '../src/services/consent.queue.service.ts'),
        'utf8'
    );

    const methodNames = ['addBulkUpdateJob', 'addUploadJob'];
    for (let index = 0; index < methodNames.length; index += 1) {
        const start = source.indexOf(`async ${methodNames[index]}`);
        const end = index + 1 < methodNames.length
            ? source.indexOf(`async ${methodNames[index + 1]}`, start)
            : source.indexOf('private async processBulkUpdateJob', start);
        const methodSource = source.slice(start, end);

        assert.ok(start >= 0, `${methodNames[index]}를 찾을 수 없습니다.`);
        assert.match(methodSource, /\.from\('sync_jobs'\)/);
        assert.match(methodSource, /\.select\('id, union_id, job_type, status'\)/);
        assert.match(methodSource, /\.eq\('id', request\.jobId\)/);
        assert.match(methodSource, /\.eq\('union_id', request\.unionId\)/);
        assert.match(methodSource, /\.eq\('job_type', CONSENT_SYNC_JOB_TYPE\)/);
        assert.match(methodSource, /\.eq\('status', 'PROCESSING'\)/);

        const verifyIndex = methodSource.indexOf('await this.verifyPersistedSyncJob');
        const mapIndex = methodSource.indexOf('this.jobs.set');
        const queueIndex = methodSource.indexOf('this.queue');
        assert.ok(verifyIndex >= 0 && verifyIndex < mapIndex && mapIndex < queueIndex);
    }
});

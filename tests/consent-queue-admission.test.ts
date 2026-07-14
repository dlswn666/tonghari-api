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

const consentModule = import('../src/services/consent.queue.service');

const bulkRequest: ConsentBulkUpdateRequest = {
    jobId: 'bulk-job',
    unionId: 'union-a',
    stageId: 'stage-1',
    memberIds: ['member-1'],
    status: 'AGREED',
};

const uploadRequest: ConsentUploadRequest = {
    jobId: 'upload-job',
    unionId: 'union-a',
    stageId: 'stage-1',
    data: [{ rowNumber: 2, name: '홍길동', address: '미아동 1-1', status: '동의' }],
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
        assert.equal(service.getJobStatus(request.jobId), undefined);
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
    assert.equal(service.getJobStatus(bulkRequest.jobId)?.status, 'pending');
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
        assert.match(methodSource, /\.select\('id, union_id'\)/);
        assert.match(methodSource, /\.eq\('id', request\.jobId\)/);
        assert.match(methodSource, /\.eq\('union_id', request\.unionId\)/);

        const verifyIndex = methodSource.indexOf('await this.verifyPersistedSyncJob');
        const mapIndex = methodSource.indexOf('this.jobs.set');
        const queueIndex = methodSource.indexOf('this.queue');
        assert.ok(verifyIndex >= 0 && verifyIndex < mapIndex && mapIndex < queueIndex);
    }
});

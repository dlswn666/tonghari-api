import assert from 'node:assert/strict';
import test from 'node:test';

import type { MemberJobInfo } from '../src/types/member.types';

Object.assign(process.env, {
    JWT_SECRET: 'test-production-jwt-secret',
    DEV_API_JWT_SECRET: 'test-development-jwt-secret',
    ALIGO_API_KEY: 'test-aligo-key',
    ALIGO_USER_ID: 'test-aligo-user',
    ALIGO_SENDER_PHONE: '0212345678',
    DEFAULT_SENDER_KEY: 'test-sender-key',
    SUPABASE_URL: 'https://member-production-ref.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-production-service-role-key',
    DEV_SUPABASE_URL: 'https://member-development-ref.supabase.co',
    DEV_SUPABASE_SERVICE_ROLE_KEY: 'test-development-service-role-key',
});

test('member queue는 동일 UUID를 target별로 격리하고 wrong-target 조회를 반환하지 않는다', async () => {
    const { MemberQueueService } = await import('../src/services/member.queue.service');
    const service = new MemberQueueService();
    const sameJobId = 'same-member-job-id';
    const productionJob: MemberJobInfo = {
        jobId: sameJobId,
        jobType: 'MEMBER_INVITE_SYNC',
        unionId: 'production-union',
        totalCount: 2,
        processedCount: 0,
        status: 'pending',
        createdAt: new Date(),
    };
    const developmentJob: MemberJobInfo = {
        ...productionJob,
        unionId: 'development-union',
        totalCount: 1,
    };
    const internals = service as unknown as {
        jobs: Map<string, MemberJobInfo>;
        jobKey: (databaseTarget: 'production' | 'development', jobId: string) => string;
    };

    internals.jobs.set(internals.jobKey('production', sameJobId), productionJob);
    internals.jobs.set(internals.jobKey('development', sameJobId), developmentJob);
    internals.jobs.set(
        internals.jobKey('production', 'production-only-job'),
        { ...productionJob, jobId: 'production-only-job' }
    );

    assert.equal(service.getJobStatus(sameJobId, 'production')?.unionId, 'production-union');
    assert.equal(service.getJobStatus(sameJobId, 'development')?.unionId, 'development-union');
    assert.equal(service.getJobStatus('production-only-job', 'development'), undefined);
});

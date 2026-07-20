import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BuildingOperationCapabilityError,
    BuildingOperationPersistenceError,
    buildBuildingOperationRpcArguments,
    persistBuildingQueueAdmissionOrThrow,
} from '../src/services/building-operation-admission';
import { finalizeDeferredQueueAdmissions } from '../src/services/deferred-queue-admission';

const unionId = '00000000-0000-4000-a000-000000000001';
const jobId = '00000000-0000-4000-b000-000000000001';
const operationId = '00000000-0000-4000-c000-000000000001';

function persistedSyncJob() {
    return Promise.resolve({ data: { id: jobId, union_id: unionId }, error: null });
}

test('operation manifest는 입력 순서와 공백 차이에도 같은 canonical hash를 만든다', () => {
    const first = buildBuildingOperationRpcArguments({
        unionId,
        jobId,
        operationKind: 'GIS_SYNC',
        explicitInputs: ['address:서울 강북구 미아동 745-62', 'address:서울 강북구 미아동 745-63'],
        sourceDeploymentVersion: 'test',
        sourceReleaseSha: null,
    });
    const second = buildBuildingOperationRpcArguments({
        unionId,
        jobId,
        operationKind: 'GIS_SYNC',
        explicitInputs: [' address:서울  강북구 미아동 745-63 ', 'address:서울 강북구 미아동 745-62'],
        sourceDeploymentVersion: 'test',
        sourceReleaseSha: null,
    });

    assert.deepEqual(first.p_explicit_input_tokens, second.p_explicit_input_tokens);
    assert.equal(first.p_source_fingerprint, second.p_source_fingerprint);
    assert.match(first.p_source_fingerprint, /^[0-9a-f]{64}$/);
});

test('development capability가 없으면 sync_jobs 저장 전 차단한다', async () => {
    const calls: string[] = [];
    await assert.rejects(
        persistBuildingQueueAdmissionOrThrow({
            databaseTarget: 'development',
            unionId,
            jobId,
            operationKind: 'GIS_SYNC',
            explicitInputs: ['address:test'],
            enabledTargets: new Set(),
            persistSyncJob: () => {
                calls.push('sync');
                return persistedSyncJob();
            },
            persistOperation: async () => {
                calls.push('operation');
                return { data: null, error: null };
            },
        }),
        BuildingOperationCapabilityError
    );
    assert.deepEqual(calls, []);
});

test('production legacy target은 sync_jobs만 저장하고 operation RPC를 호출하지 않는다', async () => {
    const calls: string[] = [];
    const result = await persistBuildingQueueAdmissionOrThrow({
        databaseTarget: 'production',
        unionId,
        jobId,
        operationKind: 'GIS_SYNC',
        explicitInputs: ['address:test'],
        enabledTargets: new Set(),
        persistSyncJob: () => {
            calls.push('sync');
            return persistedSyncJob();
        },
        persistOperation: async () => {
            calls.push('operation');
            return { data: null, error: null };
        },
    });
    assert.equal(result, null);
    assert.deepEqual(calls, ['sync']);
});

test('development target은 sync_jobs 뒤 root operation을 저장한다', async () => {
    const calls: string[] = [];
    const result = await persistBuildingQueueAdmissionOrThrow({
        databaseTarget: 'development',
        unionId,
        jobId,
        operationKind: 'GIS_SYNC',
        explicitInputs: ['address:test'],
        enabledTargets: new Set(['development']),
        persistSyncJob: () => {
            calls.push('sync');
            return persistedSyncJob();
        },
        persistOperation: async (args) => {
            calls.push('operation');
            assert.equal(args.p_sync_job_id, jobId);
            assert.equal(args.p_union_id, unionId);
            return {
                data: {
                    status: 'CREATED',
                    operation_id: operationId,
                    operation_epoch: 12,
                    request_hash: 'a'.repeat(64),
                },
                error: null,
            };
        },
    });
    assert.deepEqual(calls, ['sync', 'operation']);
    assert.equal(result?.operationId, operationId);
});

test('operation 저장 실패는 durable job을 FAILED 처리하고 admission 오류를 반환한다', async () => {
    const calls: string[] = [];
    await assert.rejects(
        persistBuildingQueueAdmissionOrThrow({
            databaseTarget: 'development',
            unionId,
            jobId,
            operationKind: 'GIS_SYNC',
            explicitInputs: ['address:test'],
            enabledTargets: new Set(['development']),
            persistSyncJob: () => {
                calls.push('sync');
                return persistedSyncJob();
            },
            persistOperation: async () => {
                calls.push('operation');
                return { data: null, error: { message: 'rpc failed', code: 'P0001' } };
            },
            markSyncJobFailed: async () => {
                calls.push('failed');
            },
        }),
        BuildingOperationPersistenceError
    );
    assert.deepEqual(calls, ['sync', 'operation', 'failed']);
});

test('묶음 prepare 일부 실패 시 commit은 0건이고 준비된 job만 FAILED 처리한다', async () => {
    const calls: string[] = [];
    const failure = new Error('prepare failed');
    await assert.rejects(
        finalizeDeferredQueueAdmissions({
            settled: [
                { status: 'fulfilled', value: { jobId: 'land', admit: async () => calls.push('admit:land') } },
                { status: 'rejected', reason: failure },
                { status: 'fulfilled', value: { jobId: 'house', admit: async () => calls.push('admit:house') } },
            ],
            markFailed: async (job) => calls.push(`failed:${job.jobId}`),
        }),
        failure
    );
    assert.deepEqual(calls, ['failed:land', 'failed:house']);
});

test('묶음 prepare 전부 성공한 뒤에만 모든 commit을 호출한다', async () => {
    const calls: string[] = [];
    const prepared = await finalizeDeferredQueueAdmissions({
        settled: [
            { status: 'fulfilled', value: { jobId: 'land', admit: async () => calls.push('admit:land') } },
            { status: 'fulfilled', value: { jobId: 'apt', admit: async () => calls.push('admit:apt') } },
            { status: 'fulfilled', value: { jobId: 'house', admit: async () => calls.push('admit:house') } },
        ],
        markFailed: async (job) => calls.push(`failed:${job.jobId}`),
    });
    assert.equal(prepared.length, 3);
    assert.deepEqual(calls, ['admit:land', 'admit:apt', 'admit:house']);
});

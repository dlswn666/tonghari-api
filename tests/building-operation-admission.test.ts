import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BuildingOperationAdmissionFinalizationError,
    BuildingOperationCapabilityError,
    BuildingOperationInputFailureFinalizationError,
    BuildingOperationInputPersistenceError,
    BuildingOperationPersistenceError,
    appendBuildingOperationInputPnuOrThrow,
    buildBuildingOperationInputPnuRpcArguments,
    buildBuildingOperationRpcArguments,
    persistBuildingOperationInputFailureOrThrow,
    persistBuildingQueueAdmissionOrThrow,
} from '../src/services/building-operation-admission';
import {
    DeferredQueueAdmissionFinalizationError,
    finalizeDeferredQueueAdmissions,
} from '../src/services/deferred-queue-admission';

const unionId = '00000000-0000-4000-a000-000000000001';
const jobId = '00000000-0000-4000-b000-000000000001';
const operationId = '00000000-0000-4000-c000-000000000001';
const pnu = '1130510100107450001';
const operationIdentity = {
    status: 'CREATED' as const,
    operationId,
    operationEpoch: 12,
    requestHash: 'a'.repeat(64),
};

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
    assert.equal(first.p_writer_contract_version, 'legacy-v1');
    assert.match(first.p_source_fingerprint, /^[0-9a-f]{64}$/);
});

test('PNU provenance는 root manifest와 같은 canonical input token 및 exact evidence를 만든다', () => {
    const explicitInput = ' address:서울  강북구 미아동 745-1 ';
    const root = buildBuildingOperationRpcArguments({
        unionId,
        jobId,
        operationKind: 'GIS_SYNC',
        explicitInputs: [explicitInput],
        sourceDeploymentVersion: 'test',
        sourceReleaseSha: null,
    });
    const input = buildBuildingOperationInputPnuRpcArguments({
        operationIdentity,
        unionId,
        pnu,
        explicitInput,
    });

    assert.equal(input.p_input_token_hash, root.p_explicit_input_tokens[0]);
    assert.equal(input.p_normalized_input, 'address:서울 강북구 미아동 745-1');
    assert.deepEqual(input.p_resolution_evidence, {
        input_token_hash: input.p_input_token_hash,
        pnu,
        normalized_input: input.p_normalized_input,
    });
});

test('production legacy operation identity가 없으면 input PNU RPC를 호출하지 않는다', async () => {
    let calls = 0;
    const result = await appendBuildingOperationInputPnuOrThrow({
        operationIdentity: null,
        unionId,
        jobId,
        pnu,
        explicitInput: 'address:서울 강북구 미아동 745-1',
        persistInput: async () => {
            calls++;
            return { data: null, error: null };
        },
    });

    assert.equal(result, null);
    assert.equal(calls, 0);
});

test('development operation identity는 input PNU identity까지 검증해 worker에 반환한다', async () => {
    const result = await appendBuildingOperationInputPnuOrThrow({
        operationIdentity,
        unionId,
        jobId,
        pnu,
        explicitInput: 'address:서울 강북구 미아동 745-1',
        persistInput: async (args) => ({
            data: {
                status: 'CREATED',
                operation_id: args.p_operation_id,
                pnu: args.p_pnu,
                input_token_hash: args.p_input_token_hash,
                resolution_evidence_hash: 'b'.repeat(64),
            },
            error: null,
        }),
    });

    assert.equal(result?.operationId, operationId);
    assert.equal(result?.pnu, pnu);
    assert.match(result?.inputTokenHash ?? '', /^[0-9a-f]{64}$/);
});

test('input PNU RPC 실패와 응답 identity mismatch는 fail-closed 오류로 변환한다', async () => {
    await assert.rejects(
        appendBuildingOperationInputPnuOrThrow({
            operationIdentity,
            unionId,
            jobId,
            pnu,
            explicitInput: 'address:서울 강북구 미아동 745-1',
            persistInput: async () => ({
                data: null,
                error: { message: 'append failed', code: 'P0001' },
            }),
        }),
        BuildingOperationInputPersistenceError
    );

    await assert.rejects(
        appendBuildingOperationInputPnuOrThrow({
            operationIdentity,
            unionId,
            jobId,
            pnu,
            explicitInput: 'address:서울 강북구 미아동 745-1',
            persistInput: async (args) => ({
                data: {
                    status: 'REUSED',
                    operation_id: '00000000-0000-4000-c000-000000000099',
                    pnu: args.p_pnu,
                    input_token_hash: args.p_input_token_hash,
                    resolution_evidence_hash: 'c'.repeat(64),
                },
                error: null,
            }),
        }),
        BuildingOperationInputPersistenceError
    );
});

test('input PNU 실패 상태는 bounded retry로 durable FAILED를 저장한다', async () => {
    let calls = 0;
    await persistBuildingOperationInputFailureOrThrow({
        jobId,
        pnu,
        persistFailed: async () => ++calls === 3,
    });

    assert.equal(calls, 3);
});

test('input PNU FAILED 저장이 끝까지 실패하면 worker용 fatal 오류를 반환한다', async () => {
    let calls = 0;
    await assert.rejects(
        persistBuildingOperationInputFailureOrThrow({
            jobId,
            pnu,
            persistFailed: async () => {
                calls++;
                return false;
            },
        }),
        BuildingOperationInputFailureFinalizationError
    );

    assert.equal(calls, 3);
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
            markSyncJobFailed: async () => true,
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
        markSyncJobFailed: async () => true,
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
        markSyncJobFailed: async () => true,
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
                return true;
            },
        }),
        BuildingOperationPersistenceError
    );
    assert.deepEqual(calls, ['sync', 'operation', 'failed']);
});

test('operation 실패 뒤 FAILED update가 false면 원본과 종결 실패를 보존하고 admission하지 않는다', async () => {
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
                return false;
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof BuildingOperationAdmissionFinalizationError);
            assert.equal(error.code, 'BUILDING_OPERATION_ADMISSION_FINALIZE_FAILED');
            assert.match(error.admissionFailure.message, /rpc failed/);
            assert.match(error.message, /updateSyncJobStatus가 false/);
            return true;
        }
    );
    assert.deepEqual(calls, ['sync', 'operation', 'failed', 'failed', 'failed']);
    assert.doesNotMatch(calls.join(','), /admit/);
});

test('operation 실패 뒤 FAILED update 예외도 원본과 종결 예외를 함께 노출한다', async () => {
    let finalizationAttempts = 0;
    await assert.rejects(
        persistBuildingQueueAdmissionOrThrow({
            databaseTarget: 'development',
            unionId,
            jobId,
            operationKind: 'GIS_SYNC',
            explicitInputs: ['address:test'],
            enabledTargets: new Set(['development']),
            persistSyncJob: persistedSyncJob,
            persistOperation: async () => ({
                data: null,
                error: { message: 'rpc failed', code: 'P0001' },
            }),
            markSyncJobFailed: async () => {
                finalizationAttempts++;
                throw new Error('status update exploded');
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof BuildingOperationAdmissionFinalizationError);
            assert.match(error.message, /rpc failed/);
            assert.match(error.message, /status update exploded/);
            assert.ok(error.finalizationCause instanceof Error);
            assert.equal(error.finalizationCause.message, 'status update exploded');
            return true;
        }
    );
    assert.equal(finalizationAttempts, 3);
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
            markFailed: async (job) => {
                calls.push(`failed:${job.jobId}`);
                return true;
            },
        }),
        failure
    );
    assert.deepEqual(calls, ['failed:land', 'failed:house']);
});

test('묶음 prepare 실패의 sibling FAILED update false/예외를 모두 수집하고 commit하지 않는다', async () => {
    const calls: string[] = [];
    const failure = new Error('prepare failed');
    await assert.rejects(
        finalizeDeferredQueueAdmissions({
            settled: [
                { status: 'fulfilled', value: { jobId: 'land', admit: async () => calls.push('admit:land') } },
                { status: 'rejected', reason: failure },
                { status: 'fulfilled', value: { jobId: 'house', admit: async () => calls.push('admit:house') } },
            ],
            markFailed: async (job) => {
                calls.push(`failed:${job.jobId}`);
                if (job.jobId === 'land') return false;
                throw new Error('status update exploded');
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof DeferredQueueAdmissionFinalizationError);
            assert.equal(error.code, 'DEFERRED_QUEUE_ADMISSION_FINALIZE_FAILED');
            assert.equal(error.prepareFailure, failure);
            assert.deepEqual(
                error.finalizationFailures.map(({ jobId }) => jobId).sort(),
                ['house', 'land']
            );
            assert.match(error.message, /prepare failed/);
            assert.match(error.message, /updateSyncJobStatus가 false/);
            assert.match(error.message, /status update exploded/);
            return true;
        }
    );
    assert.equal(calls.filter((call) => call === 'failed:land').length, 3);
    assert.equal(calls.filter((call) => call === 'failed:house').length, 3);
    assert.equal(calls.some((call) => call.startsWith('admit:')), false);
});

test('묶음 prepare 전부 성공한 뒤에만 모든 commit을 호출한다', async () => {
    const calls: string[] = [];
    const prepared = await finalizeDeferredQueueAdmissions({
        settled: [
            { status: 'fulfilled', value: { jobId: 'land', admit: async () => calls.push('admit:land') } },
            { status: 'fulfilled', value: { jobId: 'apt', admit: async () => calls.push('admit:apt') } },
            { status: 'fulfilled', value: { jobId: 'house', admit: async () => calls.push('admit:house') } },
        ],
        markFailed: async (job) => {
            calls.push(`failed:${job.jobId}`);
            return true;
        },
    });
    assert.equal(prepared.length, 3);
    assert.deepEqual(calls, ['admit:land', 'admit:apt', 'admit:house']);
});

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseTarget } from '../types/database.types';
import { persistSyncJobOrThrow } from './sync-job-admission';

export type BuildingOperationKind =
    | 'GIS_SYNC'
    | 'APART_HOUSING_PRICE_SYNC'
    | 'INDIVIDUAL_HOUSING_PRICE_SYNC';

interface OperationRpcError {
    message: string;
    code?: string;
}

interface OperationRpcResult {
    data: unknown;
    error: OperationRpcError | null;
}

export async function persistBuildingWriteOperation(
    client: SupabaseClient,
    args: BuildingOperationRpcArguments
): Promise<OperationRpcResult> {
    return client.rpc('create_building_write_operation', args);
}

export interface BuildingOperationIdentity {
    status: 'CREATED' | 'REUSED';
    operationId: string;
    operationEpoch: number;
    requestHash: string;
}

export interface BuildingOperationRpcArguments {
    p_union_id: string;
    p_operation_kind: BuildingOperationKind;
    p_execution_mode: 'STANDARD' | 'RELATION_OBSERVATION_ONLY';
    p_source_deployment_version: string;
    p_writer_contract_version: string;
    p_source_fingerprint: string;
    p_explicit_input_tokens: string[];
    p_source_release_sha: string | null;
    p_sync_job_id: string;
    p_idempotency_key: null;
    p_actor_user_id: null;
}

export class BuildingOperationCapabilityError extends Error {
    readonly code = 'BUILDING_OPERATION_CAPABILITY_DISABLED';

    constructor(databaseTarget: DatabaseTarget) {
        super(`${databaseTarget} DB의 building operation capability가 활성화되지 않았습니다.`);
        this.name = 'BuildingOperationCapabilityError';
    }
}

export class BuildingOperationPersistenceError extends Error {
    readonly code = 'BUILDING_OPERATION_PERSIST_FAILED';
    readonly jobId: string;

    constructor(jobId: string, cause: OperationRpcError) {
        super(`building operation 저장 실패 (${jobId}): ${cause.message}`);
        this.name = 'BuildingOperationPersistenceError';
        this.jobId = jobId;
    }
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function canonicalInput(value: string): string {
    return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildBuildingOperationRpcArguments(input: {
    unionId: string;
    jobId: string;
    operationKind: BuildingOperationKind;
    explicitInputs: string[];
    executionMode?: 'STANDARD' | 'RELATION_OBSERVATION_ONLY';
    sourceDeploymentVersion?: string;
    sourceReleaseSha?: string | null;
}): BuildingOperationRpcArguments {
    const explicitInputTokens = Array.from(new Set(
        input.explicitInputs
            .map(canonicalInput)
            .filter(Boolean)
            .map((value) => sha256(value))
    )).sort();

    const sourceFingerprint = sha256(
        JSON.stringify({
            operationKind: input.operationKind,
            unionId: input.unionId,
            explicitInputTokens,
        })
    );
    const deploymentVersion = input.sourceDeploymentVersion?.trim()
        || process.env.GIT_SHA?.trim()
        || 'unknown';
    const releaseCandidate = input.sourceReleaseSha ?? process.env.GIT_SHA ?? null;
    const sourceReleaseSha = releaseCandidate && /^[0-9a-f]{7,64}$/.test(releaseCandidate)
        ? releaseCandidate
        : null;

    return {
        p_union_id: input.unionId,
        p_operation_kind: input.operationKind,
        p_execution_mode: input.executionMode ?? 'STANDARD',
        p_source_deployment_version: deploymentVersion,
        p_writer_contract_version: 'building-writer-v1',
        p_source_fingerprint: sourceFingerprint,
        p_explicit_input_tokens: explicitInputTokens,
        p_source_release_sha: sourceReleaseSha,
        p_sync_job_id: input.jobId,
        p_idempotency_key: null,
        p_actor_user_id: null,
    };
}

export function buildingOperationEnabledForTarget(
    databaseTarget: DatabaseTarget,
    enabledTargets: ReadonlySet<DatabaseTarget>
): boolean {
    if (databaseTarget === 'development' && !enabledTargets.has('development')) {
        throw new BuildingOperationCapabilityError(databaseTarget);
    }
    return enabledTargets.has(databaseTarget);
}

function normalizeOperationIdentity(jobId: string, result: OperationRpcResult): BuildingOperationIdentity {
    if (result.error) {
        throw new BuildingOperationPersistenceError(jobId, result.error);
    }

    const value = result.data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BuildingOperationPersistenceError(jobId, {
            message: 'operation RPC 응답이 object가 아닙니다.',
        });
    }
    const row = value as Record<string, unknown>;
    if (
        (row.status !== 'CREATED' && row.status !== 'REUSED')
        || typeof row.operation_id !== 'string'
        || !Number.isInteger(row.operation_epoch)
        || typeof row.request_hash !== 'string'
        || !/^[0-9a-f]{64}$/.test(row.request_hash)
    ) {
        throw new BuildingOperationPersistenceError(jobId, {
            message: 'operation RPC 응답 identity가 잘못되었습니다.',
        });
    }

    return {
        status: row.status,
        operationId: row.operation_id,
        operationEpoch: row.operation_epoch as number,
        requestHash: row.request_hash,
    };
}

/**
 * DB target capability 확인 → sync_jobs → root operation 순서가 끝난 뒤에만
 * 호출자가 memory jobs map/queue admission을 수행할 수 있다.
 */
export async function persistBuildingQueueAdmissionOrThrow(input: {
    databaseTarget: DatabaseTarget;
    unionId: string;
    jobId: string;
    operationKind: BuildingOperationKind;
    explicitInputs: string[];
    executionMode?: 'STANDARD' | 'RELATION_OBSERVATION_ONLY';
    enabledTargets: ReadonlySet<DatabaseTarget>;
    persistSyncJob: () => PromiseLike<{
        data: { id: string; union_id: string } | null;
        error: { message: string; code?: string } | null;
    }>;
    persistOperation: (args: BuildingOperationRpcArguments) => PromiseLike<OperationRpcResult>;
    markSyncJobFailed?: (message: string) => PromiseLike<unknown>;
}): Promise<BuildingOperationIdentity | null> {
    const operationEnabled = buildingOperationEnabledForTarget(
        input.databaseTarget,
        input.enabledTargets
    );

    await persistSyncJobOrThrow(input.jobId, input.unionId, input.persistSyncJob);
    if (!operationEnabled) return null;

    const args = buildBuildingOperationRpcArguments({
        unionId: input.unionId,
        jobId: input.jobId,
        operationKind: input.operationKind,
        explicitInputs: input.explicitInputs,
        executionMode: input.executionMode,
    });

    try {
        return normalizeOperationIdentity(
            input.jobId,
            await input.persistOperation(args)
        );
    } catch (error) {
        const failure = error instanceof BuildingOperationPersistenceError
            ? error
            : new BuildingOperationPersistenceError(input.jobId, {
                  message: error instanceof Error ? error.message : '알 수 없는 operation 오류',
              });
        try {
            await input.markSyncJobFailed?.(failure.message);
        } catch {
            // 원래 operation 실패를 보존한다. durable job 보정 실패는 상위 로그에서 함께 진단한다.
        }
        throw failure;
    }
}

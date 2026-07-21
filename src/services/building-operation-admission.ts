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

export interface BuildingOperationInputRpcArguments {
    p_operation_id: string;
    p_union_id: string;
    p_pnu: string;
    p_input_token_hash: string;
    p_normalized_input: string;
    p_resolution_evidence: {
        input_token_hash: string;
        pnu: string;
        normalized_input: string;
    };
}

export interface BuildingOperationInputIdentity {
    status: 'CREATED' | 'REUSED';
    operationId: string;
    pnu: string;
    inputTokenHash: string;
    resolutionEvidenceHash: string;
}

export async function persistBuildingWriteOperation(
    client: SupabaseClient,
    args: BuildingOperationRpcArguments
): Promise<OperationRpcResult> {
    return client.rpc('create_building_write_operation', args);
}

export async function persistBuildingWriteOperationInputPnu(
    client: SupabaseClient,
    args: BuildingOperationInputRpcArguments
): Promise<OperationRpcResult> {
    return client.rpc('append_building_write_operation_input_pnu', args);
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

export class BuildingOperationAdmissionFinalizationError extends Error {
    readonly code = 'BUILDING_OPERATION_ADMISSION_FINALIZE_FAILED';
    readonly jobId: string;
    readonly admissionFailure: BuildingOperationPersistenceError;
    readonly finalizationCause: unknown;

    constructor(
        jobId: string,
        admissionFailure: BuildingOperationPersistenceError,
        finalizationCause: unknown
    ) {
        const finalizationMessage = finalizationCause instanceof Error
            ? finalizationCause.message
            : String(finalizationCause ?? '알 수 없는 FAILED 종결 오류');
        super(
            `${admissionFailure.message}; sync_jobs FAILED 종결 실패 (${jobId}): ${finalizationMessage}`,
            { cause: admissionFailure }
        );
        this.name = 'BuildingOperationAdmissionFinalizationError';
        this.jobId = jobId;
        this.admissionFailure = admissionFailure;
        this.finalizationCause = finalizationCause;
    }
}

export class BuildingOperationInputPersistenceError extends Error {
    readonly code = 'BUILDING_OPERATION_INPUT_PERSIST_FAILED';
    readonly jobId: string;
    readonly pnu: string;

    constructor(jobId: string, pnu: string, cause: OperationRpcError) {
        super(`building operation input PNU 저장 실패 (${jobId}/${pnu}): ${cause.message}`);
        this.name = 'BuildingOperationInputPersistenceError';
        this.jobId = jobId;
        this.pnu = pnu;
    }
}

export class BuildingOperationInputFailureFinalizationError extends Error {
    readonly code = 'BUILDING_OPERATION_INPUT_FAILURE_FINALIZE_FAILED';
    readonly jobId: string;
    readonly pnu: string;

    constructor(jobId: string, pnu: string) {
        super(`building operation input 실패 상태 저장 실패 (${jobId}/${pnu})`);
        this.name = 'BuildingOperationInputFailureFinalizationError';
        this.jobId = jobId;
        this.pnu = pnu;
    }
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function canonicalBuildingOperationInput(value: string): string {
    return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildBuildingOperationInputToken(value: string): {
    normalizedInput: string;
    inputTokenHash: string;
} {
    const normalizedInput = canonicalBuildingOperationInput(value);
    return {
        normalizedInput,
        inputTokenHash: sha256(normalizedInput),
    };
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
            .map(canonicalBuildingOperationInput)
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
        p_writer_contract_version: 'legacy-v1',
        p_source_fingerprint: sourceFingerprint,
        p_explicit_input_tokens: explicitInputTokens,
        p_source_release_sha: sourceReleaseSha,
        p_sync_job_id: input.jobId,
        p_idempotency_key: null,
        p_actor_user_id: null,
    };
}

export function buildBuildingOperationInputPnuRpcArguments(input: {
    operationIdentity: BuildingOperationIdentity;
    unionId: string;
    pnu: string;
    explicitInput: string;
}): BuildingOperationInputRpcArguments {
    const { normalizedInput, inputTokenHash } = buildBuildingOperationInputToken(
        input.explicitInput
    );
    const resolutionEvidence = {
        input_token_hash: inputTokenHash,
        pnu: input.pnu,
        normalized_input: normalizedInput,
    };

    return {
        p_operation_id: input.operationIdentity.operationId,
        p_union_id: input.unionId,
        p_pnu: input.pnu,
        p_input_token_hash: inputTokenHash,
        p_normalized_input: normalizedInput,
        p_resolution_evidence: resolutionEvidence,
    };
}

function normalizeOperationInputIdentity(
    jobId: string,
    pnu: string,
    result: OperationRpcResult
): BuildingOperationInputIdentity {
    if (result.error) {
        throw new BuildingOperationInputPersistenceError(jobId, pnu, result.error);
    }

    const value = result.data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BuildingOperationInputPersistenceError(jobId, pnu, {
            message: 'operation input RPC 응답이 object가 아닙니다.',
        });
    }
    const row = value as Record<string, unknown>;
    if (
        (row.status !== 'CREATED' && row.status !== 'REUSED')
        || typeof row.operation_id !== 'string'
        || row.pnu !== pnu
        || typeof row.input_token_hash !== 'string'
        || !/^[0-9a-f]{64}$/.test(row.input_token_hash)
        || typeof row.resolution_evidence_hash !== 'string'
        || !/^[0-9a-f]{64}$/.test(row.resolution_evidence_hash)
    ) {
        throw new BuildingOperationInputPersistenceError(jobId, pnu, {
            message: 'operation input RPC 응답 identity가 잘못되었습니다.',
        });
    }

    return {
        status: row.status,
        operationId: row.operation_id,
        pnu,
        inputTokenHash: row.input_token_hash,
        resolutionEvidenceHash: row.resolution_evidence_hash,
    };
}

/**
 * Phase A에서 명시 입력이 PNU로 해소된 직후 호출한다.
 * operation identity가 null인 production legacy target은 RPC를 호출하지 않는다.
 */
export async function appendBuildingOperationInputPnuOrThrow(input: {
    operationIdentity: BuildingOperationIdentity | null;
    unionId: string;
    jobId: string;
    pnu: string;
    explicitInput: string;
    persistInput: (args: BuildingOperationInputRpcArguments) => PromiseLike<OperationRpcResult>;
}): Promise<BuildingOperationInputIdentity | null> {
    if (!input.operationIdentity) return null;

    const args = buildBuildingOperationInputPnuRpcArguments({
        operationIdentity: input.operationIdentity,
        unionId: input.unionId,
        pnu: input.pnu,
        explicitInput: input.explicitInput,
    });

    try {
        const identity = normalizeOperationInputIdentity(
            input.jobId,
            input.pnu,
            await input.persistInput(args)
        );
        if (
            identity.operationId !== input.operationIdentity.operationId
            || identity.inputTokenHash !== args.p_input_token_hash
        ) {
            throw new BuildingOperationInputPersistenceError(input.jobId, input.pnu, {
                message: 'operation input RPC 응답이 요청 identity와 일치하지 않습니다.',
            });
        }
        return identity;
    } catch (error) {
        if (error instanceof BuildingOperationInputPersistenceError) throw error;
        throw new BuildingOperationInputPersistenceError(input.jobId, input.pnu, {
            message: error instanceof Error ? error.message : '알 수 없는 operation input 오류',
        });
    }
}

/**
 * input provenance 실패 뒤 sync_jobs를 FAILED로 고정한다. 모든 시도가 실패하면
 * worker가 일반 주소 오류로 삼키지 않도록 별도 fatal 오류를 반환한다.
 */
export async function persistBuildingOperationInputFailureOrThrow(input: {
    jobId: string;
    pnu: string;
    persistFailed: () => PromiseLike<boolean>;
    maxAttempts?: number;
}): Promise<void> {
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
        throw new RangeError('maxAttempts는 1~5 정수여야 합니다.');
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (await input.persistFailed()) return;
        } catch {
            // 다음 bounded attempt에서 다시 시도한다.
        }
    }

    throw new BuildingOperationInputFailureFinalizationError(input.jobId, input.pnu);
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

async function finalizeBuildingOperationAdmissionFailureOrThrow(input: {
    jobId: string;
    failure: BuildingOperationPersistenceError;
    markSyncJobFailed: (message: string) => PromiseLike<boolean>;
}): Promise<void> {
    let finalizationCause: unknown = new Error(
        'updateSyncJobStatus가 false를 반환했습니다.'
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (await input.markSyncJobFailed(input.failure.message) === true) return;
            finalizationCause = new Error(
                'updateSyncJobStatus가 false를 반환했습니다.'
            );
        } catch (error) {
            finalizationCause = error;
        }
    }

    throw new BuildingOperationAdmissionFinalizationError(
        input.jobId,
        input.failure,
        finalizationCause
    );
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
    markSyncJobFailed: (message: string) => PromiseLike<boolean>;
}): Promise<BuildingOperationIdentity | null> {
    const operationEnabled = buildingOperationEnabledForTarget(
        input.databaseTarget,
        input.enabledTargets
    );

    await persistSyncJobOrThrow(input.jobId, input.unionId, input.persistSyncJob);
    if (!operationEnabled) return null;

    try {
        const args = buildBuildingOperationRpcArguments({
            unionId: input.unionId,
            jobId: input.jobId,
            operationKind: input.operationKind,
            explicitInputs: input.explicitInputs,
            executionMode: input.executionMode,
        });
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

        await finalizeBuildingOperationAdmissionFailureOrThrow({
            jobId: input.jobId,
            failure,
            markSyncJobFailed: input.markSyncJobFailed,
        });
        throw failure;
    }
}

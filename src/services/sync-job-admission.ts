export interface SyncJobInsertError {
    message: string;
    code?: string;
}

export class SyncJobPersistenceError extends Error {
    readonly code = 'SYNC_JOB_PERSIST_FAILED';
    readonly jobId: string;

    constructor(jobId: string, cause: SyncJobInsertError) {
        super(`sync_jobs 저장 실패 (${jobId}): ${cause.message}`);
        this.name = 'SyncJobPersistenceError';
        this.jobId = jobId;
    }
}

export interface PersistedSyncJobIdentity {
    id: string;
    union_id: string;
}

export interface SyncJobRouteFailure {
    status: 500 | 503;
    code: string;
    message: string;
}

/** queue producer 오류를 HTTP 경계에서 동일한 계약으로 노출한다. */
export function toSyncJobRouteFailure(
    error: unknown,
    fallbackCode = 'QUEUE_JOB_START_FAILED'
): SyncJobRouteFailure {
    const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : fallbackCode;

    return {
        status: [
            'SYNC_JOB_PERSIST_FAILED',
            'BUILDING_OPERATION_PERSIST_FAILED',
            'BUILDING_OPERATION_CAPABILITY_DISABLED',
        ].includes(code) ? 503 : 500,
        code,
        message: error instanceof Error ? error.message : 'Internal server error.',
    };
}

type SyncJobIdentityResult = {
    data: PersistedSyncJobIdentity | null;
    error: SyncJobInsertError | null;
};

function normalizeSyncJobError(error: unknown): SyncJobInsertError {
    if (error instanceof Error) {
        return { message: error.message };
    }

    if (typeof error === 'object' && error !== null && 'message' in error) {
        const value = error as { message?: unknown; code?: unknown };
        return {
            message: typeof value.message === 'string' ? value.message : '알 수 없는 sync_jobs 오류',
            code: typeof value.code === 'string' ? value.code : undefined,
        };
    }

    return { message: '알 수 없는 sync_jobs 오류' };
}

async function resolveSyncJobIdentityOrThrow<T extends SyncJobIdentityResult>(
    jobId: string,
    unionId: string,
    resolve: () => PromiseLike<T>
): Promise<void> {
    let result: T;
    try {
        result = await resolve();
    } catch (error) {
        throw new SyncJobPersistenceError(jobId, normalizeSyncJobError(error));
    }

    if (result.error) {
        throw new SyncJobPersistenceError(jobId, result.error);
    }

    if (!result.data || result.data.id !== jobId || result.data.union_id !== unionId) {
        throw new SyncJobPersistenceError(jobId, {
            code: 'SYNC_JOB_IDENTITY_MISMATCH',
            message: '저장된 작업의 id 또는 union_id가 요청과 일치하지 않습니다.',
        });
    }
}

/**
 * 영속 작업 원장이 생성된 뒤에만 메모리 map/queue admission을 허용한다.
 */
export async function persistSyncJobOrThrow<
    T extends SyncJobIdentityResult
>(
    jobId: string,
    unionId: string,
    persist: () => PromiseLike<T>
): Promise<void> {
    await resolveSyncJobIdentityOrThrow(jobId, unionId, persist);
}

/**
 * Web이 먼저 만든 sync_jobs 원장이 요청의 id/union과 정확히 일치할 때만
 * API의 메모리 queue admission을 허용한다.
 */
export async function verifyPersistedSyncJobOrThrow<
    T extends SyncJobIdentityResult
>(
    jobId: string,
    unionId: string,
    load: () => PromiseLike<T>
): Promise<void> {
    await resolveSyncJobIdentityOrThrow(jobId, unionId, load);
}

export interface DeferredQueueAdmission {
    jobId: string;
    admit: () => Promise<void>;
}

export interface DeferredQueueAdmissionFinalizationFailure {
    jobId: string;
    cause: unknown;
}

export class DeferredQueueAdmissionFinalizationError extends Error {
    readonly code = 'DEFERRED_QUEUE_ADMISSION_FINALIZE_FAILED';
    readonly prepareFailure: unknown;
    readonly finalizationFailures: DeferredQueueAdmissionFinalizationFailure[];

    constructor(
        prepareFailure: unknown,
        finalizationFailures: DeferredQueueAdmissionFinalizationFailure[]
    ) {
        const prepareMessage = prepareFailure instanceof Error
            ? prepareFailure.message
            : String(prepareFailure ?? '알 수 없는 durable prepare 오류');
        const finalizationMessage = finalizationFailures
            .map(({ jobId, cause }) => {
                const causeMessage = cause instanceof Error
                    ? cause.message
                    : String(cause ?? '알 수 없는 FAILED 종결 오류');
                return `${jobId}: ${causeMessage}`;
            })
            .join('; ');
        super(
            `durable prepare 실패: ${prepareMessage}; sync_jobs FAILED 종결 실패: ${finalizationMessage}`,
            { cause: prepareFailure }
        );
        this.name = 'DeferredQueueAdmissionFinalizationError';
        this.prepareFailure = prepareFailure;
        this.finalizationFailures = finalizationFailures;
    }
}

async function markPreparedJobFailedOrThrow<T extends DeferredQueueAdmission>(input: {
    job: T;
    markFailed: (job: T) => PromiseLike<boolean>;
}): Promise<void> {
    let finalizationCause: unknown = new Error(
        'updateSyncJobStatus가 false를 반환했습니다.'
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (await input.markFailed(input.job) === true) return;
            finalizationCause = new Error(
                'updateSyncJobStatus가 false를 반환했습니다.'
            );
        } catch (error) {
            finalizationCause = error;
        }
    }

    throw finalizationCause;
}

/**
 * 여러 durable prepare가 모두 성공한 경우에만 memory admission을 한 번에 연다.
 * 일부 실패 시 성공한 prepare 원장은 FAILED로 종결하고 admit은 한 건도 호출하지 않는다.
 */
export async function finalizeDeferredQueueAdmissions<T extends DeferredQueueAdmission>(input: {
    settled: PromiseSettledResult<T>[];
    markFailed: (job: T) => PromiseLike<boolean>;
}): Promise<T[]> {
    const prepared = input.settled
        .filter((result): result is PromiseFulfilledResult<T> => result.status === 'fulfilled')
        .map((result) => result.value);
    const rejected = input.settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    if (rejected) {
        const finalizationResults = await Promise.allSettled(
            prepared.map((job) => markPreparedJobFailedOrThrow({
                job,
                markFailed: input.markFailed,
            }))
        );
        const finalizationFailures = finalizationResults.flatMap((result, index) =>
            result.status === 'rejected'
                ? [{ jobId: prepared[index].jobId, cause: result.reason }]
                : []
        );
        if (finalizationFailures.length > 0) {
            throw new DeferredQueueAdmissionFinalizationError(
                rejected.reason,
                finalizationFailures
            );
        }
        throw rejected.reason;
    }

    await Promise.all(prepared.map((job) => job.admit()));
    return prepared;
}

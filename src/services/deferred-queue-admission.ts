export interface DeferredQueueAdmission {
    jobId: string;
    admit: () => Promise<void>;
}

/**
 * 여러 durable prepare가 모두 성공한 경우에만 memory admission을 한 번에 연다.
 * 일부 실패 시 성공한 prepare 원장은 FAILED로 종결하고 admit은 한 건도 호출하지 않는다.
 */
export async function finalizeDeferredQueueAdmissions<T extends DeferredQueueAdmission>(input: {
    settled: PromiseSettledResult<T>[];
    markFailed: (job: T) => PromiseLike<unknown>;
}): Promise<T[]> {
    const prepared = input.settled
        .filter((result): result is PromiseFulfilledResult<T> => result.status === 'fulfilled')
        .map((result) => result.value);
    const rejected = input.settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    if (rejected) {
        await Promise.allSettled(prepared.map((job) => input.markFailed(job)));
        throw rejected.reason;
    }

    await Promise.all(prepared.map((job) => job.admit()));
    return prepared;
}

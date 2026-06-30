import { MemberJobStatus, PreRegisterResult } from '../types/member.types';

export interface PreRegisterCompletionInput {
    totalCount: number;
    matchedCount: number;
    unmatchedCount: number;
    savedCount: number;
    updatedCount: number;
    duplicateCount: number;
    propertyLinkCreatedCount: number;
    propertyLinkUpdatedCount: number;
    propertyLinkFailedCount: number;
    errors: string[];
}

export interface PreRegisterCompletion {
    finalStatus: MemberJobStatus;
    persistedStatus: 'COMPLETED' | 'FAILED';
    result: PreRegisterResult;
}

export function buildPreRegisterCompletion(input: PreRegisterCompletionInput): PreRegisterCompletion {
    const hasFailures =
        input.unmatchedCount > 0 ||
        input.propertyLinkFailedCount > 0 ||
        input.errors.length > 0;

    const result: PreRegisterResult = {
        success: !hasFailures,
        totalCount: input.totalCount,
        matchedCount: input.matchedCount,
        unmatchedCount: input.unmatchedCount,
        savedCount: input.savedCount,
        updatedCount: input.updatedCount,
        duplicateCount: input.duplicateCount,
        propertyLinkCreatedCount: input.propertyLinkCreatedCount,
        propertyLinkUpdatedCount: input.propertyLinkUpdatedCount,
        propertyLinkFailedCount: input.propertyLinkFailedCount,
        errors: input.errors.slice(0, 100),
    };

    return {
        finalStatus: result.success ? 'completed' : 'failed',
        persistedStatus: result.success ? 'COMPLETED' : 'FAILED',
        result,
    };
}

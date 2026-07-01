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
    const propertyLinkCount = input.propertyLinkCreatedCount + input.propertyLinkUpdatedCount;
    const hasSuccessfulUserWrite = input.savedCount > 0 || input.updatedCount > 0;
    const missingPropertyLinks =
        input.matchedCount > 0 &&
        hasSuccessfulUserWrite &&
        propertyLinkCount === 0 &&
        input.propertyLinkFailedCount === 0;
    const errors = input.errors.slice(0, 100);
    if (missingPropertyLinks) {
        errors.unshift(
            'property_units/property_ownerships link count is zero after PRE_REGISTER user writes. Check deployed API version and ownership linking path.'
        );
    }

    const hasFailures =
        input.unmatchedCount > 0 ||
        input.propertyLinkFailedCount > 0 ||
        errors.length > 0;

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
        errors,
    };

    return {
        finalStatus: result.success ? 'completed' : 'failed',
        persistedStatus: result.success ? 'COMPLETED' : 'FAILED',
        result,
    };
}

import assert from 'node:assert/strict';
import { getAutoOwnershipRatio } from '../src/services/member.pre-register-ownership';
import { buildPreRegisterCompletion } from '../src/services/member.pre-register-result';

{
    const completion = buildPreRegisterCompletion({
        totalCount: 2,
        matchedCount: 2,
        unmatchedCount: 0,
        savedCount: 1,
        updatedCount: 0,
        duplicateCount: 0,
        propertyLinkCreatedCount: 0,
        propertyLinkUpdatedCount: 0,
        propertyLinkFailedCount: 2,
        errors: ['홍길동: property relation failed'],
    });

    assert.equal(completion.finalStatus, 'failed');
    assert.equal(completion.persistedStatus, 'FAILED');
    assert.equal(completion.result.success, false);
    assert.equal(completion.result.propertyLinkFailedCount, 2);
}

{
    const completion = buildPreRegisterCompletion({
        totalCount: 2,
        matchedCount: 2,
        unmatchedCount: 0,
        savedCount: 1,
        updatedCount: 0,
        duplicateCount: 0,
        propertyLinkCreatedCount: 2,
        propertyLinkUpdatedCount: 0,
        propertyLinkFailedCount: 0,
        errors: [],
    });

    assert.equal(completion.finalStatus, 'completed');
    assert.equal(completion.persistedStatus, 'COMPLETED');
    assert.equal(completion.result.success, true);
    assert.equal(completion.result.propertyLinkCreatedCount, 2);
}

assert.equal(getAutoOwnershipRatio(1), 100);
assert.equal(getAutoOwnershipRatio(8), 12.5);
assert.equal(getAutoOwnershipRatio(7), 14.2857);

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemberQueueExecutionActor } from '../src/security/member-queue-execution-policy';

const actor = (overrides: Record<string, unknown> = {}) => ({
    id: 'admin-a',
    role: 'ADMIN',
    is_blocked: false,
    union_id: 'union-a',
    ...overrides,
});

test('invite-sync 실행 직전 현재 조합 ADMIN 또는 SYSTEM_ADMIN만 허용한다', () => {
    assert.equal(validateMemberQueueExecutionActor(actor(), 'union-a', 'MEMBER_INVITE_SYNC'), null);
    assert.equal(validateMemberQueueExecutionActor(
        actor({ role: 'SYSTEM_ADMIN', union_id: null }),
        'union-a',
        'MEMBER_INVITE_SYNC'
    ), null);
    assert.equal(
        validateMemberQueueExecutionActor(actor({ union_id: 'union-b' }), 'union-a', 'MEMBER_INVITE_SYNC')?.code,
        'ACTOR_UNION_MISMATCH'
    );
    assert.equal(
        validateMemberQueueExecutionActor(actor({ role: 'USER' }), 'union-a', 'MEMBER_INVITE_SYNC')?.code,
        'ACTOR_ROLE_REVOKED'
    );
});

test('pre-register 실행 직전 동일 actor의 SYSTEM_ADMIN 권한과 차단 상태를 재검증한다', () => {
    assert.equal(validateMemberQueueExecutionActor(
        actor({ role: 'SYSTEM_ADMIN', union_id: null }),
        'union-a',
        'PRE_REGISTER'
    ), null);
    assert.equal(
        validateMemberQueueExecutionActor(actor(), 'union-a', 'PRE_REGISTER')?.code,
        'ACTOR_ROLE_REVOKED'
    );
    assert.equal(
        validateMemberQueueExecutionActor(actor({ is_blocked: true }), 'union-a', 'PRE_REGISTER')?.code,
        'ACTOR_BLOCKED'
    );
    assert.equal(
        validateMemberQueueExecutionActor(null, 'union-a', 'PRE_REGISTER')?.code,
        'ACTOR_NOT_FOUND'
    );
});

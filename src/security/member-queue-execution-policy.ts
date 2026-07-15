export type MemberQueueExecutionOperation = 'MEMBER_INVITE_SYNC' | 'PRE_REGISTER';

export type MemberQueueExecutionActor = {
    id: string;
    role: string;
    is_blocked: boolean | null;
    union_id: string | null;
};

export type MemberQueueExecutionFailure = {
    code: 'ACTOR_NOT_FOUND' | 'ACTOR_BLOCKED' | 'ACTOR_ROLE_REVOKED' | 'ACTOR_UNION_MISMATCH';
    message: string;
};

/** Queue 대기 중 권한이 회수된 작업이 service-role로 실행되지 않도록 최종 판정합니다. */
export function validateMemberQueueExecutionActor(
    actor: MemberQueueExecutionActor | null,
    unionId: string,
    operation: MemberQueueExecutionOperation
): MemberQueueExecutionFailure | null {
    if (!actor) {
        return { code: 'ACTOR_NOT_FOUND', message: '작업 실행자를 찾을 수 없습니다.' };
    }
    if (actor.is_blocked === true) {
        return { code: 'ACTOR_BLOCKED', message: '차단된 실행자의 작업은 취소됩니다.' };
    }
    if (operation === 'PRE_REGISTER') {
        return actor.role === 'SYSTEM_ADMIN'
            ? null
            : { code: 'ACTOR_ROLE_REVOKED', message: '시스템 관리자 권한이 회수되었습니다.' };
    }
    if (actor.role === 'SYSTEM_ADMIN') return null;
    if (actor.role !== 'ADMIN') {
        return { code: 'ACTOR_ROLE_REVOKED', message: '조합 관리자 권한이 회수되었습니다.' };
    }
    if (actor.union_id !== unionId) {
        return { code: 'ACTOR_UNION_MISMATCH', message: '실행자의 조합 범위가 변경되었습니다.' };
    }
    return null;
}

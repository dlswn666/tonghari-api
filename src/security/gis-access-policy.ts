import { AuthenticatedUser } from '../types/auth.types';

export type GisAccessFailure = {
    status: number;
    code: string;
    error: string;
};

/** 서명 토큰의 인증 여부와 요청 조합 범위만 확인한다. 역할·차단 상태는 DB 현재값으로 판정한다. */
export function validateGisAuthenticatedScope(
    user: AuthenticatedUser | undefined,
    requestedUnionId?: string | null
): GisAccessFailure | null {
    if (!user) {
        return { status: 401, code: 'UNAUTHORIZED', error: '인증이 필요합니다.' };
    }

    if (requestedUnionId && user.unionId !== 'system' && user.unionId !== requestedUnionId) {
        return { status: 403, code: 'UNION_SCOPE_MISMATCH', error: '토큰과 요청의 정비사업 범위가 일치하지 않습니다.' };
    }

    return null;
}

import { NextFunction, Request, Response } from 'express';
import { validateGisAuthenticatedScope } from '../security/gis-access-policy';
import { getSupabaseService } from '../services/supabase.service';
import { createLogger } from '../utils/logger';

const logger = createLogger('MEMBER-AUTH');

type MemberAdminActor = {
    id: string;
    role: 'SYSTEM_ADMIN' | 'ADMIN';
    is_blocked: boolean;
    union_id: string | null;
};

type MemberAdminOptions = {
    operation: 'MEMBER_INVITE_SYNC' | 'PRE_REGISTER';
    systemAdminOnly: boolean;
};

/**
 * 조합원 초대 변경 경계.
 * 현재 DB의 미차단 SYSTEM_ADMIN 또는 요청 조합에 정확히 속한 ADMIN만 허용한다.
 */
async function authorizeMemberAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
    options: MemberAdminOptions
): Promise<void> {
    const requestedUnionId =
        typeof req.body?.unionId === 'string' && req.body.unionId.trim()
            ? req.body.unionId.trim()
            : null;
    if (!requestedUnionId) {
        res.status(400).json({
            success: false,
            code: 'UNION_ID_REQUIRED',
            error: 'unionId가 필요합니다.',
        });
        return;
    }

    const claimFailure = validateGisAuthenticatedScope(req.user, requestedUnionId);
    if (claimFailure) {
        res.status(claimFailure.status).json({ success: false, ...claimFailure });
        return;
    }
    const claimedActorUserId =
        typeof req.user?.actorUserId === 'string' && req.user.actorUserId.trim()
            ? req.user.actorUserId.trim()
            : null;
    if (!claimedActorUserId) {
        res.status(403).json({
            success: false,
            code: 'ACTOR_ID_REQUIRED',
            error: '검증된 조합원 관리자 실행자 정보가 필요합니다.',
        });
        return;
    }
    const audience = req.user?.audience;
    const hasExpectedAudience = audience === 'tonghari-api' ||
        (Array.isArray(audience) && audience.includes('tonghari-api'));
    const expectedIssuer = req.user?.databaseTarget === 'development'
        ? 'tonghari-web-dev'
        : 'tonghari-web';
    if (
        req.user?.purpose !== 'MEMBER_QUEUE' ||
        req.user?.operation !== options.operation ||
        req.user?.issuer !== expectedIssuer ||
        !hasExpectedAudience
    ) {
        res.status(403).json({
            success: false,
            code: 'TOKEN_PURPOSE_INVALID',
            error: '조합원 queue 전용 토큰이 필요합니다.',
        });
        return;
    }
    req.body.unionId = requestedUnionId;

    try {
        const client = getSupabaseService(req.user!.databaseTarget).getClient();
        const { data: links, error: linkError } = await client
            .from('user_auth_links')
            .select('user_id')
            .eq('auth_user_id', req.user!.userId);
        if (linkError) {
            logger.error(`인증 사용자 링크 조회 실패 (${req.user!.userId})`, linkError);
            res.status(503).json({
                success: false,
                code: 'AUTHORIZATION_LOOKUP_FAILED',
                error: '현재 권한을 확인할 수 없습니다.',
            });
            return;
        }

        const linkedUserIds = Array.from(
            new Set((links ?? []).map((link: { user_id: string }) => link.user_id).filter(Boolean))
        );
        if (linkedUserIds.length === 0) {
            res.status(403).json({
                success: false,
                code: 'MEMBER_ADMIN_REQUIRED',
                error: '조합원 관리 권한이 필요합니다.',
            });
            return;
        }
        if (!linkedUserIds.includes(claimedActorUserId)) {
            res.status(403).json({
                success: false,
                code: 'ACTOR_ID_MISMATCH',
                error: '토큰 실행자가 현재 인증 사용자와 연결되어 있지 않습니다.',
            });
            return;
        }

        const { data: actorRows, error: actorError } = await client
            .from('users')
            .select('id, role, is_blocked, union_id')
            .in('id', linkedUserIds)
            .in('role', ['SYSTEM_ADMIN', 'ADMIN']);
        if (actorError) {
            logger.error(`조합원 관리자 조회 실패 (${req.user!.userId})`, actorError);
            res.status(503).json({
                success: false,
                code: 'AUTHORIZATION_LOOKUP_FAILED',
                error: '현재 권한을 확인할 수 없습니다.',
            });
            return;
        }

        const actors = (actorRows ?? []) as MemberAdminActor[];
        const matchingActors = actors.filter((actor) =>
            actor.id === claimedActorUserId &&
            (!options.systemAdminOnly || actor.role === 'SYSTEM_ADMIN') &&
            (actor.role === 'SYSTEM_ADMIN' || actor.union_id === requestedUnionId)
        );
        const actor = matchingActors.find((candidate) => !candidate.is_blocked);
        if (!actor) {
            if (matchingActors.some((candidate) => candidate.is_blocked)) {
                res.status(403).json({
                    success: false,
                    code: 'USER_BLOCKED',
                    error: '차단된 사용자는 조합원 작업을 실행할 수 없습니다.',
                });
                return;
            }
            res.status(403).json({
                success: false,
                code: 'MEMBER_ADMIN_REQUIRED',
                error: '요청 조합의 관리자 권한이 필요합니다.',
            });
            return;
        }

        const { data: union, error: unionError } = await client
            .from('unions')
            .select('id')
            .eq('id', requestedUnionId)
            .maybeSingle();
        if (unionError) {
            logger.error(`정비사업 범위 조회 실패 (${requestedUnionId})`, unionError);
            res.status(503).json({
                success: false,
                code: 'UNION_SCOPE_LOOKUP_FAILED',
                error: '정비사업 범위를 확인할 수 없습니다.',
            });
            return;
        }
        if (!union) {
            res.status(404).json({
                success: false,
                code: 'UNION_NOT_FOUND',
                error: '정비사업을 찾을 수 없습니다.',
            });
            return;
        }

        req.user!.actorUserId = actor.id;
        next();
    } catch (error) {
        logger.error('조합원 관리자 권한 검증 중 예외', error);
        res.status(503).json({
            success: false,
            code: 'AUTHORIZATION_LOOKUP_FAILED',
            error: '현재 권한을 확인할 수 없습니다.',
        });
    }
}

export function memberAdminMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    return authorizeMemberAdmin(req, res, next, {
        operation: 'MEMBER_INVITE_SYNC',
        systemAdminOnly: false,
    });
}

export function memberSystemAdminMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    return authorizeMemberAdmin(req, res, next, {
        operation: 'PRE_REGISTER',
        systemAdminOnly: true,
    });
}

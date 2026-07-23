import { NextFunction, Request, Response } from 'express';
import { getSupabaseService } from '../services/supabase.service';
import { validateGisAuthenticatedScope } from '../security/gis-access-policy';
import { createLogger } from '../utils/logger';

const logger = createLogger('GIS-AUTH');

const GIS_JOB_TYPES = [
    'GIS_MAP',
    'APARTMENT_PRICE_SYNC',
    'INDIVIDUAL_HOUSING_PRICE_SYNC',
    'LAND_PRICE_SYNC',
    'LAND_AREA_SYNC',
] as const;

/**
 * GIS 변경·가격·상태 라우트의 시스템관리자 경계.
 * 서명된 claim을 먼저 확인하고 운영 DB의 현재 역할·차단 상태를 다시 검증한다.
 */
export async function gisSystemAdminMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    const requestedUnionId =
        typeof req.body?.unionId === 'string' && req.body.unionId.trim()
            ? req.body.unionId.trim()
            : null;
    const claimFailure = validateGisAuthenticatedScope(req.user, requestedUnionId);
    if (claimFailure) {
        res.status(claimFailure.status).json({ success: false, ...claimFailure });
        return;
    }
    if (
        req.user?.legacyProductionToken === false &&
        req.user.purpose !== 'GIS_SYSTEM_ADMIN'
    ) {
        res.status(403).json({
            success: false,
            code: 'TOKEN_PURPOSE_INVALID',
            error: 'GIS 변경 전용 토큰이 필요합니다.',
        });
        return;
    }
    if (requestedUnionId) req.body.unionId = requestedUnionId;

    try {
        const client = getSupabaseService(req.user!.databaseTarget).getClient();
        // JWT userId는 auth.users UUID다. users.id(VARCHAR)와 직접 비교하지 않는다.
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
                code: 'SYSTEM_ADMIN_REQUIRED',
                error: '시스템관리자 권한이 필요합니다.',
            });
            return;
        }

        const { data: actor, error: actorError } = await client
            .from('users')
            .select('id, role, is_blocked')
            .in('id', linkedUserIds)
            .eq('role', 'SYSTEM_ADMIN')
            .limit(1)
            .maybeSingle();

        if (actorError) {
            logger.error(`시스템관리자 조회 실패 (${req.user!.userId})`, actorError);
            res.status(503).json({
                success: false,
                code: 'AUTHORIZATION_LOOKUP_FAILED',
                error: '현재 권한을 확인할 수 없습니다.',
            });
            return;
        }

        if (!actor || actor.role !== 'SYSTEM_ADMIN') {
            res.status(403).json({
                success: false,
                code: 'SYSTEM_ADMIN_REQUIRED',
                error: '시스템관리자 권한이 필요합니다.',
            });
            return;
        }

        if (actor.is_blocked) {
            res.status(403).json({
                success: false,
                code: 'USER_BLOCKED',
                error: '차단된 사용자는 GIS 작업을 실행할 수 없습니다.',
            });
            return;
        }

        req.user!.actorUserId = actor.id;

        if (requestedUnionId) {
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
        }

        if (req.params.jobId) {
            const { data: job, error: jobError } = await client
                .from('sync_jobs')
                .select('id, union_id, job_type')
                .eq('id', req.params.jobId)
                .in('job_type', [...GIS_JOB_TYPES])
                .maybeSingle();

            if (jobError) {
                logger.error(`GIS 작업 범위 조회 실패 (${req.params.jobId})`, jobError);
                res.status(503).json({
                    success: false,
                    code: 'JOB_SCOPE_LOOKUP_FAILED',
                    error: 'GIS 작업 범위를 확인할 수 없습니다.',
                });
                return;
            }

            if (!job) {
                res.status(404).json({
                    success: false,
                    code: 'JOB_NOT_FOUND',
                    error: 'GIS 작업을 찾을 수 없습니다.',
                });
                return;
            }

            if (req.user!.unionId !== 'system' && req.user!.unionId !== job.union_id) {
                res.status(403).json({
                    success: false,
                    code: 'UNION_SCOPE_MISMATCH',
                    error: 'GIS 작업의 정비사업 범위가 토큰과 일치하지 않습니다.',
                });
                return;
            }
        }

        next();
    } catch (error) {
        logger.error('GIS 권한 검증 중 예외', error);
        res.status(503).json({
            success: false,
            code: 'AUTHORIZATION_LOOKUP_FAILED',
            error: '현재 권한을 확인할 수 없습니다.',
        });
    }
}

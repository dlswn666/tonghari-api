import { NextFunction, Request, Response } from 'express';
import { supabaseService } from '../services/supabase.service';
import { createLogger } from '../utils/logger';

const logger = createLogger('CONSENT-AUTH');
const CONSENT_SYNC_JOB_TYPE = 'CONSENT_UPLOAD';
const MEMBER_LOOKUP_CHUNK_SIZE = 500;

type ConsentOperation = 'CONSENT_BULK_UPDATE' | 'CONSENT_BULK_UPLOAD';

type ConsentAdminActor = {
    id: string;
    role: 'SYSTEM_ADMIN' | 'ADMIN';
    is_blocked: boolean;
    union_id: string | null;
};

type UnionProjectProfile = {
    project_type_code: string;
    implementation_method: string;
};

type ConsentUnionScope = {
    id: string;
    union_project_profiles: UnionProjectProfile | UnionProjectProfile[] | null;
};

type ConsentStageScope = {
    id: string;
    project_type_code: string;
    implementation_method_code: string;
};

type ConsentAdminOptions = {
    operation: ConsentOperation;
    validateMemberIds: boolean;
};

function hasExpectedAudience(audience: string | string[] | undefined): boolean {
    return audience === 'tonghari-api' ||
        (Array.isArray(audience) && audience.includes('tonghari-api'));
}

function requestString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 운영 consent queue의 service-role 쓰기 경계.
 *
 * - 이 큐는 아직 production Supabase singleton만 사용하므로 dev 토큰을 절대 허용하지 않는다.
 * - 무인증이었던 과거 route에는 보존할 JWT 계약이 없으므로 kid 없는 legacy 토큰도 허용하지 않는다.
 * - 토큰 claim은 요청 범위를 좁히는 용도이며, 실제 역할/차단/조합 소속은 운영 DB 현재값으로 재검증한다.
 */
async function authorizeConsentAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
    options: ConsentAdminOptions
): Promise<void> {
    const requestedUnionId = requestString(req.body?.unionId);
    const requestedJobId = requestString(req.body?.jobId);
    const requestedStageId = requestString(req.body?.stageId);

    if (!requestedUnionId || !requestedJobId || !requestedStageId) {
        res.status(400).json({
            success: false,
            code: 'CONSENT_SCOPE_REQUIRED',
            error: 'jobId, unionId, stageId가 필요합니다.',
        });
        return;
    }

    // authMiddleware가 먼저 실행되지만 잘못된 route wiring에도 fail-closed한다.
    if (!req.user) {
        res.status(401).json({
            success: false,
            code: 'UNAUTHORIZED',
            error: '인증이 필요합니다.',
        });
        return;
    }
    if (req.user.databaseTarget !== 'production') {
        res.status(403).json({
            success: false,
            code: 'DEVELOPMENT_TARGET_NOT_SUPPORTED',
            error: '동의 변경 작업은 운영 전용입니다.',
        });
        return;
    }
    if (req.user.legacyProductionToken) {
        res.status(403).json({
            success: false,
            code: 'LEGACY_TOKEN_NOT_SUPPORTED',
            error: '동의 변경 전용 운영 토큰이 필요합니다.',
        });
        return;
    }
    // SYSTEM_ADMIN도 요청마다 실제 대상 조합으로 좁힌 토큰만 사용한다.
    if (req.user.unionId !== requestedUnionId) {
        res.status(403).json({
            success: false,
            code: 'UNION_SCOPE_MISMATCH',
            error: '토큰과 요청의 정비사업 범위가 일치하지 않습니다.',
        });
        return;
    }
    if (
        req.user.purpose !== 'CONSENT_QUEUE' ||
        req.user.operation !== options.operation ||
        req.user.issuer !== 'tonghari-web' ||
        !hasExpectedAudience(req.user.audience)
    ) {
        res.status(403).json({
            success: false,
            code: 'TOKEN_PURPOSE_INVALID',
            error: '동의 변경 작업 전용 토큰이 필요합니다.',
        });
        return;
    }

    const claimedActorUserId = requestString(req.user.actorUserId);
    if (!claimedActorUserId) {
        res.status(403).json({
            success: false,
            code: 'ACTOR_ID_REQUIRED',
            error: '검증된 동의 관리자 실행자 정보가 필요합니다.',
        });
        return;
    }

    let memberIds: string[] = [];
    if (options.validateMemberIds) {
        if (
            !Array.isArray(req.body?.memberIds) ||
            req.body.memberIds.length === 0 ||
            req.body.memberIds.some((value: unknown) => !requestString(value))
        ) {
            res.status(400).json({
                success: false,
                code: 'MEMBER_IDS_REQUIRED',
                error: '유효한 memberIds 배열이 필요합니다.',
            });
            return;
        }
        memberIds = Array.from(new Set(
            (req.body.memberIds as string[]).map((value) => value.trim())
        ));
    }

    // 이 route의 worker는 production singleton에 고정돼 있다. 명시적으로 운영 client만 사용한다.
    const client = supabaseService.getClient();

    try {
        const { data: link, error: linkError } = await client
            .from('user_auth_links')
            .select('user_id')
            .eq('auth_user_id', req.user.userId)
            .eq('user_id', claimedActorUserId)
            .maybeSingle();
        if (linkError) {
            logger.error('동의 관리자 인증 링크 조회 실패', linkError);
            res.status(503).json({
                success: false,
                code: 'AUTHORIZATION_LOOKUP_FAILED',
                error: '현재 권한을 확인할 수 없습니다.',
            });
            return;
        }
        if (!link) {
            res.status(403).json({
                success: false,
                code: 'ACTOR_ID_MISMATCH',
                error: '토큰 실행자가 현재 인증 사용자와 연결되어 있지 않습니다.',
            });
            return;
        }

        const { data: actorData, error: actorError } = await client
            .from('users')
            .select('id, role, is_blocked, union_id')
            .eq('id', claimedActorUserId)
            .in('role', ['SYSTEM_ADMIN', 'ADMIN'])
            .maybeSingle();
        if (actorError) {
            logger.error('동의 관리자 현재 권한 조회 실패', actorError);
            res.status(503).json({
                success: false,
                code: 'AUTHORIZATION_LOOKUP_FAILED',
                error: '현재 권한을 확인할 수 없습니다.',
            });
            return;
        }

        const actor = actorData as ConsentAdminActor | null;
        if (!actor || (actor.role !== 'SYSTEM_ADMIN' && actor.union_id !== requestedUnionId)) {
            res.status(403).json({
                success: false,
                code: 'CONSENT_ADMIN_REQUIRED',
                error: '요청 정비사업의 동의 관리 권한이 필요합니다.',
            });
            return;
        }
        if (actor.is_blocked) {
            res.status(403).json({
                success: false,
                code: 'USER_BLOCKED',
                error: '차단된 사용자는 동의 작업을 실행할 수 없습니다.',
            });
            return;
        }

        // union 존재와 1:1 사업 프로필을 한 번에 확인해 consent stage의 전역 ID를
        // 요청 조합의 사업유형/시행방식 범위로 제한한다.
        const { data: unionData, error: unionError } = await client
            .from('unions')
            .select(`
                id,
                union_project_profiles (
                    project_type_code,
                    implementation_method
                )
            `)
            .eq('id', requestedUnionId)
            .maybeSingle();
        if (unionError) {
            logger.error('동의 작업 정비사업 범위 조회 실패', unionError);
            res.status(503).json({
                success: false,
                code: 'UNION_SCOPE_LOOKUP_FAILED',
                error: '정비사업 범위를 확인할 수 없습니다.',
            });
            return;
        }
        if (!unionData) {
            res.status(404).json({
                success: false,
                code: 'UNION_NOT_FOUND',
                error: '정비사업을 찾을 수 없습니다.',
            });
            return;
        }

        const union = unionData as ConsentUnionScope;
        const profileData = Array.isArray(union.union_project_profiles)
            ? union.union_project_profiles[0]
            : union.union_project_profiles;
        const projectTypeCode = requestString(profileData?.project_type_code);
        const implementationMethod = requestString(profileData?.implementation_method);
        if (
            union.id !== requestedUnionId ||
            !projectTypeCode ||
            !implementationMethod ||
            (Array.isArray(union.union_project_profiles) && union.union_project_profiles.length !== 1)
        ) {
            res.status(409).json({
                success: false,
                code: 'UNION_PROJECT_PROFILE_REQUIRED',
                error: '정비사업의 사업유형과 시행방식을 확인할 수 없습니다.',
            });
            return;
        }

        const { data: stageData, error: stageError } = await client
            .from('consent_stages')
            .select('id, project_type_code, implementation_method_code')
            .eq('id', requestedStageId)
            .eq('project_type_code', projectTypeCode)
            .eq('implementation_method_code', implementationMethod)
            .maybeSingle();
        if (stageError) {
            logger.error('동의 단계 조회 실패', stageError);
            res.status(503).json({
                success: false,
                code: 'CONSENT_STAGE_LOOKUP_FAILED',
                error: '동의 단계를 확인할 수 없습니다.',
            });
            return;
        }
        const stage = stageData as ConsentStageScope | null;
        if (
            !stage ||
            stage.id !== requestedStageId ||
            stage.project_type_code !== projectTypeCode ||
            stage.implementation_method_code !== implementationMethod
        ) {
            res.status(404).json({
                success: false,
                code: 'CONSENT_STAGE_NOT_FOUND',
                error: '요청 정비사업에 사용할 수 있는 동의 단계를 찾을 수 없습니다.',
            });
            return;
        }

        const { data: job, error: jobError } = await client
            .from('sync_jobs')
            .select('id, union_id, job_type')
            .eq('id', requestedJobId)
            .eq('union_id', requestedUnionId)
            .eq('job_type', CONSENT_SYNC_JOB_TYPE)
            .maybeSingle();
        if (jobError) {
            logger.error('동의 작업 원장 조회 실패', jobError);
            res.status(503).json({
                success: false,
                code: 'JOB_SCOPE_LOOKUP_FAILED',
                error: '동의 작업 범위를 확인할 수 없습니다.',
            });
            return;
        }
        if (
            !job ||
            job.id !== requestedJobId ||
            job.union_id !== requestedUnionId ||
            job.job_type !== CONSENT_SYNC_JOB_TYPE
        ) {
            res.status(404).json({
                success: false,
                code: 'JOB_NOT_FOUND',
                error: '요청 범위와 일치하는 동의 작업을 찾을 수 없습니다.',
            });
            return;
        }

        if (options.validateMemberIds) {
            const verifiedIds = new Set<string>();
            for (let offset = 0; offset < memberIds.length; offset += MEMBER_LOOKUP_CHUNK_SIZE) {
                const chunk = memberIds.slice(offset, offset + MEMBER_LOOKUP_CHUNK_SIZE);
                const { data: members, error: memberError } = await client
                    .from('users')
                    .select('id')
                    .eq('union_id', requestedUnionId)
                    .in('id', chunk);
                if (memberError) {
                    logger.error('동의 대상 조합원 범위 조회 실패', memberError);
                    res.status(503).json({
                        success: false,
                        code: 'MEMBER_SCOPE_LOOKUP_FAILED',
                        error: '동의 대상의 정비사업 범위를 확인할 수 없습니다.',
                    });
                    return;
                }
                for (const member of members ?? []) {
                    if (typeof member.id === 'string') verifiedIds.add(member.id);
                }
            }
            if (memberIds.some((memberId) => !verifiedIds.has(memberId))) {
                res.status(403).json({
                    success: false,
                    code: 'MEMBER_SCOPE_MISMATCH',
                    error: '동의 대상 중 요청 정비사업에 속하지 않은 사용자가 있습니다.',
                });
                return;
            }
        }

        req.body.jobId = requestedJobId;
        req.body.unionId = requestedUnionId;
        req.body.stageId = requestedStageId;
        req.user.actorUserId = actor.id;
        next();
    } catch (error) {
        logger.error('동의 관리자 권한 검증 중 예외', error);
        res.status(503).json({
            success: false,
            code: 'AUTHORIZATION_LOOKUP_FAILED',
            error: '현재 권한을 확인할 수 없습니다.',
        });
    }
}

export function consentBulkUpdateAdminMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    return authorizeConsentAdmin(req, res, next, {
        operation: 'CONSENT_BULK_UPDATE',
        validateMemberIds: true,
    });
}

export function consentBulkUploadAdminMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    return authorizeConsentAdmin(req, res, next, {
        operation: 'CONSENT_BULK_UPLOAD',
        validateMemberIds: false,
    });
}

import { Request, Response, Router } from 'express';
import { memberQueueService } from '../services/member.queue.service';
import { MemberInviteSyncRequest, PreRegisterRequest } from '../types/member.types';
import { createLogger } from '../utils/logger';
import { toSyncJobRouteFailure } from '../services/sync-job-admission';
import { authMiddleware } from '../middleware/auth';
import {
    memberAdminMiddleware,
    memberSystemAdminMiddleware,
} from '../middleware/member-admin';

const router = Router();
const logger = createLogger('MEMBER-ROUTE');

function legacyJobReadDisabled(_req: Request, res: Response) {
    return res.status(410).json({
        success: false,
        code: 'LEGACY_SYNC_JOB_STATUS_DISABLED',
        error: '작업 상태는 인증된 Web 서버 경계에서 조회해야 합니다.',
    });
}

/**
 * 조합원 초대 동기화 요청 (엑셀 업로드)
 * POST /member/invite-sync
 */
router.post('/invite-sync', authMiddleware, memberAdminMiddleware, async (req, res) => {
    const { unionId, expiresHours, members } = req.body;

    if (!unionId || !Array.isArray(members)) {
        return res.status(400).json({
            success: false,
            error: 'unionId, members (array) are required.',
        });
    }

    if (members.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'members array cannot be empty.',
        });
    }

    const normalizedExpiresHours = expiresHours === undefined ? 8760 : expiresHours;
    if (!Number.isInteger(normalizedExpiresHours) || normalizedExpiresHours <= 0) {
        return res.status(400).json({
            success: false,
            error: 'expiresHours must be a positive integer.',
        });
    }

    // 각 멤버 데이터 검증
    for (let i = 0; i < members.length; i++) {
        const member = members[i];
        if (!member.name || !member.phone_number) {
            return res.status(400).json({
                success: false,
                error: `Member at index ${i} is missing name or phone_number.`,
            });
        }
    }

    try {
        logger.info(`Member invite sync request: unionId=${unionId}, members=${members.length}`);

        const request: MemberInviteSyncRequest = {
            jobType: 'MEMBER_INVITE_SYNC',
            unionId,
            createdBy: req.user!.actorUserId!,
            expiresHours: normalizedExpiresHours,
            members,
        };

        const jobInfo = await memberQueueService.addMemberInviteSyncJob(request);

        res.json({
            success: true,
            jobId: jobInfo.jobId,
            jobType: jobInfo.jobType,
            status: jobInfo.status,
            totalCount: jobInfo.totalCount,
        });
    } catch (error: any) {
        logger.error('Member invite sync request failed:', error);
        const failure = toSyncJobRouteFailure(error, 'MEMBER_INVITE_JOB_START_FAILED');
        res.status(failure.status).json({
            success: false,
            code: failure.code,
            error: failure.message,
        });
    }
});

/**
 * 사전 등록 요청 (Raw 엑셀 데이터 - GIS 매칭 + 저장 통합 처리)
 * POST /member/pre-register
 *
 * Request Body:
 * {
 *   unionId: string,
 *   members: [{ name, phoneNumber?, propertyAddress, dong?, ho?, residentAddress? }]
 * }
 */
router.post('/pre-register', authMiddleware, memberSystemAdminMiddleware, async (req, res) => {
    const { unionId, members } = req.body;

    if (!unionId || !Array.isArray(members)) {
        return res.status(400).json({
            success: false,
            error: 'unionId, members (array) are required.',
        });
    }

    if (members.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'members array cannot be empty.',
        });
    }

    // 각 멤버 데이터 검증 (Raw 데이터: name, propertyAddress 필수)
    for (let i = 0; i < members.length; i++) {
        const member = members[i];
        if (!member.name || !member.propertyAddress) {
            return res.status(400).json({
                success: false,
                error: `Member at index ${i} is missing required data (name, propertyAddress).`,
            });
        }
    }

    try {
        logger.info(`Pre-register request: unionId=${unionId}, members=${members.length}`);

        const request: PreRegisterRequest = {
            jobType: 'PRE_REGISTER',
            unionId,
            actorUserId: req.user!.actorUserId!,
            members,
        };

        const jobInfo = await memberQueueService.addPreRegisterJob(request);

        res.json({
            success: true,
            jobId: jobInfo.jobId,
            jobType: jobInfo.jobType,
            status: jobInfo.status,
            totalCount: jobInfo.totalCount,
        });
    } catch (error: any) {
        logger.error('Pre-register request failed:', error);
        const failure = toSyncJobRouteFailure(error, 'PRE_REGISTER_JOB_START_FAILED');
        res.status(failure.status).json({
            success: false,
            code: failure.code,
            error: failure.message,
        });
    }
});

// 구 status/list endpoint는 union/job scope를 증명하지 못하므로 공개 데이터를 반환하지 않는다.
router.get('/job/:jobId', legacyJobReadDisabled);
router.get('/job/:jobId/db', legacyJobReadDisabled);
router.get('/jobs/:unionId', legacyJobReadDisabled);

/**
 * 소유지 자동 연결 요청
 * POST /member/sync-properties
 *
 * Phase F 별도 승인 전까지 서버에서 명시적으로 차단한다.
 *
 * Request Body:
 * {
 *   unionId: string
 * }
 */
router.post('/sync-properties', async (req, res) => {
    const { unionId } = req.body;

    if (!unionId) {
        return res.status(400).json({
            success: false,
            error: 'unionId is required.',
        });
    }

    logger.warn(`Sync properties blocked before Phase F approval: unionId=${unionId}`);
    return res.status(409).json({
        success: false,
        code: 'FEATURE_DISABLED_PHASE_F',
        error: '호실 자동 연결은 Phase F 승인 전까지 사용할 수 없습니다.',
    });
});

export default router;

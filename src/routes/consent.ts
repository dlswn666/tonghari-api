import { Request, Response, Router } from 'express';
import { consentQueueService } from '../services/consent.queue.service';
import {
    ConsentBulkUpdateRequest,
    ConsentUploadRequest,
} from '../types/consent.types';
import { createLogger } from '../utils/logger';
import { toSyncJobRouteFailure } from '../services/sync-job-admission';
import { databaseTargetAuthMiddleware as authMiddleware } from '../middleware/auth';
import {
    consentBulkUpdateAdminMiddleware,
    consentBulkUploadAdminMiddleware,
} from '../middleware/consent-admin';

const router = Router();
const logger = createLogger('CONSENT-ROUTE');

function legacyJobReadDisabled(_req: Request, res: Response) {
    return res.status(410).json({
        success: false,
        code: 'LEGACY_SYNC_JOB_STATUS_DISABLED',
        error: '작업 상태는 인증된 Web 서버 경계에서 조회해야 합니다.',
    });
}

/**
 * 일괄 동의 처리 요청
 * POST /consent/queue
 * 
 * Next.js API에서 sync_jobs 생성 후 호출
 * jobId가 포함된 요청을 받아서 큐에 추가
 */
router.post('/queue', authMiddleware, consentBulkUpdateAdminMiddleware, async (req, res) => {
    const { jobId, unionId, stageId, memberIds, status } = req.body;

    if (!jobId || !unionId || !stageId || !memberIds || !status) {
        return res.status(400).json({
            success: false,
            error: 'jobId, unionId, stageId, memberIds, status are required.',
        });
    }

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'memberIds array cannot be empty.',
        });
    }

    if (status !== 'AGREED' && status !== 'DISAGREED') {
        return res.status(400).json({
            success: false,
            error: 'status must be AGREED or DISAGREED.',
        });
    }

    try {
        logger.info(`Consent bulk update request: jobId=${jobId}, unionId=${unionId}, members=${memberIds.length}`);

        const request: ConsentBulkUpdateRequest = {
            jobId,
            unionId,
            stageId,
            actorUserId: req.user!.actorUserId!,
            memberIds,
            status,
            databaseTarget: req.user!.databaseTarget,
        };

        const jobInfo = await consentQueueService.addBulkUpdateJob(request);

        res.json({
            success: true,
            jobId: jobInfo.jobId,
            jobType: jobInfo.jobType,
            status: jobInfo.status,
            totalCount: jobInfo.totalCount,
        });
    } catch (error: any) {
        logger.error('Consent bulk update request failed:', error);
        const failure = toSyncJobRouteFailure(error, 'CONSENT_BULK_JOB_START_FAILED');
        res.status(failure.status).json({
            success: false,
            code: failure.code,
            error: failure.message,
        });
    }
});

/**
 * 엑셀 업로드 동의 처리 요청
 * POST /consent/upload-queue
 */
router.post('/upload-queue', authMiddleware, consentBulkUploadAdminMiddleware, async (req, res) => {
    const { jobId, unionId, stageId, data } = req.body;

    if (!jobId || !unionId || !stageId || !data) {
        return res.status(400).json({
            success: false,
            error: 'jobId, unionId, stageId, data are required.',
        });
    }

    if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'data array cannot be empty.',
        });
    }

    // 각 행 데이터 검증
    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        if (!row.name || !row.status) {
            return res.status(400).json({
                success: false,
                error: `Row ${i} is missing required data (name, status).`,
            });
        }
    }

    try {
        logger.info(`Consent upload request: jobId=${jobId}, unionId=${unionId}, rows=${data.length}`);

        const request: ConsentUploadRequest = {
            jobId,
            unionId,
            stageId,
            actorUserId: req.user!.actorUserId!,
            data,
            databaseTarget: req.user!.databaseTarget,
        };

        const jobInfo = await consentQueueService.addUploadJob(request);

        res.json({
            success: true,
            jobId: jobInfo.jobId,
            jobType: jobInfo.jobType,
            status: jobInfo.status,
            totalCount: jobInfo.totalCount,
        });
    } catch (error: any) {
        logger.error('Consent upload request failed:', error);
        const failure = toSyncJobRouteFailure(error, 'CONSENT_UPLOAD_JOB_START_FAILED');
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

export default router;

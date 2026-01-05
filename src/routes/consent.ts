import { Router } from 'express';
import { consentQueueService } from '../services/consent.queue.service';
import { supabaseService } from '../services/supabase.service';
import {
    ConsentBulkUpdateRequest,
    ConsentUploadRequest,
    ConsentJobStatusResponse,
} from '../types/consent.types';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('CONSENT-ROUTE');

/**
 * 일괄 동의 처리 요청
 * POST /consent/queue
 * 
 * Next.js API에서 sync_jobs 생성 후 호출
 * jobId가 포함된 요청을 받아서 큐에 추가
 */
router.post('/queue', async (req, res) => {
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
            memberIds,
            status,
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
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error.',
        });
    }
});

/**
 * 엑셀 업로드 동의 처리 요청
 * POST /consent/upload-queue
 */
router.post('/upload-queue', async (req, res) => {
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
            data,
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
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error.',
        });
    }
});

/**
 * 작업 상태 조회 (인메모리)
 * GET /consent/job/:jobId
 */
router.get('/job/:jobId', (req, res) => {
    const { jobId } = req.params;

    const jobStatus = consentQueueService.getJobStatus(jobId);

    if (!jobStatus) {
        return res.status(404).json({
            success: false,
            error: 'Job not found in memory. Check sync_jobs table for persisted status.',
        });
    }

    const response: ConsentJobStatusResponse = {
        jobId: jobStatus.jobId,
        jobType: jobStatus.jobType,
        status: jobStatus.status,
        progress: jobStatus.totalCount > 0 ? Math.round((jobStatus.processedCount / jobStatus.totalCount) * 100) : 0,
        totalCount: jobStatus.totalCount,
        processedCount: jobStatus.processedCount,
        result: jobStatus.result,
        error: jobStatus.error,
        createdAt: jobStatus.createdAt.toISOString(),
        startedAt: jobStatus.startedAt?.toISOString(),
        completedAt: jobStatus.completedAt?.toISOString(),
    };

    res.json({
        success: true,
        data: response,
    });
});

/**
 * 작업 상태 조회 (DB 기반 - 서버 재시작 후에도 조회 가능)
 * GET /consent/job/:jobId/db
 */
router.get('/job/:jobId/db', async (req, res) => {
    const { jobId } = req.params;

    try {
        const { data, error } = await supabaseService
            .getClient()
            .from('sync_jobs')
            .select('*')
            .eq('id', jobId)
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: 'Job not found in database.',
            });
        }

        res.json({
            success: true,
            data: {
                jobId: data.id,
                jobType: data.preview_data?.job_type || 'UNKNOWN',
                status: data.status.toLowerCase(),
                progress: data.progress,
                unionId: data.union_id,
                result: data.preview_data,
                error: data.error_log,
                createdAt: data.created_at,
                updatedAt: data.updated_at,
            },
        });
    } catch (error: any) {
        logger.error('Job status DB lookup failed:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error.',
        });
    }
});

/**
 * 조합의 동의 처리 작업 목록 조회
 * GET /consent/jobs/:unionId
 */
router.get('/jobs/:unionId', async (req, res) => {
    const { unionId } = req.params;
    const { status } = req.query; // 선택적 상태 필터

    try {
        let query = supabaseService
            .getClient()
            .from('sync_jobs')
            .select('*')
            .eq('union_id', unionId)
            .order('created_at', { ascending: false })
            .limit(20);

        if (status) {
            query = query.eq('status', (status as string).toUpperCase());
        }

        const { data, error } = await query;

        if (error) {
            throw error;
        }

        // 동의 처리 관련 작업만 필터링
        const consentJobs = (data || []).filter((job: any) => {
            const jobType = job.preview_data?.job_type;
            return jobType === 'CONSENT_BULK_UPDATE' || jobType === 'CONSENT_BULK_UPLOAD';
        });

        res.json({
            success: true,
            data: consentJobs.map((job: any) => ({
                jobId: job.id,
                jobType: job.preview_data?.job_type || 'UNKNOWN',
                status: job.status.toLowerCase(),
                progress: job.progress,
                result: job.preview_data,
                error: job.error_log,
                createdAt: job.created_at,
                updatedAt: job.updated_at,
            })),
        });
    } catch (error: any) {
        logger.error('Consent jobs list lookup failed:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error.',
        });
    }
});

export default router;

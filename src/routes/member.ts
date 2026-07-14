import { Router } from 'express';
import { memberQueueService } from '../services/member.queue.service';
import { supabaseService } from '../services/supabase.service';
import { MemberInviteSyncRequest, PreRegisterRequest, MemberJobStatusResponse } from '../types/member.types';
import { createLogger } from '../utils/logger';
import { toSyncJobRouteFailure } from '../services/sync-job-admission';

const router = Router();
const logger = createLogger('MEMBER-ROUTE');

/**
 * 조합원 초대 동기화 요청 (엑셀 업로드)
 * POST /member/invite-sync
 */
router.post('/invite-sync', async (req, res) => {
    const { unionId, createdBy, expiresHours, members } = req.body;

    if (!unionId || !createdBy || !Array.isArray(members)) {
        return res.status(400).json({
            success: false,
            error: 'unionId, createdBy, members (array) are required.',
        });
    }

    if (members.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'members array cannot be empty.',
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
            createdBy,
            expiresHours: expiresHours || 8760, // 기본값: 1년
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
router.post('/pre-register', async (req, res) => {
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

/**
 * 작업 상태 조회 (인메모리)
 * GET /member/job/:jobId
 */
router.get('/job/:jobId', (req, res) => {
    const { jobId } = req.params;

    const jobStatus = memberQueueService.getJobStatus(jobId);

    if (!jobStatus) {
        return res.status(404).json({
            success: false,
            error: 'Job not found in memory. Check sync_jobs table for persisted status.',
        });
    }

    const response: MemberJobStatusResponse = {
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
 * GET /member/job/:jobId/db
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
 * 조합의 진행 중인 작업 목록 조회
 * GET /member/jobs/:unionId
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

        // 조합원 관련 작업만 필터링
        const memberJobs = (data || []).filter((job: any) => {
            const jobType = job.preview_data?.job_type;
            return jobType === 'MEMBER_INVITE_SYNC' || jobType === 'PRE_REGISTER';
        });

        res.json({
            success: true,
            data: memberJobs.map((job: any) => ({
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
        logger.error('Jobs list lookup failed:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error.',
        });
    }
});

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

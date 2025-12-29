import { Router, Request, Response, NextFunction } from 'express';
import { aligoService, supabaseService, pricingService } from '../services';
import { queueService } from '../services/queue.service';
import { authMiddleware } from '../middleware';
import { SendAlimtalkRequest } from '../types/alimtalk.types';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

// 모든 알림톡 API에 인증 미들웨어 적용
router.use(authMiddleware);

/**
 * 알림톡 발송 (비동기 큐 처리)
 * POST /api/alimtalk/send
 * 
 * 대량 발송의 경우 큐에 추가하고 즉시 jobId 반환
 * 소량 발송(500건 이하)의 경우에도 동일하게 큐를 통해 처리
 */
router.post('/send', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = req.body as SendAlimtalkRequest;

        // 필수 파라미터 검증
        if (!body.unionId || !body.templateCode || !body.recipients || body.recipients.length === 0) {
            sendError(res, 'Required parameters are missing.', 'INVALID_PARAMS', 400);
            return;
        }

        console.log(`Alimtalk send request: template=${body.templateCode}, recipients=${body.recipients.length}`);

        // 큐 상태 확인
        const queueStatus = queueService.getQueueStatus();
        if (queueStatus.isFull) {
            sendError(res, 'Queue is full. Please try again later.', 'QUEUE_FULL', 503);
            return;
        }

        // 큐에 작업 추가
        const jobInfo = await queueService.addJob(body);

        if (!jobInfo) {
            sendError(res, 'Failed to add job to queue.', 'QUEUE_ERROR', 500);
            return;
        }

        console.log(`Alimtalk job added: jobId=${jobInfo.jobId}`);

        // 즉시 응답 (비동기 처리)
        sendSuccess(res, {
            jobId: jobInfo.jobId,
            status: jobInfo.status,
            recipientCount: jobInfo.recipientCount,
            message: 'Send request has been accepted. Please check the result via status API.',
            queueStatus: {
                pending: queueStatus.pending,
                running: queueStatus.running,
            },
        }, 202);
    } catch (error) {
        next(error);
    }
});

/**
 * 알림톡 발송 (동기 처리) - 소량 발송용
 * POST /api/alimtalk/send-sync
 * 
 * 500건 이하의 소량 발송 시 즉시 결과 반환
 * 대량 발송 시에는 /send 엔드포인트 사용 권장
 */
router.post('/send-sync', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = req.body as SendAlimtalkRequest;

        // 필수 파라미터 검증
        if (!body.unionId || !body.templateCode || !body.recipients || body.recipients.length === 0) {
            sendError(res, 'Required parameters are missing.', 'INVALID_PARAMS', 400);
            return;
        }

        // 수신자 수 제한 (동기 처리는 500건까지만)
        if (body.recipients.length > 500) {
            sendError(res, 'Sync processing supports up to 500 recipients. Please use /send endpoint.', 'TOO_MANY_RECIPIENTS', 400);
            return;
        }

        console.log(`Alimtalk sync send request: template=${body.templateCode}, recipients=${body.recipients.length}`);

        // 알리고 API 호출
        const aligoResult = await aligoService.sendAlimtalk(body);

        // Sender Key 정보 조회 (로그용)
        const senderKeyInfo = await aligoService.getSenderKey(body.unionId);

        // 비용 계산
        const estimatedCost = await pricingService.calculateCost(
            aligoResult.kakaoSuccessCount,
            aligoResult.smsSuccessCount
        );

        // 로그 저장 (templateName은 발송 결과에서 가져옴)
        const logId = await supabaseService.saveAlimtalkLog({
            union_id: body.unionId,
            sender_id: body.senderId,
            template_code: body.templateCode,
            template_name: aligoResult.templateName || body.templateCode,
            title: aligoResult.templateName || body.templateCode,
            notice_id: body.noticeId,
            sender_channel_name: senderKeyInfo.channelName,
            total_count: body.recipients.length,
            kakao_success_count: aligoResult.kakaoSuccessCount,
            sms_success_count: aligoResult.smsSuccessCount,
            fail_count: aligoResult.failCount,
            estimated_cost: estimatedCost,
            recipient_details: body.recipients,
            aligo_response: aligoResult.batchResults,
        });

        console.log(`Alimtalk sync send completed: logId=${logId}, success=${aligoResult.kakaoSuccessCount}, fail=${aligoResult.failCount}`);

        sendSuccess(res, {
            logId,
            totalCount: body.recipients.length,
            totalBatches: aligoResult.totalBatches,
            kakaoSuccessCount: aligoResult.kakaoSuccessCount,
            smsSuccessCount: aligoResult.smsSuccessCount,
            failCount: aligoResult.failCount,
            estimatedCost,
            channelName: senderKeyInfo.channelName,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 작업 상태 조회
 * GET /api/alimtalk/send/status/:jobId
 */
router.get('/send/status/:jobId', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { jobId } = req.params;

        if (!jobId) {
            sendError(res, 'jobId is required.', 'INVALID_PARAMS', 400);
            return;
        }

        const jobInfo = queueService.getJobStatus(jobId);

        if (!jobInfo) {
            sendError(res, 'Job not found.', 'JOB_NOT_FOUND', 404);
            return;
        }

        sendSuccess(res, {
            jobId: jobInfo.jobId,
            status: jobInfo.status,
            unionId: jobInfo.unionId,
            recipientCount: jobInfo.recipientCount,
            createdAt: jobInfo.createdAt,
            startedAt: jobInfo.startedAt,
            completedAt: jobInfo.completedAt,
            result: jobInfo.status === 'completed' ? {
                success: jobInfo.result?.success,
                totalRecipients: jobInfo.result?.totalRecipients,
                totalBatches: jobInfo.result?.totalBatches,
                kakaoSuccessCount: jobInfo.result?.kakaoSuccessCount,
                smsSuccessCount: jobInfo.result?.smsSuccessCount,
                failCount: jobInfo.result?.failCount,
            } : undefined,
            error: jobInfo.error,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 큐 상태 조회
 * GET /api/alimtalk/queue/status
 */
router.get('/queue/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const queueStatus = queueService.getQueueStatus();
        sendSuccess(res, queueStatus);
    } catch (error) {
        next(error);
    }
});

/**
 * 템플릿 동기화
 * POST /api/alimtalk/sync-templates
 */
router.post('/sync-templates', async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log('Template sync started');

        // 알리고에서 템플릿 목록 조회
        const aligoTemplates = await aligoService.getTemplateList();
        console.log(`Fetched ${aligoTemplates.length} templates from Aligo`);

        if (aligoTemplates.length === 0) {
            sendSuccess(res, {
                totalFromAligo: 0,
                inserted: 0,
                updated: 0,
                deleted: 0,
                syncedAt: new Date().toISOString(),
            });
            return;
        }

        // DB에 UPSERT
        const upsertResult = await supabaseService.upsertTemplates(aligoTemplates);

        // 알리고에 없는 템플릿 삭제
        const currentCodes = aligoTemplates.map(t => t.template_code);
        const deletedCount = await supabaseService.deleteOldTemplates(currentCodes);

        const result = {
            totalFromAligo: aligoTemplates.length,
            inserted: upsertResult.inserted,
            updated: upsertResult.updated,
            deleted: deletedCount,
            syncedAt: new Date().toISOString(),
        };

        console.log('Template sync completed:', result);

        sendSuccess(res, result);
    } catch (error) {
        next(error);
    }
});

export default router;

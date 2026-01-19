import { Router, Request, Response, NextFunction } from 'express';
import { smsService } from '../services/sms.service';
import { authMiddleware } from '../middleware';
import { SendSmsRequest } from '../types/sms.types';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

// 모든 SMS API에 인증 미들웨어 적용
router.use(authMiddleware);

/**
 * SMS 발송 (동기 처리)
 * POST /api/sms/send
 *
 * 500건 이하의 발송 시 즉시 결과 반환
 * 대량 발송 시에는 클라이언트에서 10건씩 분할하여 호출
 */
router.post('/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as SendSmsRequest;

    // 필수 파라미터 검증
    if (!body.unionId || !body.message || !body.recipients || body.recipients.length === 0) {
      sendError(res, 'Required parameters are missing.', 'INVALID_PARAMS', 400);
      return;
    }

    // 메시지 타입 기본값
    if (!body.msgType) {
      body.msgType = 'LMS';
    }

    // 수신자 수 제한 (동기 처리는 500건까지만)
    if (body.recipients.length > 500) {
      sendError(
        res,
        'Sync processing supports up to 500 recipients. Please split requests.',
        'TOO_MANY_RECIPIENTS',
        400
      );
      return;
    }

    console.log(
      `SMS send request: type=${body.msgType}, recipients=${body.recipients.length}`
    );

    // SMS 발송
    const result = await smsService.sendSms(body);

    // 로그 저장
    const logId = await smsService.saveSmsLog({
      union_id: body.unionId,
      sender_id: body.senderId,
      title: body.title,
      message: body.message,
      msg_type: body.msgType,
      total_count: body.recipients.length,
      success_count: result.successCount,
      fail_count: result.failCount,
      status: result.success ? 'completed' : 'failed',
      aligo_msg_ids: result.msgIds,
      estimated_cost: result.estimatedCost,
    });

    console.log(
      `SMS send completed: logId=${logId}, success=${result.successCount}, fail=${result.failCount}`
    );

    sendSuccess(res, {
      logId,
      totalCount: body.recipients.length,
      totalBatches: result.totalBatches,
      successCount: result.successCount,
      failCount: result.failCount,
      estimatedCost: result.estimatedCost,
      msgIds: result.msgIds,
      batchResults: result.batchResults.map((batch) => ({
        batchIndex: batch.batchIndex,
        success: batch.success,
        successCount: batch.successCount,
        failCount: batch.failCount,
        msgId: batch.msgId,
        error: batch.error,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * SMS 발송 (배치 단위) - 10건씩 분할 발송용
 * POST /api/sms/send-batch
 *
 * 클라이언트에서 10건씩 분할하여 호출
 * 각 배치의 결과를 즉시 반환
 */
router.post('/send-batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as SendSmsRequest & { batchIndex?: number };

    // 필수 파라미터 검증
    if (!body.unionId || !body.message || !body.recipients || body.recipients.length === 0) {
      sendError(res, 'Required parameters are missing.', 'INVALID_PARAMS', 400);
      return;
    }

    // 메시지 타입 기본값
    if (!body.msgType) {
      body.msgType = 'LMS';
    }

    // 배치 크기 제한 (최대 10건)
    if (body.recipients.length > 10) {
      sendError(res, 'Batch size must be 10 or less.', 'BATCH_TOO_LARGE', 400);
      return;
    }

    console.log(
      `SMS batch send: batchIndex=${body.batchIndex}, recipients=${body.recipients.length}`
    );

    // SMS 발송
    const result = await smsService.sendSms(body);

    // 배치 결과 반환 (로그는 클라이언트에서 최종 결과로 저장)
    sendSuccess(res, {
      batchIndex: body.batchIndex || 0,
      success: result.success,
      successCount: result.successCount,
      failCount: result.failCount,
      msgId: result.msgIds[0],
      error: result.batchResults[0]?.error,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

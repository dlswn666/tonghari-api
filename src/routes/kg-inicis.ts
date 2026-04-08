import { Router, Request, Response, NextFunction } from 'express';
import { kgInicisService } from '../services/kg-inicis.service';
import { authMiddleware } from '../middleware';
import { KgInicisRouteRequestBody, KgInicisCallbackParams } from '../types/kg-inicis.types';
import { sendSuccess, sendError } from '../utils/response';
import { env } from '../config/env';

const router = Router();

/** successUrl/failUrl 허용 도메인 목록 */
const ALLOWED_HOSTS = (env.KG_INICIS_ALLOWED_HOSTS || '').split(',').filter(Boolean);

/**
 * STEP1: 인증 요청
 * POST /api/kg-inicis/auth/request
 *
 * 가맹점 거래 ID와 인증 폼 파라미터를 생성하여 반환한다.
 * 프론트에서 이 데이터로 KG이니시스 인증 팝업을 띄움.
 */
router.post('/auth/request', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = req.body as KgInicisRouteRequestBody;

        // reqSvcCd 검증
        const VALID_REQ_SVC_CDS = ['01', '02', '03'];
        if (!body.reqSvcCd || !VALID_REQ_SVC_CDS.includes(body.reqSvcCd)) {
            sendError(res, "reqSvcCd must be '01', '02', or '03'.", 'INVALID_PARAMS', 400);
            return;
        }

        // successUrl, failUrl 필수 검증
        if (!body.successUrl || !body.failUrl) {
            sendError(res, 'successUrl and failUrl are required.', 'INVALID_PARAMS', 400);
            return;
        }

        // successUrl/failUrl 도메인 검증
        if (ALLOWED_HOSTS.length > 0) {
            for (const urlField of ['successUrl', 'failUrl'] as const) {
                try {
                    const parsed = new URL(body[urlField]);
                    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
                        sendError(res, `${urlField} host is not allowed.`, 'INVALID_URL', 400);
                        return;
                    }
                } catch {
                    sendError(res, `${urlField} is not a valid URL.`, 'INVALID_URL', 400);
                    return;
                }
            }
        }

        const result = kgInicisService.requestAuth({
            reqSvcCd: body.reqSvcCd,
            successUrl: body.successUrl,
            failUrl: body.failUrl,
            identifier: body.identifier,
            flgFixedUser: body.flgFixedUser,
            userName: body.userName,
            userPhone: body.userPhone,
            userBirthday: body.userBirthday,
        });

        sendSuccess(res, result);
    } catch (error) {
        next(error);
    }
});

/**
 * STEP2: KG이니시스 콜백 수신 (인증 성공)
 * POST /api/kg-inicis/auth/success
 *
 * KG이니시스 서버에서 호출하므로 authMiddleware 없음.
 */
router.post('/auth/success', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const mTxId: string = req.body?.mTxId || (req.query?.mTxId as string);

        if (!mTxId) {
            res.status(400).json({ success: false, error: 'mTxId is required.' });
            return;
        }

        const params: KgInicisCallbackParams = {
            resultCode: req.body?.resultCode || '0000',
            resultMsg: req.body?.resultMsg || '',
            authRequestUrl: req.body?.authRequestUrl,
            txId: req.body?.txId,
            token: req.body?.token,
        };

        kgInicisService.handleCallback(mTxId, params);

        res.status(200).json({ mTxId, status: 'CALLBACK_RECEIVED' });
    } catch (error) {
        next(error);
    }
});

/**
 * STEP2: KG이니시스 콜백 수신 (인증 실패)
 * POST /api/kg-inicis/auth/fail
 *
 * KG이니시스 서버에서 호출하므로 authMiddleware 없음.
 */
router.post('/auth/fail', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const mTxId: string = req.body?.mTxId || (req.query?.mTxId as string);
        const resultCode: string = req.body?.resultCode || '';
        const resultMsg: string = req.body?.resultMsg || '';

        res.status(200).json({
            mTxId,
            status: 'FAILED',
            resultCode,
            resultMsg,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * STEP3+4: 인증 결과 조회
 * POST /api/kg-inicis/auth/result
 *
 * 프론트에서 mTxId를 전달하면 KG이니시스에서 최종 인증 결과를 가져온다.
 */
router.post('/auth/result', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { mTxId } = req.body as { mTxId?: string };

        if (!mTxId) {
            sendError(res, 'mTxId is required.', 'INVALID_PARAMS', 400);
            return;
        }

        const result = await kgInicisService.queryResult(mTxId);

        sendSuccess(res, result);
    } catch (error) {
        next(error);
    }
});

/**
 * 거래 상태 조회
 * GET /api/kg-inicis/auth/status/:mTxId
 */
router.get('/auth/status/:mTxId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { mTxId } = req.params;

        const status = kgInicisService.getTxStatus(mTxId);

        if (status === null) {
            sendError(res, `Transaction not found: ${mTxId}`, 'NOT_FOUND', 404);
            return;
        }

        sendSuccess(res, { mTxId, status });
    } catch (error) {
        next(error);
    }
});

export default router;

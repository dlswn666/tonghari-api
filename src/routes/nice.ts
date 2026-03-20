import { Router, Request, Response, NextFunction } from 'express';
import { niceService } from '../services/nice.service';
import { authMiddleware } from '../middleware';
import { NiceEncryptRequest, NiceDecryptRequest } from '../types/nice.types';
import { sendSuccess, sendError } from '../utils/response';
import { env } from '../config/env';

const router = Router();

// 본인인증 API에 인증 미들웨어 적용
router.use(authMiddleware);

/** returnUrl 허용 도메인 목록 */
const ALLOWED_RETURN_HOSTS = (env.NICE_ALLOWED_RETURN_HOSTS || '').split(',').filter(Boolean);

/**
 * 본인인증 암호화 데이터 요청
 * POST /api/nice/encrypt
 *
 * NICE에서 crypto token을 받아 요청 데이터를 암호화하여 반환
 * 프론트에서 이 데이터로 NICE 인증 팝업을 띄움
 */
router.post('/encrypt', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = req.body as NiceEncryptRequest;

        if (!body.returnUrl) {
            sendError(res, 'returnUrl is required.', 'INVALID_PARAMS', 400);
            return;
        }

        // returnUrl 도메인 검증
        if (ALLOWED_RETURN_HOSTS.length > 0) {
            try {
                const parsed = new URL(body.returnUrl);
                if (!ALLOWED_RETURN_HOSTS.includes(parsed.hostname)) {
                    sendError(res, 'returnUrl host is not allowed.', 'INVALID_RETURN_URL', 400);
                    return;
                }
            } catch {
                sendError(res, 'returnUrl is not a valid URL.', 'INVALID_RETURN_URL', 400);
                return;
            }
        }

        const result = await niceService.encrypt({
            returnUrl: body.returnUrl,
            authType: body.authType || 'M',
            popupGuide: body.popupGuide,
            customize: body.customize,
        });

        sendSuccess(res, {
            requestNo: result.requestNo,
            tokenVersionId: result.tokenVersionId,
            encData: result.encData,
            integrityValue: result.integrityValue,
            authUrl: niceService.getAuthUrl(),
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 본인인증 결과 복호화
 * POST /api/nice/decrypt
 *
 * NICE 콜백에서 받은 암호화 데이터를 복호화하여 사용자 정보 반환
 */
router.post('/decrypt', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = req.body as NiceDecryptRequest;

        if (!body.requestNo || !body.encData || !body.integrityValue) {
            sendError(
                res,
                'requestNo, encData, integrityValue are required.',
                'INVALID_PARAMS',
                400
            );
            return;
        }

        const identity = niceService.decrypt(
            body.requestNo,
            body.encData,
            body.integrityValue
        );

        sendSuccess(res, {
            name: identity.utf8_name,
            birthDate: identity.birthdate,
            gender: identity.gender,
            mobileNo: identity.mobileno,
            mobileCo: identity.mobileco,
            nationalInfo: identity.nationalinfo,
            di: identity.di,
            ci: identity.ci,
            requestNo: identity.requestno,
            responseNo: identity.responseno,
            authType: identity.authtype,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Access Token 발급 (관리용, 최초 1회)
 * POST /api/nice/issue-token
 *
 * 개발/관리 환경에서만 사용 가능
 * 발급된 토큰은 환경변수(NICE_ACCESS_TOKEN)에 저장해야 함
 */
router.post('/issue-token', async (req: Request, res: Response, next: NextFunction) => {
    try {
        // production 환경에서는 접근 차단
        if (env.isProduction) {
            sendError(res, 'This endpoint is not available in production.', 'FORBIDDEN', 403);
            return;
        }

        const accessToken = await niceService.issueAccessToken();
        sendSuccess(res, { accessToken });
    } catch (error) {
        next(error);
    }
});

export default router;

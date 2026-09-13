import { Router, Request, Response, NextFunction } from 'express';
import { KgInicisService, kgInicisService } from '../services/kg-inicis.service';
import { identityVerificationAuthMiddleware } from '../middleware/auth';
import type { IdentityVerificationContext } from '../types/kg-inicis.types';
import { AppError } from '../middleware/errorHandler';
import { sendSuccess } from '../utils/response';

/** 범용/레거시 JWT를 본인확인 증빙으로 전용할 수 없게 서버 발급 범위를 검증한다. */
export function identityVerificationContext(req: Request): IdentityVerificationContext {
    const user = req.user;
    const now = Math.floor(Date.now() / 1000);
    const isId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128;
    if (!user || user.legacyProductionToken || user.isBlocked === true ||
        user.purpose !== 'IDENTITY_VERIFICATION' || !isId(user.userId) || !isId(user.unionId) || !isId(user.assemblyId) ||
        !['ENTRY', 'VOTE'].includes(user.verificationPurpose ?? '') ||
        !Number.isSafeInteger(user.issuedAt) || !Number.isSafeInteger(user.expiresAt) ||
        user.issuedAt! > now || user.expiresAt! <= now || user.expiresAt! - user.issuedAt! > 60 ||
        user.expiresAt! <= user.issuedAt!) {
        throw new AppError('본인확인 전용 인증 권한이 필요합니다.', 403, 'IDENTITY_VERIFICATION_FORBIDDEN');
    }
    return { userId: user.userId, unionId: user.unionId, databaseTarget: user.databaseTarget,
        assemblyId: user.assemblyId!, purpose: user.verificationPurpose! };
}

export function createKgInicisRouter(service: KgInicisService = kgInicisService): Router {
    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });
    const scoped = [identityVerificationAuthMiddleware,
        (req: Request, _res: Response, next: NextFunction) => {
            try { identityVerificationContext(req); next(); } catch (error) { next(error); }
        }];

    router.get('/auth/readiness', ...scoped, (req, res, next) => {
        try { sendSuccess(res, service.getReadiness(identityVerificationContext(req).databaseTarget)); }
        catch (error) { next(error); }
    });
    router.post('/auth/request', ...scoped, (req, res, next) => {
        try {
            const body = req.body;
            // 제어 파라미터를 클라이언트나 범용 프록시로부터 받지 않는다.
            if (!body || typeof body !== 'object' || Array.isArray(body) ||
                Object.keys(body).some((key) => !['reqSvcCd', 'expectedIdentity'].includes(key)) ||
                !body.expectedIdentity || typeof body.expectedIdentity !== 'object' || Array.isArray(body.expectedIdentity) ||
                Object.keys(body.expectedIdentity).some((key) => !['name', 'phone', 'birthday'].includes(key))) {
                throw new AppError('본인확인 요청 형식이 올바르지 않습니다.', 400, 'INVALID_PARAMS');
            }
            sendSuccess(res, service.requestAuth(body, identityVerificationContext(req)));
        } catch (error) { next(error); }
    });
    for (const outcome of ['success', 'fail'] as const) {
        router.post(`/auth/${outcome}`, (req, res, next) => {
            try {
                const mTxId = typeof req.query.t === 'string' ? req.query.t : '';
                const state = typeof req.query.s === 'string' ? req.query.s : '';
                service.handleCallback(mTxId, state, outcome, {
                    resultCode: req.body?.resultCode,
                    authRequestUrl: req.body?.authRequestUrl,
                    txId: req.body?.txId,
                    token: req.body?.token,
                });
                sendSuccess(res, { mTxId, status: outcome === 'success' ? 'CALLBACK_RECEIVED' : 'FAILED' });
            } catch (error) { next(error); }
        });
    }
    router.post('/auth/result', ...scoped, async (req, res, next) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body) ||
                Object.keys(body).some((key) => !['mTxId', 'expectedIdentity'].includes(key)) ||
                typeof body.mTxId !== 'string' || !body.expectedIdentity ||
                typeof body.expectedIdentity !== 'object' || Array.isArray(body.expectedIdentity) ||
                Object.keys(body.expectedIdentity).some((key) => !['name', 'phone', 'birthday'].includes(key)) ||
                typeof body.expectedIdentity.name !== 'string' || typeof body.expectedIdentity.phone !== 'string' ||
                (body.expectedIdentity.birthday !== undefined && typeof body.expectedIdentity.birthday !== 'string')) {
                throw new AppError('본인확인 결과 요청 형식이 올바르지 않습니다.', 400, 'INVALID_PARAMS');
            }
            sendSuccess(res, await service.queryResult(body.mTxId, identityVerificationContext(req), body.expectedIdentity));
        }
        catch (error) { next(error); }
    });
    router.get('/auth/status/:mTxId', ...scoped, (req, res, next) => {
        try { sendSuccess(res, { mTxId: req.params.mTxId,
            status: service.getTxStatus(req.params.mTxId, identityVerificationContext(req)) }); }
        catch (error) { next(error); }
    });
    return router;
}

export default createKgInicisRouter();

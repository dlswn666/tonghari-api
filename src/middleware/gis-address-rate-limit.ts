import { NextFunction, Request, Response } from 'express';
import { FixedWindowRateLimiter } from '../security/fixed-window-rate-limiter';

const addressReadLimiter = new FixedWindowRateLimiter(30, 60_000);

/** 인증된 사용자별 주소→PNU 조회를 분당 30회로 제한한다. */
export function gisAddressReadRateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const userId = req.user?.userId;
    if (!userId) {
        res.status(401).json({ success: false, code: 'UNAUTHORIZED', error: '인증이 필요합니다.' });
        return;
    }

    const decision = addressReadLimiter.consume(userId);
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        res.status(429).json({
            success: false,
            code: 'GIS_ADDRESS_RATE_LIMITED',
            error: '주소 검색 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
        });
        return;
    }

    next();
}

import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';

/**
 * JWT Bearer 토큰 인증 미들웨어 (Shared Secret 방식)
 * 
 * 통하리 홈페이지에서 생성한 JWT 토큰을 검증합니다.
 * 검증 성공 시 req.user에 인증 정보를 추가합니다.
 */
export const authMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
): void => {
    const authHeader = req.headers.authorization;

    // Authorization 헤더에서 토큰 추출
    const token = authService.extractBearerToken(authHeader);

    if (!token) {
        res.status(401).json({
            success: false,
            error: 'Authorization header missing or invalid',
            code: 'UNAUTHORIZED',
        });
        return;
    }

    // JWT 토큰 검증
    const verifyResult = authService.verifyToken(token);

    if (!verifyResult.valid || !verifyResult.payload) {
        res.status(401).json({
            success: false,
            error: verifyResult.error || 'Invalid token',
            code: verifyResult.errorCode || 'INVALID_TOKEN',
        });
        return;
    }

    // 인증 정보를 request에 추가
    req.user = {
        unionId: verifyResult.payload.unionId,
        userId: verifyResult.payload.userId,
    };

    next();
};

export default authMiddleware;

import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';

/**
 * JWT Bearer 토큰 인증 미들웨어 (Shared Secret 방식)
 * 
 * 통하리 홈페이지에서 생성한 JWT 토큰을 검증합니다.
 * 검증 성공 시 req.user에 인증 정보를 추가합니다.
 */
function authenticateRequest(
    req: Request,
    res: Response,
    next: NextFunction,
    allowDevelopment: boolean
): void {
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

    if (!verifyResult.valid || !verifyResult.payload || !verifyResult.databaseTarget) {
        res.status(401).json({
            success: false,
            error: verifyResult.error || 'Invalid token',
            code: verifyResult.errorCode || 'INVALID_TOKEN',
        });
        return;
    }

    if (verifyResult.databaseTarget === 'development' && !allowDevelopment) {
        res.status(403).json({
            success: false,
            error: 'Development token is not allowed for this endpoint.',
            code: 'DEVELOPMENT_TARGET_NOT_SUPPORTED',
        });
        return;
    }

    // 인증 정보를 request에 추가
    req.user = {
        unionId: verifyResult.payload.unionId,
        userId: verifyResult.payload.userId,
        role: verifyResult.payload.role,
        isBlocked: verifyResult.payload.isBlocked,
        actorUserId: verifyResult.payload.actorUserId,
        purpose: verifyResult.payload.purpose,
        scope: verifyResult.payload.scope,
        operation: verifyResult.payload.operation,
        issuer: verifyResult.payload.iss,
        audience: verifyResult.payload.aud,
        databaseTarget: verifyResult.databaseTarget,
        legacyProductionToken: verifyResult.legacyProductionToken === true,
    };

    next();
}

/** 운영 전용 기본 인증. 알림톡/SMS/KG이니시스 등 미분기 side effect를 dev 토큰에서 차단한다. */
export const authMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
): void => authenticateRequest(req, res, next, false);

/** DB target 전파가 완료된 GIS/조합원 경로에서만 사용하는 인증. */
export const databaseTargetAuthMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
): void => authenticateRequest(req, res, next, true);

export default authMiddleware;

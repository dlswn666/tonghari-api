import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import {
    LAND_AREA_SYNC_DISABLED_CODE,
    LAND_AREA_SYNC_DISABLED_MESSAGE,
} from '../security/land-area-sync-execution-policy';
import {
    LandAreaSyncCanaryError,
    assertLandAreaSyncCanaryAllowed,
} from '../security/land-area-sync-canary-policy';

/**
 * LAND_AREA_SYNC 쓰기 경로의 전역 emergency gate.
 * 인증·SYSTEM_ADMIN 재검증 뒤, handler와 모든 DB write보다 먼저 실행한다.
 */
export function landAreaSyncEnabledMiddleware(
    _req: Request,
    res: Response,
    next: NextFunction
): void {
    if (!env.LAND_AREA_SYNC_ENABLED) {
        res.status(503).json({
            success: false,
            code: LAND_AREA_SYNC_DISABLED_CODE,
            error: LAND_AREA_SYNC_DISABLED_MESSAGE,
        });
        return;
    }

    next();
}

/**
 * discovery 입력의 DB target + union + anchor PNU exact canary gate.
 * confirmation은 body anchor를 신뢰하지 않고 저장된 discovery lineage로 route에서 같은 정책을 적용한다.
 */
export function landAreaSyncDiscoveryCanaryMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    const { unionId, anchorPnu } = req.body ?? {};
    try {
        assertLandAreaSyncCanaryAllowed(
            env.LAND_AREA_SYNC_ALLOWED_TARGETS,
            req.user?.databaseTarget,
            unionId,
            anchorPnu
        );
        next();
    } catch (error) {
        if (error instanceof LandAreaSyncCanaryError) {
            res.status(error.status).json({
                success: false,
                code: error.code,
                error: error.message,
            });
            return;
        }
        throw error;
    }
}

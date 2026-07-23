import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import {
    LAND_AREA_SYNC_DISABLED_CODE,
    LAND_AREA_SYNC_DISABLED_MESSAGE,
} from '../security/land-area-sync-execution-policy';

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

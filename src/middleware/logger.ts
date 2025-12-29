import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger';

const logger = createLogger('HTTP');

/**
 * 요청 로깅 미들웨어
 */
export const loggerMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
): void => {
    const startTime = Date.now();

    // 응답 완료 시 추가 정보 로깅
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const message = `${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`;
        
        if (res.statusCode >= 500) {
            logger.error(message);
        } else if (res.statusCode >= 400) {
            logger.warn(message);
        } else {
            logger.info(message);
        }
    });

    next();
};

export default loggerMiddleware;


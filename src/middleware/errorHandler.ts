import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/**
 * 커스텀 에러 클래스
 */
export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code: string;
    public readonly isOperational: boolean;

    constructor(message: string, statusCode: number = 500, code: string = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true;

        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * 에러 핸들링 미들웨어
 */
export const errorHandler = (
    err: Error | AppError,
    req: Request,
    res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: NextFunction
): void => {
    // AppError인 경우
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            success: false,
            error: err.message,
            code: err.code,
        });
        return;
    }

    // 전역 JSON/form 파서 오류에는 err.body로 인증 token과 개인정보가 붙을 수 있다.
    // KG 경로는 라우터 진입 전 오류도 원문/stack을 로그나 응답에 전달하지 않는다.
    const normalizedPath = req.path.toLowerCase();
    if (normalizedPath === '/api/kg-inicis' || normalizedPath.startsWith('/api/kg-inicis/')) {
        const parserError = err as Error & { status?: number };
        const status = parserError.status === 400 || parserError.status === 413 ? parserError.status : 500;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.status(status).json({
            success: false,
            error: '본인확인 요청을 처리할 수 없습니다. 다시 시도해 주세요.',
            code: status === 400 || status === 413 ? 'INVALID_PARAMS' : 'IDENTITY_VERIFICATION_FAILED',
        });
        return;
    }

    // 일반 에러인 경우
    console.error('Unhandled error:', err);

    res.status(500).json({
        success: false,
        error: env.isDevelopment ? err.message : 'Internal server error',
        code: 'INTERNAL_ERROR',
    });
};

/**
 * 404 핸들러
 */
export const notFoundHandler = (
    req: Request,
    res: Response
): void => {
    res.status(404).json({
        success: false,
        error: `Route ${req.method} ${req.path} not found`,
        code: 'NOT_FOUND',
    });
};

export default errorHandler;

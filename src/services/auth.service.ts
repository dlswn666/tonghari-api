import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { JwtPayload, TokenVerifyResult } from '../types/auth.types';

/**
 * JWT 인증 서비스 (Shared Secret 방식)
 * 
 * 조합온 홈페이지에서 생성한 JWT 토큰을 검증합니다.
 * 토큰 발급은 조합온 서버에서 수행하며, 이 서버는 검증만 담당합니다.
 */
class AuthService {
    private readonly jwtSecret: string;

    constructor() {
        this.jwtSecret = env.JWT_SECRET;
    }

    /**
     * JWT 토큰 검증
     * 
     * @param token - 검증할 JWT 토큰
     * @returns 검증 결과
     */
    verifyToken(token: string): TokenVerifyResult {
        if (!token) {
            return {
                valid: false,
                error: 'Token was not provided.',
                errorCode: 'NO_TOKEN',
            };
        }

        try {
            // JWT 토큰 검증
            const decoded = jwt.verify(token, this.jwtSecret) as JwtPayload;

            // 필수 필드 확인
            if (!decoded.unionId || !decoded.userId) {
                return {
                    valid: false,
                    error: 'Required information is missing in token.',
                    errorCode: 'MALFORMED_TOKEN',
                };
            }

            return {
                valid: true,
                payload: decoded,
            };
        } catch (error) {
            if (error instanceof jwt.TokenExpiredError) {
                return {
                    valid: false,
                    error: 'Token has expired.',
                    errorCode: 'EXPIRED_TOKEN',
                };
            }

            if (error instanceof jwt.JsonWebTokenError) {
                return {
                    valid: false,
                    error: 'Invalid token.',
                    errorCode: 'INVALID_TOKEN',
                };
            }

            return {
                valid: false,
                error: 'An error occurred during token verification.',
                errorCode: 'INVALID_TOKEN',
            };
        }
    }

    /**
     * Authorization 헤더에서 Bearer 토큰 추출
     * 
     * @param authHeader - Authorization 헤더 값
     * @returns 추출된 토큰 또는 null
     */
    extractBearerToken(authHeader: string | undefined): string | null {
        if (!authHeader) {
            return null;
        }

        if (!authHeader.startsWith('Bearer ')) {
            return null;
        }

        return authHeader.substring(7);
    }
}

export const authService = new AuthService();
export default authService;


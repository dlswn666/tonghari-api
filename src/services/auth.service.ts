import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { JwtPayload, TokenVerifyResult } from '../types/auth.types';
import { DatabaseTarget } from '../types/database.types';

interface AuthServiceSecrets {
    production: string;
    development?: string;
}

/**
 * JWT 인증 서비스 (Shared Secret 방식)
 * 
 * 통하리 홈페이지에서 생성한 JWT 토큰을 검증합니다.
 * 토큰 발급은 통하리 서버에서 수행하며, 이 서버는 검증만 담당합니다.
 */
export class AuthService {
    private readonly secrets: AuthServiceSecrets;

    constructor(secrets: AuthServiceSecrets = {
        production: env.JWT_SECRET,
        development: env.DEV_API_JWT_SECRET || undefined,
    }) {
        if (secrets.development && secrets.development === secrets.production) {
            throw new Error('DEV_API_JWT_SECRET은 운영 JWT_SECRET과 달라야 합니다.');
        }
        this.secrets = secrets;
    }

    private hasExpectedAudience(audience: JwtPayload['aud']): boolean {
        return audience === 'tonghari-api' ||
            (Array.isArray(audience) && audience.includes('tonghari-api'));
    }

    /**
     * 검증에 성공한 서명키가 환경을 확정한다. claim은 그 환경과 일치하는지 확인할 뿐이다.
     */
    private validateEnvironmentClaims(
        payload: JwtPayload,
        verifiedTarget: DatabaseTarget,
        legacyProductionToken: boolean
    ): TokenVerifyResult | null {
        if (legacyProductionToken) {
            if (
                verifiedTarget !== 'production' ||
                payload.databaseTarget !== undefined ||
                payload.iss === 'tonghari-web-dev'
            ) {
                return {
                    valid: false,
                    error: 'Token environment is invalid.',
                    errorCode: 'TOKEN_ENVIRONMENT_INVALID',
                };
            }
            return null;
        }

        if (verifiedTarget === 'development') {
            if (
                payload.databaseTarget !== 'development' ||
                payload.iss !== 'tonghari-web-dev' ||
                !this.hasExpectedAudience(payload.aud)
            ) {
                return {
                    valid: false,
                    error: 'Token environment is invalid.',
                    errorCode: 'TOKEN_ENVIRONMENT_INVALID',
                };
            }
            return null;
        }

        if (
            payload.databaseTarget !== 'production' ||
            payload.iss !== 'tonghari-web' ||
            !this.hasExpectedAudience(payload.aud)
        ) {
            return {
                valid: false,
                error: 'Token environment is invalid.',
                errorCode: 'TOKEN_ENVIRONMENT_INVALID',
            };
        }
        return null;
    }

    private verifyWithSecret(
        token: string,
        secret: string,
        databaseTarget: DatabaseTarget,
        legacyProductionToken: boolean
    ): TokenVerifyResult {
        const decoded = jwt.verify(token, secret, {
            algorithms: ['HS256'],
        }) as JwtPayload;

        if (!decoded.unionId || !decoded.userId) {
            return {
                valid: false,
                error: 'Required information is missing in token.',
                errorCode: 'MALFORMED_TOKEN',
            };
        }

        const environmentFailure = this.validateEnvironmentClaims(
            decoded,
            databaseTarget,
            legacyProductionToken
        );
        if (environmentFailure) return environmentFailure;

        return {
            valid: true,
            payload: decoded,
            databaseTarget,
            legacyProductionToken,
        };
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

        const decodedHeader = jwt.decode(token, { complete: true })?.header;
        const keyId = typeof decodedHeader?.kid === 'string' ? decodedHeader.kid : null;

        if (keyId !== null && keyId !== 'prod' && keyId !== 'dev') {
            return {
                valid: false,
                error: 'Token environment is invalid.',
                errorCode: 'TOKEN_ENVIRONMENT_INVALID',
            };
        }

        if (keyId === 'prod') {
            try {
                return this.verifyWithSecret(token, this.secrets.production, 'production', false);
            } catch (error) {
                return this.toVerifyError(error);
            }
        }

        if (keyId === 'dev') {
            if (!this.secrets.development) {
                return {
                    valid: false,
                    error: 'Token environment is invalid.',
                    errorCode: 'TOKEN_ENVIRONMENT_INVALID',
                };
            }
            try {
                return this.verifyWithSecret(token, this.secrets.development, 'development', false);
            } catch (error) {
                return this.toVerifyError(error);
            }
        }

        // kid가 없는 기존 토큰은 운영 키로만 검증하고 production으로만 한정한다.
        try {
            return this.verifyWithSecret(token, this.secrets.production, 'production', true);
        } catch (error) {
            return this.toVerifyError(error);
        }
    }

    private toVerifyError(error: unknown): TokenVerifyResult {
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

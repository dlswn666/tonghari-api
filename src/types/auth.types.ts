import { DatabaseTarget } from './database.types';

/**
 * JWT 페이로드 타입
 */
export interface JwtPayload {
    /** 조합 ID */
    unionId: string;
    /** 사용자 ID */
    userId: string;
    /** 프록시에서 재검증할 시스템 역할 */
    role?: 'SYSTEM_ADMIN' | 'ADMIN' | 'USER';
    /** 토큰 발급 시점 차단 상태 */
    isBlocked?: boolean;
    /** 감사 로그용 내부 users.id. 권한 판정에는 사용하지 않음 */
    actorUserId?: string;
    /** shared-secret 토큰의 허용 용도 */
    purpose?: 'MEMBER_QUEUE' | 'GIS_SYSTEM_ADMIN' | 'CONSENT_QUEUE';
    /** 개발 환경의 제한된 읽기 토큰 범위 */
    scope?: 'GIS_ADDRESS_READ';
    /** MEMBER_QUEUE 토큰이 호출할 수 있는 단일 작업 */
    operation?:
        | 'MEMBER_INVITE_SYNC'
        | 'PRE_REGISTER'
        | 'CONSENT_BULK_UPDATE'
        | 'CONSENT_BULK_UPLOAD';
    /** 토큰 발급자 */
    iss?: string;
    /** 토큰 대상 */
    aud?: string | string[];
    /** 토큰을 발급한 Web 환경. 운영 레거시 토큰에서는 생략될 수 있다. */
    databaseTarget?: DatabaseTarget;
    /** 발급 시간 (issued at) */
    iat: number;
    /** 만료 시간 (expiration) */
    exp: number;
}

/**
 * 토큰 검증 결과 타입
 */
export interface TokenVerifyResult {
    /** 검증 성공 여부 */
    valid: boolean;
    /** 검증된 페이로드 (성공 시) */
    payload?: JwtPayload;
    /** 오류 메시지 (실패 시) */
    error?: string;
    /** 오류 코드 */
    errorCode?:
        | 'INVALID_TOKEN'
        | 'EXPIRED_TOKEN'
        | 'MALFORMED_TOKEN'
        | 'NO_TOKEN'
        | 'TOKEN_ENVIRONMENT_INVALID';
    /** JWT 서명키로 확정된 DB 환경. claim 자체를 선택자로 사용하지 않는다. */
    databaseTarget?: DatabaseTarget;
    /** kid/databaseTarget이 없는 기존 운영 토큰 호환 여부 */
    legacyProductionToken?: boolean;
}

/**
 * 인증된 요청에 추가되는 사용자 정보
 */
export interface AuthenticatedUser {
    unionId: string;
    userId: string;
    role?: 'SYSTEM_ADMIN' | 'ADMIN' | 'USER';
    isBlocked?: boolean;
    actorUserId?: string;
    purpose?: 'MEMBER_QUEUE' | 'GIS_SYSTEM_ADMIN' | 'CONSENT_QUEUE';
    scope?: 'GIS_ADDRESS_READ';
    operation?:
        | 'MEMBER_INVITE_SYNC'
        | 'PRE_REGISTER'
        | 'CONSENT_BULK_UPDATE'
        | 'CONSENT_BULK_UPLOAD';
    issuer?: string;
    audience?: string | string[];
    databaseTarget: DatabaseTarget;
    legacyProductionToken: boolean;
}

/**
 * Express Request에 인증 정보 확장
 */
declare global {
    namespace Express {
        interface Request {
            user?: AuthenticatedUser;
        }
    }
}

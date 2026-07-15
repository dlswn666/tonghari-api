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
    purpose?: 'MEMBER_QUEUE' | 'GIS_SYSTEM_ADMIN';
    /** MEMBER_QUEUE 토큰이 호출할 수 있는 단일 작업 */
    operation?: 'MEMBER_INVITE_SYNC' | 'PRE_REGISTER';
    /** 토큰 발급자 */
    iss?: string;
    /** 토큰 대상 */
    aud?: string | string[];
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
    errorCode?: 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'MALFORMED_TOKEN' | 'NO_TOKEN';
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
    purpose?: 'MEMBER_QUEUE' | 'GIS_SYSTEM_ADMIN';
    operation?: 'MEMBER_INVITE_SYNC' | 'PRE_REGISTER';
    issuer?: string;
    audience?: string | string[];
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

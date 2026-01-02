/**
 * 조합원 대량 처리 관련 타입 정의
 */

/**
 * 작업 유형
 */
export type MemberJobType = 'MEMBER_INVITE_SYNC' | 'PRE_REGISTER';

/**
 * 작업 상태
 */
export type MemberJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

// ============================================
// 조합원 초대 동기화 (MEMBER_INVITE_SYNC)
// ============================================

/**
 * 조합원 초대 데이터 (엑셀에서 파싱된 데이터)
 */
export interface MemberInviteData {
    name: string;
    phone_number: string;
}

/**
 * 조합원 초대 동기화 요청
 */
export interface MemberInviteSyncRequest {
    jobType: 'MEMBER_INVITE_SYNC';
    unionId: string;
    createdBy: string;
    expiresHours?: number; // 기본값: 8760 (1년)
    members: MemberInviteData[];
}

/**
 * 조합원 초대 동기화 결과
 */
export interface MemberInviteSyncResult {
    inserted: number;
    deleted_pending: number;
    deleted_used: number;
    deleted_auth_user_ids: string[];
}

// ============================================
// 사전 등록 (PRE_REGISTER)
// ============================================

/**
 * 사전 등록 데이터 (엑셀에서 파싱된 데이터)
 */
export interface PreRegisterData {
    name: string;
    phoneNumber?: string;
    propertyAddress: string; // 소유지 지번 (필수)
    dong?: string;
    ho?: string;
    residentAddress?: string;
}

/**
 * 사전 등록 매칭 결과
 */
export interface PreRegisterMatchingResult {
    row: PreRegisterData;
    matched: boolean;
    pnu: string | null;
    matchedAddress: string | null;
    error?: string;
}

/**
 * 사전 등록 요청
 */
export interface PreRegisterRequest {
    jobType: 'PRE_REGISTER';
    unionId: string;
    members: PreRegisterMatchingResult[];
}

/**
 * 사전 등록 결과
 */
export interface PreRegisterResult {
    success: boolean;
    totalCount: number;
    matchedCount: number;
    unmatchedCount: number;
    savedCount: number;
    errors: string[];
}

// ============================================
// 공통 타입
// ============================================

/**
 * 조합원 대량 처리 요청 (통합)
 */
export type MemberBulkRequest = MemberInviteSyncRequest | PreRegisterRequest;

/**
 * 작업 정보
 */
export interface MemberJobInfo {
    jobId: string;
    jobType: MemberJobType;
    unionId: string;
    totalCount: number;
    processedCount: number;
    status: MemberJobStatus;
    error?: string;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    result?: MemberInviteSyncResult | PreRegisterResult;
}

/**
 * 작업 상태 응답
 */
export interface MemberJobStatusResponse {
    jobId: string;
    jobType: MemberJobType;
    status: MemberJobStatus;
    progress: number; // 0-100
    totalCount: number;
    processedCount: number;
    result?: MemberInviteSyncResult | PreRegisterResult;
    error?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
}

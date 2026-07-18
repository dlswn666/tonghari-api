/**
 * 동의 처리 관련 타입 정의
 */
import { DatabaseTarget } from './database.types';

/**
 * 작업 유형
 */
export type ConsentJobType = 'CONSENT_BULK_UPDATE' | 'CONSENT_BULK_UPLOAD';

/**
 * 작업 상태
 */
export type ConsentJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * 동의 상태
 */
export type ConsentStatus = 'AGREED' | 'DISAGREED';

// ============================================
// 일괄 동의 처리 (CONSENT_BULK_UPDATE)
// ============================================

/**
 * 일괄 동의 처리 요청
 * Next.js API에서 sync_jobs 생성 후 프록시 서버로 전달
 */
export interface ConsentBulkUpdateRequest {
    jobId: string;
    unionId: string;
    stageId: string;
    actorUserId: string;
    memberIds: string[];
    status: ConsentStatus;
    databaseTarget: DatabaseTarget;
}

/**
 * 일괄 동의 처리 결과
 */
export interface ConsentBulkUpdateResult {
    success: boolean;
    totalCount: number;
    successCount: number;
    failCount: number;
    errors: string[];
}

// ============================================
// 엑셀 업로드 동의 처리 (CONSENT_BULK_UPLOAD)
// ============================================

/**
 * 엑셀 업로드 행 데이터
 */
export interface ConsentUploadRow {
    rowNumber: number;
    name: string;
    address: string;
    buildingName?: string;
    dong?: string;
    ho?: string;
    status: string; // 'AGREED' | 'DISAGREED'
}

/**
 * 엑셀 업로드 동의 처리 요청
 */
export interface ConsentUploadRequest {
    jobId: string;
    unionId: string;
    stageId: string;
    actorUserId: string;
    data: ConsentUploadRow[];
    databaseTarget: DatabaseTarget;
}

/**
 * 엑셀 업로드 동의 처리 결과
 */
export interface ConsentUploadResult {
    success: boolean;
    totalCount: number;
    successCount: number;
    failCount: number;
    errors: { row: number; message: string }[];
}

// ============================================
// 공통 타입
// ============================================

/**
 * 동의 처리 요청 (통합)
 */
export type ConsentBulkRequest = ConsentBulkUpdateRequest | ConsentUploadRequest;

/**
 * 작업 정보
 */
export interface ConsentJobInfo {
    jobId: string;
    jobType: ConsentJobType;
    unionId: string;
    stageId: string;
    totalCount: number;
    processedCount: number;
    status: ConsentJobStatus;
    error?: string;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    result?: ConsentBulkUpdateResult | ConsentUploadResult;
}

/**
 * 작업 상태 응답
 */
export interface ConsentJobStatusResponse {
    jobId: string;
    jobType: ConsentJobType;
    status: ConsentJobStatus;
    progress: number; // 0-100
    totalCount: number;
    processedCount: number;
    result?: ConsentBulkUpdateResult | ConsentUploadResult;
    error?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
}

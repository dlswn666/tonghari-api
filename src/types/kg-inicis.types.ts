import type { DatabaseTarget } from './database.types';

/** 이번 연결 계약은 본인확인만 지원한다. 전자서명은 별도 계약이다. */
export type ReqSvcCd = '03';
export type VerificationPurpose = 'ENTRY' | 'VOTE';

export interface IdentityVerificationContext {
    userId: string;
    unionId: string;
    databaseTarget: DatabaseTarget;
    assemblyId: string;
    purpose: VerificationPurpose;
}

export interface KgInicisAuthRequest {
    reqSvcCd: ReqSvcCd;
    /** Web 서버가 조합원 자료로 확정한 비교 기준. 클라이언트 입력은 금지한다. */
    expectedIdentity: { name: string; phone: string; birthday?: string };
}

export interface KgInicisAuthRequestResult {
    mTxId: string;
    authUrl: string;
    formParams: Record<string, string>;
    expiresAt: string;
}

export interface KgInicisCallbackParams {
    resultCode?: unknown;
    authRequestUrl?: unknown;
    txId?: unknown;
    token?: unknown;
}

/** 서버 간 1회 소비 결과. CI/DI 및 원시 응답은 외부로 반환하지 않는다. */
export interface KgInicisVerifiedResult {
    verified: true;
    mTxId: string;
    txId: string;
    svcCd: '03';
    providerDevCd: string;
    verifiedAt: string;
    assemblyId: string;
    purpose: VerificationPurpose;
    /** 원거래 유효기간 및 서버 검증 영수증. 브라우저 응답에는 포함하지 않는다. */
    issuedAt: string;
    expiresAt: string;
    expectedSubjectDigest: string;
    verifiedSubjectDigest: string;
    requestPayloadDigest: string;
    providerEvidenceDigest: string;
    callbackDigest: string;
}

export type KgInicisTxStatus = 'REQUESTED' | 'CALLBACK_RECEIVED' | 'VERIFYING' | 'FAILED' | 'EXPIRED';
export type KgInicisRouteRequestBody = KgInicisAuthRequest;
export type KgInicisRouteResultBody = KgInicisAuthRequestResult;

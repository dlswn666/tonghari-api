/**
 * KG이니시스 통합인증 API 타입 정의
 */

/**
 * 요청 서비스 코드
 * '01': 간편인증, '02': 전자서명, '03': 본인확인
 */
export type ReqSvcCd = '01' | '02' | '03';

/**
 * 요청 서비스 코드 → 서비스명 매핑
 */
export const REQ_SVC_NAMES: Record<ReqSvcCd, string> = {
    '01': '간편인증',
    '02': '전자서명',
    '03': '본인확인',
};

/**
 * STEP1: 인증 요청 파라미터 (프론트 → API)
 */
export interface KgInicisAuthRequest {
    /** 요청 서비스 코드 ('01': 간편인증, '02': 전자서명, '03': 본인확인) */
    reqSvcCd: ReqSvcCd;
    /** 인증 성공 시 리다이렉트 URL */
    successUrl: string;
    /** 인증 실패 시 리다이렉트 URL */
    failUrl: string;
    /** 식별자 (거래 추적용, 선택) */
    identifier?: string;
    /** 사용자 정보 고정 여부 ('Y'/'N', 선택) */
    flgFixedUser?: 'Y' | 'N';
    /** 사용자 이름 (선택) */
    userName?: string;
    /** 사용자 전화번호 (선택) */
    userPhone?: string;
    /** 사용자 생년월일 YYYYMMDD (선택) */
    userBirthday?: string;
}

/**
 * STEP1 응답: 프론트엔드로 반환되는 인증 시작 데이터 (API → 프론트)
 */
export interface KgInicisAuthRequestResult {
    /** 가맹점 거래 ID */
    mTxId: string;
    /** 인증 팝업/리다이렉트 URL */
    authUrl: string;
    /** 인증 폼 전송용 파라미터 */
    formParams: Record<string, string>;
}

/**
 * STEP2: KG이니시스 콜백 파라미터 (KG이니시스 → API 콜백)
 */
export interface KgInicisCallbackParams {
    /** 결과 코드 ('0000': 성공) */
    resultCode: string;
    /** 결과 메시지 */
    resultMsg: string;
    /** 인증 결과 조회 URL (성공 시) */
    authRequestUrl?: string;
    /** KG이니시스 거래 ID (성공 시) */
    txId?: string;
    /** 인증 토큰 (성공 시) */
    token?: string;
}

/**
 * STEP3: 인증 결과 조회 요청 (프론트 → API)
 */
export interface KgInicisResultQueryRequest {
    /** 가맹점 거래 ID */
    mTxId: string;
}

/**
 * STEP4: 인증 결과 공통 필드
 */
export interface KgInicisResultBase {
    /** 결과 코드 ('0000': 성공) */
    resultCode: string;
    /** 결과 메시지 */
    resultMsg: string;
    /** KG이니시스 거래 ID */
    txId: string;
    /** 가맹점 거래 ID */
    mTxId: string;
    /** 인증 결과 조회 URL */
    authRequestUrl: string;
    /** 사용자 이름 */
    userName?: string;
    /** 사용자 전화번호 */
    userPhone?: string;
    /** 연계정보 CI (88byte) */
    userCi?: string;
}

/**
 * STEP4: 본인확인('03') 결과 — KgInicisResultBase 확장
 */
export interface KgInicisIdResult extends KgInicisResultBase {
    /** 중복가입확인정보 DI */
    userDi?: string;
    /** 연계정보 CI2 (일부 기관 추가 제공) */
    userCi2?: string;
    /** 성별 ('M': 남성, 'F': 여성) */
    userGender?: 'M' | 'F';
    /** 외국인 여부 ('Y': 외국인, 'N': 내국인) */
    isForeign?: 'Y' | 'N';
}

/**
 * STEP4: 전자서명('02') 결과 — KgInicisResultBase 확장
 */
export interface KgInicisEsignResult extends KgInicisResultBase {
    /** 서명 데이터 (Base64 인코딩) */
    signedData?: string;
}

/**
 * KG이니시스 거래 상태
 * REQUESTED: 인증 요청됨
 * CALLBACK_RECEIVED: 콜백 수신됨
 * SUCCESS: 인증 성공
 * FAILED: 인증 실패
 * EXPIRED: 거래 만료
 */
export type KgInicisTxStatus =
    | 'REQUESTED'
    | 'CALLBACK_RECEIVED'
    | 'SUCCESS'
    | 'FAILED'
    | 'EXPIRED';

/**
 * API 라우트 요청 바디 (프론트 → API)
 */
export interface KgInicisRouteRequestBody {
    /** 요청 서비스 코드 */
    reqSvcCd: ReqSvcCd;
    /** 인증 성공 시 리다이렉트 URL */
    successUrl: string;
    /** 인증 실패 시 리다이렉트 URL */
    failUrl: string;
    /** 식별자 (선택) */
    identifier?: string;
    /** 사용자 정보 고정 여부 (선택) */
    flgFixedUser?: 'Y' | 'N';
    /** 사용자 이름 (선택) */
    userName?: string;
    /** 사용자 전화번호 (선택) */
    userPhone?: string;
    /** 사용자 생년월일 YYYYMMDD (선택) */
    userBirthday?: string;
}

/**
 * API 라우트 결과 바디 (API → 프론트)
 */
export interface KgInicisRouteResultBody {
    /** 가맹점 거래 ID */
    mTxId: string;
    /** 인증 팝업/리다이렉트 URL */
    authUrl: string;
    /** 인증 폼 전송용 파라미터 */
    formParams: Record<string, string>;
}

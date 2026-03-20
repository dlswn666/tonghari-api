/**
 * NICE 본인인증 API 타입 정의
 */

/**
 * NICE 암호화 토큰 응답
 */
export interface NiceCryptoTokenResponse {
    dataHeader: {
        GW_RSLT_CD: string;
        GW_RSLT_MSG: string;
    };
    dataBody: {
        rsp_cd: string;
        result_cd: string;
        site_code: string;
        token_version_id: string;
        token_val: string;
        period: number;
    };
}

/**
 * 암호화 키 임시 저장 (메모리)
 */
export interface NiceEncryptionArtifact {
    key: string;
    iv: string;
    hmacKey: string;
    reqNo: string;
    tokenVersionId: string;
    returnUrl: string;
    createdAt: number;
}

/**
 * 본인인증 암호화 요청 (프론트 → API)
 */
export interface NiceEncryptRequest {
    /** NICE 인증 완료 후 리다이렉트될 URL */
    returnUrl: string;
    /** 인증 수단 (M: 휴대폰, X: 공동인증서, 빈값: 전체) */
    authType?: string;
    /** 팝업 가이드 표시 여부 (Y/N) */
    popupGuide?: string;
    /** 커스터마이즈 옵션 */
    customize?: string;
}

/**
 * 암호화 데이터 응답 (API → 프론트)
 */
export interface NiceEncryptResponse {
    requestNo: string;
    tokenVersionId: string;
    encData: string;
    integrityValue: string;
}

/**
 * 복호화 요청 (프론트 → API)
 */
export interface NiceDecryptRequest {
    requestNo: string;
    encData: string;
    integrityValue: string;
}

/**
 * 본인인증 결과 (복호화된 사용자 정보)
 */
export interface NiceIdentityResult {
    /** 요청 번호 */
    requestno: string;
    /** 응답 번호 */
    responseno: string;
    /** 인증 수단 */
    authtype: string;
    /** 이름 (EUC-KR) */
    name: string;
    /** 이름 (UTF-8) */
    utf8_name: string;
    /** 생년월일 (YYYYMMDD) */
    birthdate: string;
    /** 성별 (0: 여성, 1: 남성) */
    gender: string;
    /** 내외국인 (0: 내국인, 1: 외국인) */
    nationalinfo: string;
    /** 휴대폰번호 */
    mobileno: string;
    /** 통신사 (SKT, KT, LGU+, SKT알뜰, KT알뜰, LGU+알뜰) */
    mobileco: string;
    /** 중복가입확인정보 (DI) - 64byte */
    di: string;
    /** 연계정보 (CI) - 88byte */
    ci: string;
    /** 결과코드 */
    receivedata: string;
}

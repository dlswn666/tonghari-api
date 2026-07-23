/**
 * GIS API 인스펙터 타입 — 외부 토지·건물 API 원본 응답 검수용
 */

/** 카카오(다음) 우편번호 위젯에서 넘어오는 주소 데이터 */
export interface KakaoInspectAddress {
    roadAddress: string;
    jibunAddress: string;
    /** 법정동코드 10자리 */
    bcode: string;
    /** 지번 본번 */
    mainNo: string;
    /** 지번 부번 (없으면 빈 문자열) */
    subNo: string;
    /** 산 여부 */
    mountainYn: 'Y' | 'N';
}

export type InspectStepStatus = 'SUCCESS' | 'ERROR' | 'SKIPPED';

export interface InspectStep {
    id: string;
    /** 한글 스텝 이름 */
    name: string;
    provider: 'VWORLD' | 'DATA_GO_KR';
    /** 실제 호출 URL (키 미포함) */
    endpoint: string;
    /** 요청 파라미터 — key/serviceKey는 마스킹된 상태 */
    requestParams: Record<string, unknown>;
    status: InspectStepStatus;
    durationMs: number;
    /** 외부 API 응답 원본 그대로 */
    rawJson: unknown;
    error?: string;
}

export interface InspectResponse {
    address: KakaoInspectAddress;
    pnu: string | null;
    pnuSource: 'LOCAL' | 'VWORLD_COORD' | null;
    steps: InspectStep[];
    totalDurationMs: number;
}

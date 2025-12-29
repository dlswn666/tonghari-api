// ============================================================
// 알림톡 발송 관련 타입
// ============================================================

/**
 * 알림톡 수신자 정보 (단순화)
 * 클라이언트에서는 변수만 전달하고, 서버에서 템플릿 기반으로 메시지 구성
 */
export interface AlimtalkRecipient {
    phoneNumber: string;
    name: string;
    variables?: Record<string, string>;
}

/**
 * 알림톡 버튼 정보 (DB/알리고 API용)
 */
export interface AlimtalkButton {
    ordering?: number; // 버튼 순서 (1 ~ 5)
    name: string;
    linkType: string; // WL: 웹링크, AL: 앱링크, DS: 배송조회, BK: 봇키워드, MD: 메시지전달, AC: 채널 추가
    linkTypeName: string; // 웹링크, 앱링크, 배송조회, 봇키워드, 메시지전달, 채널 추가
    linkMo?: string; // 모바일 웹 링크 (WL일때)
    linkPc?: string; // PC 웹 링크 (WL일때)
    linkIos?: string; // IOS 앱링크 (AL일때)
    linkAnd?: string; // 안드로이드 앱링크 (AL일때)
}

/**
 * 알리고 API 수신자 타입 (내부 처리용)
 * 서버에서 템플릿 정보와 변수를 조합하여 구성
 */
export interface Recipient {
    phoneNumber: string;
    name?: string;
    variables?: Record<string, string>;
    // 서버에서 템플릿 기반으로 자동 구성되는 필드들
    content?: string;
    buttons?: AlimtalkButton[];
    emtitle?: string;
    failoverSubject?: string;
    failoverMessage?: string;
}

/**
 * 알림톡 발송 요청 파라미터 (단순화)
 * 클라이언트에서는 templateCode와 수신자 정보만 전달
 */
export interface SendAlimtalkRequest {
    unionId: string;
    senderId: string;
    templateCode: string;
    recipients: AlimtalkRecipient[];
    noticeId?: number;
}

/**
 * 알림톡 발송 결과
 */
export interface SendAlimtalkResult {
    logId: string;
    totalCount: number;
    kakaoSuccessCount: number;
    smsSuccessCount: number;
    failCount: number;
    estimatedCost: number;
    channelName: string;
}

/**
 * 알림톡 로그 입력
 */
export interface AlimtalkLogInput {
    union_id: string;
    sender_id: string;
    template_code: string;
    template_name: string;
    title: string;
    content?: string;
    notice_id?: number;
    sender_channel_name: string;
    total_count: number;
    kakao_success_count: number;
    sms_success_count: number;
    fail_count: number;
    estimated_cost: number;
    recipient_details: AlimtalkRecipient[];
    aligo_response: unknown;
}

/**
 * 알림톡 템플릿 정보 (DB 스키마와 일치, 알리고 API 응답 구조 그대로 저장)
 */
export interface AlimtalkTemplate {
    id?: string;
    template_code: string; // 알리고 템플릿 코드 (예: P000004)
    template_name: string; // 템플릿 이름
    template_content?: string; // 템플릿 내용
    status?: string; // 알리고 상태 (S: 중단, A: 정상, R: 대기)
    insp_status?: string; // 승인상태 (REG, REQ, APR, REJ)
    buttons?: AlimtalkButton[]; // 버튼 정보 (JSON)
    synced_at?: string; // 마지막 알리고 동기화 시간
    // 추가된 필드 (알리고 API 응답 구조)
    sender_key?: string; // 발신프로필키
    template_type?: string; // 템플릿 메시지 유형 (BA: 기본형, EX: 부가 정보형, AD: 광고 추가형, MI: 복합형)
    template_em_type?: string; // 템플릿 강조유형 (NONE: 선택안함, TEXT: 강조표기형, IMAGE: 이미지형)
    template_title?: string; // 강조표기 핵심정보
    template_subtitle?: string; // 강조표기 보조문구
    template_image_name?: string; // 템플릿 이미지 파일명
    template_image_url?: string; // 템플릿 이미지 링크
    cdate?: string; // 템플릿 생성일
    comments?: string; // 템플릿 코멘트
    use_failover?: boolean; // LMS 대체 발송 사용 여부 (기본: false)
}

/**
 * 단가 정보
 */
export interface PricingInfo {
    message_type: string;
    unit_price: number;
}

export interface PricingMap {
    KAKAO: number;
    SMS: number;
    LMS: number;
}

/**
 * API 응답 기본 형식
 */
export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    code?: string;
}

/**
 * 템플릿 동기화 결과
 */
export interface TemplateSyncResult {
    totalFromAligo: number;
    inserted: number;
    updated: number;
    deleted: number;
    syncedAt: string;
}

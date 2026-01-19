/**
 * SMS 발송 요청 타입
 */
export interface SendSmsRequest {
  unionId: string;
  senderId: string;
  title?: string;
  message: string;
  msgType: 'SMS' | 'LMS' | 'MMS';
  recipients: SmsRecipient[];
}

/**
 * SMS 수신자 정보
 */
export interface SmsRecipient {
  name: string;
  phone: string;
}

/**
 * SMS 배치 발송 결과
 */
export interface SmsBatchResult {
  batchIndex: number;
  success: boolean;
  successCount: number;
  failCount: number;
  msgId?: string;
  error?: string;
  aligoResponse?: AligoSmsSendResponse;
}

/**
 * SMS 전체 발송 결과
 */
export interface SmsSendResult {
  success: boolean;
  totalRecipients: number;
  totalBatches: number;
  successCount: number;
  failCount: number;
  estimatedCost: number;
  batchResults: SmsBatchResult[];
  msgIds: string[];
}

/**
 * 알리고 SMS 대량 발송 응답
 * https://smartsms.aligo.in/smsapi.html
 */
export interface AligoSmsSendResponse {
  result_code: number;  // 1: 성공, 음수: 실패
  message: string;
  msg_id?: number;
  success_cnt?: number;
  error_cnt?: number;
  msg_type?: string;
}

/**
 * SMS 발송 로그 저장용
 */
export interface SmsSendLogInput {
  union_id: string;
  sender_id: string;
  title?: string;
  message: string;
  msg_type: string;
  total_count: number;
  success_count: number;
  fail_count: number;
  status: string;
  aligo_msg_ids: string[];
  estimated_cost: number;
}

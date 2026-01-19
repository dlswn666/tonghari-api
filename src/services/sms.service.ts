import https from 'https';
import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { supabaseService } from './supabase.service';
import {
  SendSmsRequest,
  SmsRecipient,
  SmsBatchResult,
  SmsSendResult,
  AligoSmsSendResponse,
  SmsSendLogInput,
} from '../types/sms.types';
import { formatPhoneNumber } from '../utils/phone';
import { createLogger } from '../utils/logger';

const logger = createLogger('SMS');

const ALIGO_SMS_BASE_URL = 'https://apis.aligo.in';

// 배치 처리 상수
const BATCH_SIZE = 500; // 알리고 API 최대 수신자 수

/**
 * 변수 치환 함수
 */
function replaceVariables(template: string, recipient: SmsRecipient): string {
  return template.replace(/{이름}/g, recipient.name);
}

/**
 * 알리고 SMS API 서비스
 */
class SmsService {
  private httpClient: AxiosInstance;

  constructor() {
    // Keep-Alive 설정으로 TCP 연결 재사용
    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: 30000,
    });

    this.httpClient = axios.create({
      baseURL: ALIGO_SMS_BASE_URL,
      timeout: 30000,
      httpsAgent,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  }

  /**
   * 배열을 지정된 크기로 분할
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * 단일 배치 SMS 발송 (최대 500건)
   * /send_mass/ 엔드포인트 사용
   */
  private async sendBatch(
    recipients: SmsRecipient[],
    messageTemplate: string,
    title: string | undefined,
    msgType: 'SMS' | 'LMS' | 'MMS',
    batchIndex: number
  ): Promise<SmsBatchResult> {
    // 알리고 SMS API 파라미터 구성
    const formData = new URLSearchParams({
      key: env.ALIGO_API_KEY,
      user_id: env.ALIGO_USER_ID,
      sender: env.ALIGO_SENDER_PHONE,
      msg_type: msgType,
      cnt: recipients.length.toString(),
    });

    // LMS/MMS일 경우 제목 추가
    if ((msgType === 'LMS' || msgType === 'MMS') && title) {
      formData.append('title', title);
    }

    // 테스트 모드 (개발 환경에서만)
    if (env.isDevelopment) {
      formData.append('testmode_yn', 'Y');
    }

    // 수신자별 메시지 생성 (변수 치환)
    recipients.forEach((recipient, index) => {
      const idx = index + 1;
      const phoneNumber = formatPhoneNumber(recipient.phone);
      const message = replaceVariables(messageTemplate, recipient);

      formData.append(`rec_${idx}`, phoneNumber);
      formData.append(`msg_${idx}`, message);
    });

    try {
      const response = await this.httpClient.post<AligoSmsSendResponse>(
        '/send_mass/',
        formData.toString()
      );

      const result = response.data;

      logger.debug(`[Batch ${batchIndex + 1}] API response: ${JSON.stringify(result)}`);

      // 응답 분석 (result_code가 1이면 성공)
      if (result.result_code === 1) {
        const successCount = result.success_cnt || recipients.length;
        const failCount = result.error_cnt || 0;

        logger.info(
          `[Batch ${batchIndex + 1}] Send completed (success: ${successCount}, fail: ${failCount})`
        );

        return {
          batchIndex,
          success: true,
          successCount,
          failCount,
          msgId: result.msg_id?.toString(),
          aligoResponse: result,
        };
      } else {
        logger.error(`[Batch ${batchIndex + 1}] API error: ${result.message}`, result);
        return {
          batchIndex,
          success: false,
          successCount: 0,
          failCount: recipients.length,
          error: result.message,
          aligoResponse: result,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Batch ${batchIndex + 1}] API call exception occurred`, error);
      return {
        batchIndex,
        success: false,
        successCount: 0,
        failCount: recipients.length,
        error: errorMessage,
      };
    }
  }

  /**
   * SMS 발송 (대량 배치 처리 지원)
   * 500건씩 분할하여 순차 발송
   */
  async sendSms(request: SendSmsRequest): Promise<SmsSendResult> {
    const { recipients, message, title, msgType } = request;

    logger.info(`[SMS Send] Starting: ${recipients.length} recipients, type: ${msgType}`);

    // 수신자를 500건씩 분할
    const batches = this.chunkArray(recipients, BATCH_SIZE);
    const totalBatches = batches.length;

    logger.info(`[SMS Send] Total ${recipients.length} recipients, ${totalBatches} batches`);

    const batchResults: SmsBatchResult[] = [];
    const msgIds: string[] = [];
    let totalSuccess = 0;
    let totalFail = 0;

    // 순차적으로 배치 처리
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const result = await this.sendBatch(batch, message, title, msgType, i);

      batchResults.push(result);
      totalSuccess += result.successCount;
      totalFail += result.failCount;

      if (result.msgId) {
        msgIds.push(result.msgId);
      }

      // 배치 간 딜레이 (API 부하 방지)
      if (i < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // 비용 계산
    const unitPrice = await this.getUnitPrice(msgType);
    const estimatedCost = totalSuccess * unitPrice;

    // 전체 성공 여부
    const allSuccess = batchResults.every((r) => r.success);

    logger.info(
      `[SMS Send Completed] Total success: ${totalSuccess}, fail: ${totalFail}, cost: ${estimatedCost} KRW`
    );

    return {
      success: allSuccess,
      totalRecipients: recipients.length,
      totalBatches,
      successCount: totalSuccess,
      failCount: totalFail,
      estimatedCost,
      batchResults,
      msgIds,
    };
  }

  /**
   * 메시지 타입별 단가 조회
   */
  private async getUnitPrice(msgType: 'SMS' | 'LMS' | 'MMS'): Promise<number> {
    try {
      const pricing = await supabaseService.getCurrentPricing();

      switch (msgType) {
        case 'SMS':
          return pricing.SMS || 20;
        case 'LMS':
          return pricing.LMS || 50;
        case 'MMS':
          return pricing.MMS || 200;
        default:
          return 50;
      }
    } catch {
      // 기본값 반환
      switch (msgType) {
        case 'SMS':
          return 20;
        case 'LMS':
          return 50;
        case 'MMS':
          return 200;
        default:
          return 50;
      }
    }
  }

  /**
   * SMS 발송 로그 저장
   */
  async saveSmsLog(input: SmsSendLogInput): Promise<string | null> {
    return supabaseService.saveSmsLog(input);
  }
}

export const smsService = new SmsService();
export default smsService;

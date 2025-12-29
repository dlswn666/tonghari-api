import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { aligoService, SendResult } from './aligo.service';
import { supabaseService } from './supabase.service';
import { SendAlimtalkRequest } from '../types/alimtalk.types';
import { JobInfo, JobStatus, QueueStatus } from '../types/queue.types';

/**
 * 알림톡 발송 큐 서비스
 * 
 * p-queue를 사용한 인메모리 큐 시스템
 * 동시 처리 개수를 제한하여 메모리 보호 및 API 부하 관리
 * 
 * 주의사항:
 * - 인메모리 큐는 서버 재시작 시 대기 중인 작업이 손실됨
 * - 알림톡 특성상 치명적이진 않으나 인지 필요
 */
class QueueService {
    private queue: PQueue;
    private jobs: Map<string, JobInfo>;
    private maxSize: number;

    constructor() {
        // 동시 실행 개수 제한 (메모리 보호 및 TCP 연결 제한)
        this.queue = new PQueue({ 
            concurrency: env.QUEUE_CONCURRENCY,
            throwOnTimeout: true,
            timeout: 300000, // 5분 타임아웃
        });

        // 작업 상태 저장소
        this.jobs = new Map();
        this.maxSize = env.QUEUE_MAX_SIZE;

        // 큐 이벤트 리스너
        this.queue.on('active', () => {
            console.log(`[큐] 작업 시작. 대기: ${this.queue.pending}, 실행 중: ${this.queue.pending + 1}`);
        });

        this.queue.on('idle', () => {
            console.log('[큐] 모든 작업 완료 (Idle 상태)');
        });

        this.queue.on('error', (error) => {
            console.error('[큐] 오류 발생:', error);
        });
    }

    /**
     * 큐가 가득 찼는지 확인
     */
    private isFull(): boolean {
        return this.queue.pending + this.queue.size >= this.maxSize;
    }

    /**
     * 작업을 큐에 추가
     * 
     * @param request - 알림톡 발송 요청
     * @returns 작업 정보 또는 null (큐가 가득 찬 경우)
     */
    async addJob(request: SendAlimtalkRequest): Promise<JobInfo | null> {
        // 큐 크기 확인
        if (this.isFull()) {
            console.warn('[큐] 큐가 가득 찼습니다. 작업 추가 거부.');
            return null;
        }

        // 작업 ID 생성
        const jobId = uuidv4();

        // 작업 정보 생성
        const jobInfo: JobInfo = {
            jobId,
            unionId: request.unionId,
            senderId: request.senderId,
            templateCode: request.templateCode,
            recipientCount: request.recipients.length,
            status: 'pending',
            createdAt: new Date(),
        };

        // 작업 저장
        this.jobs.set(jobId, jobInfo);

        console.log(`[큐] 작업 추가: ${jobId} (수신자: ${request.recipients.length}명)`);

        // 큐에 작업 추가 (비동기 처리)
        this.queue.add(async () => {
            await this.processJob(jobId, request);
        }).catch((error) => {
            console.error(`[큐] 작업 실패 (${jobId}):`, error);
            this.updateJobStatus(jobId, 'failed', undefined, error instanceof Error ? error.message : '알 수 없는 오류');
        });

        return jobInfo;
    }

    /**
     * 작업 처리
     */
    private async processJob(jobId: string, request: SendAlimtalkRequest): Promise<void> {
        console.log(`[작업 ${jobId}] 처리 시작`);

        // 상태 업데이트: processing
        this.updateJobStatus(jobId, 'processing');

        try {
            // 알림톡 발송 실행
            const result = await aligoService.sendAlimtalk(request);

            // 상태 업데이트: completed
            this.updateJobStatus(jobId, 'completed', result);

            console.log(`[작업 ${jobId}] 처리 완료. 성공: ${result.kakaoSuccessCount}, 실패: ${result.failCount}`);

            // Supabase에 로그 저장 (templateName은 발송 결과에서 가져옴)
            try {
                await supabaseService.saveAlimtalkLog({
                    union_id: request.unionId,
                    sender_id: request.senderId,
                    template_code: request.templateCode,
                    template_name: result.templateName || request.templateCode,
                    title: result.templateName || request.templateCode,
                    notice_id: request.noticeId,
                    sender_channel_name: '조합온', // 기본값
                    total_count: result.totalRecipients,
                    kakao_success_count: result.kakaoSuccessCount,
                    sms_success_count: result.smsSuccessCount,
                    fail_count: result.failCount,
                    estimated_cost: this.calculateCost(result),
                    recipient_details: request.recipients,
                    aligo_response: result.batchResults,
                });
                console.log(`[작업 ${jobId}] 로그 저장 완료`);
            } catch (logError) {
                console.error(`[작업 ${jobId}] 로그 저장 실패:`, logError);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '알 수 없는 오류';
            console.error(`[작업 ${jobId}] 처리 실패:`, error);
            this.updateJobStatus(jobId, 'failed', undefined, errorMessage);
            throw error;
        }
    }

    /**
     * 작업 상태 업데이트
     */
    private updateJobStatus(
        jobId: string, 
        status: JobStatus, 
        result?: SendResult, 
        error?: string
    ): void {
        const job = this.jobs.get(jobId);
        if (!job) return;

        job.status = status;

        if (status === 'processing') {
            job.startedAt = new Date();
        }

        if (status === 'completed' || status === 'failed') {
            job.completedAt = new Date();
        }

        if (result) {
            job.result = result;
        }

        if (error) {
            job.error = error;
        }

        this.jobs.set(jobId, job);
    }

    /**
     * 비용 계산 (예상)
     */
    private calculateCost(result: SendResult): number {
        // 카카오 알림톡: 건당 약 9원
        // SMS: 건당 약 20원
        const KAKAO_PRICE = 9;
        const SMS_PRICE = 20;

        return (result.kakaoSuccessCount * KAKAO_PRICE) + (result.smsSuccessCount * SMS_PRICE);
    }

    /**
     * 작업 상태 조회
     */
    getJobStatus(jobId: string): JobInfo | undefined {
        return this.jobs.get(jobId);
    }

    /**
     * 큐 상태 조회
     */
    getQueueStatus(): QueueStatus {
        return {
            pending: this.queue.pending,
            running: this.queue.size,
            concurrency: env.QUEUE_CONCURRENCY,
            maxSize: this.maxSize,
            isFull: this.isFull(),
        };
    }

    /**
     * 완료된 작업 정리 (메모리 관리)
     * 완료된 지 1시간이 지난 작업을 삭제
     */
    cleanupOldJobs(): void {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        let cleaned = 0;

        for (const [jobId, job] of this.jobs.entries()) {
            if (job.completedAt && job.completedAt < oneHourAgo) {
                this.jobs.delete(jobId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[큐] ${cleaned}개의 완료된 작업 정리됨`);
        }
    }
}

// 싱글톤 인스턴스
export const queueService = new QueueService();

// 주기적으로 완료된 작업 정리 (30분마다)
setInterval(() => {
    queueService.cleanupOldJobs();
}, 30 * 60 * 1000);

export default queueService;


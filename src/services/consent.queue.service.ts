import PQueue from 'p-queue';
import { supabaseService } from './supabase.service';
import {
    ConsentJobInfo,
    ConsentBulkUpdateRequest,
    ConsentBulkUpdateResult,
    ConsentUploadRequest,
    ConsentUploadResult,
    ConsentUploadRow,
} from '../types/consent.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('CONSENT-QUEUE');

/**
 * 동의 상태 파싱 헬퍼 함수: 한글/영문 모두 지원
 * @param statusStr 동의 상태 문자열
 * @returns 'AGREED' 또는 'DISAGREED'
 */
function parseConsentStatus(statusStr: string): 'AGREED' | 'DISAGREED' {
    const normalizedStatus = statusStr?.toString().trim().toUpperCase();
    // 동의: "동의", "AGREED" 허용
    if (normalizedStatus === 'AGREED' || normalizedStatus === '동의') {
        return 'AGREED';
    }
    // 비동의: "비동의", "DISAGREED" 허용 (기본값)
    return 'DISAGREED';
}

/**
 * 동의 처리 큐 서비스
 * 
 * - CONSENT_BULK_UPDATE: 일괄 동의 처리 (조합원 ID 목록으로 직접 처리)
 * - CONSENT_BULK_UPLOAD: 엑셀 업로드 동의 처리 (이름/주소로 매칭 후 처리)
 */
class ConsentQueueService {
    private queue: PQueue;
    private jobs: Map<string, ConsentJobInfo>;

    constructor() {
        this.queue = new PQueue({
            concurrency: 2, // DB 부하 조절을 위해 낮게 설정
            timeout: 600000, // 10분
        });
        this.jobs = new Map();

        // 주기적으로 완료된 작업 정리 (30분마다)
        setInterval(() => {
            this.cleanupOldJobs();
        }, 30 * 60 * 1000);
    }

    /**
     * 일괄 동의 처리 작업 추가
     */
    async addBulkUpdateJob(request: ConsentBulkUpdateRequest): Promise<ConsentJobInfo> {
        const jobInfo: ConsentJobInfo = {
            jobId: request.jobId,
            jobType: 'CONSENT_BULK_UPDATE',
            unionId: request.unionId,
            stageId: request.stageId,
            totalCount: request.memberIds.length,
            processedCount: 0,
            status: 'pending',
            createdAt: new Date(),
        };

        this.jobs.set(request.jobId, jobInfo);

        logger.info(`Consent bulk update job added: ${request.jobId} (members: ${request.memberIds.length})`);

        this.queue
            .add(async () => {
                await this.processBulkUpdateJob(request);
            })
            .catch((err) => {
                logger.error(`Consent bulk update job ${request.jobId} fatal error`, err);
                this.updateJobStatus(request.jobId, { status: 'failed', error: err.message });
                supabaseService.updateSyncJobStatus(request.jobId, 'FAILED', 0, err.message);
            });

        return jobInfo;
    }

    /**
     * 엑셀 업로드 동의 처리 작업 추가
     */
    async addUploadJob(request: ConsentUploadRequest): Promise<ConsentJobInfo> {
        const jobInfo: ConsentJobInfo = {
            jobId: request.jobId,
            jobType: 'CONSENT_BULK_UPLOAD',
            unionId: request.unionId,
            stageId: request.stageId,
            totalCount: request.data.length,
            processedCount: 0,
            status: 'pending',
            createdAt: new Date(),
        };

        this.jobs.set(request.jobId, jobInfo);

        logger.info(`Consent upload job added: ${request.jobId} (rows: ${request.data.length})`);

        this.queue
            .add(async () => {
                await this.processUploadJob(request);
            })
            .catch((err) => {
                logger.error(`Consent upload job ${request.jobId} fatal error`, err);
                this.updateJobStatus(request.jobId, { status: 'failed', error: err.message });
                supabaseService.updateSyncJobStatus(request.jobId, 'FAILED', 0, err.message);
            });

        return jobInfo;
    }

    /**
     * 일괄 동의 처리 실행
     */
    private async processBulkUpdateJob(request: ConsentBulkUpdateRequest): Promise<void> {
        const job = this.jobs.get(request.jobId);
        if (!job) return;

        logger.info(`[Consent BulkUpdate ${request.jobId}] Processing started`);
        this.updateJobStatus(request.jobId, { status: 'processing', startedAt: new Date() });

        const client = supabaseService.getClient();
        let successCount = 0;
        let failCount = 0;
        const errors: string[] = [];
        const total = request.memberIds.length;

        for (let i = 0; i < request.memberIds.length; i++) {
            const memberId = request.memberIds[i];

            try {
                // upsert 처리
                const { error } = await client
                    .from('user_consents')
                    .upsert(
                        {
                            user_id: memberId,
                            stage_id: request.stageId,
                            status: request.status,
                            consent_date: new Date().toISOString().split('T')[0],
                            updated_at: new Date().toISOString(),
                        },
                        {
                            onConflict: 'user_id,stage_id',
                        }
                    );

                if (error) {
                    logger.warn(`[Consent BulkUpdate ${request.jobId}] Failed for member ${memberId}: ${error.message}`);
                    errors.push(`${memberId}: ${error.message}`);
                    failCount++;
                } else {
                    successCount++;
                }
            } catch (err: any) {
                errors.push(`${memberId}: ${err.message || 'Unknown error'}`);
                failCount++;
            }

            // 진행률 업데이트 (10% 단위)
            job.processedCount = i + 1;
            const progress = Math.round(((i + 1) / total) * 100);

            if (progress % 10 === 0 || i === total - 1) {
                const previewData = {
                    job_type: 'CONSENT_BULK_UPDATE',
                    stageId: request.stageId,
                    status: request.status,
                    successCount,
                    failCount,
                    totalCount: total,
                };
                await supabaseService.updateSyncJobStatus(request.jobId, 'PROCESSING', progress, undefined, previewData);
            }
        }

        // 완료 처리
        const result: ConsentBulkUpdateResult = {
            success: failCount === 0,
            totalCount: total,
            successCount,
            failCount,
            errors: errors.slice(0, 100), // 최대 100개만
        };

        this.updateJobStatus(request.jobId, {
            status: 'completed',
            completedAt: new Date(),
            result,
        });

        const previewData = {
            job_type: 'CONSENT_BULK_UPDATE',
            stageId: request.stageId,
            status: request.status,
            ...result,
        };

        const errorLog = errors.length > 0 ? JSON.stringify({ errors: errors.slice(0, 100) }) : undefined;

        await supabaseService.updateSyncJobStatus(
            request.jobId,
            'COMPLETED',
            100,
            errorLog,
            previewData
        );

        logger.info(`[Consent BulkUpdate ${request.jobId}] Completed - Success: ${successCount}, Fail: ${failCount}, Total: ${total}`);
    }

    /**
     * 엑셀 업로드 동의 처리 실행
     */
    private async processUploadJob(request: ConsentUploadRequest): Promise<void> {
        const job = this.jobs.get(request.jobId);
        if (!job) return;

        logger.info(`[Consent Upload ${request.jobId}] Processing started`);
        this.updateJobStatus(request.jobId, { status: 'processing', startedAt: new Date() });

        const client = supabaseService.getClient();
        let successCount = 0;
        let failCount = 0;
        const errors: { row: number; message: string }[] = [];
        const total = request.data.length;

        for (let i = 0; i < request.data.length; i++) {
            const row = request.data[i];

            try {
                // 조합원 찾기 (이름 + 주소로 매칭)
                const member = await this.findMemberByInfo(
                    client,
                    request.unionId,
                    row
                );

                if (!member) {
                    errors.push({ row: row.rowNumber, message: `조합원을 찾을 수 없습니다: ${row.name}` });
                    failCount++;
                    continue;
                }

                // 한글/영문 동의 상태 파싱
                const status = parseConsentStatus(row.status);

                // 동의 상태 upsert
                const { error: upsertError } = await client
                    .from('user_consents')
                    .upsert(
                        {
                            user_id: member.id,
                            stage_id: request.stageId,
                            status,
                            consent_date: new Date().toISOString().split('T')[0],
                            updated_at: new Date().toISOString(),
                        },
                        {
                            onConflict: 'user_id,stage_id',
                        }
                    );

                if (upsertError) {
                    errors.push({ row: row.rowNumber, message: `동의 처리 실패: ${upsertError.message}` });
                    failCount++;
                } else {
                    successCount++;
                }
            } catch (err: any) {
                errors.push({ row: row.rowNumber, message: `처리 오류: ${err.message || 'Unknown error'}` });
                failCount++;
            }

            // 진행률 업데이트 (10% 단위)
            job.processedCount = i + 1;
            const progress = Math.round(((i + 1) / total) * 100);

            if (progress % 10 === 0 || i === total - 1) {
                const previewData = {
                    job_type: 'CONSENT_BULK_UPLOAD',
                    stageId: request.stageId,
                    successCount,
                    failCount,
                    totalCount: total,
                };
                await supabaseService.updateSyncJobStatus(request.jobId, 'PROCESSING', progress, undefined, previewData);
            }
        }

        // 완료 처리
        const result: ConsentUploadResult = {
            success: failCount === 0,
            totalCount: total,
            successCount,
            failCount,
            errors: errors.slice(0, 100),
        };

        this.updateJobStatus(request.jobId, {
            status: 'completed',
            completedAt: new Date(),
            result,
        });

        const previewData = {
            job_type: 'CONSENT_BULK_UPLOAD',
            stageId: request.stageId,
            successCount,
            failCount,
            totalCount: total,
            errorCount: errors.length,
        };

        const errorLog = errors.length > 0 ? JSON.stringify({ errors: errors.slice(0, 100) }) : undefined;

        await supabaseService.updateSyncJobStatus(
            request.jobId,
            'COMPLETED',
            100,
            errorLog,
            previewData
        );

        logger.info(`[Consent Upload ${request.jobId}] Completed - Success: ${successCount}, Fail: ${failCount}, Total: ${total}`);
    }

    /**
     * 조합원 찾기 (이름 + 주소로 매칭)
     */
    private async findMemberByInfo(
        client: any,
        unionId: string,
        row: ConsentUploadRow
    ): Promise<{ id: string } | null> {
        try {
            // 승인 + 사전등록 조합원 모두 포함
            let query = client
                .from('users')
                .select('id')
                .eq('union_id', unionId)
                .in('user_status', ['APPROVED', 'PRE_REGISTERED'])
                .ilike('name', row.name.trim());

            // 주소로 필터
            if (row.address) {
                query = query.or(
                    `property_address.ilike.%${row.address}%,property_address_jibun.ilike.%${row.address}%`
                );
            }

            // 동/호로 추가 필터
            if (row.dong) {
                query = query.ilike('property_dong', `%${row.dong}%`);
            }
            if (row.ho) {
                query = query.ilike('property_ho', `%${row.ho}%`);
            }

            const { data, error } = await query.limit(1);

            if (error || !data || data.length === 0) {
                return null;
            }

            return data[0];
        } catch (error) {
            logger.error(`findMemberByInfo error: ${error}`);
            return null;
        }
    }

    /**
     * 작업 상태 업데이트
     */
    private updateJobStatus(jobId: string, update: Partial<ConsentJobInfo>): void {
        const job = this.jobs.get(jobId);
        if (job) {
            Object.assign(job, update);
            this.jobs.set(jobId, job);
        }
    }

    /**
     * 작업 상태 조회
     */
    getJobStatus(jobId: string): ConsentJobInfo | undefined {
        return this.jobs.get(jobId);
    }

    /**
     * 완료된 작업 정리 (메모리 관리)
     */
    private cleanupOldJobs(): void {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        let cleaned = 0;

        for (const [jobId, job] of this.jobs.entries()) {
            if (job.completedAt && job.completedAt < oneHourAgo) {
                this.jobs.delete(jobId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.info(`${cleaned} completed consent jobs cleaned up`);
        }
    }
}

export const consentQueueService = new ConsentQueueService();
export default consentQueueService;

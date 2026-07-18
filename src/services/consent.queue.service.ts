import PQueue from 'p-queue';
import { getSupabaseService } from './supabase.service';
import {
    ConsentJobInfo,
    ConsentBulkUpdateRequest,
    ConsentBulkUpdateResult,
    ConsentUploadRequest,
    ConsentUploadResult,
    ConsentUploadRow,
} from '../types/consent.types';
import { createLogger } from '../utils/logger';
import { verifyPersistedSyncJobOrThrow } from './sync-job-admission';
import { DatabaseTarget } from '../types/database.types';

const logger = createLogger('CONSENT-QUEUE');
const CONSENT_SYNC_JOB_TYPE = 'CONSENT_UPLOAD';
const MEMBER_SCOPE_CHUNK_SIZE = 500;

function executionAuthorizationError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

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
type VerifyPersistedSyncJob = typeof verifyPersistedSyncJobOrThrow;
type AssertConsentAuthorizedAtExecution = (
    request: ConsentBulkUpdateRequest | ConsentUploadRequest
) => Promise<void>;
type UpdatePersistedConsentJob = (
    request: ConsentBulkUpdateRequest | ConsentUploadRequest,
    status: 'PROCESSING' | 'COMPLETED' | 'FAILED',
    progress: number,
    errorLog?: string,
    previewData?: Record<string, unknown>
) => Promise<boolean>;

interface ConsentQueueServiceOptions {
    queue?: Pick<PQueue, 'add'>;
    verifyPersistedSyncJob?: VerifyPersistedSyncJob;
    assertAuthorizedAtExecution?: AssertConsentAuthorizedAtExecution;
    updatePersistedJob?: UpdatePersistedConsentJob;
    scheduleCleanup?: boolean;
}

export class ConsentQueueService {
    private queue: Pick<PQueue, 'add'>;
    private jobs: Map<string, ConsentJobInfo>;
    private readonly verifyPersistedSyncJob: VerifyPersistedSyncJob;
    private readonly assertAuthorizedAtExecution: AssertConsentAuthorizedAtExecution;
    private readonly updatePersistedJob: UpdatePersistedConsentJob;

    constructor(options: ConsentQueueServiceOptions = {}) {
        this.queue = options.queue ?? new PQueue({
            concurrency: 2,
            timeout: 600000,
        });
        this.jobs = new Map();
        this.verifyPersistedSyncJob = options.verifyPersistedSyncJob ?? verifyPersistedSyncJobOrThrow;
        this.assertAuthorizedAtExecution = options.assertAuthorizedAtExecution
            ?? ((request) => this.assertRequestAuthorizedAtExecution(request));
        this.updatePersistedJob = options.updatePersistedJob
            ?? ((request, status, progress, errorLog, previewData) =>
                this.updatePersistedSyncJobIfProcessing(
                    request,
                    status,
                    progress,
                    errorLog,
                    previewData
                ));

        if (options.scheduleCleanup !== false) {
            const cleanupTimer = setInterval(() => {
                this.cleanupOldJobs();
            }, 30 * 60 * 1000);
            cleanupTimer.unref();
        }
    }

    /**
     * 일괄 동의 처리 작업 추가
     */
    async addBulkUpdateJob(request: ConsentBulkUpdateRequest): Promise<ConsentJobInfo> {
        const database = getSupabaseService(request.databaseTarget);
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

        await this.verifyPersistedSyncJob(request.jobId, request.unionId, () =>
            database
                .getClient()
                .from('sync_jobs')
                .select('id, union_id, job_type, status')
                .eq('id', request.jobId)
                .eq('union_id', request.unionId)
                .eq('job_type', CONSENT_SYNC_JOB_TYPE)
                .eq('status', 'PROCESSING')
                .maybeSingle()
        );

        const key = this.jobKey(request.databaseTarget, request.jobId);
        if (this.jobs.has(key)) {
            throw Object.assign(new Error('같은 DB 대상의 consent 작업이 이미 admission 됐습니다.'), {
                code: 'CONSENT_JOB_ALREADY_ADMITTED',
            });
        }
        this.jobs.set(key, jobInfo);

        logger.info(`Consent bulk update job added: ${request.jobId} (members: ${request.memberIds.length})`);

        this.queue
            .add(async () => {
                await this.processBulkUpdateJob(request);
            })
            .catch((err) => {
                logger.error(`Consent bulk update job ${request.jobId} fatal error`, err);
                this.updateJobStatus(request.jobId, request.databaseTarget, {
                    status: 'failed',
                    error: err.message,
                    completedAt: new Date(),
                });
                return this.updatePersistedJob(request, 'FAILED', 0, err.message);
            });

        return jobInfo;
    }

    /**
     * 엑셀 업로드 동의 처리 작업 추가
     */
    async addUploadJob(request: ConsentUploadRequest): Promise<ConsentJobInfo> {
        const database = getSupabaseService(request.databaseTarget);
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

        await this.verifyPersistedSyncJob(request.jobId, request.unionId, () =>
            database
                .getClient()
                .from('sync_jobs')
                .select('id, union_id, job_type, status')
                .eq('id', request.jobId)
                .eq('union_id', request.unionId)
                .eq('job_type', CONSENT_SYNC_JOB_TYPE)
                .eq('status', 'PROCESSING')
                .maybeSingle()
        );

        const key = this.jobKey(request.databaseTarget, request.jobId);
        if (this.jobs.has(key)) {
            throw Object.assign(new Error('같은 DB 대상의 consent 작업이 이미 admission 됐습니다.'), {
                code: 'CONSENT_JOB_ALREADY_ADMITTED',
            });
        }
        this.jobs.set(key, jobInfo);

        logger.info(`Consent upload job added: ${request.jobId} (rows: ${request.data.length})`);

        this.queue
            .add(async () => {
                await this.processUploadJob(request);
            })
            .catch((err) => {
                logger.error(`Consent upload job ${request.jobId} fatal error`, err);
                this.updateJobStatus(request.jobId, request.databaseTarget, {
                    status: 'failed',
                    error: err.message,
                    completedAt: new Date(),
                });
                return this.updatePersistedJob(request, 'FAILED', 0, err.message);
            });

        return jobInfo;
    }

    /**
     * 일괄 동의 처리 실행
     */
    private async processBulkUpdateJob(request: ConsentBulkUpdateRequest): Promise<void> {
        const job = this.jobs.get(this.jobKey(request.databaseTarget, request.jobId));
        if (!job) return;

        await this.assertAuthorizedAtExecution(request);

        logger.info(`[Consent BulkUpdate ${request.jobId}] Processing started`);
        this.updateJobStatus(request.jobId, request.databaseTarget, {
            status: 'processing',
            startedAt: new Date(),
        });

        const database = getSupabaseService(request.databaseTarget);
        const client = database.getClient();
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
                await this.updatePersistedJob(request, 'PROCESSING', progress, undefined, previewData);
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

        this.updateJobStatus(request.jobId, request.databaseTarget, {
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

        await this.updatePersistedJob(
            request,
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
        const job = this.jobs.get(this.jobKey(request.databaseTarget, request.jobId));
        if (!job) return;

        await this.assertAuthorizedAtExecution(request);

        logger.info(`[Consent Upload ${request.jobId}] Processing started`);
        this.updateJobStatus(request.jobId, request.databaseTarget, {
            status: 'processing',
            startedAt: new Date(),
        });

        const database = getSupabaseService(request.databaseTarget);
        const client = database.getClient();
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
                await this.updatePersistedJob(request, 'PROCESSING', progress, undefined, previewData);
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

        this.updateJobStatus(request.jobId, request.databaseTarget, {
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

        await this.updatePersistedJob(
            request,
            'COMPLETED',
            100,
            errorLog,
            previewData
        );

        logger.info(`[Consent Upload ${request.jobId}] Completed - Success: ${successCount}, Fail: ${failCount}, Total: ${total}`);
    }

    /** terminal 상태를 되돌리지 않도록 PROCESSING 원장에만 exact-scope CAS를 수행한다. */
    private async updatePersistedSyncJobIfProcessing(
        request: ConsentBulkUpdateRequest | ConsentUploadRequest,
        status: 'PROCESSING' | 'COMPLETED' | 'FAILED',
        progress: number,
        errorLog?: string,
        previewData?: Record<string, unknown>
    ): Promise<boolean> {
        const client = getSupabaseService(request.databaseTarget).getClient();
        const updateData: Record<string, unknown> = {
            status,
            progress,
            updated_at: new Date().toISOString(),
        };
        if (errorLog !== undefined) updateData.error_log = errorLog;

        if (previewData !== undefined) {
            const { data: currentJob, error: previewError } = await client
                .from('sync_jobs')
                .select('id, preview_data')
                .eq('id', request.jobId)
                .eq('union_id', request.unionId)
                .eq('job_type', CONSENT_SYNC_JOB_TYPE)
                .eq('status', 'PROCESSING')
                .maybeSingle();
            if (previewError || !currentJob || currentJob.id !== request.jobId) {
                logger.warn(`Consent sync job preview CAS rejected: ${request.jobId}`);
                return false;
            }
            const currentPreview = currentJob.preview_data
                && typeof currentJob.preview_data === 'object'
                && !Array.isArray(currentJob.preview_data)
                ? currentJob.preview_data
                : {};
            updateData.preview_data = { ...currentPreview, ...previewData };
        }

        const { data: updated, error: updateError } = await client
            .from('sync_jobs')
            .update(updateData)
            .eq('id', request.jobId)
            .eq('union_id', request.unionId)
            .eq('job_type', CONSENT_SYNC_JOB_TYPE)
            .eq('status', 'PROCESSING')
            .select('id, union_id, job_type, status')
            .maybeSingle();
        if (updateError) {
            logger.error(`Consent sync job CAS update failed: ${request.jobId}`, updateError);
            return false;
        }
        return Boolean(
            updated &&
            updated.id === request.jobId &&
            updated.union_id === request.unionId &&
            updated.job_type === CONSENT_SYNC_JOB_TYPE &&
            updated.status === status
        );
    }

    /**
     * admission 이후 queue 대기 중 권한이나 범위가 바뀌었을 수 있으므로
     * 첫 service-role mutation 직전에 선택된 DB에서 다시 검증한다.
     */
    private async assertRequestAuthorizedAtExecution(
        request: ConsentBulkUpdateRequest | ConsentUploadRequest
    ): Promise<void> {
        const client = getSupabaseService(request.databaseTarget).getClient();

        const { data: actor, error: actorError } = await client
            .from('users')
            .select('id, role, is_blocked, union_id')
            .eq('id', request.actorUserId)
            .in('role', ['SYSTEM_ADMIN', 'ADMIN'])
            .maybeSingle();
        if (actorError) {
            throw executionAuthorizationError(
                'CONSENT_EXECUTION_AUTH_LOOKUP_FAILED',
                '동의 작업 실행자의 현재 권한을 확인할 수 없습니다.'
            );
        }
        if (
            !actor ||
            actor.id !== request.actorUserId ||
            (actor.role !== 'SYSTEM_ADMIN' && actor.role !== 'ADMIN') ||
            actor.is_blocked !== false ||
            (actor.role !== 'SYSTEM_ADMIN' && actor.union_id !== request.unionId)
        ) {
            throw executionAuthorizationError(
                'CONSENT_EXECUTION_FORBIDDEN',
                '동의 작업 실행 권한이 회수됐거나 요청 조합 범위와 일치하지 않습니다.'
            );
        }

        const { data: job, error: jobError } = await client
            .from('sync_jobs')
            .select('id, union_id, job_type, status')
            .eq('id', request.jobId)
            .eq('union_id', request.unionId)
            .eq('job_type', CONSENT_SYNC_JOB_TYPE)
            .eq('status', 'PROCESSING')
            .maybeSingle();
        if (jobError) {
            throw executionAuthorizationError(
                'CONSENT_EXECUTION_JOB_LOOKUP_FAILED',
                '동의 작업 원장의 현재 상태를 확인할 수 없습니다.'
            );
        }
        if (
            !job ||
            job.id !== request.jobId ||
            job.union_id !== request.unionId ||
            job.job_type !== CONSENT_SYNC_JOB_TYPE ||
            job.status !== 'PROCESSING'
        ) {
            throw executionAuthorizationError(
                'CONSENT_EXECUTION_JOB_INVALID',
                '동의 작업 원장이 더 이상 실행 가능한 상태가 아닙니다.'
            );
        }

        const { data: union, error: unionError } = await client
            .from('unions')
            .select(`
                id,
                union_project_profiles (
                    project_type_code,
                    implementation_method
                )
            `)
            .eq('id', request.unionId)
            .maybeSingle();
        if (unionError) {
            throw executionAuthorizationError(
                'CONSENT_EXECUTION_UNION_LOOKUP_FAILED',
                '동의 작업의 현재 조합 범위를 확인할 수 없습니다.'
            );
        }
        const profileRows = Array.isArray(union?.union_project_profiles)
            ? union.union_project_profiles
            : union?.union_project_profiles
                ? [union.union_project_profiles]
                : [];
        const profile = profileRows[0];
        if (
            !union ||
            union.id !== request.unionId ||
            profileRows.length !== 1 ||
            typeof profile?.project_type_code !== 'string' ||
            typeof profile?.implementation_method !== 'string'
        ) {
            throw executionAuthorizationError(
                'CONSENT_EXECUTION_UNION_SCOPE_INVALID',
                '동의 작업의 현재 조합 사업 범위가 유효하지 않습니다.'
            );
        }

        const { data: stage, error: stageError } = await client
            .from('consent_stages')
            .select('id, project_type_code, implementation_method_code')
            .eq('id', request.stageId)
            .eq('project_type_code', profile.project_type_code)
            .eq('implementation_method_code', profile.implementation_method)
            .maybeSingle();
        if (stageError) {
            throw executionAuthorizationError(
                'CONSENT_EXECUTION_STAGE_LOOKUP_FAILED',
                '동의 작업의 현재 단계를 확인할 수 없습니다.'
            );
        }
        if (
            !stage ||
            stage.id !== request.stageId ||
            stage.project_type_code !== profile.project_type_code ||
            stage.implementation_method_code !== profile.implementation_method
        ) {
            throw executionAuthorizationError(
                'CONSENT_EXECUTION_STAGE_INVALID',
                '동의 단계가 더 이상 요청 조합에서 사용할 수 없습니다.'
            );
        }

        if ('memberIds' in request) {
            const verifiedMemberIds = new Set<string>();
            for (
                let offset = 0;
                offset < request.memberIds.length;
                offset += MEMBER_SCOPE_CHUNK_SIZE
            ) {
                const chunk = request.memberIds.slice(offset, offset + MEMBER_SCOPE_CHUNK_SIZE);
                const { data: members, error: memberError } = await client
                    .from('users')
                    .select('id')
                    .eq('union_id', request.unionId)
                    .in('id', chunk);
                if (memberError) {
                    throw executionAuthorizationError(
                        'CONSENT_EXECUTION_MEMBER_LOOKUP_FAILED',
                        '동의 대상 조합원의 현재 범위를 확인할 수 없습니다.'
                    );
                }
                for (const member of members ?? []) {
                    if (typeof member.id === 'string') verifiedMemberIds.add(member.id);
                }
            }
            if (request.memberIds.some((memberId) => !verifiedMemberIds.has(memberId))) {
                throw executionAuthorizationError(
                    'CONSENT_EXECUTION_MEMBER_SCOPE_MISMATCH',
                    '동의 대상 중 현재 요청 조합에 속하지 않은 사용자가 있습니다.'
                );
            }
        }
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
    private jobKey(databaseTarget: DatabaseTarget, jobId: string): string {
        return `${databaseTarget}:${jobId}`;
    }

    private updateJobStatus(
        jobId: string,
        databaseTarget: DatabaseTarget,
        update: Partial<ConsentJobInfo>
    ): void {
        const key = this.jobKey(databaseTarget, jobId);
        const job = this.jobs.get(key);
        if (job) {
            Object.assign(job, update);
            this.jobs.set(key, job);
        }
    }

    /**
     * 작업 상태 조회
     */
    getJobStatus(jobId: string, databaseTarget: DatabaseTarget): ConsentJobInfo | undefined {
        return this.jobs.get(this.jobKey(databaseTarget, jobId));
    }

    /**
     * 완료된 작업 정리 (메모리 관리)
     */
    private cleanupOldJobs(): void {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        let cleaned = 0;

        for (const [jobKey, job] of this.jobs.entries()) {
            if (job.completedAt && job.completedAt < oneHourAgo) {
                this.jobs.delete(jobKey);
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

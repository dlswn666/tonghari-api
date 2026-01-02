import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { supabaseService } from './supabase.service';
import {
    MemberJobInfo,
    MemberJobType,
    MemberInviteSyncRequest,
    MemberInviteSyncResult,
    PreRegisterRequest,
    PreRegisterResult,
    PreRegisterMatchingResult,
    MemberBulkRequest,
} from '../types/member.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('MEMBER-QUEUE');

/**
 * 조합원 대량 처리 큐 서비스
 * 
 * - MEMBER_INVITE_SYNC: 조합원 초대 동기화 (member_invites 테이블)
 * - PRE_REGISTER: 사전 등록 (users 테이블, PRE_REGISTERED 상태)
 */
class MemberQueueService {
    private queue: PQueue;
    private jobs: Map<string, MemberJobInfo>;

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
     * 조합원 초대 동기화 작업 추가
     */
    async addMemberInviteSyncJob(request: MemberInviteSyncRequest): Promise<MemberJobInfo> {
        const jobId = uuidv4();
        const jobInfo: MemberJobInfo = {
            jobId,
            jobType: 'MEMBER_INVITE_SYNC',
            unionId: request.unionId,
            totalCount: request.members.length,
            processedCount: 0,
            status: 'pending',
            createdAt: new Date(),
        };

        this.jobs.set(jobId, jobInfo);

        // Supabase sync_jobs 테이블에 초기 등록
        try {
            await supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                status: 'PROCESSING',
                progress: 0,
                preview_data: { job_type: 'MEMBER_INVITE_SYNC' },
            });
            logger.info(`Member invite sync job added: ${jobId} (members: ${request.members.length})`);
        } catch (error) {
            logger.error(`sync_jobs registration failed (${jobId})`, error);
        }

        this.queue
            .add(async () => {
                await this.processMemberInviteSyncJob(jobId, request);
            })
            .catch((err) => {
                logger.error(`Member invite sync job ${jobId} fatal error`, err);
                this.updateJobStatus(jobId, { status: 'failed', error: err.message });
                supabaseService.updateSyncJobStatus(jobId, 'FAILED', 0, err.message);
            });

        return jobInfo;
    }

    /**
     * 사전 등록 작업 추가
     */
    async addPreRegisterJob(request: PreRegisterRequest): Promise<MemberJobInfo> {
        const jobId = uuidv4();
        const jobInfo: MemberJobInfo = {
            jobId,
            jobType: 'PRE_REGISTER',
            unionId: request.unionId,
            totalCount: request.members.length,
            processedCount: 0,
            status: 'pending',
            createdAt: new Date(),
        };

        this.jobs.set(jobId, jobInfo);

        // Supabase sync_jobs 테이블에 초기 등록
        try {
            await supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                status: 'PROCESSING',
                progress: 0,
                preview_data: { job_type: 'PRE_REGISTER' },
            });
            logger.info(`Pre-register job added: ${jobId} (members: ${request.members.length})`);
        } catch (error) {
            logger.error(`sync_jobs registration failed (${jobId})`, error);
        }

        this.queue
            .add(async () => {
                await this.processPreRegisterJob(jobId, request);
            })
            .catch((err) => {
                logger.error(`Pre-register job ${jobId} fatal error`, err);
                this.updateJobStatus(jobId, { status: 'failed', error: err.message });
                supabaseService.updateSyncJobStatus(jobId, 'FAILED', 0, err.message);
            });

        return jobInfo;
    }

    /**
     * 조합원 초대 동기화 처리
     */
    private async processMemberInviteSyncJob(jobId: string, request: MemberInviteSyncRequest): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job) return;

        logger.info(`[Member Sync ${jobId}] Processing started`);
        this.updateJobStatus(jobId, { status: 'processing', startedAt: new Date() });

        try {
            const client = supabaseService.getClient();
            
            // RPC 함수 호출 - 동기화 수행
            const { data: syncResult, error: syncError } = await client.rpc('sync_member_invites', {
                p_union_id: request.unionId,
                p_created_by: request.createdBy,
                p_expires_hours: request.expiresHours || 8760, // 1년
                p_members: request.members,
            });

            if (syncError) {
                throw new Error(syncError.message);
            }

            const result = syncResult as MemberInviteSyncResult;

            // auth.users 삭제 처리
            if (result.deleted_auth_user_ids && result.deleted_auth_user_ids.length > 0) {
                logger.info(`[Member Sync ${jobId}] Deleting ${result.deleted_auth_user_ids.length} auth users`);
                for (const authUserId of result.deleted_auth_user_ids) {
                    try {
                        const { error: deleteAuthError } = await client.auth.admin.deleteUser(authUserId);
                        if (deleteAuthError) {
                            logger.error(`[Member Sync ${jobId}] Failed to delete auth user ${authUserId}:`, deleteAuthError);
                        }
                    } catch (error) {
                        logger.error(`[Member Sync ${jobId}] Error deleting auth user ${authUserId}:`, error);
                    }
                }
            }

            // 완료 처리
            this.updateJobStatus(jobId, {
                status: 'completed',
                completedAt: new Date(),
                processedCount: request.members.length,
                result,
            });

            const previewData = {
                job_type: 'MEMBER_INVITE_SYNC',
                inserted: result.inserted,
                deleted_pending: result.deleted_pending,
                deleted_used: result.deleted_used,
                totalCount: request.members.length,
            };

            await supabaseService.updateSyncJobStatus(jobId, 'COMPLETED', 100, undefined, previewData);

            logger.info(`[Member Sync ${jobId}] Completed - Inserted: ${result.inserted}, Deleted pending: ${result.deleted_pending}, Deleted used: ${result.deleted_used}`);

        } catch (error: any) {
            const errorMessage = error.message || 'Unknown error';
            logger.error(`[Member Sync ${jobId}] Failed`, error);
            this.updateJobStatus(jobId, { status: 'failed', error: errorMessage, completedAt: new Date() });
            await supabaseService.updateSyncJobStatus(jobId, 'FAILED', 0, errorMessage);
        }
    }

    /**
     * 사전 등록 처리
     */
    private async processPreRegisterJob(jobId: string, request: PreRegisterRequest): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job) return;

        logger.info(`[Pre-Register ${jobId}] Processing started`);
        this.updateJobStatus(jobId, { status: 'processing', startedAt: new Date() });

        const client = supabaseService.getClient();
        const errors: string[] = [];
        let savedCount = 0;
        let matchedCount = 0;
        let unmatchedCount = 0;

        const totalCount = request.members.length;

        for (let i = 0; i < request.members.length; i++) {
            const member = request.members[i];
            const currentIndex = i + 1;

            try {
                if (member.matched && member.pnu) {
                    matchedCount++;
                } else {
                    unmatchedCount++;
                }

                // 동호수 정규화
                const normalizedDong = this.normalizeDong(member.row.dong);
                const normalizedHo = this.normalizeHo(member.row.ho);

                // 중복 체크
                if (member.pnu) {
                    const isDuplicate = await this.checkDuplicatePnu(
                        client,
                        request.unionId,
                        member.pnu,
                        normalizedDong,
                        normalizedHo
                    );
                    if (isDuplicate.isDuplicate) {
                        errors.push(`${member.row.name}: 이미 등록된 소유지입니다. (기존 등록자: ${isDuplicate.existingUserName})`);
                        continue;
                    }
                }

                // UUID 생성
                const userId = uuidv4();

                // users 테이블에 저장
                const { error } = await client.from('users').insert({
                    id: userId,
                    name: member.row.name,
                    phone_number: member.row.phoneNumber || null,
                    email: null,
                    role: 'USER',
                    union_id: request.unionId,
                    user_status: 'PRE_REGISTERED',
                    resident_address: member.row.residentAddress || null,
                    property_pnu: member.pnu,
                    property_address_jibun: member.row.propertyAddress,
                    property_dong: normalizedDong,
                    property_ho: normalizedHo,
                });

                if (error) {
                    errors.push(`${member.row.name}: ${error.message}`);
                } else {
                    savedCount++;
                }

            } catch (err: any) {
                errors.push(`${member.row.name}: ${err.message || 'Unknown error'}`);
            }

            // 진행률 업데이트
            job.processedCount = currentIndex;
            const progress = Math.round((currentIndex / totalCount) * 100);

            // 10% 단위로 DB 업데이트
            if (progress % 10 === 0 || currentIndex === totalCount) {
                logger.info(`[Pre-Register ${jobId}] Progress: ${progress}% (${currentIndex}/${totalCount}, saved: ${savedCount})`);
                await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress);
            }
        }

        // 완료 처리
        const finalStatus = errors.length === totalCount ? 'failed' : 'completed';
        const result: PreRegisterResult = {
            success: errors.length === 0,
            totalCount,
            matchedCount,
            unmatchedCount,
            savedCount,
            errors: errors.slice(0, 100), // 최대 100개만 저장
        };

        this.updateJobStatus(jobId, {
            status: finalStatus,
            completedAt: new Date(),
            result,
        });

        const previewData = {
            job_type: 'PRE_REGISTER',
            ...result,
        };

        const errorLog = errors.length > 0 ? JSON.stringify({ errors: errors.slice(0, 100) }) : undefined;

        await supabaseService.updateSyncJobStatus(
            jobId,
            finalStatus === 'completed' ? 'COMPLETED' : 'FAILED',
            100,
            errorLog,
            previewData
        );

        logger.info(`[Pre-Register ${jobId}] Completed - Saved: ${savedCount}, Errors: ${errors.length}, Total: ${totalCount}`);
    }

    /**
     * 동 정규화
     */
    private normalizeDong(dong?: string): string | null {
        if (!dong) return null;
        let normalized = dong.trim();
        // "동" 접미사 제거
        normalized = normalized.replace(/동$/g, '');
        return normalized || null;
    }

    /**
     * 호수 정규화
     */
    private normalizeHo(ho?: string): string | null {
        if (!ho) return null;
        let normalized = ho.trim();
        // "호" 접미사 제거
        normalized = normalized.replace(/호$/g, '');
        return normalized || null;
    }

    /**
     * PNU 중복 체크
     */
    private async checkDuplicatePnu(
        client: any,
        unionId: string,
        pnu: string,
        dong: string | null,
        ho: string | null
    ): Promise<{ isDuplicate: boolean; existingUserName?: string }> {
        try {
            let query = client
                .from('users')
                .select('id, name')
                .eq('union_id', unionId)
                .eq('property_pnu', pnu);

            if (dong) {
                query = query.eq('property_dong', dong);
            } else {
                query = query.is('property_dong', null);
            }

            if (ho) {
                query = query.eq('property_ho', ho);
            } else {
                query = query.is('property_ho', null);
            }

            const { data, error } = await query.limit(1);

            if (error) {
                logger.error('Duplicate check error:', error);
                return { isDuplicate: false };
            }

            if (data && data.length > 0) {
                return { isDuplicate: true, existingUserName: data[0].name };
            }

            return { isDuplicate: false };
        } catch (error) {
            logger.error('Duplicate check error:', error);
            return { isDuplicate: false };
        }
    }

    /**
     * 작업 상태 업데이트
     */
    private updateJobStatus(jobId: string, update: Partial<MemberJobInfo>): void {
        const job = this.jobs.get(jobId);
        if (job) {
            Object.assign(job, update);
            this.jobs.set(jobId, job);
        }
    }

    /**
     * 작업 상태 조회
     */
    getJobStatus(jobId: string): MemberJobInfo | undefined {
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
            logger.info(`${cleaned} completed member jobs cleaned up`);
        }
    }
}

export const memberQueueService = new MemberQueueService();
export default memberQueueService;

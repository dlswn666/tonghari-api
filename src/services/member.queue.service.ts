import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { supabaseService } from './supabase.service';
import { gisService } from './gis.service';
import {
    MemberJobInfo,
    MemberInviteSyncRequest,
    MemberInviteSyncResult,
    PreRegisterRequest,
    PreRegisterResult,
    PreRegisterData,
    SyncPropertiesRequest,
    SyncPropertiesResult,
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
            await supabaseService
                .getClient()
                .from('sync_jobs')
                .insert({
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
            await supabaseService
                .getClient()
                .from('sync_jobs')
                .insert({
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
     * 소유지 동기화 작업 추가
     * user_property_units 테이블의 pnu, dong, ho를 기반으로
     * building_units와 매칭하여 building_unit_id를 연결합니다.
     */
    async addSyncPropertiesJob(request: SyncPropertiesRequest): Promise<MemberJobInfo> {
        const jobId = uuidv4();

        // pnu가 있고 building_unit_id가 없는 user_property_units 수를 조회
        const client = supabaseService.getClient();
        const { count, error: countError } = await client
            .from('user_property_units')
            .select('*, users!inner(id)', { count: 'exact', head: true })
            .eq('users.union_id', request.unionId)
            .not('pnu', 'is', null)
            .is('building_unit_id', null);

        if (countError) {
            logger.error(`Failed to count property units for sync: ${countError.message}`);
        }

        const totalCount = count || 0;

        const jobInfo: MemberJobInfo = {
            jobId,
            jobType: 'SYNC_PROPERTIES',
            unionId: request.unionId,
            totalCount,
            processedCount: 0,
            status: 'pending',
            createdAt: new Date(),
        };

        this.jobs.set(jobId, jobInfo);

        // Supabase sync_jobs 테이블에 초기 등록
        try {
            await client.from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                status: 'PROCESSING',
                progress: 0,
                preview_data: { job_type: 'SYNC_PROPERTIES', totalCount },
            });
            logger.info(`Sync properties job added: ${jobId} (property units to sync: ${totalCount})`);
        } catch (error) {
            logger.error(`sync_jobs registration failed (${jobId})`, error);
        }

        this.queue
            .add(async () => {
                await this.processSyncPropertiesJob(jobId, request.unionId);
            })
            .catch((err) => {
                logger.error(`Sync properties job ${jobId} fatal error`, err);
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
                            logger.error(
                                `[Member Sync ${jobId}] Failed to delete auth user ${authUserId}:`,
                                deleteAuthError
                            );
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

            logger.info(
                `[Member Sync ${jobId}] Completed - Inserted: ${result.inserted}, Deleted pending: ${result.deleted_pending}, Deleted used: ${result.deleted_used}`
            );
        } catch (error: any) {
            const errorMessage = error.message || 'Unknown error';
            logger.error(`[Member Sync ${jobId}] Failed`, error);
            this.updateJobStatus(jobId, { status: 'failed', error: errorMessage, completedAt: new Date() });
            await supabaseService.updateSyncJobStatus(jobId, 'FAILED', 0, errorMessage);
        }
    }

    /**
     * 사전 등록 처리 (GIS 매칭 + 저장 통합)
     * 1단계: GIS 매칭 (0-50%) - 면적/공시지가가 있으면 생략
     * 2단계: DB 저장 (50-100%) - users + user_property_units
     */
    private async processPreRegisterJob(jobId: string, request: PreRegisterRequest): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job) return;

        logger.info(`[Pre-Register ${jobId}] Processing started (${request.members.length} members)`);
        this.updateJobStatus(jobId, { status: 'processing', startedAt: new Date() });

        const client = supabaseService.getClient();
        const errors: string[] = [];
        let savedCount = 0;
        let updatedCount = 0; // 중복 시 업데이트된 건수
        let matchedCount = 0;
        let unmatchedCount = 0;
        let duplicateCount = 0;
        let apiSkippedCount = 0;

        const totalCount = request.members.length;

        // ========================================
        // 1단계: GIS 매칭 (진행률 업데이트 없음)
        // 면적 AND 공시지가가 있으면 API 호출 생략
        // DB Insert 완료 시점에만 진행률을 반영하므로 이 단계에서는 진행률 0% 유지
        // ========================================
        logger.info(`[Pre-Register ${jobId}] Phase 1: GIS Matching`);

        interface MatchedMember {
            row: PreRegisterData;
            pnu: string | null;
            matched: boolean;
            apiSkipped: boolean; // API 호출 생략 여부
        }

        const matchedMembers: MatchedMember[] = [];

        for (let i = 0; i < request.members.length; i++) {
            const member = request.members[i];
            const currentIndex = i + 1;

            let pnu: string | null = null;
            let matched = false;
            let apiSkipped = false;

            // 면적 AND 공시지가가 있으면 API 호출 생략
            const hasPropertyDetails =
                member.area !== undefined &&
                member.area > 0 &&
                member.officialPrice !== undefined &&
                member.officialPrice > 0;

            if (hasPropertyDetails) {
                // API 호출 생략 - 로컬 PNU 생성만 시도
                try {
                    const pnuResult = await gisService.generatePNUFromAddress(member.propertyAddress);
                    if (pnuResult) {
                        pnu = pnuResult.pnu;
                        matched = true;
                        matchedCount++;
                    } else {
                        unmatchedCount++;
                    }
                } catch (err: any) {
                    logger.warn(
                        `[Pre-Register ${jobId}] Local PNU generation failed for "${member.propertyAddress}": ${err.message}`
                    );
                    unmatchedCount++;
                }
                apiSkipped = true;
                apiSkippedCount++;
                logger.debug(`[Pre-Register ${jobId}] API skipped for "${member.propertyAddress}" (has area & price)`);
            } else {
                // 기존 GIS 매칭 로직 (API 호출)
                try {
                    const pnuResult = await gisService.generatePNUFromAddress(member.propertyAddress);
                    if (pnuResult) {
                        pnu = pnuResult.pnu;
                        matched = true;
                        matchedCount++;
                    } else {
                        unmatchedCount++;
                    }
                } catch (err: any) {
                    logger.warn(
                        `[Pre-Register ${jobId}] GIS matching failed for "${member.propertyAddress}": ${err.message}`
                    );
                    unmatchedCount++;
                }
            }

            matchedMembers.push({ row: member, pnu, matched, apiSkipped });

            // Phase 1에서는 진행률을 업데이트하지 않음 (DB Insert 완료 시점에만 진행률 반영)
            // 로컬 상태만 업데이트
            job.processedCount = currentIndex;
        }

        logger.info(
            `[Pre-Register ${jobId}] Phase 1 completed - Matched: ${matchedCount}, Unmatched: ${unmatchedCount}, API Skipped: ${apiSkippedCount}`
        );

        // ========================================
        // 2단계: DB 저장 (0-100%)
        // users + building_units + user_property_units 저장
        // Phase 1에서 진행률 업데이트 없이, DB Insert 완료 시점에만 반영
        // ========================================
        logger.info(`[Pre-Register ${jobId}] Phase 2: DB Insert`);

        for (let i = 0; i < matchedMembers.length; i++) {
            const member = matchedMembers[i];
            const currentIndex = i + 1;

            try {
                // 동호수 정규화
                const normalizedDong = this.normalizeDong(member.row.dong);
                const normalizedHo = this.normalizeHo(member.row.ho);

                // 중복 체크 (PNU가 있는 경우에만)
                // 공동 소유자 지원: 동일 PNU+동+호라도 이름이 다르면 별도 저장
                if (member.pnu) {
                    const duplicateResult = await this.checkDuplicatePnu(
                        client,
                        request.unionId,
                        member.pnu,
                        normalizedDong,
                        normalizedHo,
                        member.row.name // 현재 처리 중인 멤버 이름 전달
                    );

                    if (duplicateResult.isDuplicate && duplicateResult.existingUserId) {
                        // 이름이 같으면 실제 중복 → 기존 정보 업데이트
                        // 이름이 다르면 공동 소유자 → 별도 레코드로 저장 (continue 하지 않음)
                        const isSamePerson = duplicateResult.existingUserName?.trim() === member.row.name.trim();

                        if (isSamePerson) {
                            // 동일인 중복인 경우 기존 사용자 정보 업데이트
                            const { error: updateError } = await client
                                .from('users')
                                .update({
                                    name: member.row.name,
                                    phone_number: member.row.phoneNumber || null,
                                    resident_address: member.row.residentAddress || null,
                                    notes: member.row.notes || null,
                                })
                                .eq('id', duplicateResult.existingUserId);

                            if (updateError) {
                                errors.push(`${member.row.name}: 업데이트 실패 - ${updateError.message}`);
                            } else {
                                // user_property_units도 업데이트
                                if (duplicateResult.existingPropertyUnitId) {
                                    await client
                                        .from('user_property_units')
                                        .update({
                                            property_address_jibun: member.row.propertyAddress || null,
                                            property_address_road: member.row.propertyAddressRoad || null,
                                            building_name: member.row.buildingName || null,
                                            dong: normalizedDong,
                                            ho: normalizedHo,
                                            land_area: this.sanitizeNumeric(member.row.landArea),
                                            land_ownership_ratio: this.sanitizeNumeric(member.row.landOwnershipRatio),
                                            building_area: this.sanitizeNumeric(member.row.buildingArea),
                                            building_ownership_ratio: this.sanitizeNumeric(
                                                member.row.buildingOwnershipRatio
                                            ),
                                        })
                                        .eq('id', duplicateResult.existingPropertyUnitId);
                                }
                                updatedCount++;
                                duplicateCount++;
                            }
                            continue;
                        } else {
                            // 공동 소유자는 별도 레코드로 저장 (continue 하지 않고 아래 insert 로직 진행)
                        }
                    }
                }

                // UUID 생성
                const userId = uuidv4();

                // users 테이블에 저장 (기본 정보만)
                // 물건지 정보(PNU, 주소, 면적, 지분율, 동, 호수)는 user_property_units에서 관리
                const { error: userError } = await client.from('users').insert({
                    id: userId,
                    name: member.row.name,
                    phone_number: member.row.phoneNumber || null,
                    email: null,
                    role: 'USER',
                    union_id: request.unionId,
                    user_status: 'PRE_REGISTERED',
                    resident_address: member.row.residentAddress || null,
                    notes: member.row.notes || null,
                });

                if (userError) {
                    errors.push(`${member.row.name}: ${userError.message}`);
                    continue;
                }

                // user_property_units에 물건지 정보 저장 (building_unit_id는 선택적)
                try {
                    // building_unit 조회 또는 생성 (GIS 매칭용, PNU가 있는 경우만)
                    let buildingUnitId: string | null = null;
                    if (member.pnu) {
                        buildingUnitId = await this.findOrCreateBuildingUnit(
                            client,
                            member.pnu,
                            member.row.buildingName || null,
                            normalizedDong,
                            normalizedHo,
                            this.sanitizeNumeric(member.row.landArea || member.row.area),
                            this.sanitizeNumeric(member.row.officialPrice)
                        );
                    }

                    // 토지/건물 면적 및 지분율 개별 처리
                    const landArea = this.sanitizeNumeric(member.row.landArea);
                    const landOwnershipRatio = this.sanitizeNumeric(member.row.landOwnershipRatio);
                    const buildingArea = this.sanitizeNumeric(member.row.buildingArea);
                    const buildingOwnershipRatio = this.sanitizeNumeric(member.row.buildingOwnershipRatio);

                    // 소유유형 결정: 토지 또는 건물 지분율이 100% 미만이면 CO_OWNER
                    const effectiveRatio = landOwnershipRatio || buildingOwnershipRatio || 100;
                    let ownershipType: 'OWNER' | 'CO_OWNER' | 'FAMILY' = 'OWNER';
                    if (member.row.ownershipType) {
                        ownershipType = member.row.ownershipType;
                    } else if (effectiveRatio < 100) {
                        ownershipType = 'CO_OWNER';
                    }

                    // user_property_units에 모든 물건지 정보 저장
                    const { error: propUnitError } = await client.from('user_property_units').insert({
                        id: uuidv4(),
                        user_id: userId,
                        building_unit_id: buildingUnitId, // nullable - GIS 매칭 시 연결됨
                        pnu: member.pnu || null,
                        property_address_jibun: member.row.propertyAddress || null,
                        property_address_road: member.row.propertyAddressRoad || null,
                        building_name: member.row.buildingName || null,
                        dong: normalizedDong,
                        ho: normalizedHo,
                        ownership_type: ownershipType,
                        is_primary: true,
                        land_area: landArea,
                        land_ownership_ratio: landOwnershipRatio,
                        building_area: buildingArea,
                        building_ownership_ratio: buildingOwnershipRatio,
                    });

                    if (propUnitError) {
                        logger.warn(
                            `[Pre-Register ${jobId}] user_property_units insert failed for ${member.row.name}: ${propUnitError.message}`
                        );
                    } else {
                        logger.debug(
                            `[Pre-Register ${jobId}] user_property_units created for ${member.row.name} (pnu=${member.pnu}, dong=${normalizedDong}, ho=${normalizedHo})`
                        );
                    }
                } catch (propErr: any) {
                    logger.warn(
                        `[Pre-Register ${jobId}] user_property_units creation failed for ${member.row.name}: ${propErr.message}`
                    );
                }

                savedCount++;
            } catch (err: any) {
                errors.push(`${member.row.name}: ${err.message || 'Unknown error'}`);
            }

            // 진행률 업데이트 (0-100%) - DB Insert 완료 시점에만 진행률 반영
            const progress = Math.round((currentIndex / totalCount) * 100);

            // 5% 단위로 DB 업데이트
            if (progress % 5 === 0 || currentIndex === totalCount) {
                const previewData = {
                    job_type: 'PRE_REGISTER',
                    phase: 'SAVING',
                    matchedCount,
                    unmatchedCount,
                    savedCount,
                    updatedCount,
                    duplicateCount,
                    totalCount,
                };
                await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress, undefined, previewData);
            }
        }

        // 완료 처리 - 신규 저장 또는 업데이트가 있으면 성공으로 처리
        const hasSuccessfulOperations = savedCount > 0 || updatedCount > 0;
        const finalStatus = !hasSuccessfulOperations && errors.length > 0 ? 'failed' : 'completed';
        const result: PreRegisterResult = {
            success: errors.length === 0,
            totalCount,
            matchedCount,
            unmatchedCount,
            savedCount,
            updatedCount,
            duplicateCount,
            errors: errors.slice(0, 100), // 최대 100개만 저장
        };

        this.updateJobStatus(jobId, {
            status: finalStatus,
            completedAt: new Date(),
            result,
        });

        const previewData = {
            job_type: 'PRE_REGISTER',
            phase: 'COMPLETED',
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

        logger.info(
            `[Pre-Register ${jobId}] Completed - Matched: ${matchedCount}, Saved: ${savedCount}, Updated: ${updatedCount}, Duplicates: ${duplicateCount}, Errors: ${errors.length}, Total: ${totalCount}`
        );
    }

    /**
     * 동 정규화 (프론트엔드 dong-ho-utils.ts와 동일한 로직)
     * - "제" 접두사 제거 (제1호 → 1호)
     * - "동", "호", "층" 접미사 제거
     * - 지하 표시 통일 (비, 지하, 지 → B)
     */
    private normalizeDong(dong?: string): string | null {
        if (!dong) return null;
        let normalized = dong.trim();

        // "제" 접두사 제거 (예: "제1호" -> "1호")
        normalized = normalized.replace(/^제/g, '');

        // "동", "호", "층" 접미사 제거
        normalized = normalized.replace(/(동|호|층)$/g, '');

        // 지하 표시 통일 (비, 지하, 지 → B)
        normalized = normalized.replace(/^비/g, 'B');
        normalized = normalized.replace(/^지하/g, 'B');
        normalized = normalized.replace(/^지(?=\d)/g, 'B');

        return normalized.trim() || null;
    }

    /**
     * 호수 정규화 (프론트엔드 dong-ho-utils.ts와 동일한 로직)
     * - "호" 접미사 제거
     * - 지하층 표시 통일 (비, 지하, 지 → B)
     */
    private normalizeHo(ho?: string): string | null {
        if (!ho) return null;
        let normalized = ho.trim();

        // "호" 접미사 제거
        normalized = normalized.replace(/호$/g, '');

        // 지하층 표시 통일 (비, 지하, 지 → B)
        normalized = normalized.replace(/^비/g, 'B');
        normalized = normalized.replace(/^지하/g, 'B');
        normalized = normalized.replace(/^지(?=\d)/g, 'B');

        return normalized.trim() || null;
    }

    /**
     * 숫자 값 정리 - 0이나 undefined는 null로 변환
     * 면적, 지분율 등에 적용하여 DB에 일관된 값 저장
     */
    private sanitizeNumeric(value: number | null | undefined): number | null {
        if (value === undefined || value === null || value === 0) return null;
        return value;
    }

    /**
     * PNU 중복 체크
     * 중복인 경우 기존 사용자 ID와 property_unit ID를 반환하여 업데이트에 사용
     * user_property_units 테이블에서 pnu, dong, ho로 직접 체크
     */
    private async checkDuplicatePnu(
        client: any,
        unionId: string,
        pnu: string,
        dong: string | null,
        ho: string | null,
        currentMemberName?: string // 현재 처리 중인 멤버 이름 (공동 소유자 판별용)
    ): Promise<{
        isDuplicate: boolean;
        existingUserId?: string;
        existingUserName?: string;
        existingPropertyUnitId?: string;
    }> {
        try {
            // user_property_units에서 pnu, dong, ho로 직접 조회
            let query = client.from('user_property_units').select('id, user_id').eq('pnu', pnu);

            if (dong) {
                query = query.eq('dong', dong);
            } else {
                query = query.is('dong', null);
            }

            if (ho) {
                query = query.eq('ho', ho);
            } else {
                query = query.is('ho', null);
            }

            const { data: propertyUnits } = await query;

            if (!propertyUnits || propertyUnits.length === 0) {
                return { isDuplicate: false };
            }

            // 연결된 사용자 중 해당 조합의 사용자 찾기
            const userIds = propertyUnits.map((pu: any) => pu.user_id);
            const { data: users } = await client
                .from('users')
                .select('id, name')
                .eq('union_id', unionId)
                .in('id', userIds)
                .limit(1);

            if (users && users.length > 0) {
                // 해당 사용자의 property_unit 찾기
                const matchingPropertyUnit = propertyUnits.find((pu: any) => pu.user_id === users[0].id);
                return {
                    isDuplicate: true,
                    existingUserId: users[0].id,
                    existingUserName: users[0].name,
                    existingPropertyUnitId: matchingPropertyUnit?.id,
                };
            }

            return { isDuplicate: false };
        } catch (error) {
            logger.error('Duplicate check error:', error);
            return { isDuplicate: false };
        }
    }

    /**
     * Building Unit 조회 또는 생성
     * 1. PNU로 land_lot 존재 확인 (GIS 초기화 필요)
     * 2. building_land_lots로 building 조회, 없으면 생성 + 매핑 추가
     * 3. building에서 동/호수로 building_unit 조회, 없으면 생성
     * 4. 면적/공시지가 업데이트 (엑셀에서 제공된 경우)
     */
    private async findOrCreateBuildingUnit(
        client: any,
        pnu: string,
        buildingName: string | null,
        dong: string | null,
        ho: string | null,
        area: number | null,
        officialPrice: number | null
    ): Promise<string | null> {
        try {
            // 1. PNU로 land_lot 존재 확인 (FK 제약으로 인해 land_lots에 먼저 존재해야 함)
            const { data: landLot, error: landLotError } = await client
                .from('land_lots')
                .select('pnu')
                .eq('pnu', pnu)
                .single();

            if (landLotError && landLotError.code !== 'PGRST116') {
                logger.warn(`land_lot lookup error for PNU ${pnu}: ${landLotError.message}`);
                return null;
            }

            // land_lot이 없으면 생성하지 않음 (GIS 초기화에서 생성되어야 함)
            if (!landLot) {
                logger.debug(`No land_lot found for PNU ${pnu}, skipping building_unit creation`);
                return null;
            }

            // 2. building_land_lots에서 PNU로 building 조회
            let { data: mapping, error: mappingError } = await client
                .from('building_land_lots')
                .select('building_id')
                .eq('pnu', pnu)
                .single();

            if (mappingError && mappingError.code !== 'PGRST116') {
                logger.warn(`building_land_lots lookup error for PNU ${pnu}: ${mappingError.message}`);
            }

            let buildingId: string | null = mapping?.building_id || null;

            // building이 없으면 생성 + building_land_lots에 매핑 추가
            if (!buildingId) {
                const newBuildingId = uuidv4();
                const { error: createBuildingError } = await client.from('buildings').insert({
                    id: newBuildingId,
                    building_name: buildingName,
                    building_type: 'NONE', // 기본값
                });

                if (createBuildingError) {
                    logger.warn(`building creation failed for PNU ${pnu}: ${createBuildingError.message}`);
                    return null;
                }

                buildingId = newBuildingId;

                // building_land_lots에 매핑 추가
                const { error: mappingInsertError } = await client.from('building_land_lots').insert({
                    pnu: pnu,
                    building_id: buildingId,
                });

                if (mappingInsertError) {
                    logger.warn(`building_land_lots mapping failed for PNU ${pnu}: ${mappingInsertError.message}`);
                    // building은 생성되었으므로 계속 진행
                }

                logger.debug(`Created new building ${buildingId} with mapping for PNU ${pnu}`);
            }

            // 3. building_id + dong + ho로 building_unit 조회
            let query = client.from('building_units').select('id').eq('building_id', buildingId);

            if (dong) {
                query = query.eq('dong', dong);
            } else {
                query = query.is('dong', null);
            }

            if (ho) {
                query = query.eq('ho', ho);
            } else {
                query = query.is('ho', null);
            }

            const { data: existingUnit, error: unitLookupError } = await query.limit(1).single();

            if (unitLookupError && unitLookupError.code !== 'PGRST116') {
                logger.warn(`building_unit lookup error: ${unitLookupError.message}`);
            }

            if (existingUnit) {
                // 기존 unit이 있고, 면적/공시지가가 제공되면 업데이트
                if (area !== null || officialPrice !== null) {
                    const updateData: Record<string, any> = {};
                    if (area !== null) updateData.area = area;
                    if (officialPrice !== null) updateData.official_price = officialPrice;

                    await client.from('building_units').update(updateData).eq('id', existingUnit.id);

                    logger.debug(`Updated building_unit ${existingUnit.id} with area=${area}, price=${officialPrice}`);
                }
                return existingUnit.id;
            }

            // 4. building_unit이 없으면 생성
            const newUnitId = uuidv4();
            const { error: createUnitError } = await client.from('building_units').insert({
                id: newUnitId,
                building_id: buildingId,
                dong: dong,
                ho: ho,
                area: area,
                official_price: officialPrice,
            });

            if (createUnitError) {
                logger.warn(`building_unit creation failed: ${createUnitError.message}`);
                return null;
            }

            logger.debug(`Created new building_unit ${newUnitId} for building ${buildingId} (dong=${dong}, ho=${ho})`);
            return newUnitId;
        } catch (error: any) {
            logger.error(`findOrCreateBuildingUnit error: ${error.message}`);
            return null;
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
     * 소유지 동기화 처리
     * user_property_units 테이블의 pnu, dong, ho를 기반으로
     * building_units와 매칭하여 building_unit_id를 연결합니다.
     */
    private async processSyncPropertiesJob(jobId: string, unionId: string): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job) return;

        logger.info(`[Sync Properties ${jobId}] Processing started for union ${unionId}`);
        this.updateJobStatus(jobId, { status: 'processing', startedAt: new Date() });

        const client = supabaseService.getClient();
        const errors: string[] = [];
        let syncedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        try {
            // 해당 조합의 pnu가 있고 building_unit_id가 없는 user_property_units 조회
            const { data: propertyUnits, error: propUnitsError } = await client
                .from('user_property_units')
                .select(
                    `
                    id, user_id, pnu, dong, ho, building_name,
                    land_area, land_ownership_ratio, building_area, building_ownership_ratio,
                    users!inner(id, name, union_id)
                `
                )
                .eq('users.union_id', unionId)
                .not('pnu', 'is', null)
                .is('building_unit_id', null);

            if (propUnitsError) {
                throw new Error(`Failed to fetch property units: ${propUnitsError.message}`);
            }

            const totalCount = propertyUnits?.length || 0;
            this.updateJobStatus(jobId, { totalCount });

            logger.info(`[Sync Properties ${jobId}] Found ${totalCount} property units to sync`);

            for (let i = 0; i < (propertyUnits || []).length; i++) {
                const propUnit = propertyUnits![i];
                const currentIndex = i + 1;
                const userName = (propUnit.users as any)?.name || 'Unknown';

                try {
                    // building_unit 조회 또는 생성
                    const buildingUnitId = await this.findOrCreateBuildingUnit(
                        client,
                        propUnit.pnu!,
                        propUnit.building_name,
                        propUnit.dong,
                        propUnit.ho,
                        propUnit.land_area,
                        null // officialPrice
                    );

                    if (!buildingUnitId) {
                        failedCount++;
                        errors.push(`${userName}: GIS 데이터가 없어 매칭 불가 (PNU: ${propUnit.pnu})`);
                        continue;
                    }

                    // user_property_units에 building_unit_id 연결
                    const { error: updateError } = await client
                        .from('user_property_units')
                        .update({ building_unit_id: buildingUnitId })
                        .eq('id', propUnit.id);

                    if (updateError) {
                        failedCount++;
                        errors.push(`${userName}: 연결 저장 실패 - ${updateError.message}`);
                        continue;
                    }

                    syncedCount++;
                    logger.debug(`[Sync Properties ${jobId}] Synced ${userName} to building_unit ${buildingUnitId}`);
                } catch (err: any) {
                    failedCount++;
                    errors.push(`${userName}: ${err.message || 'Unknown error'}`);
                }

                // 진행률 업데이트
                const progress = Math.round((currentIndex / totalCount) * 100);

                // 5% 단위로 DB 업데이트
                if (progress % 5 === 0 || currentIndex === totalCount) {
                    const previewData = {
                        job_type: 'SYNC_PROPERTIES',
                        totalCount,
                        syncedCount,
                        skippedCount,
                        failedCount,
                    };
                    await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress, undefined, previewData);
                }
            }

            // 완료 처리
            const result: SyncPropertiesResult = {
                success: failedCount === 0,
                totalCount,
                syncedCount,
                skippedCount,
                failedCount,
                errors: errors.slice(0, 100),
            };

            this.updateJobStatus(jobId, {
                status: 'completed',
                completedAt: new Date(),
                result,
            });

            const previewData = {
                job_type: 'SYNC_PROPERTIES',
                ...result,
            };

            await supabaseService.updateSyncJobStatus(
                jobId,
                'COMPLETED',
                100,
                errors.length > 0 ? JSON.stringify({ errors: errors.slice(0, 100) }) : undefined,
                previewData
            );

            logger.info(
                `[Sync Properties ${jobId}] Completed - Synced: ${syncedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`
            );
        } catch (error: any) {
            const errorMessage = error.message || 'Unknown error';
            logger.error(`[Sync Properties ${jobId}] Failed`, error);
            this.updateJobStatus(jobId, { status: 'failed', error: errorMessage, completedAt: new Date() });
            await supabaseService.updateSyncJobStatus(jobId, 'FAILED', 0, errorMessage);
        }
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

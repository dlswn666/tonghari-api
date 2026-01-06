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
        let matchedCount = 0;
        let unmatchedCount = 0;
        let duplicateCount = 0;
        let apiSkippedCount = 0;

        const totalCount = request.members.length;

        // ========================================
        // 1단계: GIS 매칭 (0-50%)
        // 면적 AND 공시지가가 있으면 API 호출 생략
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
            const hasPropertyDetails = member.area !== undefined && member.area > 0 && 
                                        member.officialPrice !== undefined && member.officialPrice > 0;
            
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
                    logger.warn(`[Pre-Register ${jobId}] Local PNU generation failed for "${member.propertyAddress}": ${err.message}`);
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
                    logger.warn(`[Pre-Register ${jobId}] GIS matching failed for "${member.propertyAddress}": ${err.message}`);
                    unmatchedCount++;
                }
            }
            
            matchedMembers.push({ row: member, pnu, matched, apiSkipped });
            
            // 진행률 업데이트 (0-50%)
            job.processedCount = currentIndex;
            const progress = Math.round((currentIndex / totalCount) * 50);
            
            // 5% 단위로 DB 업데이트
            if (progress % 5 === 0 || currentIndex === totalCount) {
                const previewData = {
                    job_type: 'PRE_REGISTER',
                    phase: 'MATCHING',
                    matchedCount,
                    unmatchedCount,
                    apiSkippedCount,
                    totalCount,
                };
                await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress, undefined, previewData);
            }
        }
        
        logger.info(`[Pre-Register ${jobId}] Phase 1 completed - Matched: ${matchedCount}, Unmatched: ${unmatchedCount}, API Skipped: ${apiSkippedCount}`);

        // ========================================
        // 2단계: DB 저장 (50-100%)
        // users + building_units + user_property_units 저장
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
                if (member.pnu) {
                    const isDuplicate = await this.checkDuplicatePnu(
                        client,
                        request.unionId,
                        member.pnu,
                        normalizedDong,
                        normalizedHo
                    );
                    if (isDuplicate.isDuplicate) {
                        duplicateCount++;
                        errors.push(`${member.row.name}: 이미 등록된 소유지입니다. (기존 등록자: ${isDuplicate.existingUserName})`);
                        continue;
                    }
                }

                // UUID 생성
                const userId = uuidv4();

                // users 테이블에 저장 (기본 정보)
                const { error: userError } = await client.from('users').insert({
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
                    property_address_road: member.row.propertyAddressRoad || null,
                    property_dong: normalizedDong,
                    property_ho: normalizedHo,
                    notes: member.row.notes || null,
                });

                if (userError) {
                    errors.push(`${member.row.name}: ${userError.message}`);
                    continue;
                }

                // building_unit 조회 또는 생성 (PNU가 있는 경우)
                let buildingUnitId: string | null = null;
                
                if (member.pnu) {
                    buildingUnitId = await this.findOrCreateBuildingUnit(
                        client,
                        member.pnu,
                        member.row.buildingName || null,
                        normalizedDong,
                        normalizedHo,
                        member.row.area || null,
                        member.row.officialPrice || null
                    );
                }

                // user_property_units에 연결 저장 (building_unit이 있는 경우)
                if (buildingUnitId) {
                    const ownershipType = member.row.ownershipType || 'OWNER';
                    
                    // 하위 호환성: 기존 단일 지분율이 있으면 토지/건축물 양쪽에 적용
                    const defaultRatio = ownershipType === 'OWNER' ? 100 : null;
                    const landOwnershipRatio = member.row.landOwnershipRatio ?? member.row.ownershipRatio ?? defaultRatio;
                    const buildingOwnershipRatio = member.row.buildingOwnershipRatio ?? member.row.ownershipRatio ?? defaultRatio;
                    
                    // 토지/건축물 면적 (하위 호환: 기존 area 필드 참조)
                    const landArea = member.row.landArea ?? null;
                    const buildingArea = member.row.buildingArea ?? member.row.area ?? null;
                    
                    const { error: linkError } = await client.from('user_property_units').insert({
                        id: uuidv4(),
                        user_id: userId,
                        building_unit_id: buildingUnitId,
                        ownership_type: ownershipType,
                        ownership_ratio: member.row.ownershipRatio ?? defaultRatio, // 하위 호환성
                        land_area: landArea,
                        land_ownership_ratio: landOwnershipRatio,
                        building_area: buildingArea,
                        building_ownership_ratio: buildingOwnershipRatio,
                        is_primary: true, // 첫 번째 물건지는 대표로 설정
                        notes: member.row.notes || null,
                    });

                    if (linkError) {
                        logger.warn(`[Pre-Register ${jobId}] user_property_units insert failed for ${member.row.name}: ${linkError.message}`);
                        // 연결 실패해도 사용자는 저장됨
                    }
                }

                savedCount++;

            } catch (err: any) {
                errors.push(`${member.row.name}: ${err.message || 'Unknown error'}`);
            }

            // 진행률 업데이트 (50-100%)
            const progress = 50 + Math.round((currentIndex / totalCount) * 50);
            
            // 5% 단위로 DB 업데이트
            if (progress % 5 === 0 || currentIndex === totalCount) {
                const previewData = {
                    job_type: 'PRE_REGISTER',
                    phase: 'SAVING',
                    matchedCount,
                    unmatchedCount,
                    savedCount,
                    duplicateCount,
                    totalCount,
                };
                await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress, undefined, previewData);
            }
        }

        // 완료 처리
        const finalStatus = savedCount === 0 && errors.length > 0 ? 'failed' : 'completed';
        const result: PreRegisterResult = {
            success: errors.length === 0,
            totalCount,
            matchedCount,
            unmatchedCount,
            savedCount,
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

        logger.info(`[Pre-Register ${jobId}] Completed - Matched: ${matchedCount}, Saved: ${savedCount}, Duplicates: ${duplicateCount}, Errors: ${errors.length}, Total: ${totalCount}`);
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
     * Building Unit 조회 또는 생성
     * 1. PNU로 building 조회, 없으면 생성
     * 2. building에서 동/호수로 building_unit 조회, 없으면 생성
     * 3. 면적/공시지가 업데이트 (엑셀에서 제공된 경우)
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
            // 1. PNU로 land_lot 조회
            const { data: landLot, error: landLotError } = await client
                .from('land_lots')
                .select('id')
                .eq('pnu', pnu)
                .single();

            if (landLotError && landLotError.code !== 'PGRST116') {
                logger.warn(`land_lot lookup error for PNU ${pnu}: ${landLotError.message}`);
                return null;
            }

            let landLotId: string | null = landLot?.id || null;

            // land_lot이 없으면 생성하지 않음 (GIS 초기화에서 생성되어야 함)
            if (!landLotId) {
                logger.debug(`No land_lot found for PNU ${pnu}, skipping building_unit creation`);
                return null;
            }

            // 2. land_lot_id로 building 조회
            let { data: building, error: buildingError } = await client
                .from('buildings')
                .select('id')
                .eq('land_lot_id', landLotId)
                .limit(1)
                .single();

            if (buildingError && buildingError.code !== 'PGRST116') {
                logger.warn(`building lookup error for land_lot ${landLotId}: ${buildingError.message}`);
            }

            let buildingId: string | null = building?.id || null;

            // building이 없으면 생성
            if (!buildingId) {
                const newBuildingId = uuidv4();
                const { error: createBuildingError } = await client.from('buildings').insert({
                    id: newBuildingId,
                    land_lot_id: landLotId,
                    building_name: buildingName,
                });

                if (createBuildingError) {
                    logger.warn(`building creation failed for land_lot ${landLotId}: ${createBuildingError.message}`);
                    return null;
                }

                buildingId = newBuildingId;
                logger.debug(`Created new building ${buildingId} for land_lot ${landLotId}`);
            }

            // 3. building_id + dong + ho로 building_unit 조회
            let query = client
                .from('building_units')
                .select('id')
                .eq('building_id', buildingId);

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

                    await client
                        .from('building_units')
                        .update(updateData)
                        .eq('id', existingUnit.id);

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

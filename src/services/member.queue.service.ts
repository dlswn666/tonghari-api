import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { supabaseService } from './supabase.service';
import { gisService } from './gis.service';
import {
    MemberJobInfo,
    MemberInviteSyncRequest,
    MemberInviteSyncResult,
    PreRegisterRequest,
    PreRegisterData,
    SyncPropertiesRequest,
    SyncPropertiesResult,
} from '../types/member.types';
import { createLogger } from '../utils/logger';
import { getAutoOwnershipRatio as calculateAutoOwnershipRatio } from './member.pre-register-ownership';
import { buildPreRegisterCompletion } from './member.pre-register-result';

const logger = createLogger('MEMBER-QUEUE');

/**
 * 법인 / 국가기관 의심 이름 패턴.
 * 같은 이름이면 한 entity 로 간주 — 전화/거주지/생년월일이 없어도 매칭.
 * 도시정비법상 같은 토지등소유자(법인 또는 지자체)는 부동산 수만큼 별도 user 로
 * 등록되면 안 되므로, 업로드 시 dedup 룰을 자연인보다 느슨하게 적용한다.
 *
 * 향후 PreRegisterData 에 businessRegistrationNo 가 추가되면 사업자번호를
 * 우선 키로 사용하도록 확장.
 */
const LEGAL_GOV_PATTERNS: RegExp[] = [
    /주식회사/,
    /\(주\)/,
    /유한회사/,
    /합자회사/,
    /^(강북구|성북구|도봉구|노원구|중랑구|동대문구|성동구|광진구|용산구|중구|종로구|서대문구|마포구|은평구|강서구|양천구|구로구|영등포구|동작구|관악구|서초구|강남구|송파구|강동구|금천구)$/,
    /^(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시)$/,
    /^(서울주택도시공사|한국토지주택공사|대한주택공사|국가|대한민국)$/,
    /구청$/,
    /시청$/,
    /도청$/,
    /국토교통부$/,
    /기획재정부$/,
];

function isLegalOrGovEntity(name: string): boolean {
    const trimmed = (name || '').trim();
    if (!trimmed) return false;
    return LEGAL_GOV_PATTERNS.some((re) => re.test(trimmed));
}

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
                    job_type: 'MEMBER_INVITE', // GIS 페이지와 구분하기 위해 명시적으로 설정
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
                    job_type: 'PRE_REGISTER', // GIS 페이지와 구분하기 위해 명시적으로 설정
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
     * property_units 테이블의 pnu, dong, ho를 기반으로
     * building_units와 매칭하여 building_unit_id를 연결합니다.
     */
    async addSyncPropertiesJob(request: SyncPropertiesRequest): Promise<MemberJobInfo> {
        const jobId = uuidv4();

        // pnu가 있고 building_unit_id가 없는 property_units 수를 조회
        const client = supabaseService.getClient();
        const { count, error: countError } = await client
            .from('property_units')
            .select('id', { count: 'exact', head: true })
            .eq('union_id', request.unionId)
            .eq('is_deleted', false)
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
                job_type: 'SYNC_PROPERTIES', // GIS 페이지와 구분하기 위해 명시적으로 설정
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
     * 2단계: DB 저장 (50-100%) - users + property_units/property_ownerships
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
        let propertyLinkCreatedCount = 0;
        let propertyLinkUpdatedCount = 0;
        let propertyLinkFailedCount = 0;

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

        /**
         * 동일인 판별: 이름+거주지(필수) 일치 + 생년월일/전화번호(선택, 양쪽 다 있을 때만 비교)
         */
        const isSamePersonCheck = (a: PreRegisterData, b: PreRegisterData): boolean => {
            if (a.name !== b.name) return false;
            if ((a.residentAddress || '') !== (b.residentAddress || '')) return false;
            if (a.birthDate && b.birthDate && a.birthDate !== b.birthDate) return false;
            if (a.phoneNumber && b.phoneNumber && a.phoneNumber !== b.phoneNumber) return false;
            return true;
        };

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
            // processedCount는 Phase 2에서만 업데이트하여 클라이언트에 정확한 진행률 표시
        }

        logger.info(
            `[Pre-Register ${jobId}] Phase 1 completed - Matched: ${matchedCount}, Unmatched: ${unmatchedCount}, API Skipped: ${apiSkippedCount}`
        );

        // ========================================
        // 2단계: 동일인 그룹핑 + DB 저장 (0-100%)
        // 이름+거주지(필수) + 생년월일+전화번호(선택) 기준으로 동일인 판별
        // 1 user + N property_units 구조로 저장 (다물건자 자연 표현)
        //
        // ★ 동일인 판별 룰 (2026-05 개편):
        //   1) 업로드 배치 내부 그룹핑: groupByPerson()
        //   2) 같은 union 의 기존 active user 와 글로벌 매칭:
        //      - 자연인: (이름+거주지) OR (이름+전화) 일치
        //      - 법인:   (이름+거주지) 일치 (사업자번호 컬럼 추가 시 우선)
        //      - 매칭 시 user 재사용, property_ownerships 만 추가 → 1 user = N property
        //      - 미매칭 시 새 user 생성
        // ========================================
        logger.info(`[Pre-Register ${jobId}] Phase 2: Grouping + DB Insert`);

        // 동일인 그룹핑 (배치 내부)
        const personGroups = this.groupByPerson(matchedMembers);
        logger.info(`[Pre-Register ${jobId}] Grouped ${matchedMembers.length} rows into ${personGroups.length} persons`);

        const getPropertyKey = (member: MatchedMember): string => {
            const normalizedDong = this.normalizeDong(member.row.dong);
            const normalizedHo = this.normalizeHo(member.row.ho);
            return [
                member.pnu || member.row.propertyAddress || '',
                normalizedDong || '',
                normalizedHo || '',
            ].join('|');
        };

        const propertyOwnerCountByKey = new Map<string, number>();
        for (const group of personGroups) {
            const groupPropertyKeys = new Set<string>();
            for (const member of group) {
                groupPropertyKeys.add(getPropertyKey(member));
            }
            for (const propertyKey of groupPropertyKeys) {
                propertyOwnerCountByKey.set(propertyKey, (propertyOwnerCountByKey.get(propertyKey) || 0) + 1);
            }
        }

        const getBatchOwnerCount = (member: MatchedMember): number => {
            return propertyOwnerCountByKey.get(getPropertyKey(member)) || 1;
        };

        const getAutoOwnershipRatio = (member: MatchedMember): number => {
            return calculateAutoOwnershipRatio(getBatchOwnerCount(member));
        };

        // 글로벌 매칭용: union 의 기존 active user 캐시 로드
        const { data: existingUsersData } = await client
            .from('users')
            .select('id, name, phone_number, birth_date, resident_address')
            .eq('union_id', request.unionId)
            .in('user_status', ['APPROVED', 'PRE_REGISTERED']);

        interface ExistingUser {
            id: string;
            name: string;
            phone_number: string | null;
            birth_date: string | null;
            resident_address: string | null;
        }

        const existingUsers: ExistingUser[] = (existingUsersData || []) as ExistingUser[];

        const normalizeName = (n?: string | null) => (n || '').replace(/\s+/g, '').trim();
        const normalizeAddr = (a?: string | null) => (a || '').replace(/\s+/g, ' ').trim();
        const normalizePhone = (p?: string | null) => (p || '').replace(/[^0-9]/g, '');

        // 이름 기반 인덱스 (소문자/공백 제거)
        const byName = new Map<string, ExistingUser[]>();
        for (const u of existingUsers) {
            const key = normalizeName(u.name);
            if (!key) continue;
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key)!.push(u);
        }

        const findExistingPerson = (
            name: string,
            addr: string | null,
            phone: string | null,
            birth: string | null
        ): ExistingUser | null => {
            const key = normalizeName(name);
            const candidates = byName.get(key);
            if (!candidates || candidates.length === 0) return null;
            const nAddr = normalizeAddr(addr);
            const nPhone = normalizePhone(phone);
            // 법인/국가기관: 같은 이름이면 동일 entity 로 매칭 (전화/거주지 없어도 OK).
            // 부동산 수만큼 user 가 중복 생성되는 것을 방지.
            // (향후 사업자번호 컬럼이 추가되면 그것을 우선 키로 사용)
            if (isLegalOrGovEntity(name)) {
                return candidates[0];
            }
            for (const u of candidates) {
                const cAddr = normalizeAddr(u.resident_address);
                const cPhone = normalizePhone(u.phone_number);
                // 자연인 충돌 회피: 생년월일 양쪽 다 있고 다르면 다른 사람
                if (birth && u.birth_date && birth !== u.birth_date) continue;
                // 전화번호 양쪽 다 있고 다르면 다른 사람
                if (nPhone && cPhone && nPhone !== cPhone) continue;
                // 일치 조건: 거주지 일치(8자 초과) 또는 전화 일치
                const addrMatch = !!nAddr && !!cAddr && nAddr === cAddr && nAddr.length > 8;
                const phoneMatch = !!nPhone && nPhone === cPhone;
                if (addrMatch || phoneMatch) return u;
            }
            return null;
        };

        let processedRowCount = 0;

        for (const group of personGroups) {
            try {
                // 그룹 내 최선의 개인정보 취합 (null이 아닌 값 우선)
                const firstRow = group[0].row;
                const bestPhone = group.find((m) => m.row.phoneNumber)?.row.phoneNumber || null;
                const bestBirthDate = group.find((m) => m.row.birthDate)?.row.birthDate || null;
                const bestResidentAddress = group.find((m) => m.row.residentAddress)?.row.residentAddress || null;
                const bestNotes = group.find((m) => m.row.notes)?.row.notes || null;

                // ★ 글로벌 동일인 검색 (union 내 기존 user)
                const existingPerson = findExistingPerson(
                    firstRow.name,
                    bestResidentAddress,
                    bestPhone,
                    bestBirthDate
                );

                let userId: string = '';
                let isReusedUser = false;

                if (existingPerson) {
                    // 동일인 발견 → 기존 user 재사용 (다물건자 추가 property)
                    userId = existingPerson.id;
                    isReusedUser = true;

                    // 누락된 개인정보가 있으면 채우기
                    const updates: Record<string, unknown> = {};
                    if (!existingPerson.phone_number && bestPhone) updates.phone_number = bestPhone;
                    if (!existingPerson.birth_date && bestBirthDate) updates.birth_date = bestBirthDate;
                    if (!existingPerson.resident_address && bestResidentAddress) updates.resident_address = bestResidentAddress;
                    if (Object.keys(updates).length > 0) {
                        await client.from('users').update(updates).eq('id', userId);
                    }
                    duplicateCount++;
                    logger.debug(
                        `[Pre-Register ${jobId}] Reused existing user ${userId} for ${firstRow.name} (다물건자)`
                    );
                }

                // 그룹 내 각 물건지별 PNU 중복 체크 → 통과한 것만 저장
                const validMembers: MatchedMember[] = [];

                if (!isReusedUser) {
                    // 새 user 경로는 PNU 중복 체크 불필요 (다른 user 의 PNU 와 충돌 가능성 낮음)
                    validMembers.push(...group);
                } else {
                    // 재사용 user 경로: 같은 user 의 동일 PNU+동/호 중복 회피
                    for (const member of group) {
                        if (!member.pnu) {
                            validMembers.push(member);
                            continue;
                        }
                        const normalizedDong = this.normalizeDong(member.row.dong);
                        const normalizedHo = this.normalizeHo(member.row.ho);
                        let existingOwnershipQuery = client
                            .from('property_ownerships')
                            .select('id, property_unit_id, property_units!inner(id, pnu, dong, ho)')
                            .eq('user_id', userId)
                            .eq('union_id', request.unionId)
                            .eq('is_active', true)
                            .eq('property_units.pnu', member.pnu)
                            .eq('property_units.is_deleted', false);

                        existingOwnershipQuery = normalizedDong
                            ? existingOwnershipQuery.eq('property_units.dong', normalizedDong)
                            : existingOwnershipQuery.is('property_units.dong', null);
                        existingOwnershipQuery = normalizedHo
                            ? existingOwnershipQuery.eq('property_units.ho', normalizedHo)
                            : existingOwnershipQuery.is('property_units.ho', null);

                        const { data: existingOwnership } = await existingOwnershipQuery
                            .limit(1)
                            .maybeSingle();
                        if (existingOwnership) {
                            // 이미 같은 user 가 이 호수 보유 → 정보만 업데이트
                            const landOwnershipRatio = this.sanitizeNumeric(member.row.landOwnershipRatio);
                            const buildingOwnershipRatio = this.sanitizeNumeric(member.row.buildingOwnershipRatio);
                            const batchOwnerCount = getBatchOwnerCount(member);
                            const effectiveRatio =
                                landOwnershipRatio || buildingOwnershipRatio || getAutoOwnershipRatio(member);
                            const effectiveLandRatio = landOwnershipRatio || effectiveRatio;
                            const effectiveBuildingRatio = buildingOwnershipRatio || effectiveRatio;

                            const propertyUnitUpdates: Record<string, unknown> = {
                                updated_at: new Date().toISOString(),
                            };
                            if (member.row.propertyAddress) {
                                propertyUnitUpdates.property_address_jibun = member.row.propertyAddress;
                            }
                            if (member.row.propertyAddressRoad) {
                                propertyUnitUpdates.property_address_road = member.row.propertyAddressRoad;
                            }
                            if (member.row.buildingName) {
                                propertyUnitUpdates.building_name = member.row.buildingName;
                            }
                            const landArea = this.sanitizeNumeric(member.row.landArea);
                            const buildingArea = this.sanitizeNumeric(member.row.buildingArea);
                            if (landArea !== null) propertyUnitUpdates.land_area = landArea;
                            if (buildingArea !== null) propertyUnitUpdates.building_area = buildingArea;

                            if (Object.keys(propertyUnitUpdates).length > 1) {
                                const { error: propertyUpdateError } = await client
                                    .from('property_units')
                                    .update(propertyUnitUpdates)
                                    .eq('id', existingOwnership.property_unit_id);
                                if (propertyUpdateError) {
                                    propertyLinkFailedCount++;
                                    errors.push(
                                        `${member.row.name}: property_units update failed (${member.row.propertyAddress || member.pnu || '주소 없음'}) - ${propertyUpdateError.message}`
                                    );
                                    logger.warn(
                                        `[Pre-Register ${jobId}] property_units update failed for ${member.row.name}: ${propertyUpdateError.message}`
                                    );
                                    continue;
                                }
                            }

                            const ownershipUpdates: Record<string, unknown> = {
                                land_ownership_ratio: effectiveLandRatio,
                                building_ownership_ratio: effectiveBuildingRatio,
                                ownership_ratio: effectiveRatio,
                                ownership_type:
                                    member.row.ownershipType ||
                                    (batchOwnerCount > 1 || effectiveRatio < 100 ? 'CO_OWNER' : 'OWNER'),
                                updated_at: new Date().toISOString(),
                            };
                            if (member.row.notes) {
                                ownershipUpdates.notes = member.row.notes;
                            }

                            const { error: ownershipUpdateError } = await client
                                .from('property_ownerships')
                                .update(ownershipUpdates)
                                .eq('id', existingOwnership.id);
                            if (ownershipUpdateError) {
                                propertyLinkFailedCount++;
                                errors.push(
                                    `${member.row.name}: property_ownerships update failed (${member.row.propertyAddress || member.pnu || '주소 없음'}) - ${ownershipUpdateError.message}`
                                );
                                logger.warn(
                                    `[Pre-Register ${jobId}] property_ownerships update failed for ${member.row.name}: ${ownershipUpdateError.message}`
                                );
                                continue;
                            }
                            propertyLinkUpdatedCount++;
                            updatedCount++;
                        } else {
                            validMembers.push(member);
                        }
                    }
                }

                processedRowCount += group.length;

                if (validMembers.length === 0) {
                    // 진행률 업데이트
                    const progress = Math.round((processedRowCount / totalCount) * 100);
                    this.updateJobStatus(jobId, { processedCount: processedRowCount });
                    if (progress % 5 === 0 || processedRowCount === totalCount) {
                        await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress, undefined, {
                            job_type: 'PRE_REGISTER', phase: 'SAVING',
                            matchedCount, unmatchedCount, savedCount, updatedCount, duplicateCount, totalCount,
                            propertyLinkCreatedCount,
                            propertyLinkUpdatedCount,
                            propertyLinkFailedCount,
                        });
                    }
                    continue;
                }

                // 신규 user 생성 (재사용 아닌 경우만)
                if (!isReusedUser) {
                    userId = uuidv4();

                    const { error: userError } = await client.from('users').insert({
                        id: userId,
                        name: firstRow.name,
                        phone_number: bestPhone,
                        birth_date: bestBirthDate,
                        email: null,
                        role: 'USER',
                        union_id: request.unionId,
                        user_status: 'PRE_REGISTERED',
                        resident_address: bestResidentAddress,
                        notes: bestNotes,
                    });

                    if (userError) {
                        errors.push(`${firstRow.name}: ${userError.message}`);
                        const progress = Math.round((processedRowCount / totalCount) * 100);
                        this.updateJobStatus(jobId, { processedCount: processedRowCount });
                        if (progress % 5 === 0 || processedRowCount === totalCount) {
                            await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress, undefined, {
                                job_type: 'PRE_REGISTER', phase: 'SAVING',
                                matchedCount, unmatchedCount, savedCount, updatedCount, duplicateCount, totalCount,
                                propertyLinkCreatedCount,
                                propertyLinkUpdatedCount,
                                propertyLinkFailedCount,
                            });
                        }
                        continue;
                    }

                    // 캐시에 추가 → 같은 배치 내 후속 그룹이 동일인이면 재사용됨
                    const newUser: ExistingUser = {
                        id: userId,
                        name: firstRow.name,
                        phone_number: bestPhone,
                        birth_date: bestBirthDate,
                        resident_address: bestResidentAddress,
                    };
                    existingUsers.push(newUser);
                    const k = normalizeName(firstRow.name);
                    if (!byName.has(k)) byName.set(k, []);
                    byName.get(k)!.push(newUser);
                }

                // N property_units 생성 (첫 번째만 is_primary)
                // 같은 업로드 행이 중복되어도 동일 user-property 연결은 한 번만 만든다.
                const uniqueMembers: MatchedMember[] = [];
                const seenMemberProperties = new Set<string>();
                for (const member of validMembers) {
                    const normalizedDong = this.normalizeDong(member.row.dong);
                    const normalizedHo = this.normalizeHo(member.row.ho);
                    const propertyKey = [
                        member.pnu || member.row.propertyAddress || '',
                        normalizedDong || '',
                        normalizedHo || '',
                    ].join('|');
                    if (seenMemberProperties.has(propertyKey)) continue;
                    seenMemberProperties.add(propertyKey);
                    uniqueMembers.push(member);
                }

                for (let pi = 0; pi < uniqueMembers.length; pi++) {
                    const member = uniqueMembers[pi];
                    try {
                        const normalizedDong = this.normalizeDong(member.row.dong);
                        const normalizedHo = this.normalizeHo(member.row.ho);

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

                        const landArea = this.sanitizeNumeric(member.row.landArea);
                        const landOwnershipRatio = this.sanitizeNumeric(member.row.landOwnershipRatio);
                        const buildingArea = this.sanitizeNumeric(member.row.buildingArea);
                        const buildingOwnershipRatio = this.sanitizeNumeric(member.row.buildingOwnershipRatio);

                        const batchOwnerCount = getBatchOwnerCount(member);
                        const effectiveRatio = landOwnershipRatio || buildingOwnershipRatio || getAutoOwnershipRatio(member);
                        const effectiveLandRatio = landOwnershipRatio || effectiveRatio;
                        const effectiveBuildingRatio = buildingOwnershipRatio || effectiveRatio;
                        let ownershipType: 'OWNER' | 'CO_OWNER' | 'FAMILY' = 'OWNER';
                        if (member.row.ownershipType) {
                            ownershipType = member.row.ownershipType;
                        } else if (batchOwnerCount > 1 || effectiveRatio < 100) {
                            ownershipType = 'CO_OWNER';
                        }

                        // 합필 PNU 해소: land_lots에 없는 PNU를 합필된 대표 PNU로 변환
                        let finalPnu = member.pnu || null;
                        let previousPnu: string | null = null;
                        if (finalPnu) {
                            const resolved = await this.resolveMergedPnu(client, request.unionId, finalPnu, member.row.propertyAddress);
                            if (resolved.merged) {
                                previousPnu = finalPnu;
                                finalPnu = resolved.resolvedPnu;
                            }
                        }

                        const propertyUnitId = await this.findOrCreatePropertyUnit(
                            client,
                            request.unionId,
                            {
                                pnu: finalPnu,
                                previousPnu,
                                buildingUnitId,
                                propertyAddressJibun: member.row.propertyAddress || null,
                                propertyAddressRoad: member.row.propertyAddressRoad || null,
                                buildingName: member.row.buildingName || null,
                                dong: normalizedDong,
                                ho: normalizedHo,
                                landArea,
                                buildingArea,
                                officialPrice: this.sanitizeNumeric(member.row.officialPrice),
                                notes: member.row.notes || null,
                            }
                        );

                        const { error: ownershipError } = await client.from('property_ownerships').insert({
                            id: uuidv4(),
                            property_unit_id: propertyUnitId,
                            user_id: userId,
                            union_id: request.unionId,
                            ownership_type: ownershipType,
                            ownership_ratio: effectiveRatio,
                            land_ownership_ratio: effectiveLandRatio,
                            building_ownership_ratio: effectiveBuildingRatio,
                            is_primary: pi === 0,
                            is_active: true,
                            notes: member.row.notes || 'member.queue.service: 사전등록 업로드',
                        });

                        if (ownershipError) {
                            propertyLinkFailedCount++;
                            errors.push(
                                `${member.row.name}: property_ownerships insert failed (${member.row.propertyAddress || member.pnu || '주소 없음'}) - ${ownershipError.message}`
                            );
                            logger.warn(
                                `[Pre-Register ${jobId}] property_ownerships insert failed for ${member.row.name}: ${ownershipError.message}`
                            );
                        } else {
                            propertyLinkCreatedCount++;
                            logger.debug(
                                `[Pre-Register ${jobId}] property_ownerships created for ${member.row.name} (pnu=${member.pnu}, dong=${normalizedDong}, ho=${normalizedHo})`
                            );
                        }
                    } catch (propErr: any) {
                        propertyLinkFailedCount++;
                        errors.push(
                            `${member.row.name}: property relation failed (${member.row.propertyAddress || member.pnu || '주소 없음'}) - ${propErr.message || 'Unknown error'}`
                        );
                        logger.warn(
                            `[Pre-Register ${jobId}] property ownership creation failed for ${member.row.name}: ${propErr.message}`
                        );
                    }
                }

                savedCount++;
            } catch (err: any) {
                errors.push(`${group[0].row.name}: ${err.message || 'Unknown error'}`);
                processedRowCount += group.length;
            }

            // 진행률 업데이트 (0-100%) - DB Insert 완료 시점에만 반영
            const progress = Math.round((processedRowCount / totalCount) * 100);

            // 인메모리 상태 업데이트 (클라이언트 폴링용)
            this.updateJobStatus(jobId, { processedCount: processedRowCount });

            // 5% 단위로 DB 업데이트
            if (progress % 5 === 0 || processedRowCount === totalCount) {
                const previewData = {
                    job_type: 'PRE_REGISTER',
                    phase: 'SAVING',
                    matchedCount,
                    unmatchedCount,
                    savedCount,
                    updatedCount,
                    duplicateCount,
                    propertyLinkCreatedCount,
                    propertyLinkUpdatedCount,
                    propertyLinkFailedCount,
                    totalCount,
                };
                await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress, undefined, previewData);
            }
        }

        const completion = buildPreRegisterCompletion({
            totalCount,
            matchedCount,
            unmatchedCount,
            savedCount,
            updatedCount,
            duplicateCount,
            propertyLinkCreatedCount,
            propertyLinkUpdatedCount,
            propertyLinkFailedCount,
            errors,
        });
        const { finalStatus, result } = completion;

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

        const errorLog = result.errors.length > 0 ? JSON.stringify({ errors: result.errors }) : undefined;

        await supabaseService.updateSyncJobStatus(
            jobId,
            completion.persistedStatus,
            100,
            errorLog,
            previewData
        );

        logger.info(
            `[Pre-Register ${jobId}] Completed - Matched: ${matchedCount}, Saved: ${savedCount}, Updated: ${updatedCount}, Duplicates: ${duplicateCount}, PropertyLinks: ${propertyLinkCreatedCount + propertyLinkUpdatedCount}, PropertyLinkFailed: ${propertyLinkFailedCount}, Errors: ${errors.length}, Total: ${totalCount}`
        );
    }

    /**
     * 동일인 그룹핑: 이름+거주지(필수) + 생년월일+전화번호(선택) 기준
     * 같은 이름+거주지 그룹 내에서 생년월일/전화번호가 충돌하면 별도 그룹으로 분리
     */
    private groupByPerson<T extends { row: PreRegisterData }>(members: T[]): T[][] {
        // 1차: 이름+거주지로 그룹핑
        const baseGroups = new Map<string, T[]>();
        for (const m of members) {
            const baseKey = `${m.row.name}||${m.row.residentAddress || ''}`;
            if (!baseGroups.has(baseKey)) baseGroups.set(baseKey, []);
            baseGroups.get(baseKey)!.push(m);
        }

        // 2차: 같은 이름+거주지 그룹 내에서 생년월일/전화번호 충돌 시 분리
        const finalGroups: T[][] = [];
        for (const group of baseGroups.values()) {
            if (group.length === 1) {
                finalGroups.push(group);
                continue;
            }
            const subGroups: T[][] = [];
            for (const m of group) {
                const matched = subGroups.find((sg) => {
                    const a = m.row;
                    const b = sg[0].row;
                    if (a.birthDate && b.birthDate && a.birthDate !== b.birthDate) return false;
                    if (a.phoneNumber && b.phoneNumber && a.phoneNumber !== b.phoneNumber) return false;
                    return true;
                });
                if (matched) {
                    matched.push(m);
                } else {
                    subGroups.push([m]);
                }
            }
            finalGroups.push(...subGroups);
        }
        return finalGroups;
    }

    /**
     * 합필 PNU 해소: property_unit의 PNU가 land_lots에 없으면
     * 합필된 대표 필지의 PNU를 찾아서 반환한다.
     * 예: 836-77(폐지) → land_lots에 "836-75, 836-77, 836-78, 836-79" → 836-75의 PNU 반환
     */
    private async resolveMergedPnu(
        client: ReturnType<typeof supabaseService.getClient>,
        unionId: string,
        pnu: string,
        propertyAddress: string
    ): Promise<{ resolvedPnu: string; merged: boolean }> {
        // 1. PNU가 이 조합의 land_lots에 있는지 확인
        const { data: existing } = await client
            .from('land_lots')
            .select('pnu')
            .eq('pnu', pnu)
            .eq('union_id', unionId)
            .limit(1);

        if (existing && existing.length > 0) {
            return { resolvedPnu: pnu, merged: false };
        }

        // 2. 주소에서 지번 추출 (예: "서울특별시 강북구 미아동 836-77" → "836-77")
        const jibunMatch = propertyAddress.match(/(\d+(-\d+)?)\s*$/);
        if (!jibunMatch) return { resolvedPnu: pnu, merged: false };

        const jibun = jibunMatch[1];

        // 3. land_lots.address에서 이 지번을 포함하는 합필 필지 검색
        const { data: candidates } = await client
            .from('land_lots')
            .select('pnu, address')
            .eq('union_id', unionId)
            .ilike('address', `%${jibun}%`);

        if (!candidates || candidates.length === 0) {
            return { resolvedPnu: pnu, merged: false };
        }

        // 4. 정확한 지번 매칭 (836-77이 836-770을 오매칭하지 않도록)
        for (const candidate of candidates) {
            const addressJibuns = candidate.address
                .replace(/.*[동리가]\s*/, '') // 법정동 이후만
                .split(/[,\s]+/)
                .map((j: string) => j.trim())
                .filter((j: string) => j);
            if (addressJibuns.includes(jibun)) {
                logger.info(`[PNU-Merge] ${pnu} (${jibun}) → ${candidate.pnu} (합필 필지: ${candidate.address})`);
                return { resolvedPnu: candidate.pnu, merged: true };
            }
        }

        return { resolvedPnu: pnu, merged: false };
    }

    private async findOrCreatePropertyUnit(
        client: ReturnType<typeof supabaseService.getClient>,
        unionId: string,
        input: {
            pnu: string | null;
            previousPnu: string | null;
            buildingUnitId: string | null;
            propertyAddressJibun: string | null;
            propertyAddressRoad: string | null;
            buildingName: string | null;
            dong: string | null;
            ho: string | null;
            landArea: number | null;
            buildingArea: number | null;
            officialPrice: number | null;
            notes: string | null;
        }
    ): Promise<string> {
        let query = client
            .from('property_units')
            .select('id')
            .eq('union_id', unionId)
            .eq('is_deleted', false);

        query = input.pnu ? query.eq('pnu', input.pnu) : query.is('pnu', null);
        query = input.buildingUnitId
            ? query.eq('building_unit_id', input.buildingUnitId)
            : query.is('building_unit_id', null);
        query = input.dong ? query.eq('dong', input.dong) : query.is('dong', null);
        query = input.ho ? query.eq('ho', input.ho) : query.is('ho', null);

        const { data: existingUnit, error: existingError } = await query.limit(1).maybeSingle();
        if (existingError) {
            throw new Error(`property_units lookup failed: ${existingError.message}`);
        }
        if (existingUnit?.id) {
            const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
            if (input.previousPnu) updateData.previous_pnu = input.previousPnu;
            if (input.propertyAddressJibun) updateData.property_address_jibun = input.propertyAddressJibun;
            if (input.propertyAddressRoad) updateData.property_address_road = input.propertyAddressRoad;
            if (input.buildingName) updateData.building_name = input.buildingName;
            if (input.landArea !== null) updateData.land_area = input.landArea;
            if (input.buildingArea !== null) updateData.building_area = input.buildingArea;
            if (input.officialPrice !== null) updateData.official_price = input.officialPrice;
            if (input.notes) updateData.notes = input.notes;

            if (Object.keys(updateData).length > 1) {
                const { error: updateError } = await client
                    .from('property_units')
                    .update(updateData)
                    .eq('id', existingUnit.id);
                if (updateError) {
                    throw new Error(`property_units update failed: ${updateError.message}`);
                }
            }

            return existingUnit.id;
        }

        const newUnitId = uuidv4();
        const { error: insertError } = await client.from('property_units').insert({
            id: newUnitId,
            union_id: unionId,
            pnu: input.pnu,
            previous_pnu: input.previousPnu,
            building_unit_id: input.buildingUnitId,
            property_address_jibun: input.propertyAddressJibun,
            property_address_road: input.propertyAddressRoad,
            building_name: input.buildingName,
            dong: input.dong,
            ho: input.ho,
            land_area: input.landArea,
            building_area: input.buildingArea,
            official_price: input.officialPrice,
            is_deleted: false,
            notes: input.notes || 'member.queue.service: 사전등록 업로드',
        });

        if (insertError) {
            throw new Error(`property_units insert failed: ${insertError.message}`);
        }

        return newUnitId;
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
     * property_ownerships/property_units 기준으로 pnu, dong, ho를 체크
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
        existingPhoneNumber?: string;  // BUG-012: 전화번호 추가
        existingPropertyUnitId?: string;
    }> {
        try {
            let query = client
                .from('property_ownerships')
                .select('id, user_id, property_unit_id, property_units!inner(pnu, dong, ho)')
                .eq('union_id', unionId)
                .eq('is_active', true)
                .eq('property_units.pnu', pnu)
                .eq('property_units.is_deleted', false);

            if (dong) {
                query = query.eq('property_units.dong', dong);
            } else {
                query = query.is('property_units.dong', null);
            }

            if (ho) {
                query = query.eq('property_units.ho', ho);
            } else {
                query = query.is('property_units.ho', null);
            }

            const { data: ownerships } = await query;

            if (!ownerships || ownerships.length === 0) {
                return { isDuplicate: false };
            }

            // 연결된 사용자 중 해당 조합의 사용자 찾기
            const userIds = ownerships.map((ownership: any) => ownership.user_id);
            const { data: users } = await client
                .from('users')
                .select('id, name, phone_number')  // BUG-012: 전화번호 추가
                .eq('union_id', unionId)
                .in('id', userIds)
                .limit(1);

            if (users && users.length > 0) {
                // 해당 사용자의 property_unit 찾기
                const matchingOwnership = ownerships.find((ownership: any) => ownership.user_id === users[0].id);
                return {
                    isDuplicate: true,
                    existingUserId: users[0].id,
                    existingUserName: users[0].name,
                    existingPhoneNumber: users[0].phone_number,  // BUG-012: 전화번호 추가
                    existingPropertyUnitId: matchingOwnership?.property_unit_id,
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
     * property_units 테이블의 pnu, dong, ho를 기반으로
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
            // 해당 조합의 pnu가 있고 building_unit_id가 없는 property_units 조회
            const { data: propertyUnits, error: propUnitsError } = await client
                .from('property_units')
                .select(
                    `
                    id, pnu, dong, ho, building_name, property_address_jibun,
                    land_area, building_area
                `
                )
                .eq('union_id', unionId)
                .eq('is_deleted', false)
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
                const label = propUnit.property_address_jibun || propUnit.pnu || propUnit.id;

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
                        errors.push(`${label}: GIS 데이터가 없어 매칭 불가 (PNU: ${propUnit.pnu})`);
                        continue;
                    }

                    // property_units에 building_unit_id 연결
                    const { error: updateError } = await client
                        .from('property_units')
                        .update({ building_unit_id: buildingUnitId })
                        .eq('id', propUnit.id);

                    if (updateError) {
                        failedCount++;
                        errors.push(`${label}: 연결 저장 실패 - ${updateError.message}`);
                        continue;
                    }

                    syncedCount++;
                    logger.debug(`[Sync Properties ${jobId}] Synced ${label} to building_unit ${buildingUnitId}`);
                } catch (err: any) {
                    failedCount++;
                    errors.push(`${label}: ${err.message || 'Unknown error'}`);
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

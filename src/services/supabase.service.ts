import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { AlimtalkLogInput, AlimtalkTemplate, PricingMap } from '../types/alimtalk.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('SUPABASE');

/**
 * Supabase 서비스
 * - Vault에서 Sender Key 조회
 * - 알림톡 로그 저장
 * - 템플릿 동기화
 * - 단가 조회
 */
class SupabaseService {
    private client: SupabaseClient;

    constructor() {
        this.client = createClient(
            env.SUPABASE_URL,
            env.SUPABASE_SERVICE_ROLE_KEY
        );
    }

    /**
     * Vault에서 조합별 Sender Key 조회
     */
    async getUnionSenderKey(unionId: string): Promise<string | null> {
        try {
            const { data, error } = await this.client
                .from('decrypted_secrets')
                .select('decrypted_secret')
                .eq('name', `union_${unionId}_sender_key`)
                .single();

            if (error || !data) {
                return null;
            }

            return data.decrypted_secret;
        } catch (error) {
            logger.error(`Vault lookup error (unionId: ${unionId})`, error);
            return null;
        }
    }

    /**
     * 기본 Sender Key 조회 (조합온)
     */
    async getDefaultSenderKey(): Promise<string> {
        try {
            const { data, error } = await this.client
                .from('decrypted_secrets')
                .select('decrypted_secret')
                .eq('name', 'JOHAPON_DEFAULT_SENDER_KEY')
                .single();

            if (error || !data) {
                // Vault에서 조회 실패 시 환경 변수 사용
                logger.warn('Failed to fetch default Sender Key from Vault, using environment variable');
                return env.DEFAULT_SENDER_KEY;
            }

            return data.decrypted_secret;
        } catch (error) {
            logger.error('Error fetching default Sender Key', error);
            return env.DEFAULT_SENDER_KEY;
        }
    }

    /**
     * 조합의 채널명 조회
     */
    async getUnionChannelName(unionId: string): Promise<string> {
        try {
            const { data, error } = await this.client
                .from('unions')
                .select('kakao_channel_id')
                .eq('id', unionId)
                .single();

            if (error || !data || !data.kakao_channel_id) {
                return env.DEFAULT_CHANNEL_NAME;
            }

            return data.kakao_channel_id;
        } catch (error) {
            logger.error(`Error fetching union channel name (unionId: ${unionId})`, error);
            return env.DEFAULT_CHANNEL_NAME;
        }
    }

    /**
     * 알림톡 로그 저장
     */
    async saveAlimtalkLog(log: AlimtalkLogInput): Promise<string> {
        const { data, error } = await this.client
            .from('alimtalk_logs')
            .insert({
                union_id: log.union_id,
                sender_id: log.sender_id,
                template_code: log.template_code,
                template_name: log.template_name,
                title: log.title,
                content: log.content,
                notice_id: log.notice_id,
                sender_channel_name: log.sender_channel_name,
                recipient_count: log.total_count,
                kakao_success_count: log.kakao_success_count,
                sms_success_count: log.sms_success_count,
                fail_count: log.fail_count,
                estimated_cost: log.estimated_cost,
                recipient_details: log.recipient_details,
                aligo_response: log.aligo_response,
                sent_at: new Date().toISOString(),
            })
            .select('id')
            .single();

        if (error) {
            logger.error('Failed to save alimtalk log', error);
            throw new Error('Failed to save alimtalk log.');
        }

        return data.id;
    }

    /**
     * 템플릿 UPSERT (알리고 API 응답 구조 그대로 저장)
     */
    async upsertTemplates(templates: AlimtalkTemplate[]): Promise<{ inserted: number; updated: number }> {
        let inserted = 0;
        let updated = 0;

        for (const template of templates) {
            // 기존 템플릿 확인
            const { data: existing } = await this.client
                .from('alimtalk_templates')
                .select('id')
                .eq('template_code', template.template_code)
                .single();

            // 공통 데이터 구성 (알리고 API 응답 구조 그대로 저장)
            const templateData = {
                template_name: template.template_name,
                template_content: template.template_content,
                status: template.status,
                insp_status: template.insp_status,
                buttons: template.buttons,
                synced_at: new Date().toISOString(),
                // 추가된 필드 (알리고 API 응답 구조)
                sender_key: template.sender_key,
                template_type: template.template_type,
                template_em_type: template.template_em_type,
                template_title: template.template_title,
                template_subtitle: template.template_subtitle,
                template_image_name: template.template_image_name,
                template_image_url: template.template_image_url,
                cdate: template.cdate ? new Date(template.cdate).toISOString() : null,
                comments: template.comments,
            };

            if (existing) {
                // UPDATE
                await this.client
                    .from('alimtalk_templates')
                    .update(templateData)
                    .eq('template_code', template.template_code);
                updated++;
            } else {
                // INSERT
                await this.client
                    .from('alimtalk_templates')
                    .insert({
                        template_code: template.template_code,
                        ...templateData,
                    });
                inserted++;
            }
        }

        return { inserted, updated };
    }

    /**
     * 알리고에 없는 템플릿 삭제
     */
    async deleteOldTemplates(currentCodes: string[]): Promise<number> {
        if (currentCodes.length === 0) {
            // 모든 템플릿 삭제
            const { data } = await this.client
                .from('alimtalk_templates')
                .delete()
                .neq('template_code', '')
                .select('id');
            
            return data?.length || 0;
        }

        const { data, error } = await this.client
            .from('alimtalk_templates')
            .delete()
            .not('template_code', 'in', `(${currentCodes.map(c => `"${c}"`).join(',')})`)
            .select('id');

        if (error) {
            logger.error('Template deletion error', error);
            return 0;
        }

        return data?.length || 0;
    }

    /**
     * 템플릿 코드로 템플릿 조회
     * 알림톡 발송 시 DB에서 템플릿 정보를 조회하여 사용
     */
    async getTemplateByCode(templateCode: string): Promise<AlimtalkTemplate | null> {
        try {
            const { data, error } = await this.client
                .from('alimtalk_templates')
                .select('*')
                .eq('template_code', templateCode)
                .single();

            if (error || !data) {
                logger.error(`Template fetch failed: ${templateCode}`, error);
                return null;
            }

            return data as AlimtalkTemplate;
        } catch (error) {
            logger.error(`Template fetch error (${templateCode})`, error);
            return null;
        }
    }

    /**
     * 현재 단가 조회
     */
    async getCurrentPricing(): Promise<PricingMap> {
        const { data, error } = await this.client.rpc('get_current_pricing');

        if (error || !data) {
            logger.warn('Pricing fetch failed, using default values');
            return {
                KAKAO: 15,
                SMS: 20,
                LMS: 50,
            };
        }

        const pricing: PricingMap = {
            KAKAO: 15,
            SMS: 20,
            LMS: 50,
        };

        for (const item of data) {
            if (item.message_type === 'KAKAO') pricing.KAKAO = item.unit_price;
            if (item.message_type === 'SMS') pricing.SMS = item.unit_price;
            if (item.message_type === 'LMS') pricing.LMS = item.unit_price;
        }

        return pricing;
    }

    // ============================================
    // GIS 관련 메서드
    // ============================================

    /**
     * 필지 정보 UPSERT (land_lots 테이블)
     */
    async upsertLandLot(landLot: {
        pnu: string;
        address: string;
        union_id: string;
        area?: number;
        official_price?: number;
        boundary?: any;
        owner_count?: number;
        land_category?: string;
        road_address?: string;
    }): Promise<boolean> {
        try {
            const { error } = await this.client
                .from('land_lots')
                .upsert({
                    pnu: landLot.pnu,
                    address: landLot.address,
                    union_id: landLot.union_id,
                    area: landLot.area,
                    official_price: landLot.official_price,
                    boundary: landLot.boundary,
                    owner_count: landLot.owner_count ?? 0,
                    land_category: landLot.land_category,
                    road_address: landLot.road_address,
                    updated_at: new Date().toISOString(),
                }, {
                    onConflict: 'pnu',
                });

            if (error) {
                logger.error(`land_lots upsert failed (PNU: ${landLot.pnu})`, error);
                return false;
            }

            logger.debug(`land_lots upserted: ${landLot.pnu} (owner_count: ${landLot.owner_count ?? 0}, land_category: ${landLot.land_category || 'N/A'})`);
            return true;
        } catch (error) {
            logger.error(`land_lots upsert error (PNU: ${landLot.pnu})`, error);
            return false;
        }
    }

    /**
     * 조합-필지 관계 생성 (deprecated - land_lots.union_id로 대체됨)
     * land_lots 테이블에 union_id가 직접 저장되므로 별도 매핑 테이블 불필요
     */
    async createUnionLandLot(unionId: string, pnu: string, addressText?: string): Promise<boolean> {
        // land_lots.union_id로 관계가 관리되므로 별도 처리 불필요
        logger.debug(`createUnionLandLot skipped (using land_lots.union_id): ${unionId} - ${pnu}`);
        return true;
    }

    // ============================================
    // 건물/세대 정보 저장
    // ============================================

    /**
     * 건물 정보 UPSERT (buildings + building_land_lots 테이블)
     * building_land_lots를 단일 소스로 사용하여 PNU↔Building 매핑 관리
     * @returns building_id 또는 null
     */
    async upsertBuilding(data: {
        pnu: string;
        buildingType: string;
        buildingName?: string | null;
        mainPurpose?: string | null;
        floorCount?: number;
        totalUnitCount?: number;
    }): Promise<string | null> {
        try {
            // 1. building_land_lots에서 기존 매핑 조회
            const { data: existingMapping, error: mappingError } = await this.client
                .from('building_land_lots')
                .select('building_id')
                .eq('pnu', data.pnu)
                .single();

            let buildingId: string | null = null;

            if (existingMapping && !mappingError) {
                // 2a. 기존 매핑이 있으면 buildings 업데이트
                buildingId = existingMapping.building_id;
                const { error: updateError } = await this.client
                    .from('buildings')
                    .update({
                        building_type: data.buildingType,
                        building_name: data.buildingName,
                        main_purpose: data.mainPurpose,
                        floor_count: data.floorCount ?? 0,
                        total_unit_count: data.totalUnitCount ?? 0,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', buildingId);

                if (updateError) {
                    logger.error(`buildings update failed (id: ${buildingId}, PNU: ${data.pnu})`, updateError);
                    return null;
                }

                logger.debug(
                    `buildings updated via building_land_lots: ${data.pnu} (type: ${data.buildingType}, name: ${data.buildingName})`
                );
            } else {
                // 2b. 기존 매핑이 없으면 새 building 생성 + building_land_lots에 매핑 추가
                const { data: newBuilding, error: insertError } = await this.client
                    .from('buildings')
                    .insert({
                        building_type: data.buildingType,
                        building_name: data.buildingName,
                        main_purpose: data.mainPurpose,
                        floor_count: data.floorCount ?? 0,
                        total_unit_count: data.totalUnitCount ?? 0,
                    })
                    .select('id')
                    .single();

                if (insertError || !newBuilding) {
                    logger.error(`buildings insert failed (PNU: ${data.pnu})`, insertError);
                    return null;
                }

                buildingId = newBuilding.id;

                // building_land_lots에 매핑 생성
                const { error: mappingInsertError } = await this.client
                    .from('building_land_lots')
                    .upsert(
                        {
                            pnu: data.pnu,
                            building_id: buildingId,
                            updated_at: new Date().toISOString(),
                        },
                        { onConflict: 'pnu' }
                    );

                if (mappingInsertError) {
                    logger.error(`building_land_lots insert failed (PNU: ${data.pnu})`, mappingInsertError);
                    // building은 생성되었으므로 계속 진행
                }

                logger.debug(
                    `buildings + building_land_lots created: ${data.pnu} (type: ${data.buildingType}, name: ${data.buildingName})`
                );
            }

            return buildingId;
        } catch (error) {
            logger.error(`upsertBuilding error (PNU: ${data.pnu})`, error);
            return null;
        }
    }

    /**
     * PNU로 건물 조회 (building_land_lots 기반)
     */
    async getBuildingByPnu(pnu: string): Promise<{ id: string } | null> {
        try {
            const { data, error } = await this.client
                .from('building_land_lots')
                .select('building_id')
                .eq('pnu', pnu)
                .single();

            if (error || !data) {
                return null;
            }

            return { id: data.building_id };
        } catch (error) {
            logger.error(`buildings lookup error via building_land_lots (PNU: ${pnu})`, error);
            return null;
        }
    }

    /**
     * 세대(동/호수) 정보 UPSERT (building_units 테이블)
     * 기존 세대는 유지하고 새 세대만 추가
     */
    async upsertBuildingUnits(
        buildingId: string,
        units: Array<{
            dong?: string | null;
            ho?: string | null;
            floor?: number | null;
            area?: number | null;
        }>
    ): Promise<boolean> {
        if (!units || units.length === 0) {
            logger.debug(`No units to upsert for building: ${buildingId}`);
            return true;
        }

        try {
            // 각 세대별로 upsert
            for (const unit of units) {
                const { error } = await this.client.from('building_units').upsert(
                    {
                        building_id: buildingId,
                        dong: unit.dong,
                        ho: unit.ho,
                        floor: unit.floor,
                        area: unit.area,
                    },
                    {
                        onConflict: 'building_id,dong,ho',
                        ignoreDuplicates: false,
                    }
                );

                if (error) {
                    // UNIQUE 제약조건 위반은 무시 (이미 존재하는 세대)
                    if (error.code !== '23505') {
                        logger.error(
                            `building_units upsert failed (building: ${buildingId}, dong: ${unit.dong}, ho: ${unit.ho})`,
                            error
                        );
                    }
                }
            }

            logger.debug(`building_units upserted: ${buildingId} (count: ${units.length})`);
            return true;
        } catch (error) {
            logger.error(`building_units upsert error (building: ${buildingId})`, error);
            return false;
        }
    }

    /**
     * 건물과 세대 정보를 한 번에 저장
     */
    async saveBuildingWithUnits(
        pnu: string,
        buildingInfo: {
            buildingType: string;
            buildingName?: string | null;
            mainPurpose?: string | null;
            floorCount?: number;
            units: Array<{
                dong?: string | null;
                ho?: string | null;
                floor?: number | null;
                area?: number | null;
            }>;
        }
    ): Promise<boolean> {
        try {
            // 1. 건물 정보 저장
            const buildingId = await this.upsertBuilding({
                pnu,
                buildingType: buildingInfo.buildingType,
                buildingName: buildingInfo.buildingName,
                mainPurpose: buildingInfo.mainPurpose,
                floorCount: buildingInfo.floorCount,
                totalUnitCount: buildingInfo.units.length,
            });

            if (!buildingId) {
                logger.error(`Failed to save building for PNU: ${pnu}`);
                return false;
            }

            // 2. 세대 정보 저장
            const unitsResult = await this.upsertBuildingUnits(buildingId, buildingInfo.units);
            if (!unitsResult) {
                logger.error(`Failed to save building units for PNU: ${pnu}`);
                return false;
            }

            logger.info(
                `Building and units saved for PNU ${pnu}: type=${buildingInfo.buildingType}, units=${buildingInfo.units.length}`
            );
            return true;
        } catch (error) {
            logger.error(`saveBuildingWithUnits error (PNU: ${pnu})`, error);
            return false;
        }
    }

    /**
     * sync_jobs 상태 업데이트
     */
    async updateSyncJobStatus(
        jobId: string,
        status: 'PROCESSING' | 'COMPLETED' | 'FAILED',
        progress: number,
        errorLog?: string,
        previewData?: any
    ): Promise<boolean> {
        try {
            const updateData: any = {
                status,
                progress,
                updated_at: new Date().toISOString(),
            };

            if (errorLog !== undefined) {
                updateData.error_log = errorLog;
            }

            if (previewData !== undefined) {
                updateData.preview_data = previewData;
            }

            const { error, count } = await this.client
                .from('sync_jobs')
                .update(updateData)
                .eq('id', jobId);

            if (error) {
                logger.error(`sync_jobs update failed (${jobId}): ${JSON.stringify(error)}`);
                return false;
            }

            logger.debug(`sync_jobs updated (${jobId}): progress=${progress}, status=${status}`);
            return true;
        } catch (error: any) {
            logger.error(`sync_jobs update error (${jobId}): ${error?.message || JSON.stringify(error)}`);
            return false;
        }
    }

    /**
     * Supabase 클라이언트 직접 접근 (필요 시)
     */
    getClient(): SupabaseClient {
        return this.client;
    }
}

export const supabaseService = new SupabaseService();
export default supabaseService;


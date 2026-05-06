import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { AlimtalkLogInput, AlimtalkTemplate, PricingMap } from '../types/alimtalk.types';
import { SmsSendLogInput } from '../types/sms.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('SUPABASE');

type BuildingExternalRefSource =
    | 'BUILDING_REGISTER'
    | 'APART_HOUSING_PRICE'
    | 'INDIVIDUAL_HOUSING_PRICE'
    | 'ROAD_ADDRESS';

interface BuildingExternalRefInput {
    buildingId: string;
    source: BuildingExternalRefSource;
    externalId: string | null | undefined;
    externalName?: string | null;
    pnu?: string | null;
    metadata?: Record<string, unknown>;
}

interface ApartmentOfficialPriceUnitInput {
    dong: string | null;
    ho: string | null;
    area: number | null;
    officialPrice: number;
    sourcePnu: string;
    stdrYear: string;
    externalId: string | null;
    externalName: string | null;
    metadata: Record<string, unknown>;
}

interface BuildingUnitMatchRow {
    id: string;
    dong: string | null;
    ho: string | null;
    official_price?: number | null;
}

interface PropertyUnitMatchCandidate {
    id: string;
    dong: string | null;
    ho: string | null;
    building_unit_id: string | null;
    building_name?: string | null;
}

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
     * SMS 발송 로그 저장
     */
    async saveSmsLog(log: SmsSendLogInput): Promise<string | null> {
        try {
            const { data, error } = await this.client
                .from('sms_send_logs')
                .insert({
                    union_id: log.union_id,
                    sender_id: log.sender_id,
                    title: log.title,
                    message: log.message,
                    msg_type: log.msg_type,
                    total_count: log.total_count,
                    success_count: log.success_count,
                    fail_count: log.fail_count,
                    status: log.status,
                    aligo_msg_ids: log.aligo_msg_ids,
                    estimated_cost: log.estimated_cost,
                    completed_at: new Date().toISOString(),
                })
                .select('id')
                .single();

            if (error) {
                logger.error('Failed to save SMS log', error);
                return null;
            }

            return data.id;
        } catch (error) {
            logger.error('SMS log save error', error);
            return null;
        }
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
                MMS: 200,
            };
        }

        const pricing: PricingMap = {
            KAKAO: 15,
            SMS: 20,
            LMS: 50,
            MMS: 200,
        };

        for (const item of data) {
            if (item.message_type === 'KAKAO') pricing.KAKAO = item.unit_price;
            if (item.message_type === 'SMS') pricing.SMS = item.unit_price;
            if (item.message_type === 'LMS') pricing.LMS = item.unit_price;
            if (item.message_type === 'MMS') pricing.MMS = item.unit_price;
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
                    onConflict: 'pnu,union_id',
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
     * 공공 API가 제공한 건물 외부 식별자와 공식명을 저장
     */
    async upsertBuildingExternalRef(input: BuildingExternalRefInput): Promise<boolean> {
        const externalId = input.externalId?.trim();
        if (!externalId) return false;

        const pnu = input.pnu?.trim() || null;
        const externalName = input.externalName?.trim() || null;
        const now = new Date().toISOString();

        try {
            let lookup = this.client
                .from('building_external_refs')
                .select('building_id')
                .eq('source', input.source)
                .eq('external_id', externalId);

            lookup = pnu ? lookup.eq('pnu', pnu) : lookup.is('pnu', null);
            const { data: existingRef, error: lookupError } = await lookup.maybeSingle();

            if (lookupError) {
                logger.warn(
                    `building_external_refs lookup failed (${input.source}/${externalId}/${pnu ?? 'no-pnu'}): ${lookupError.message}`
                );
            } else if (existingRef && existingRef.building_id !== input.buildingId) {
                logger.warn(
                    `building_external_refs remapped (${input.source}/${externalId}/${pnu ?? 'no-pnu'}): ${existingRef.building_id} -> ${input.buildingId}`
                );
            }

            const { error } = await this.client.from('building_external_refs').upsert(
                {
                    building_id: input.buildingId,
                    source: input.source,
                    external_id: externalId,
                    external_name: externalName,
                    pnu,
                    metadata: input.metadata ?? {},
                    last_seen_at: now,
                    updated_at: now,
                },
                { onConflict: 'source,external_id,pnu' }
            );

            if (error) {
                logger.warn(
                    `building_external_refs upsert failed (${input.source}/${externalId}/${pnu ?? 'no-pnu'}): ${error.message}`
                );
                return false;
            }

            await this.adoptOfficialBuildingNameIfStable({
                buildingId: input.buildingId,
                source: input.source,
                externalName,
            });
            return true;
        } catch (error) {
            logger.error(`building_external_refs upsert error (${input.source}/${externalId})`, error);
            return false;
        }
    }

    async upsertBuildingExternalRefs(inputs: BuildingExternalRefInput[]): Promise<void> {
        for (const input of inputs) {
            await this.upsertBuildingExternalRef(input);
        }
    }

    private cleanText(value: string | null | undefined): string | null {
        if (value === null || value === undefined) return null;
        const trimmed = String(value).trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    private normalizeDongForMatch(value: string | null | undefined, buildingName?: string | null): string | null {
        const cleaned = this.cleanText(value);
        if (!cleaned) return null;

        let normalized = cleaned
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/[()（）\[\]{}·.,_-]/g, '');

        const normalizedBuildingName = this.cleanText(buildingName)
            ?.toLowerCase()
            .replace(/\s+/g, '')
            .replace(/[()（）\[\]{}·.,_-]/g, '');

        if (normalizedBuildingName && normalized.startsWith(normalizedBuildingName)) {
            normalized = normalized.slice(normalizedBuildingName.length);
        }

        if (normalized.endsWith('동') && normalized.length > 1) {
            normalized = normalized.slice(0, -1);
        }

        const suffixMap: Array<[RegExp, string]> = [
            [/에이$/, 'a'],
            [/비$/, 'b'],
            [/씨$/, 'c'],
            [/시$/, 'c'],
            [/디$/, 'd'],
            [/이$/, 'e'],
            [/에프$/, 'f'],
            [/지$/, 'g'],
            [/에이치$/, 'h'],
        ];

        for (const [pattern, replacement] of suffixMap) {
            if (pattern.test(normalized)) {
                normalized = normalized.replace(pattern, replacement);
                break;
            }
        }

        return normalized || null;
    }

    private normalizeHoForMatch(value: string | null | undefined): string | null {
        const cleaned = this.cleanText(value);
        if (!cleaned) return null;

        const normalized = cleaned
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/^제/g, '')
            .replace(/호$/g, '')
            .replace(/[()（）\[\]{}·.,_-]/g, '');

        if (/^\d+$/.test(normalized)) {
            return String(Number(normalized));
        }

        return normalized || null;
    }

    private isHoMatch(
        candidateHoValue: string | null | undefined,
        unitHoValue: string | null | undefined,
        unitDongValue: string | null | undefined
    ): boolean {
        const candidateHo = this.normalizeHoForMatch(candidateHoValue);
        const unitHo = this.normalizeHoForMatch(unitHoValue);
        if (!candidateHo || !unitHo) return false;
        if (candidateHo === unitHo) return true;

        const unitDong = this.normalizeDongForMatch(unitDongValue);
        if (unitDong && unitHo === `${unitDong}${candidateHo}`) return true;

        // 예: 조합원 "302" ↔ 공시가격 "A302", "비202"
        return unitHo.endsWith(candidateHo);
    }

    private isDongMatch(
        candidateDong: string | null | undefined,
        unitDong: string | null | undefined,
        candidateBuildingName?: string | null
    ): boolean {
        const candidate = this.normalizeDongForMatch(candidateDong, candidateBuildingName);
        const unit = this.normalizeDongForMatch(unitDong);

        if (!candidate && !unit) return true;
        if (!candidate || !unit) return false;
        if (candidate === unit) return true;

        // 예: "주일빌라 B" ↔ "비", "삼각산아이원아파트 102동" ↔ "102"
        return candidate.endsWith(unit) || unit.endsWith(candidate);
    }

    private findMatchingBuildingUnit(
        candidate: PropertyUnitMatchCandidate,
        units: BuildingUnitMatchRow[]
    ): BuildingUnitMatchRow | null {
        const candidateHo = this.normalizeHoForMatch(candidate.ho);
        if (!candidateHo) return null;

        const hoMatches = units.filter((unit) => this.isHoMatch(candidate.ho, unit.ho, unit.dong));
        if (hoMatches.length === 0) return null;

        const dongMatches = hoMatches.filter((unit) =>
            this.isDongMatch(candidate.dong, unit.dong, candidate.building_name)
        );
        if (dongMatches.length === 1) return dongMatches[0];

        const candidateDong = this.normalizeDongForMatch(candidate.dong, candidate.building_name);
        const incompleteDongMatches = hoMatches.filter((unit) => {
            const unitDong = this.normalizeDongForMatch(unit.dong);
            return !candidateDong || !unitDong;
        });

        // 동 값이 한쪽에 없고 같은 호수가 건물 안에서 유일하면 연결한다.
        if (incompleteDongMatches.length === 1) return incompleteDongMatches[0];

        const pricedIncompleteMatches = incompleteDongMatches.filter((unit) => unit.official_price !== null && unit.official_price !== undefined);
        if (pricedIncompleteMatches.length === 1) return pricedIncompleteMatches[0];

        return null;
    }

    private buildOfficialPriceMetadata(
        existingMetadata: Record<string, unknown> | null | undefined,
        price: ApartmentOfficialPriceUnitInput,
        requestedPnu: string
    ): Record<string, unknown> {
        return {
            ...(existingMetadata ?? {}),
            officialPrice: {
                ...(price.metadata ?? {}),
                source: 'APART_HOUSING_PRICE',
                requestedPnu,
                sourcePnu: price.sourcePnu,
                aphusCode: price.externalId,
                aphusName: price.externalName,
                stdrYear: price.stdrYear,
                area: price.area,
                officialPrice: price.officialPrice,
            },
        };
    }

    /**
     * 공동주택/개별주택 가격 API 공식명이 안정적으로 하나일 때만 대표 건물명으로 반영
     */
    private async adoptOfficialBuildingNameIfStable(input: {
        buildingId: string;
        source: BuildingExternalRefSource;
        externalName: string | null;
    }): Promise<void> {
        if (!input.externalName || !['APART_HOUSING_PRICE', 'INDIVIDUAL_HOUSING_PRICE'].includes(input.source)) {
            return;
        }

        try {
            const { data: mappings, error: mappingError } = await this.client
                .from('building_land_lots')
                .select('pnu')
                .eq('building_id', input.buildingId);

            if (mappingError) {
                logger.warn(`building_land_lots lookup failed for official name adoption: ${mappingError.message}`);
                return;
            }

            if ((mappings?.length ?? 0) > 1) {
                logger.info(
                    `Official building name adoption skipped for multi-lot building ${input.buildingId}: ${input.externalName}`
                );
                return;
            }

            const { data: refs, error: refsError } = await this.client
                .from('building_external_refs')
                .select('external_name')
                .eq('building_id', input.buildingId)
                .eq('source', input.source);

            if (refsError) {
                logger.warn(`building_external_refs name check failed: ${refsError.message}`);
                return;
            }

            const names = new Set(
                (refs ?? [])
                    .map((ref: { external_name: string | null }) => ref.external_name?.trim())
                    .filter((name: string | undefined): name is string => Boolean(name))
            );

            if (names.size > 1) {
                logger.warn(
                    `Official building name conflict for ${input.buildingId}: ${Array.from(names).join(', ')}`
                );
                return;
            }

            const { data: building, error: buildingError } = await this.client
                .from('buildings')
                .select('building_name')
                .eq('id', input.buildingId)
                .single();

            if (buildingError) {
                logger.warn(`buildings lookup failed for official name adoption: ${buildingError.message}`);
                return;
            }

            if (building?.building_name === input.externalName) return;

            const { error: updateError } = await this.client
                .from('buildings')
                .update({
                    building_name: input.externalName,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', input.buildingId);

            if (updateError) {
                logger.warn(`buildings official name update failed (${input.buildingId}): ${updateError.message}`);
            }
        } catch (error) {
            logger.error(`Official building name adoption error (${input.buildingId})`, error);
        }
    }

    private resolveExistingUnitForOfficialPriceUpsert(
        candidates: Array<{
            id: string;
            dong: string | null;
            ho: string | null;
            source_metadata: Record<string, unknown> | null;
            official_price: number | null;
            official_price_aphus_code: string | null;
        }>,
        dong: string | null,
        ho: string,
        buildingName?: string | null
    ): {
        match: { id: string; source_metadata: Record<string, unknown> | null } | null;
        ambiguous: boolean;
    } {
        if (candidates.length === 0) return { match: null, ambiguous: false };

        const pickPriced = <T extends { official_price: number | null; official_price_aphus_code: string | null }>(
            rows: T[]
        ): T => rows.find((r) => r.official_price_aphus_code || r.official_price !== null) ?? rows[0];

        // 1) cleanText 정확 매칭
        const exact = candidates.filter(
            (c) => this.cleanText(c.ho) === ho && this.cleanText(c.dong) === dong
        );
        if (exact.length >= 1) {
            const chosen = exact.length === 1 ? exact[0] : pickPriced(exact);
            return { match: { id: chosen.id, source_metadata: chosen.source_metadata }, ambiguous: false };
        }

        // 2) 정규화 매칭
        const hoMatches = candidates.filter((c) => this.isHoMatch(ho, c.ho, c.dong));
        if (hoMatches.length === 0) return { match: null, ambiguous: false };

        const candidateDongNorm = this.normalizeDongForMatch(dong, buildingName);

        // 2-1) dong 양쪽 정규화 가능 + isDongMatch 통과
        const dongMatches = hoMatches.filter((c) => {
            const unitDongNorm = this.normalizeDongForMatch(c.dong);
            return Boolean(candidateDongNorm) && Boolean(unitDongNorm) && this.isDongMatch(dong, c.dong, buildingName);
        });
        if (dongMatches.length >= 1) {
            const chosen = dongMatches.length === 1 ? dongMatches[0] : pickPriced(dongMatches);
            return { match: { id: chosen.id, source_metadata: chosen.source_metadata }, ambiguous: false };
        }

        // 2-2) incomplete dong (한쪽이 비어있음) — shadow row 방지 핵심 path
        const incompleteMatches = hoMatches.filter((c) => {
            const unitDongNorm = this.normalizeDongForMatch(c.dong);
            return !candidateDongNorm || !unitDongNorm;
        });
        if (incompleteMatches.length === 1) {
            const chosen = incompleteMatches[0];
            return { match: { id: chosen.id, source_metadata: chosen.source_metadata }, ambiguous: false };
        }

        if (incompleteMatches.length > 1) {
            // 같은 dong-norm(둘 다 null 포함)끼리 묶어 1건이면 update, 아니면 ambiguous
            const sameDongNorm = incompleteMatches.filter((c) => {
                const unitDongNorm = this.normalizeDongForMatch(c.dong);
                return (candidateDongNorm ?? null) === (unitDongNorm ?? null);
            });
            if (sameDongNorm.length >= 1) {
                const chosen = sameDongNorm.length === 1 ? sameDongNorm[0] : pickPriced(sameDongNorm);
                return { match: { id: chosen.id, source_metadata: chosen.source_metadata }, ambiguous: false };
            }
            return { match: null, ambiguous: true };
        }

        return { match: null, ambiguous: false };
    }

    private async upsertApartmentOfficialPriceUnit(
        buildingId: string,
        price: ApartmentOfficialPriceUnitInput,
        requestedPnu: string
    ): Promise<string | null> {
        const dong = this.cleanText(price.dong);
        const ho = this.cleanText(price.ho);

        if (!ho) {
            logger.warn(`Apartment official price unit skipped: missing ho (building: ${buildingId}, pnu: ${requestedPnu})`);
            return null;
        }

        const now = new Date().toISOString();

        // building 내 모든 unit 조회 (정규화 매칭을 위해 ho 필터 제거)
        const { data: candidates, error: lookupError } = await this.client
            .from('building_units')
            .select('id, dong, ho, source_metadata, official_price, official_price_aphus_code')
            .eq('building_id', buildingId);

        if (lookupError) {
            logger.warn(
                `building_units official price lookup failed (building: ${buildingId}, dong: ${dong}, ho: ${ho}): ${lookupError.message}`
            );
        }

        const allCandidates = (candidates ?? []) as Array<{
            id: string;
            dong: string | null;
            ho: string | null;
            source_metadata: Record<string, unknown> | null;
            official_price: number | null;
            official_price_aphus_code: string | null;
        }>;

        const { match: existingUnit, ambiguous } = this.resolveExistingUnitForOfficialPriceUpsert(
            allCandidates,
            dong,
            ho,
            price.externalName
        );

        const officialFields = {
            area: price.area,
            official_price: price.officialPrice,
            official_price_aphus_code: price.externalId,
            official_price_year: price.stdrYear,
            official_price_pnu: price.sourcePnu || requestedPnu,
            official_price_area: price.area,
            official_price_updated_at: now,
            updated_at: now,
            source_metadata: this.buildOfficialPriceMetadata(
                (existingUnit?.source_metadata as Record<string, unknown> | null | undefined) ?? null,
                price,
                requestedPnu
            ),
        };

        if (existingUnit?.id) {
            // dong/ho 컬럼은 보존(사용자 입력 형식 유지) — 가격 관련 필드만 갱신
            const { data, error } = await this.client
                .from('building_units')
                .update(officialFields)
                .eq('id', existingUnit.id)
                .select('id')
                .single();

            if (error) {
                logger.warn(
                    `building_units official price update failed (building: ${buildingId}, dong: ${dong}, ho: ${ho}, target unit: ${existingUnit.id}): ${error.message}`
                );
                return null;
            }

            return data.id;
        }

        if (ambiguous) {
            // 여러 동에 같은 호수 존재 + VWorld가 동 정보 안 줌 → 잘못 박지 않고 skip (shadow row 방지)
            logger.warn(
                `building_units official price ambiguous match — skipped to avoid shadow row (building: ${buildingId}, dong: ${dong ?? 'null'}, ho: ${ho}, pnu: ${requestedPnu})`
            );
            return null;
        }

        // 정규화로도 매칭 안됨 → 진짜 신규 unit, INSERT
        const { data, error } = await this.client
            .from('building_units')
            .insert({ building_id: buildingId, dong, ho, ...officialFields })
            .select('id')
            .single();

        if (error) {
            logger.warn(
                `building_units official price insert failed (building: ${buildingId}, dong: ${dong}, ho: ${ho}): ${error.message}`
            );
            return null;
        }

        return data.id;
    }

    private async listBuildingPnus(buildingId: string): Promise<string[]> {
        const { data, error } = await this.client
            .from('building_land_lots')
            .select('pnu')
            .eq('building_id', buildingId);

        if (error) {
            logger.warn(`building_land_lots lookup failed for building ${buildingId}: ${error.message}`);
            return [];
        }

        return (data ?? [])
            .map((row: { pnu: string | null }) => row.pnu)
            .filter((pnu: string | null): pnu is string => Boolean(pnu));
    }

    private async linkUserPropertyUnitsToBuildingUnits(
        pnus: string[],
        units: BuildingUnitMatchRow[]
    ): Promise<{ linkedCount: number; skippedCount: number }> {
        if (pnus.length === 0 || units.length === 0) {
            return { linkedCount: 0, skippedCount: 0 };
        }

        const { data, error } = await this.client
            .from('user_property_units')
            .select('id, dong, ho, building_unit_id, building_name')
            .in('pnu', pnus)
            .eq('is_active', true);

        if (error) {
            logger.warn(`user_property_units lookup failed for official price linking: ${error.message}`);
            return { linkedCount: 0, skippedCount: 0 };
        }

        let linkedCount = 0;
        let skippedCount = 0;

        for (const row of (data ?? []) as PropertyUnitMatchCandidate[]) {
            const matchedUnit = this.findMatchingBuildingUnit(row, units);
            if (!matchedUnit) {
                skippedCount++;
                continue;
            }

            const updateData: Record<string, unknown> = {};
            if (row.building_unit_id !== matchedUnit.id) updateData.building_unit_id = matchedUnit.id;
            if (matchedUnit.dong !== null && row.dong !== matchedUnit.dong) updateData.dong = matchedUnit.dong;
            if (matchedUnit.ho !== null && row.ho !== matchedUnit.ho) updateData.ho = matchedUnit.ho;

            if (Object.keys(updateData).length === 0) continue;

            updateData.updated_at = new Date().toISOString();

            const { error: updateError } = await this.client
                .from('user_property_units')
                .update(updateData)
                .eq('id', row.id);

            if (updateError) {
                logger.warn(`user_property_units official price link failed (${row.id}): ${updateError.message}`);
                skippedCount++;
                continue;
            }

            linkedCount++;
        }

        return { linkedCount, skippedCount };
    }

    private async linkPropertyUnitsToBuildingUnits(
        pnus: string[],
        units: BuildingUnitMatchRow[]
    ): Promise<{ linkedCount: number; skippedCount: number }> {
        if (pnus.length === 0 || units.length === 0) {
            return { linkedCount: 0, skippedCount: 0 };
        }

        const { data, error } = await this.client
            .from('property_units')
            .select('id, dong, ho, building_unit_id, building_name')
            .in('pnu', pnus)
            .eq('is_deleted', false);

        if (error) {
            logger.warn(`property_units lookup failed for official price linking: ${error.message}`);
            return { linkedCount: 0, skippedCount: 0 };
        }

        let linkedCount = 0;
        let skippedCount = 0;

        for (const row of (data ?? []) as PropertyUnitMatchCandidate[]) {
            const matchedUnit = this.findMatchingBuildingUnit(row, units);
            if (!matchedUnit) {
                skippedCount++;
                continue;
            }

            const updateData: Record<string, unknown> = {};
            if (row.building_unit_id !== matchedUnit.id) updateData.building_unit_id = matchedUnit.id;
            if (matchedUnit.dong !== null && row.dong !== matchedUnit.dong) updateData.dong = matchedUnit.dong;
            if (matchedUnit.ho !== null && row.ho !== matchedUnit.ho) updateData.ho = matchedUnit.ho;

            if (Object.keys(updateData).length === 0) continue;

            updateData.updated_at = new Date().toISOString();

            const { error: updateError } = await this.client
                .from('property_units')
                .update(updateData)
                .eq('id', row.id);

            if (updateError) {
                logger.warn(`property_units official price link failed (${row.id}): ${updateError.message}`);
                skippedCount++;
                continue;
            }

            linkedCount++;
        }

        return { linkedCount, skippedCount };
    }

    async upsertApartmentOfficialPriceUnits(
        buildingId: string,
        requestedPnu: string,
        prices: ApartmentOfficialPriceUnitInput[]
    ): Promise<{
        upsertedCount: number;
        skippedCount: number;
        linkedUserPropertyCount: number;
        linkedPropertyUnitCount: number;
        linkSkippedCount: number;
    }> {
        let upsertedCount = 0;
        let skippedCount = 0;

        for (const price of prices) {
            const unitId = await this.upsertApartmentOfficialPriceUnit(buildingId, price, requestedPnu);
            if (unitId) {
                upsertedCount++;
            } else {
                skippedCount++;
            }
        }

        const { data: units, error: unitsError } = await this.client
            .from('building_units')
            .select('id, dong, ho, official_price')
            .eq('building_id', buildingId);

        if (unitsError) {
            logger.warn(`building_units lookup failed after official price upsert (${buildingId}): ${unitsError.message}`);
            return {
                upsertedCount,
                skippedCount,
                linkedUserPropertyCount: 0,
                linkedPropertyUnitCount: 0,
                linkSkippedCount: 0,
            };
        }

        const buildingPnus = await this.listBuildingPnus(buildingId);
        const pricePnus = prices.map((price) => price.sourcePnu).filter((pnu): pnu is string => Boolean(pnu));
        const linkPnus = Array.from(new Set([requestedPnu, ...buildingPnus, ...pricePnus].filter(Boolean)));

        const normalizedUnits = ((units ?? []) as BuildingUnitMatchRow[]).filter((unit) => this.cleanText(unit.ho));
        const userLinkResult = await this.linkUserPropertyUnitsToBuildingUnits(linkPnus, normalizedUnits);
        const propertyLinkResult = await this.linkPropertyUnitsToBuildingUnits(linkPnus, normalizedUnits);

        return {
            upsertedCount,
            skippedCount,
            linkedUserPropertyCount: userLinkResult.linkedCount,
            linkedPropertyUnitCount: propertyLinkResult.linkedCount,
            linkSkippedCount: userLinkResult.skippedCount + propertyLinkResult.skippedCount,
        };
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
            officialPrice?: number | null; // 2026-04 추가: 공동주택공시가격 (S2 integration)
            registryExternalId?: string | null;
        }>
    ): Promise<boolean> {
        if (!units || units.length === 0) {
            logger.debug(`No units to upsert for building: ${buildingId}`);
            return true;
        }

        try {
            // 각 세대별로 upsert
            for (const unit of units) {
                const unitPayload: Record<string, unknown> = {
                    building_id: buildingId,
                    dong: unit.dong,
                    ho: unit.ho,
                    floor: unit.floor,
                    area: unit.area,
                    updated_at: new Date().toISOString(),
                };

                if (unit.officialPrice !== null && unit.officialPrice !== undefined) {
                    unitPayload.official_price = unit.officialPrice;
                }

                if (unit.registryExternalId) {
                    unitPayload.registry_external_id = unit.registryExternalId;
                }

                const { error } = await this.client.from('building_units').upsert(
                    unitPayload,
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
            externalRefs?: Array<{
                source: BuildingExternalRefSource;
                externalId: string;
                externalName?: string | null;
                pnu?: string | null;
                metadata?: Record<string, unknown>;
            }>;
            units: Array<{
                dong?: string | null;
                ho?: string | null;
                floor?: number | null;
                area?: number | null;
                officialPrice?: number | null; // 2026-04 추가: 공동주택공시가격 (S2 integration)
                registryExternalId?: string | null;
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

            if (buildingInfo.externalRefs && buildingInfo.externalRefs.length > 0) {
                await this.upsertBuildingExternalRefs(
                    buildingInfo.externalRefs.map((ref) => ({
                        buildingId,
                        source: ref.source,
                        externalId: ref.externalId,
                        externalName: ref.externalName,
                        pnu: ref.pnu ?? pnu,
                        metadata: ref.metadata,
                    }))
                );
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
     * 조합 내 공동주택 타입(VILLA / APARTMENT / MIXED) 건물의 PNU 목록 조회 (2026-04)
     * 공동주택공시가격 재동기화 대상 선정에 사용
     */
    async listApartmentBuildingTargets(
        unionId: string
    ): Promise<Array<{ pnu: string; buildingId: string; buildingType: string }>> {
        return this.listOfficialPriceBuildingTargets(unionId, ['VILLA', 'APARTMENT', 'MIXED']);
    }

    /**
     * 조합 내 단독주택 타입(DETACHED_HOUSE) 건물의 PNU 목록 조회 (2026-05)
     * 개별주택가격 재동기화 대상 선정에 사용
     */
    async listIndividualHousingBuildingTargets(
        unionId: string
    ): Promise<Array<{ pnu: string; buildingId: string; buildingType: string }>> {
        return this.listOfficialPriceBuildingTargets(unionId, ['DETACHED_HOUSE']);
    }

    /**
     * 공시가격 갱신 대상 건물 조회
     * 큰 PNU 배열을 PostgREST `.in(...)`으로 보내지 않고 DB RPC 내부 join으로 조회한다.
     */
    private async listOfficialPriceBuildingTargets(
        unionId: string,
        buildingTypes: string[]
    ): Promise<Array<{ pnu: string; buildingId: string; buildingType: string }>> {
        try {
            const { data, error } = await this.client.rpc('get_official_price_building_targets', {
                p_union_id: unionId,
                p_building_types: buildingTypes,
            });

            if (error) {
                logger.error(
                    `get_official_price_building_targets RPC failed (union: ${unionId}, types: ${buildingTypes.join(',')})`,
                    error
                );
                return [];
            }

            return (data ?? []).map((row: { pnu: string; building_id: string; building_type: string }) => ({
                pnu: row.pnu,
                buildingId: row.building_id,
                buildingType: row.building_type,
            }));
        } catch (error) {
            logger.error(
                `listOfficialPriceBuildingTargets error (union: ${unionId}, types: ${buildingTypes.join(',')})`,
                error
            );
            return [];
        }
    }

    /**
     * building_units.official_price 단건 갱신 (공동주택공시가격 재동기화용, 2026-04)
     * NULL dong/ho 매칭을 위해 .is() 사용
     */
    async updateBuildingUnitPrice(
        buildingId: string,
        dong: string | null,
        ho: string | null,
        price: number
    ): Promise<boolean> {
        try {
            let query = this.client.from('building_units').update({ official_price: price }).eq('building_id', buildingId);
            query = dong === null ? query.is('dong', null) : query.eq('dong', dong);
            query = ho === null ? query.is('ho', null) : query.eq('ho', ho);
            const { error } = await query;
            if (error) {
                logger.warn(
                    `updateBuildingUnitPrice failed (building: ${buildingId}, dong: ${dong}, ho: ${ho}): ${error.message}`
                );
                return false;
            }
            return true;
        } catch (error) {
            logger.error(`updateBuildingUnitPrice error (building: ${buildingId})`, error);
            return false;
        }
    }

    /**
     * building_units.official_price 건물 단위 일괄 갱신 (개별주택가격 재동기화용, 2026-05)
     * 단독/다가구 주택은 세대 구분 없이 같은 개별주택가격을 연결된 unit 전체에 적용한다.
     */
    async updateBuildingUnitsPriceByBuildingId(buildingId: string, price: number): Promise<number> {
        try {
            const { data, error } = await this.client
                .from('building_units')
                .update({ official_price: price })
                .eq('building_id', buildingId)
                .select('id');

            if (error) {
                logger.warn(`updateBuildingUnitsPriceByBuildingId failed (building: ${buildingId}): ${error.message}`);
                return 0;
            }

            return data?.length ?? 0;
        } catch (error) {
            logger.error(`updateBuildingUnitsPriceByBuildingId error (building: ${buildingId})`, error);
            return 0;
        }
    }

    /**
     * 토지 공시지가 재동기화 대상 조회 (2026-04)
     * 해당 조합의 land_lots 전체 PNU 목록을 반환 (전체 무조건 재조회)
     */
    async listLandPriceTargetsByUnion(unionId: string): Promise<Array<{ pnu: string }>> {
        try {
            const { data, error } = await this.client
                .from('land_lots')
                .select('pnu')
                .eq('union_id', unionId);

            if (error) {
                logger.error(`land_lots lookup failed for union ${unionId}`, error);
                return [];
            }
            return (data ?? []).map((row: { pnu: string }) => ({ pnu: row.pnu }));
        } catch (error) {
            logger.error(`listLandPriceTargetsByUnion error (union: ${unionId})`, error);
            return [];
        }
    }

    /**
     * land_lots.official_price 단건 갱신 (토지 공시지가 재동기화용, 2026-04)
     * union_id + pnu 복합 조건으로 갱신하여 다른 조합 데이터 오염 방지
     */
    async updateLandLotPrice(unionId: string, pnu: string, price: number): Promise<boolean> {
        try {
            const { error } = await this.client
                .from('land_lots')
                .update({ official_price: price })
                .eq('union_id', unionId)
                .eq('pnu', pnu);
            if (error) {
                logger.warn(`updateLandLotPrice failed (union: ${unionId}, pnu: ${pnu}): ${error.message}`);
                return false;
            }
            return true;
        } catch (error) {
            logger.error(`updateLandLotPrice error (union: ${unionId}, pnu: ${pnu})`, error);
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

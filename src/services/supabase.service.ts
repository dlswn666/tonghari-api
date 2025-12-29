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
            logger.error(`Vault 조회 오류 (unionId: ${unionId})`, error);
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
                logger.warn('Vault에서 기본 Sender Key 조회 실패, 환경 변수 사용');
                return env.DEFAULT_SENDER_KEY;
            }

            return data.decrypted_secret;
        } catch (error) {
            logger.error('기본 Sender Key 조회 오류', error);
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
            logger.error(`조합 채널명 조회 오류 (unionId: ${unionId})`, error);
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
            logger.error('알림톡 로그 저장 오류', error);
            throw new Error('알림톡 로그 저장에 실패했습니다.');
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
            logger.error('템플릿 삭제 오류', error);
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
                logger.error(`템플릿 조회 실패: ${templateCode}`, error);
                return null;
            }

            return data as AlimtalkTemplate;
        } catch (error) {
            logger.error(`템플릿 조회 오류 (${templateCode})`, error);
            return null;
        }
    }

    /**
     * 현재 단가 조회
     */
    async getCurrentPricing(): Promise<PricingMap> {
        const { data, error } = await this.client.rpc('get_current_pricing');

        if (error || !data) {
            logger.warn('단가 조회 실패, 기본값 사용');
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
}

export const supabaseService = new SupabaseService();
export default supabaseService;


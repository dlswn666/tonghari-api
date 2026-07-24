import dotenv from 'dotenv';
import type { DatabaseTarget } from '../types/database.types';
import { parseExactTrueFeatureFlag } from './feature-flags';
import { createLandAreaSyncAllowedTargetsManifest } from '../security/land-area-sync-canary-policy';

// .env 파일 로드
dotenv.config();

// 필수 환경 변수 검증
function getEnvVar(key: string, required: boolean = true): string {
    const value = process.env[key];
    if (required && !value) {
        throw new Error(`환경 변수 ${key}가 설정되지 않았습니다.`);
    }
    return value || '';
}

// 숫자 환경 변수 파싱
function getEnvNumber(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}

export function parseBuildingWriteOperationTargets(value: string): ReadonlySet<DatabaseTarget> {
    const targets = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

    for (const target of targets) {
        if (target !== 'production' && target !== 'development') {
            throw new Error(
                'BUILDING_WRITE_OPERATION_TARGETS는 production, development만 허용합니다.'
            );
        }
    }

    if (new Set(targets).size !== targets.length) {
        throw new Error('BUILDING_WRITE_OPERATION_TARGETS에 중복 target이 있습니다.');
    }

    return new Set(targets as DatabaseTarget[]);
}

export interface DevelopmentApiEnvironmentInput {
    productionJwtSecret: string;
    productionSupabaseUrl: string;
    productionSupabaseServiceRoleKey: string;
    developmentJwtSecret: string;
    developmentSupabaseUrl: string;
    developmentSupabaseServiceRoleKey: string;
}

/**
 * 개발 환경은 JWT/URL/service-role 세 값이 모두 있어야 활성화된다.
 * 운영과 같은 서명키 또는 같은 Supabase URL은 환경 격리를 무력화하므로 시작을 거부한다.
 */
export function validateDevelopmentApiEnvironment(
    input: DevelopmentApiEnvironmentInput
): boolean {
    const developmentValues = [
        input.developmentJwtSecret,
        input.developmentSupabaseUrl,
        input.developmentSupabaseServiceRoleKey,
    ];
    const configuredCount = developmentValues.filter(Boolean).length;

    if (configuredCount === 0) return false;
    if (configuredCount !== developmentValues.length) {
        throw new Error(
            '개발 DB 연결은 DEV_API_JWT_SECRET, DEV_SUPABASE_URL, DEV_SUPABASE_SERVICE_ROLE_KEY를 모두 설정해야 합니다.'
        );
    }
    if (input.developmentJwtSecret === input.productionJwtSecret) {
        throw new Error('DEV_API_JWT_SECRET은 운영 JWT_SECRET과 달라야 합니다.');
    }

    const normalizeUrl = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();
    if (normalizeUrl(input.developmentSupabaseUrl) === normalizeUrl(input.productionSupabaseUrl)) {
        throw new Error('DEV_SUPABASE_URL은 운영 SUPABASE_URL과 달라야 합니다.');
    }
    // 키 원문은 로그나 오류에 포함하지 않고 프로세스 내부에서만 동일 여부를 판정한다.
    if (input.developmentSupabaseServiceRoleKey === input.productionSupabaseServiceRoleKey) {
        throw new Error('DEV_SUPABASE_SERVICE_ROLE_KEY는 운영 SUPABASE_SERVICE_ROLE_KEY와 달라야 합니다.');
    }

    return true;
}

const jwtSecret = getEnvVar('JWT_SECRET');
const supabaseUrl = getEnvVar('SUPABASE_URL');
const supabaseServiceRoleKey = getEnvVar('SUPABASE_SERVICE_ROLE_KEY');
const devApiJwtSecret = getEnvVar('DEV_API_JWT_SECRET', false);
const devSupabaseUrl = getEnvVar('DEV_SUPABASE_URL', false);
const devSupabaseServiceRoleKey = getEnvVar('DEV_SUPABASE_SERVICE_ROLE_KEY', false);
const hasDevelopmentDatabase = validateDevelopmentApiEnvironment({
    productionJwtSecret: jwtSecret,
    productionSupabaseUrl: supabaseUrl,
    productionSupabaseServiceRoleKey: supabaseServiceRoleKey,
    developmentJwtSecret: devApiJwtSecret,
    developmentSupabaseUrl: devSupabaseUrl,
    developmentSupabaseServiceRoleKey: devSupabaseServiceRoleKey,
});
const buildingWriteOperationTargets = parseBuildingWriteOperationTargets(
    process.env.BUILDING_WRITE_OPERATION_TARGETS || ''
);
const landAreaSyncAllowedTargetsManifest =
    createLandAreaSyncAllowedTargetsManifest(
        process.env.LAND_AREA_SYNC_ALLOWED_TARGETS
    );

export const env = {
    // 서버 설정
    PORT: parseInt(process.env.PORT || '3100', 10),
    NODE_ENV: process.env.NODE_ENV || 'development',

    // JWT 인증 (Shared Secret 방식)
    JWT_SECRET: jwtSecret,
    DEV_API_JWT_SECRET: devApiJwtSecret,

    // 알리고 API
    ALIGO_API_KEY: getEnvVar('ALIGO_API_KEY'),
    ALIGO_USER_ID: getEnvVar('ALIGO_USER_ID'),
    ALIGO_SENDER_PHONE: getEnvVar('ALIGO_SENDER_PHONE'),

    // 기본 Sender Key
    DEFAULT_SENDER_KEY: getEnvVar('DEFAULT_SENDER_KEY'),
    DEFAULT_CHANNEL_NAME: process.env.DEFAULT_CHANNEL_NAME || '통하리',

    // Supabase
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
    DEV_SUPABASE_URL: devSupabaseUrl,
    DEV_SUPABASE_SERVICE_ROLE_KEY: devSupabaseServiceRoleKey,
    hasDevelopmentDatabase,
    BUILDING_WRITE_OPERATION_TARGETS: buildingWriteOperationTargets,

    // 큐 설정
    QUEUE_CONCURRENCY: getEnvNumber('QUEUE_CONCURRENCY', 5),
    QUEUE_MAX_SIZE: getEnvNumber('QUEUE_MAX_SIZE', 100),

    // KG이니시스 통합인증
    KG_INICIS_MID: getEnvVar('KG_INICIS_MID', false),
    KG_INICIS_API_KEY: getEnvVar('KG_INICIS_API_KEY', false),
    KG_INICIS_ALLOWED_HOSTS: process.env.KG_INICIS_ALLOWED_HOSTS || '',

    // GIS & Public Data API
    VWORLD_API_KEY: process.env.VWORLD_API_KEY || '',
    VWORLD_API_DOMAIN: process.env.VWORLD_API_DOMAIN || process.env.VWORLD_DOMAIN || 'www.tonghari.kr',
    VWORLD_ATTR_REQUEST_INTERVAL_MS: getEnvNumber('VWORLD_ATTR_REQUEST_INTERVAL_MS', 300),
    DATA_PORTAL_API_KEY: process.env.DATA_PORTAL_API_KEY || '',
    LAND_AREA_SYNC_ENABLED: parseExactTrueFeatureFlag(process.env.LAND_AREA_SYNC_ENABLED),
    LAND_AREA_SYNC_ALLOWED_TARGETS:
        landAreaSyncAllowedTargetsManifest.allowedTargets,
    LAND_AREA_SYNC_ALLOWED_TARGETS_MANIFEST:
        landAreaSyncAllowedTargetsManifest,

    // 헬퍼
    isDevelopment: process.env.NODE_ENV === 'development',
    isProduction: process.env.NODE_ENV === 'production',
};

export default env;

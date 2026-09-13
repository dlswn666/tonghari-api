import dotenv from 'dotenv';
import { normalizeDataPortalApiKey } from '../utils/data-portal-api-key';
import type { DatabaseTarget } from '../types/database.types';
import { parseExactTrueFeatureFlag } from './feature-flags';
import { createLandAreaSyncAllowedTargetsManifest } from '../security/land-area-sync-canary-policy';
import { parseVworldRequestIntervalMs } from '../utils/vworld-request-interval';

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

// GIS MCP는 잘못된 운영 상한이 전체 API startup을 막지 않고
// 해당 endpoint만 503으로 닫히도록 NaN을 설정 검증 계층에 전달한다.
function getStrictOptionalEnvInteger(
    key: string,
    defaultValue: number
): number {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') return defaultValue;
    const normalized = raw.trim();
    if (!/^-?\d+$/.test(normalized)) return Number.NaN;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
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
    KG_INICIS_ENABLED: parseExactTrueFeatureFlag(process.env.KG_INICIS_ENABLED),
    KG_INICIS_DATABASE_TARGET: getEnvVar('KG_INICIS_DATABASE_TARGET', false),
    KG_INICIS_MID: getEnvVar('KG_INICIS_MID', false),
    KG_INICIS_API_KEY: getEnvVar('KG_INICIS_API_KEY', false),
    KG_INICIS_SEED_IV: getEnvVar('KG_INICIS_SEED_IV', false),
    KG_INICIS_CALLBACK_BASE_URL: getEnvVar('KG_INICIS_CALLBACK_BASE_URL', false),
    KG_INICIS_ID_PROVIDERS: getEnvVar('KG_INICIS_ID_PROVIDERS', false),

    // GIS & Public Data API
    VWORLD_API_KEY: process.env.VWORLD_API_KEY || '',
    VWORLD_API_DOMAIN: process.env.VWORLD_API_DOMAIN || process.env.VWORLD_DOMAIN || 'www.tonghari.kr',
    VWORLD_ATTR_REQUEST_INTERVAL_MS: parseVworldRequestIntervalMs(
        process.env.VWORLD_ATTR_REQUEST_INTERVAL_MS
    ),
    DATA_PORTAL_API_KEY: normalizeDataPortalApiKey(process.env.DATA_PORTAL_API_KEY),
    GIS_MCP_TOKEN_REGISTRY_FILE: getEnvVar('GIS_MCP_TOKEN_REGISTRY_FILE', false),
    GIS_MCP_TOKEN_REGISTRY_JSON: getEnvVar('GIS_MCP_TOKEN_REGISTRY_JSON', false),
    GIS_MCP_TOKEN_SHA256: getEnvVar('GIS_MCP_TOKEN_SHA256', false),
    GIS_MCP_PROXY_TOKEN_SHA256: getEnvVar('GIS_MCP_PROXY_TOKEN_SHA256', false),
    GIS_MCP_ALLOWED_HOSTS: getEnvVar('GIS_MCP_ALLOWED_HOSTS', false),
    GIS_MCP_ALLOWED_ORIGINS: getEnvVar('GIS_MCP_ALLOWED_ORIGINS', false),
    GIS_MCP_REQUESTS_PER_MINUTE: getStrictOptionalEnvInteger(
        'GIS_MCP_REQUESTS_PER_MINUTE',
        20
    ),
    GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE: getStrictOptionalEnvInteger(
        'GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE',
        40
    ),
    GIS_MCP_REQUEST_DEADLINE_MS: getStrictOptionalEnvInteger(
        'GIS_MCP_REQUEST_DEADLINE_MS',
        45_000
    ),
    GIS_MCP_MAX_CONCURRENCY: getStrictOptionalEnvInteger(
        'GIS_MCP_MAX_CONCURRENCY',
        2
    ),
    GIS_MCP_MAX_QUEUE: getStrictOptionalEnvInteger('GIS_MCP_MAX_QUEUE', 4),
    LAND_AREA_SYNC_ENABLED: parseExactTrueFeatureFlag(process.env.LAND_AREA_SYNC_ENABLED),
    LAND_AREA_SYNC_ALLOWED_TARGETS:
        landAreaSyncAllowedTargetsManifest.allowedTargets,
    LAND_AREA_SYNC_ALLOWED_TARGETS_MANIFEST:
        landAreaSyncAllowedTargetsManifest,

    // 현행 정비사업 법률 MCP
    LAW_API_OC: getEnvVar('LAW_API_OC', false),
    LEGAL_MCP_TOKEN_SHA256: getEnvVar('LEGAL_MCP_TOKEN_SHA256', false),
    LEGAL_MCP_TOKEN_REGISTRY_JSON: getEnvVar('LEGAL_MCP_TOKEN_REGISTRY_JSON', false),
    LEGAL_MCP_TOKEN_REGISTRY_FILE: getEnvVar('LEGAL_MCP_TOKEN_REGISTRY_FILE', false),
    LEGAL_MCP_PROXY_TOKEN_SHA256: getEnvVar('LEGAL_MCP_PROXY_TOKEN_SHA256', false),
    LEGAL_MCP_PACKET_SIGNING_KEY: getEnvVar('LEGAL_MCP_PACKET_SIGNING_KEY', false),
    LEGAL_MCP_ALLOWED_HOSTS: getEnvVar('LEGAL_MCP_ALLOWED_HOSTS', false),
    LEGAL_MCP_ALLOWED_ORIGINS: getEnvVar('LEGAL_MCP_ALLOWED_ORIGINS', false),
    LEGAL_MCP_RESEARCH_REQUESTS_PER_MINUTE: getEnvNumber(
        'LEGAL_MCP_RESEARCH_REQUESTS_PER_MINUTE',
        6
    ),
    LEGAL_MCP_RESEARCH_GLOBAL_REQUESTS_PER_MINUTE: getEnvNumber(
        'LEGAL_MCP_RESEARCH_GLOBAL_REQUESTS_PER_MINUTE',
        12
    ),
    LEGAL_MCP_RESEARCH_DEADLINE_MS: getEnvNumber('LEGAL_MCP_RESEARCH_DEADLINE_MS', 45_000),
    LEGAL_MCP_RESEARCH_MAX_CONCURRENCY: getEnvNumber('LEGAL_MCP_RESEARCH_MAX_CONCURRENCY', 2),
    LEGAL_MCP_RESEARCH_MAX_QUEUE: getEnvNumber('LEGAL_MCP_RESEARCH_MAX_QUEUE', 4),

    // 헬퍼
    isDevelopment: process.env.NODE_ENV === 'development',
    isProduction: process.env.NODE_ENV === 'production',
};

export default env;

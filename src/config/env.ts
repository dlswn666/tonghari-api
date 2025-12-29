import dotenv from 'dotenv';

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

export const env = {
    // 서버 설정
    PORT: parseInt(process.env.PORT || '3100', 10),
    NODE_ENV: process.env.NODE_ENV || 'development',
    
    // JWT 인증 (Shared Secret 방식)
    JWT_SECRET: getEnvVar('JWT_SECRET'),
    
    // 알리고 API
    ALIGO_API_KEY: getEnvVar('ALIGO_API_KEY'),
    ALIGO_USER_ID: getEnvVar('ALIGO_USER_ID'),
    ALIGO_SENDER_PHONE: getEnvVar('ALIGO_SENDER_PHONE'),
    
    // 기본 Sender Key
    DEFAULT_SENDER_KEY: getEnvVar('DEFAULT_SENDER_KEY'),
    DEFAULT_CHANNEL_NAME: process.env.DEFAULT_CHANNEL_NAME || '조합온',
    
    // Supabase
    SUPABASE_URL: getEnvVar('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: getEnvVar('SUPABASE_SERVICE_ROLE_KEY'),
    
    // 큐 설정
    QUEUE_CONCURRENCY: getEnvNumber('QUEUE_CONCURRENCY', 5),
    QUEUE_MAX_SIZE: getEnvNumber('QUEUE_MAX_SIZE', 100),
    
    // GIS & Public Data API
    VWORLD_API_KEY: process.env.VWORLD_API_KEY || '',
    DATA_PORTAL_API_KEY: process.env.DATA_PORTAL_API_KEY || '',

    // 헬퍼
    isDevelopment: process.env.NODE_ENV === 'development',
    isProduction: process.env.NODE_ENV === 'production',
};

export default env;


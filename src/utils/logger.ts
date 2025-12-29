/**
 * 중앙 집중식 로거 유틸리티
 * 
 * - 로그 레벨 지원 (DEBUG, INFO, WARN, ERROR)
 * - 네임스페이스(Category) 지원
 * - 터미널 색상 출력 지원
 */

enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

const COLORS = {
    DEBUG: '\x1b[36m', // Cyan
    INFO: '\x1b[32m',  // Green
    WARN: '\x1b[33m',  // Yellow
    ERROR: '\x1b[31m', // Red
    RESET: '\x1b[0m',
    GRAY: '\x1b[90m',
};

class Logger {
    private category: string;
    private level: LogLevel = LogLevel.INFO;

    constructor(category: string = 'SERVER') {
        this.category = category.toUpperCase();
        
        // 환경 변수에 따른 최소 로그 레벨 설정
        const envLevel = process.env.LOG_LEVEL?.toUpperCase();
        if (envLevel && envLevel in LogLevel) {
            this.level = LogLevel[envLevel as keyof typeof LogLevel];
        }
    }

    private formatMessage(level: keyof typeof LogLevel, message: string): string {
        const timestamp = new Date().toISOString();
        const color = COLORS[level] || COLORS.RESET;
        return `${COLORS.GRAY}[${timestamp}]${COLORS.RESET} ${color}[${level}]${COLORS.RESET} ${COLORS.GRAY}[${this.category}]${COLORS.RESET} ${message}`;
    }

    debug(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.DEBUG) {
            console.debug(this.formatMessage('DEBUG', message), ...args);
        }
    }

    info(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.INFO) {
            console.info(this.formatMessage('INFO', message), ...args);
        }
    }

    warn(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.WARN) {
            console.warn(this.formatMessage('WARN', message), ...args);
        }
    }

    error(message: string, error?: any, ...args: any[]): void {
        if (this.level <= LogLevel.ERROR) {
            const errorMsg = error instanceof Error ? error.stack || error.message : error;
            console.error(this.formatMessage('ERROR', message), errorMsg ? `\n${errorMsg}` : '', ...args);
        }
    }

    /**
     * 특정 카테고리의 하위 로거 생성
     */
    child(subCategory: string): Logger {
        return new Logger(`${this.category}:${subCategory}`);
    }
}

// 기본 로거 인스턴스
export const logger = new Logger();

// 카테고리별 편리한 생성기
export const createLogger = (category: string) => new Logger(category);

export default logger;

export interface RateLimitDecision {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
}

interface RateLimitWindow {
    count: number;
    resetAt: number;
}

/** 단일 프로세스용 고정 구간 limiter. 재시작 시 초기화되며 외부 API 보호용 1차 방어선이다. */
export class FixedWindowRateLimiter {
    private readonly windows = new Map<string, RateLimitWindow>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
    ) {}

    consume(key: string, now = Date.now()): RateLimitDecision {
        const existing = this.windows.get(key);
        const window = !existing || existing.resetAt <= now
            ? { count: 0, resetAt: now + this.windowMs }
            : existing;

        window.count += 1;
        this.windows.set(key, window);

        const allowed = window.count <= this.limit;
        return {
            allowed,
            remaining: Math.max(0, this.limit - window.count),
            retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
        };
    }
}

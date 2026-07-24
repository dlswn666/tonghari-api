import { Router, Request, Response } from 'express';
import { env } from '../config/env';
import { queueService } from '../services/queue.service';
import { createBuildInfo } from '../utils/build-info';

const router = Router();

function landAreaSyncHealthFeatures() {
    const enabled = env.LAND_AREA_SYNC_ENABLED;
    return {
        landAreaSyncEnabled: enabled,
        landAreaSyncAllowedTargetCount: enabled
            ? env.LAND_AREA_SYNC_ALLOWED_TARGETS_MANIFEST.count
            : 0,
        landAreaSyncAllowedTargetsDigest: enabled
            ? env.LAND_AREA_SYNC_ALLOWED_TARGETS_MANIFEST.digest
            : '',
    };
}

/**
 * 메모리 사용량을 바이트에서 MB로 변환
 */
function formatMemoryUsage(bytes: number): number {
    return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

/**
 * 헬스체크 엔드포인트
 * GET /health
 */
router.get('/', (req: Request, res: Response) => {
    const memoryUsage = process.memoryUsage();
    const queueStatus = queueService.getQueueStatus();
    const buildInfo = createBuildInfo();

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        ...buildInfo,
        features: {
            ...landAreaSyncHealthFeatures(),
        },
        uptime: process.uptime(),
        memory: {
            heapUsed: formatMemoryUsage(memoryUsage.heapUsed),
            heapTotal: formatMemoryUsage(memoryUsage.heapTotal),
            rss: formatMemoryUsage(memoryUsage.rss),
            external: formatMemoryUsage(memoryUsage.external),
            unit: 'MB',
        },
        queue: {
            pending: queueStatus.pending,
            running: queueStatus.running,
            concurrency: queueStatus.concurrency,
            maxSize: queueStatus.maxSize,
            isFull: queueStatus.isFull,
        },
    });
});

/**
 * 상세 헬스체크 엔드포인트 (모니터링용)
 * GET /health/detailed
 */
router.get('/detailed', async (req: Request, res: Response) => {
    const memoryUsage = process.memoryUsage();
    const queueStatus = queueService.getQueueStatus();
    const cpuUsage = process.cpuUsage();
    const buildInfo = createBuildInfo();

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        ...buildInfo,
        features: {
            ...landAreaSyncHealthFeatures(),
        },
        node: {
            version: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        process: {
            pid: process.pid,
            uptime: process.uptime(),
            uptimeFormatted: formatUptime(process.uptime()),
        },
        memory: {
            heapUsed: formatMemoryUsage(memoryUsage.heapUsed),
            heapTotal: formatMemoryUsage(memoryUsage.heapTotal),
            rss: formatMemoryUsage(memoryUsage.rss),
            external: formatMemoryUsage(memoryUsage.external),
            arrayBuffers: formatMemoryUsage(memoryUsage.arrayBuffers || 0),
            unit: 'MB',
        },
        cpu: {
            user: cpuUsage.user,
            system: cpuUsage.system,
        },
        queue: {
            pending: queueStatus.pending,
            running: queueStatus.running,
            concurrency: queueStatus.concurrency,
            maxSize: queueStatus.maxSize,
            isFull: queueStatus.isFull,
            available: queueStatus.maxSize - queueStatus.pending - queueStatus.running,
        },
        environment: {
            nodeEnv: process.env.NODE_ENV || 'development',
            port: process.env.PORT || 3100,
        },
    });
});

/**
 * 업타임을 사람이 읽기 쉬운 형식으로 변환
 */
function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
}

export default router;

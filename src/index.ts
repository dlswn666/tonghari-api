import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import routes from './routes';
import { loggerMiddleware, errorHandler, notFoundHandler } from './middleware';
import { logger } from './utils/logger';
import { kgInicisService } from './services/kg-inicis.service';
import {
    createLegalMcpRoute,
    type LegalMcpRouteHandle,
} from './routes/legal-mcp';
import { createLegalMcpRuntimeDependenciesV1 } from './services/legal-research/mcp-runtime';
import { getLegalMcpConfigurationStateV1 } from './services/legal-research/mcp-config';
import { createLegalMcpTokenRegistryFileProviderV1 } from './middleware/legal-mcp-token-registry-file';
import {
    setGisMcpHealthTokenRegistryFileProviderV1,
    setLegalMcpHealthTokenRegistryFileProviderV1,
} from './routes/health';
import {
    createGisMcpRoute,
    type GisMcpRouteHandle,
} from './routes/gis-mcp';
import { createPublicDataMcpRuntimeDependenciesV1 } from './services/public-data-mcp/runtime';
import { getGisMcpConfigurationStateV1 } from './services/public-data-mcp/mcp-config';
import { createGisMcpTokenRegistryFileProviderV1 } from './middleware/gis-mcp-token-registry-file';
import { closeServerAndMcpWithHardTimeoutV1 } from './utils/graceful-shutdown';

// Express 앱 생성
const app = express();

const legalMcpConfiguration = getLegalMcpConfigurationStateV1({
    lawApiOc: env.LAW_API_OC,
    tokenSha256: env.LEGAL_MCP_TOKEN_SHA256,
    tokenRegistryJson: env.LEGAL_MCP_TOKEN_REGISTRY_JSON,
    tokenRegistryFile: env.LEGAL_MCP_TOKEN_REGISTRY_FILE,
    proxyTokenSha256: env.LEGAL_MCP_PROXY_TOKEN_SHA256,
    packetSigningKey: env.LEGAL_MCP_PACKET_SIGNING_KEY,
    allowedHosts: env.LEGAL_MCP_ALLOWED_HOSTS,
});
const legalMcpConfigured = legalMcpConfiguration.configured;
const legalMcpTokenRegistryFileProvider =
    legalMcpConfigured
        && legalMcpConfiguration.authSource === 'file_registry'
        ? createLegalMcpTokenRegistryFileProviderV1(
            env.LEGAL_MCP_TOKEN_REGISTRY_FILE
        )
        : undefined;
setLegalMcpHealthTokenRegistryFileProviderV1(
    legalMcpTokenRegistryFileProvider,
    legalMcpConfiguration
);
const gisMcpConfiguration = getGisMcpConfigurationStateV1({
    vworldApiKey: env.VWORLD_API_KEY,
    vworldApiDomain: env.VWORLD_API_DOMAIN,
    dataPortalApiKey: env.DATA_PORTAL_API_KEY,
    tokenSha256: env.GIS_MCP_TOKEN_SHA256,
    tokenRegistryJson: env.GIS_MCP_TOKEN_REGISTRY_JSON,
    tokenRegistryFile: env.GIS_MCP_TOKEN_REGISTRY_FILE,
    proxyTokenSha256: env.GIS_MCP_PROXY_TOKEN_SHA256,
    allowedHosts: env.GIS_MCP_ALLOWED_HOSTS,
    allowedOrigins: env.GIS_MCP_ALLOWED_ORIGINS,
    requestsPerMinute: env.GIS_MCP_REQUESTS_PER_MINUTE,
    globalRequestsPerMinute: env.GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE,
    requestDeadlineMs: env.GIS_MCP_REQUEST_DEADLINE_MS,
    maxConcurrency: env.GIS_MCP_MAX_CONCURRENCY,
    maxQueue: env.GIS_MCP_MAX_QUEUE,
});
const gisMcpConfigured = gisMcpConfiguration.configured;
const gisMcpTokenRegistryFileProvider =
    gisMcpConfigured
        && gisMcpConfiguration.authSource === 'file_registry'
        ? createGisMcpTokenRegistryFileProviderV1(
            env.GIS_MCP_TOKEN_REGISTRY_FILE
        )
        : undefined;
setGisMcpHealthTokenRegistryFileProviderV1(
    gisMcpTokenRegistryFileProvider,
    gisMcpConfiguration
);

let legalMcp: LegalMcpRouteHandle | null = null;
let gisMcp: GisMcpRouteHandle | null = null;

// MCP는 전역 1mb body parser보다 먼저 mount해야 전용 256kb 제한을 보장한다.
if (legalMcpConfigured) {
    legalMcp = createLegalMcpRoute({
        dependencies: createLegalMcpRuntimeDependenciesV1({
            lawApiOc: env.LAW_API_OC,
            researchDeadlineMs: env.LEGAL_MCP_RESEARCH_DEADLINE_MS,
            maxConcurrentResearch: env.LEGAL_MCP_RESEARCH_MAX_CONCURRENCY,
            maxQueuedResearch: env.LEGAL_MCP_RESEARCH_MAX_QUEUE,
        }),
        tokenSha256: env.LEGAL_MCP_TOKEN_SHA256,
        tokenRegistryJson: env.LEGAL_MCP_TOKEN_REGISTRY_JSON,
        tokenRegistryFile: legalMcpTokenRegistryFileProvider
            ? ''
            : env.LEGAL_MCP_TOKEN_REGISTRY_FILE,
        tokenRegistryFileProvider: legalMcpTokenRegistryFileProvider,
        proxyTokenSha256: env.LEGAL_MCP_PROXY_TOKEN_SHA256,
        packetSigningKey: env.LEGAL_MCP_PACKET_SIGNING_KEY,
        allowedHosts: env.LEGAL_MCP_ALLOWED_HOSTS,
        allowedOrigins: env.LEGAL_MCP_ALLOWED_ORIGINS,
        researchRequestsPerMinute:
            env.LEGAL_MCP_RESEARCH_REQUESTS_PER_MINUTE,
        globalResearchRequestsPerMinute:
            env.LEGAL_MCP_RESEARCH_GLOBAL_REQUESTS_PER_MINUTE,
        onError: (error) => {
            logger.error('Legal MCP transport error', {
                errorName: error.name,
            });
        },
    });
    app.use('/mcp', legalMcp.router);
} else {
    app.use('/mcp', (_request, response) => {
        response.set('Cache-Control', 'no-store');
        response.status(503).json({
            error: 'LEGAL_MCP_NOT_CONFIGURED',
        });
    });
}

if (gisMcpConfigured) {
    gisMcp = createGisMcpRoute({
        dependencies: createPublicDataMcpRuntimeDependenciesV1({
            requestDeadlineMs: env.GIS_MCP_REQUEST_DEADLINE_MS,
            maxConcurrentRequests: env.GIS_MCP_MAX_CONCURRENCY,
            maxQueuedRequests: env.GIS_MCP_MAX_QUEUE,
        }),
        tokenSha256: env.GIS_MCP_TOKEN_SHA256,
        tokenRegistryJson: env.GIS_MCP_TOKEN_REGISTRY_JSON,
        tokenRegistryFile: gisMcpTokenRegistryFileProvider
            ? ''
            : env.GIS_MCP_TOKEN_REGISTRY_FILE,
        tokenRegistryFileProvider: gisMcpTokenRegistryFileProvider,
        proxyTokenSha256: env.GIS_MCP_PROXY_TOKEN_SHA256,
        allowedHosts: env.GIS_MCP_ALLOWED_HOSTS,
        allowedOrigins: env.GIS_MCP_ALLOWED_ORIGINS,
        requestsPerMinute: env.GIS_MCP_REQUESTS_PER_MINUTE,
        globalRequestsPerMinute: env.GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE,
        onError: (error) => {
            logger.error('GIS MCP transport error', {
                errorName: error.name,
            });
        },
    });
    app.use('/gis-mcp', gisMcp.router);
} else {
    app.use('/gis-mcp', (_request, response) => {
        response.set('Cache-Control', 'no-store');
        response.status(503).json({
            error: 'GIS_MCP_NOT_CONFIGURED',
        });
    });
}

// 미들웨어 설정
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(loggerMiddleware);

// 라우트 설정
app.use(routes);

// 404 핸들러
app.use(notFoundHandler);

// 에러 핸들러
app.use(errorHandler);

// 서버 시작
const server = app.listen(env.PORT, () => {
    logger.info('Alimtalk Proxy Server started');
    logger.info(`Environment: ${env.NODE_ENV}, Port: ${env.PORT}`);
    logger.info(`Development database routing: ${env.hasDevelopmentDatabase ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`Legal MCP Config - ${legalMcpConfigured ? 'CONFIGURED' : 'NOT CONFIGURED (endpoint disabled)'}`);
    logger.info(`GIS MCP Config - ${gisMcpConfigured ? 'CONFIGURED' : 'NOT CONFIGURED (endpoint disabled)'}`);
    
    // GIS 환경 변수 상태 로깅
    logger.info(`GIS Config - VWORLD_API_KEY: ${env.VWORLD_API_KEY ? 'SET' : 'NOT SET'}`);
    logger.info(`GIS Config - VWORLD_API_DOMAIN: ${env.VWORLD_API_DOMAIN}`);
    logger.info(`GIS Config - DATA_PORTAL_API_KEY: ${env.DATA_PORTAL_API_KEY ? 'SET' : 'NOT SET'}`);
    logger.info(`GIS Config - LAND_AREA_SYNC: ${env.LAND_AREA_SYNC_ENABLED ? 'ENABLED' : 'DISABLED'}`);

    // 계정 값 존재와 실제 사용 가능 여부를 구분하고 민감한 설정은 출력하지 않는다.
    const identityReadiness = kgInicisService.getReadiness(env.KG_INICIS_DATABASE_TARGET);
    logger.info(`KG이니시스 - ${!identityReadiness.enabled ? 'DISABLED' : identityReadiness.available ? 'READY' : 'UNAVAILABLE'}`);
});

// Graceful shutdown
let shuttingDown = false;
const SHUTDOWN_HARD_TIMEOUT_MS = 10_000;

function shutdown(signal: 'SIGTERM' | 'SIGINT'): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`${signal} signal received. Shutting down server...`);
    kgInicisService.destroy();
    void closeServerAndMcpWithHardTimeoutV1({
        server,
        closeMcp: async () => {
            const results = await Promise.allSettled([
                legalMcp?.close() ?? Promise.resolve(),
                gisMcp?.close() ?? Promise.resolve(),
            ]);
            const failures = results
                .filter((result): result is PromiseRejectedResult =>
                    result.status === 'rejected'
                )
                .map((result) => result.reason);
            if (failures.length > 0) {
                throw new AggregateError(failures, 'MCP close failed');
            }
        },
        timeoutMs: SHUTDOWN_HARD_TIMEOUT_MS,
        onForceClose: () => {
            logger.error('Graceful shutdown timed out; forcing open HTTP connections closed');
        },
    }).then(({ forced, results }) => {
        if (forced || results === null) {
            process.exit(1);
            return;
        }
        const [httpResult, mcpResult] = results;
        if (mcpResult.status === 'rejected') {
            logger.error('MCP endpoints close failed', {
                errorName: mcpResult.reason instanceof Error
                    ? mcpResult.reason.name
                    : 'UnknownError',
            });
        }
        if (httpResult.status === 'rejected') {
            logger.error('Server close failed', {
                errorName: httpResult.reason instanceof Error
                    ? httpResult.reason.name
                    : 'UnknownError',
            });
        }
        if (results.some((result) => result.status === 'rejected')) {
            process.exit(1);
        }
        logger.info('Server closed successfully');
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;

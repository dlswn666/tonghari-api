import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import routes from './routes';
import { loggerMiddleware, errorHandler, notFoundHandler } from './middleware';
import { logger } from './utils/logger';
import { kgInicisService } from './services/kg-inicis.service';

// Express 앱 생성
const app = express();

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
    
    // GIS 환경 변수 상태 로깅
    logger.info(`GIS Config - VWORLD_API_KEY: ${env.VWORLD_API_KEY ? 'SET' : 'NOT SET'}`);
    logger.info(`GIS Config - VWORLD_API_DOMAIN: ${env.VWORLD_API_DOMAIN}`);
    logger.info(`GIS Config - DATA_PORTAL_API_KEY: ${env.DATA_PORTAL_API_KEY ? 'SET' : 'NOT SET'}`);
    logger.info(`GIS Config - LAND_AREA_SYNC: ${env.LAND_AREA_SYNC_ENABLED ? 'ENABLED' : 'DISABLED'}`);

    // KG이니시스 통합인증 환경 변수 상태 로깅
    const kgInicisConfigured = env.KG_INICIS_MID && env.KG_INICIS_API_KEY;
    logger.info(`KG이니시스 Config - ${kgInicisConfigured ? 'CONFIGURED' : 'NOT CONFIGURED (통합인증 API 비활성)'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.warn('SIGTERM signal received. Shutting down server...');
    kgInicisService.destroy();
    server.close(() => {
        logger.info('Server closed successfully');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.warn('SIGINT signal received. Shutting down server...');
    kgInicisService.destroy();
    server.close(() => {
        logger.info('Server closed successfully');
        process.exit(0);
    });
});

export default app;

import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import routes from './routes';
import { loggerMiddleware, errorHandler, notFoundHandler } from './middleware';
import { logger } from './utils/logger';

// Express 앱 생성
const app = express();

// 미들웨어 설정
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(loggerMiddleware);

// 라우트 설정
app.use(routes);

// 404 핸들러
app.use(notFoundHandler);

// 에러 핸들러
app.use(errorHandler);

// 서버 시작
const server = app.listen(env.PORT, () => {
    logger.info('알림톡 프록시 서버 시작됨');
    logger.info(`환경: ${env.NODE_ENV}, 포트: ${env.PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.warn('SIGTERM 시그널 수신. 서버 종료 중...');
    server.close(() => {
        logger.info('서버가 정상적으로 종료되었습니다.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.warn('SIGINT 시그널 수신. 서버 종료 중...');
    server.close(() => {
        logger.info('서버가 정상적으로 종료되었습니다.');
        process.exit(0);
    });
});

export default app;


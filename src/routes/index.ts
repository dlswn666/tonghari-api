import { Router } from 'express';
import healthRouter from './health';
import alimtalkRouter from './alimtalk';
import gisRouter from './gis';

const router = Router();

// 헬스체크 라우트
router.use('/health', healthRouter);

// 알림톡 API 라우트
router.use('/api/alimtalk', alimtalkRouter);

// GIS API 라우트
router.use('/api/gis', gisRouter);

export default router;


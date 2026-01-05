import { Router } from 'express';
import healthRouter from './health';
import alimtalkRouter from './alimtalk';
import gisRouter from './gis';
import memberRouter from './member';
import consentRouter from './consent';

const router = Router();

// 헬스체크 라우트
router.use('/health', healthRouter);

// 알림톡 API 라우트
router.use('/api/alimtalk', alimtalkRouter);

// GIS API 라우트
router.use('/api/gis', gisRouter);

// 조합원 대량 처리 API 라우트
router.use('/api/member', memberRouter);

// 동의 처리 API 라우트
router.use('/api/consent', consentRouter);

export default router;


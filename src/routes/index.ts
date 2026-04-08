import { Router } from 'express';
import healthRouter from './health';
import alimtalkRouter from './alimtalk';
import smsRouter from './sms';
import gisRouter from './gis';
import memberRouter from './member';
import consentRouter from './consent';
import kgInicisRouter from './kg-inicis';

const router = Router();

// 헬스체크 라우트
router.use('/health', healthRouter);

// 알림톡 API 라우트
router.use('/api/alimtalk', alimtalkRouter);

// SMS API 라우트
router.use('/api/sms', smsRouter);

// GIS API 라우트
router.use('/api/gis', gisRouter);

// 조합원 대량 처리 API 라우트
router.use('/api/member', memberRouter);

// 동의 처리 API 라우트
router.use('/api/consent', consentRouter);

// KG이니시스 통합인증 API 라우트
router.use('/api/kg-inicis', kgInicisRouter);

export default router;


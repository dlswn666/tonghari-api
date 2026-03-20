import { Router } from 'express';
import healthRouter from './health';
import alimtalkRouter from './alimtalk';
import smsRouter from './sms';
import gisRouter from './gis';
import memberRouter from './member';
import consentRouter from './consent';
import niceRouter from './nice';

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

// NICE 본인인증 API 라우트
router.use('/api/nice', niceRouter);

export default router;


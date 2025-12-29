import { Router } from 'express';
import { gisQueueService } from '../services/gis.queue.service';

const router = Router();

/**
 * GIS 데이터 동기화 요청
 */
router.post('/sync', async (req, res) => {
    const { unionId, addresses } = req.body;

    if (!unionId || !Array.isArray(addresses)) {
        return res.status(400).json({ error: 'unionId와 addresses(배열)가 필요합니다.' });
    }

    try {
        const jobInfo = await gisQueueService.addSyncJob({ unionId, addresses });
        res.json(jobInfo);
    } catch (error) {
        console.error('GIS 동기화 요청 실패:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

/**
 * 작업 상태 조회
 */
router.get('/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const jobStatus = gisQueueService.getJobStatus(jobId);

    if (!jobStatus) {
        return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
    }

    res.json(jobStatus);
});

export default router;

import { Router } from 'express';
import { gisQueueService } from '../services/gis.queue.service';

const router = Router();

/**
 * GIS 데이터 동기화 요청
 */
router.post('/sync', async (req, res) => {
    const { unionId, addresses } = req.body;

    if (!unionId || !Array.isArray(addresses)) {
        return res.status(400).json({ error: 'unionId and addresses (array) are required.' });
    }

    try {
        const jobInfo = await gisQueueService.addSyncJob({ unionId, addresses });
        res.json(jobInfo);
    } catch (error) {
        console.error('GIS sync request failed:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * 작업 상태 조회
 */
router.get('/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const jobStatus = gisQueueService.getJobStatus(jobId);

    if (!jobStatus) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    res.json(jobStatus);
});

export default router;

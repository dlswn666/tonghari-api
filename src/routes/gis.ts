import { Router } from 'express';
import { gisQueueService } from '../services/gis.queue.service';
import { gisService } from '../services/gis.service';
import { supabaseService } from '../services/supabase.service';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('GIS-ROUTE');

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

/**
 * 주소 검색 (PNU만 반환)
 * source: 'vworld' | 'data_portal'
 */
router.post('/search-address', async (req, res) => {
    const { address, source } = req.body;

    if (!address || typeof address !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'address is required.',
        });
    }

    const validSources = ['vworld', 'data_portal'];
    const selectedSource = validSources.includes(source) ? source : 'vworld';

    try {
        logger.info(`Address search request: "${address}" via ${selectedSource}`);

        let result = null;

        if (selectedSource === 'vworld') {
            result = await gisService.searchAddressByVworld(address);
        } else {
            result = await gisService.searchAddressByDataPortal(address);
        }

        if (result) {
            logger.info(`Address search success: ${address} -> PNU: ${result.pnu}`);
            return res.json({
                success: true,
                data: {
                    address: result.address,
                    pnu: result.pnu,
                },
            });
        }

        logger.warn(`Address search failed: ${address} (no result)`);
        return res.json({
            success: false,
            data: null,
            message: '검색 결과가 없습니다.',
        });
    } catch (error: any) {
        logger.error(`Address search error: ${address}`, error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error.',
        });
    }
});

/**
 * 주소 추가 (전체 데이터 조회 후 DB 저장)
 */
router.post('/add-address', async (req, res) => {
    const { unionId, address, pnu } = req.body;

    if (!unionId || !address || !pnu) {
        return res.status(400).json({
            success: false,
            error: 'unionId, address, pnu are required.',
        });
    }

    try {
        logger.info(`Manual address add request: unionId=${unionId}, pnu=${pnu}`);

        // 1. 전체 토지 정보 조회
        const landInfo = await gisService.getFullLandInfo(pnu, address);

        // 2. land_lots 테이블에 저장
        const landLotSaved = await supabaseService.upsertLandLot({
            pnu: landInfo.pnu,
            address: landInfo.address,
            area: landInfo.area ?? undefined,
            official_price: landInfo.officialPrice ?? undefined,
            boundary: landInfo.boundary,
            owner_count: landInfo.ownerCount,
        });

        if (!landLotSaved) {
            logger.error(`Failed to save land_lot for PNU: ${pnu}`);
            return res.status(500).json({
                success: false,
                error: 'Failed to save land_lot.',
            });
        }

        // 3. union_land_lots 테이블에 관계 저장
        const unionLandLotSaved = await supabaseService.createUnionLandLot(unionId, pnu, address);

        if (!unionLandLotSaved) {
            logger.error(`Failed to save union_land_lot for PNU: ${pnu}`);
            return res.status(500).json({
                success: false,
                error: 'Failed to save union_land_lot.',
            });
        }

        logger.info(
            `Manual address add success: PNU=${pnu}, boundary=${!!landInfo.boundary}, price=${
                landInfo.officialPrice
            }, owners=${landInfo.ownerCount}`
        );

        return res.json({
            success: true,
            data: {
                pnu: landInfo.pnu,
                address: landInfo.address,
                area: landInfo.area,
                officialPrice: landInfo.officialPrice,
                ownerCount: landInfo.ownerCount,
                hasBoundary: !!landInfo.boundary,
            },
        });
    } catch (error: any) {
        logger.error(`Manual address add error: ${pnu}`, error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error.',
        });
    }
});

export default router;

import { Router } from 'express';
import { gisQueueService } from '../services/gis.queue.service';
import { gisService } from '../services/gis.service';
import { supabaseService } from '../services/supabase.service';
import { authMiddleware } from '../middleware/auth';
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
 * 공동주택공시가격 일괄 재동기화 (2026-04)
 * 해당 조합의 공동주택 세대의 building_units.official_price를 VWorld API로 재갱신
 * body: { unionId: string }
 */
router.post('/sync-apartment-prices', authMiddleware, async (req, res) => {
    const { unionId } = req.body;

    if (!unionId || typeof unionId !== 'string') {
        return res.status(400).json({ error: 'unionId is required.' });
    }

    // JWT 토큰의 unionId와 body의 unionId가 일치해야 함 (시스템관리자 토큰 제외)
    if (req.user?.unionId && req.user.unionId !== 'system' && req.user.unionId !== unionId) {
        return res.status(403).json({ error: 'unionId mismatch with authenticated token.' });
    }

    try {
        const result = await gisQueueService.addApartmentPriceSyncJob({ unionId });
        return res.json({
            jobId: result.jobId,
            totalPnu: result.totalPnu,
            status: 'pending',
        });
    } catch (error: any) {
        logger.error(`Apartment price sync request failed (unionId: ${unionId})`, error);
        return res.status(500).json({ error: error?.message || 'Internal server error.' });
    }
});

/**
 * 토지 공시지가 일괄 재동기화 (2026-04)
 * 해당 조합의 land_lots 전체 PNU 의 official_price 를 VWorld API 로 재갱신
 * body: { unionId: string }
 */
router.post('/sync-land-prices', authMiddleware, async (req, res) => {
    const { unionId } = req.body;

    if (!unionId || typeof unionId !== 'string') {
        return res.status(400).json({ error: 'unionId is required.' });
    }

    if (req.user?.unionId && req.user.unionId !== 'system' && req.user.unionId !== unionId) {
        return res.status(403).json({ error: 'unionId mismatch with authenticated token.' });
    }

    try {
        const result = await gisQueueService.addLandPriceSyncJob({ unionId });
        return res.json({
            jobId: result.jobId,
            totalPnu: result.totalPnu,
            status: 'pending',
        });
    } catch (error: any) {
        logger.error(`Land price sync request failed (unionId: ${unionId})`, error);
        return res.status(500).json({ error: error?.message || 'Internal server error.' });
    }
});

/**
 * 전체 공시가격 동기화 (토지 + 공동주택) — 두 개의 독립 sync_jobs 로 분리 등록
 * body: { unionId: string }
 */
router.post('/sync-official-prices', authMiddleware, async (req, res) => {
    const { unionId } = req.body;

    if (!unionId || typeof unionId !== 'string') {
        return res.status(400).json({ error: 'unionId is required.' });
    }

    if (req.user?.unionId && req.user.unionId !== 'system' && req.user.unionId !== unionId) {
        return res.status(403).json({ error: 'unionId mismatch with authenticated token.' });
    }

    try {
        const [landResult, apartmentResult] = await Promise.all([
            gisQueueService.addLandPriceSyncJob({ unionId }),
            gisQueueService.addApartmentPriceSyncJob({ unionId }),
        ]);

        return res.json({
            land: { jobId: landResult.jobId, totalPnu: landResult.totalPnu },
            apartment: { jobId: apartmentResult.jobId, totalPnu: apartmentResult.totalPnu },
            status: 'pending',
        });
    } catch (error: any) {
        logger.error(`Official price sync request failed (unionId: ${unionId})`, error);
        return res.status(500).json({ error: error?.message || 'Internal server error.' });
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
 * 주소 검색 (PNU 생성)
 * 법정동코드 + 지번 조합으로 PNU 생성 (API 호출 최소화)
 */
router.post('/search-address', async (req, res) => {
    const { address } = req.body;

    if (!address || typeof address !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'address is required.',
        });
    }

    try {
        logger.info(`Address search request: "${address}"`);

        // 법정동코드 기반 PNU 생성 (법정동코드 API 1회 호출)
        const pnuResult = await gisService.generatePNUFromAddress(address.trim());

        if (pnuResult) {
            logger.info(`PNU generated: ${address} -> ${pnuResult.pnu}`);
            return res.json({
                success: true,
                data: {
                    address: address.trim(),
                    pnu: pnuResult.pnu,
                    bjdCode: pnuResult.bjdCode,
                    sido: pnuResult.sido,
                    sigungu: pnuResult.sigungu,
                    dong: pnuResult.dong,
                },
            });
        }

        // 파싱 실패 시 상세 메시지 반환
        const components = gisService.parseAddressToComponents(address.trim());
        if (!components) {
            logger.warn(`Address parsing failed: ${address}`);
            return res.json({
                success: false,
                data: null,
                message: '주소 형식을 인식할 수 없습니다. (예: 서울시 강북구 미아동 123-45)',
            });
        }

        // 법정동코드 조회 실패
        logger.warn(`BJD code lookup failed for: ${components.sido} ${components.sigungu} ${components.dong}`);
        return res.json({
            success: false,
            data: null,
            message: `법정동코드를 찾을 수 없습니다: ${components.sido} ${components.sigungu} ${components.dong}`,
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

        // 2. 건물 정보 조회 (소유주 수 추정을 위해 land_lots 저장 전에 조회)
        let buildingInfo = null;
        try {
            buildingInfo = await gisService.getBuildingInfo(pnu);
            if (buildingInfo && buildingInfo.buildingType !== 'NONE') {
                logger.debug(
                    `Building info found for PNU: ${pnu} (type: ${buildingInfo.buildingType}, units: ${buildingInfo.units.length})`
                );
            }
        } catch (buildingError) {
            logger.warn(`Building info fetch failed for PNU: ${pnu}, continuing...`, buildingError);
        }

        // 3. 소유주 수 추정 (토지대장에서 조회된 값이 0인 경우, 건물 정보 기반으로 추정)
        let estimatedOwnerCount = landInfo.ownerCount;
        if (estimatedOwnerCount === 0 && buildingInfo && buildingInfo.buildingType !== 'NONE') {
            if (buildingInfo.buildingType === 'DETACHED_HOUSE') {
                // 단독주택은 소유주 1명으로 추정
                estimatedOwnerCount = 1;
                logger.info(`Owner count estimated for DETACHED_HOUSE: 1`);
            } else {
                // 다세대(VILLA, APARTMENT, COMMERCIAL, MIXED)는 세대 수로 추정
                estimatedOwnerCount = buildingInfo.units.length || 1;
                logger.info(`Owner count estimated from units (${buildingInfo.buildingType}): ${estimatedOwnerCount}`);
            }
        }

        // 4. land_lots 테이블에 저장 (추정된 소유주 수 사용)
        const landLotSaved = await supabaseService.upsertLandLot({
            pnu: landInfo.pnu,
            address: landInfo.address,
            union_id: unionId,
            area: landInfo.area ?? undefined,
            official_price: landInfo.officialPrice ?? undefined,
            boundary: landInfo.boundary,
            owner_count: estimatedOwnerCount,
        });

        if (!landLotSaved) {
            logger.error(`Failed to save land_lot for PNU: ${pnu}`);
            return res.status(500).json({
                success: false,
                error: 'Failed to save land_lot.',
            });
        }

        // 5. 건물 정보 저장
        if (buildingInfo && buildingInfo.buildingType !== 'NONE') {
            try {
                const buildingSaved = await supabaseService.saveBuildingWithUnits(pnu, buildingInfo);
                if (!buildingSaved) {
                    logger.warn(`Failed to save building info for PNU: ${pnu}, continuing...`);
                }
            } catch (buildingSaveError) {
                logger.warn(`Building info save failed for PNU: ${pnu}, continuing...`, buildingSaveError);
            }
        }

        // 6. union_land_lots 테이블에 관계 저장
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
            }, owners=${estimatedOwnerCount}, buildingType=${buildingInfo?.buildingType || 'NONE'}`
        );

        return res.json({
            success: true,
            data: {
                pnu: landInfo.pnu,
                address: landInfo.address,
                area: landInfo.area,
                officialPrice: landInfo.officialPrice,
                ownerCount: estimatedOwnerCount,
                hasBoundary: !!landInfo.boundary,
                building: buildingInfo
                    ? {
                          type: buildingInfo.buildingType,
                          name: buildingInfo.buildingName,
                          floorCount: buildingInfo.floorCount,
                          unitCount: buildingInfo.units.length,
                      }
                    : null,
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

/**
 * 수동 입력 API
 * API에서 조회되지 않는 필지를 수동으로 입력하여 저장
 */
router.post('/manual-add', async (req, res) => {
    const { unionId, address, pnu, area, officialPrice, ownerCount, boundary } = req.body;

    // 필수 필드 검증
    if (!unionId || !address || !pnu) {
        return res.status(400).json({
            success: false,
            error: 'unionId, address, pnu are required.',
        });
    }

    // PNU 형식 검증 (19자리)
    if (typeof pnu !== 'string' || pnu.length !== 19 || !/^\d+$/.test(pnu)) {
        return res.status(400).json({
            success: false,
            error: 'PNU must be a 19-digit numeric string.',
        });
    }

    try {
        logger.info(`Manual input request: unionId=${unionId}, pnu=${pnu}, address="${address}"`);

        // boundary가 WKT 형식이면 GeoJSON으로 변환
        let boundaryGeojson: GeoJSON.Geometry | null = null;
        if (boundary) {
            if (typeof boundary === 'string') {
                // WKT 형식 처리
                if (boundary.startsWith('POLYGON') || boundary.startsWith('MULTIPOLYGON')) {
                    boundaryGeojson = parseWktToGeoJson(boundary);
                    if (!boundaryGeojson) {
                        return res.status(400).json({
                            success: false,
                            error: 'Invalid WKT format for boundary.',
                        });
                    }
                } else {
                    // JSON 문자열로 시도
                    try {
                        boundaryGeojson = JSON.parse(boundary);
                    } catch {
                        return res.status(400).json({
                            success: false,
                            error: 'Invalid boundary format. Use GeoJSON or WKT.',
                        });
                    }
                }
            } else if (typeof boundary === 'object') {
                // 이미 GeoJSON 객체
                boundaryGeojson = boundary as GeoJSON.Geometry;
            }
        }

        // 1. land_lots 테이블에 저장 (수동 입력 데이터)
        const landLotSaved = await supabaseService.upsertLandLot({
            pnu: pnu,
            address: address.trim(),
            union_id: unionId,
            area: area !== undefined ? Number(area) : undefined,
            official_price: officialPrice !== undefined ? Number(officialPrice) : undefined,
            boundary: boundaryGeojson,
            owner_count: ownerCount !== undefined ? Number(ownerCount) : 0,
        });

        if (!landLotSaved) {
            logger.error(`Failed to save land_lot for PNU: ${pnu}`);
            return res.status(500).json({
                success: false,
                error: 'Failed to save land_lot.',
            });
        }

        // 2. union_land_lots 테이블에 관계 저장
        const unionLandLotSaved = await supabaseService.createUnionLandLot(unionId, pnu, address);

        if (!unionLandLotSaved) {
            logger.error(`Failed to save union_land_lot for PNU: ${pnu}`);
            return res.status(500).json({
                success: false,
                error: 'Failed to save union_land_lot.',
            });
        }

        logger.info(
            `Manual input success: PNU=${pnu}, area=${area}, price=${officialPrice}, owners=${ownerCount}, boundary=${!!boundaryGeojson}`
        );

        return res.json({
            success: true,
            data: {
                pnu: pnu,
                address: address.trim(),
                area: area !== undefined ? Number(area) : null,
                officialPrice: officialPrice !== undefined ? Number(officialPrice) : null,
                ownerCount: ownerCount !== undefined ? Number(ownerCount) : 0,
                hasBoundary: !!boundaryGeojson,
            },
        });
    } catch (error: any) {
        logger.error(`Manual input error: ${pnu}`, error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error.',
        });
    }
});

/**
 * WKT를 GeoJSON으로 변환하는 간단한 파서
 * 지원 형식: POLYGON((x1 y1, x2 y2, ...))
 */
function parseWktToGeoJson(wkt: string): GeoJSON.Geometry | null {
    try {
        const polygonMatch = wkt.match(/POLYGON\s*\(\((.+)\)\)/i);
        if (polygonMatch) {
            const coordsStr = polygonMatch[1];
            const rings = coordsStr.split('),(').map((ring) => {
                return ring
                    .replace(/[()]/g, '')
                    .split(',')
                    .map((coord) => {
                        const [x, y] = coord.trim().split(/\s+/).map(Number);
                        return [x, y] as [number, number];
                    });
            });

            return {
                type: 'Polygon',
                coordinates: rings,
            };
        }

        const multiPolygonMatch = wkt.match(/MULTIPOLYGON\s*\(\(\((.+)\)\)\)/i);
        if (multiPolygonMatch) {
            const polygonsStr = multiPolygonMatch[1];
            const polygons = polygonsStr.split(')),((').map((polygonStr) => {
                const rings = polygonStr.split('),(').map((ring) => {
                    return ring
                        .replace(/[()]/g, '')
                        .split(',')
                        .map((coord) => {
                            const [x, y] = coord.trim().split(/\s+/).map(Number);
                            return [x, y] as [number, number];
                        });
                });
                return rings;
            });

            return {
                type: 'MultiPolygon',
                coordinates: polygons,
            };
        }

        return null;
    } catch {
        return null;
    }
}

export default router;

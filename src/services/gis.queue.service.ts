import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { gisService } from './gis.service';
import { supabaseService } from './supabase.service';
import {
    GisSyncRequest,
    GisJobInfo,
    ApartmentPriceSyncRequest,
    ApartmentPriceSyncTarget,
    IndividualHousingPriceSyncRequest,
    IndividualHousingPriceSyncTarget,
    LandPriceSyncRequest,
    LandPriceSyncTarget,
} from '../types/gis.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('GIS-QUEUE');

/**
 * 실패한 주소 정보
 */
interface FailedAddress {
    address: string;
    reason: string;
    index: number;
}

/**
 * GIS 수집 큐 서비스
 */
class GisQueueService {
    private queue: PQueue;
    private jobs: Map<string, GisJobInfo>;

    constructor() {
        this.queue = new PQueue({
            concurrency: 2, // GIS API 부하 조절을 위해 낮게 설정
            timeout: 600000, // 10분
        });
        this.jobs = new Map();
    }

    async addSyncJob(request: GisSyncRequest): Promise<GisJobInfo> {
        const jobId = uuidv4();
        const jobInfo: GisJobInfo = {
            jobId,
            unionId: request.unionId,
            totalCount: request.addresses.length,
            processedCount: 0,
            status: 'pending',
            createdAt: new Date(),
        };

        this.jobs.set(jobId, jobInfo);

        // Supabase sync_jobs 테이블에 초기 등록
        try {
            const { error } = await supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                job_type: 'GIS_MAP',
                status: 'PROCESSING',
                progress: 0,
            });
            if (error) {
                logger.error(`sync_jobs insert error (${jobId}): ${JSON.stringify(error)}`);
            } else {
                logger.info(`GIS job added: ${jobId} (parcels: ${request.addresses.length})`);
            }
        } catch (error) {
            logger.error(`sync_jobs registration failed (${jobId})`, error);
        }

        this.queue
            .add(async () => {
                await this.processSyncJob(jobId, request);
            })
            .catch((err) => {
                logger.error(`GIS job ${jobId} fatal error`, err);
                this.updateJobStatus(jobId, { status: 'failed', error: err.message });
                // 실패 상태 DB 업데이트
                supabaseService.updateSyncJobStatus(jobId, 'FAILED', 0, err.message);
            });

        return jobInfo;
    }

    private async processSyncJob(jobId: string, request: GisSyncRequest) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        logger.info(`[GIS ${jobId}] Collection process started`);
        this.updateJobStatus(jobId, { status: 'processing', startedAt: new Date() });

        const failedAddresses: FailedAddress[] = [];
        const successfulPnus: string[] = [];
        let successCount = 0;

        for (let i = 0; i < request.addresses.length; i++) {
            const address = request.addresses[i];
            const currentIndex = i + 1;

            try {
                logger.debug(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Processing address: ${address}`);

                // Step 1: Geocoding (Address -> PNU + 좌표)
                const geocodeData = await gisService.getPNUFromAddress(address);
                if (!geocodeData) {
                    logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Geocoding failed: ${address}`);
                    failedAddresses.push({
                        address,
                        reason: 'Geocoding failed - 주소를 찾을 수 없습니다',
                        index: currentIndex,
                    });
                    continue;
                }

                const { pnu, x, y } = geocodeData;

                // Step 2: PNU가 없으면 실패 처리
                if (!pnu) {
                    logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) PNU not found for: ${address}`);
                    failedAddresses.push({
                        address,
                        reason: 'PNU not found - 필지 번호를 조회할 수 없습니다',
                        index: currentIndex,
                    });
                    continue;
                }

                // Step 2.5 (NEW): 필지 경계(Polygon) 데이터 조회
                let boundary: GeoJSON.Geometry | null = null;
                try {
                    // 먼저 좌표 기반으로 경계 조회 시도 (더 정확)
                    const boundaryData = await gisService.getParcelBoundaryFromCoordinates(x, y);
                    if (boundaryData) {
                        boundary = boundaryData.boundary;
                    } else {
                        // 좌표로 못 찾으면 PNU 기반으로 조회
                        boundary = await gisService.getParcelBoundary(pnu);
                    }

                    if (boundary) {
                        logger.debug(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Boundary found for: ${pnu}`);
                    } else {
                        logger.warn(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Boundary not found for: ${pnu}`
                        );
                    }
                } catch (boundaryError) {
                    logger.warn(
                        `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Boundary fetch error for: ${pnu}`,
                        boundaryError
                    );
                    // 경계를 못 찾아도 계속 진행 (PNU와 주소는 저장)
                }

                // Step 2.6: 토지대장 정보 조회 (면적 + 소유자수 + 지목) - Vworld API
                let ownerCount = 0;
                let area: number | undefined = undefined;
                let landCategory: string | null = null;
                try {
                    const registryInfo = await gisService.getLandRegistryInfo(pnu);
                    if (registryInfo) {
                        area = registryInfo.area;
                        ownerCount = registryInfo.ownerCount;
                        landCategory = registryInfo.landCategory;
                        logger.info(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Land registry info found for ${pnu}: area=${area}㎡, ownerCount=${ownerCount}명, landCategory=${landCategory}`
                        );
                    } else {
                        logger.debug(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Land registry info not found for: ${pnu}`
                        );
                    }
                } catch (registryError: any) {
                    logger.warn(
                        `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Land registry fetch error for ${pnu}: ${
                            registryError?.message || 'Unknown error'
                        }`
                    );
                }

                // Step 2.7: 개별공시지가 조회 (Vworld API)
                let officialPrice: number | null = null;
                try {
                    officialPrice = await gisService.getOfficialLandPrice(pnu);
                    if (officialPrice !== null) {
                        logger.info(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Official land price found for ${pnu}: ${officialPrice}원/㎡`
                        );
                    } else {
                        logger.debug(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Official land price not found for: ${pnu}`
                        );
                    }
                } catch (priceError: any) {
                    logger.warn(
                        `[GIS ${jobId}] (${currentIndex}/${
                            job.totalCount
                        }) Official land price fetch error for ${pnu}: ${priceError?.message || 'Unknown error'}`
                    );
                }

                // Step 2.8: 건물 정보 조회 (소유주 수 추정을 위해 land_lots 저장 전에 조회)
                let buildingInfo: {
                    buildingType: 'DETACHED_HOUSE' | 'VILLA' | 'APARTMENT' | 'COMMERCIAL' | 'MIXED' | 'NONE';
                    buildingName: string | null;
                    mainPurpose: string | null;
                    floorCount: number;
                    units: Array<{
                        dong: string | null;
                        ho: string | null;
                        floor: number | null;
                        area: number | null;
                        officialPrice?: number | null; // 2026-04 추가: 공동주택공시가격 (S2 integration)
                    }>;
                } | null = null;
                try {
                    buildingInfo = await gisService.getBuildingInfo(pnu);
                    if (buildingInfo && buildingInfo.buildingType !== 'NONE') {
                        logger.debug(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Building info found: ${pnu} (type: ${buildingInfo.buildingType}, units: ${buildingInfo.units.length})`
                        );
                    } else {
                        logger.debug(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) No building info or NONE type for: ${pnu}`
                        );
                    }
                } catch (buildingError: any) {
                    logger.warn(
                        `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Building info fetch error for ${pnu}: ${
                            buildingError?.message || 'Unknown error'
                        }`
                    );
                    // 건물 정보 조회 실패해도 계속 진행
                }

                // Step 2.8b: 주택 공시가격 조회 (건물 유형별 분기)
                if (buildingInfo && buildingInfo.buildingType !== 'NONE') {
                    // 공동주택 (VILLA/APARTMENT/MIXED): 세대별 공동주택공시가격 조회
                    if (
                        ['VILLA', 'APARTMENT', 'MIXED'].includes(buildingInfo.buildingType) &&
                        buildingInfo.units.length > 0
                    ) {
                        try {
                            const apartmentPrices = await gisService.getApartmentHousePrices(pnu);
                            if (apartmentPrices && apartmentPrices.length > 0) {
                                const normalize = (v: string | null | undefined): string | null => {
                                    if (v == null) return null;
                                    const trimmed = String(v).trim();
                                    return trimmed.length === 0 ? null : trimmed;
                                };
                                buildingInfo.units = buildingInfo.units.map((unit) => {
                                    const uDong = normalize(unit.dong);
                                    const uHo = normalize(unit.ho);
                                    const match = apartmentPrices.find((p) => {
                                        const pDong = normalize(p.dong);
                                        const pHo = normalize(p.ho);
                                        return pDong === uDong && pHo === uHo;
                                    });
                                    return match ? { ...unit, officialPrice: match.officialPrice } : unit;
                                });
                                const matchedCount = buildingInfo.units.filter(
                                    (u) => u.officialPrice != null
                                ).length;
                                logger.info(
                                    `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Apartment prices matched for ${pnu}: ${matchedCount}/${buildingInfo.units.length} units`
                                );
                            }
                        } catch (aptPriceError: any) {
                            logger.warn(
                                `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Apartment price fetch error for ${pnu}: ${
                                    aptPriceError?.message || 'Unknown error'
                                }`
                            );
                        }
                    }

                    // 단독주택 (DETACHED_HOUSE): 개별주택공시가격 조회 → building_units에 저장
                    if (buildingInfo.buildingType === 'DETACHED_HOUSE') {
                        try {
                            const housingPrice = await gisService.getIndividualHousingPrice(pnu);
                            if (housingPrice != null && housingPrice > 0) {
                                // 단독주택은 보통 unit이 1개. 전체 unit에 동일 가격 적용.
                                buildingInfo.units = buildingInfo.units.map((unit) => ({
                                    ...unit,
                                    officialPrice: housingPrice,
                                }));
                                logger.info(
                                    `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Individual housing price for ${pnu}: ${housingPrice.toLocaleString()}원`
                                );
                            }
                        } catch (housingPriceError: any) {
                            logger.warn(
                                `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Individual housing price fetch error for ${pnu}: ${
                                    housingPriceError?.message || 'Unknown error'
                                }`
                            );
                        }
                    }
                }

                // Step 2.9: 소유주 수 계산 (building_units 기준으로 통일)
                // 건물이 있으면 units.length를 기준으로, 없으면 토지대장 값 사용
                let estimatedOwnerCount = ownerCount;
                if (buildingInfo && buildingInfo.buildingType !== 'NONE') {
                    if (buildingInfo.buildingType === 'DETACHED_HOUSE') {
                        // 단독주택은 소유주 1명으로 계산
                        estimatedOwnerCount = 1;
                        logger.info(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Owner count (building_units basis) for DETACHED_HOUSE: 1`
                        );
                    } else {
                        // 다세대(VILLA, APARTMENT, COMMERCIAL, MIXED)는 세대 수 = building_units 수
                        estimatedOwnerCount = buildingInfo.units.length || 1;
                        logger.info(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Owner count (building_units basis, ${buildingInfo.buildingType}): ${estimatedOwnerCount}`
                        );
                    }
                }

                // Step 2.10: 도로명 주소 조회 (좌표 기반)
                let roadAddress: string | null = null;
                try {
                    // 지오코딩에서 얻은 좌표가 있으면 도로명 주소 조회
                    if (x && y) {
                        roadAddress = await gisService.getRoadAddress(x, y);
                        if (roadAddress) {
                            logger.debug(
                                `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Road address found for ${pnu}: ${roadAddress}`
                            );
                        }
                    }
                } catch (roadAddressError: any) {
                    logger.warn(
                        `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Road address fetch error for ${pnu}: ${
                            roadAddressError?.message || 'Unknown error'
                        }`
                    );
                }

                // Step 3: land_lots 테이블에 필지 정보 저장 (경계 데이터 + 면적 + 소유자 수 + 공시지가 + 지목 + 도로명주소 포함)
                const landLotSaved = await supabaseService.upsertLandLot({
                    pnu,
                    address,
                    union_id: request.unionId, // 조합 ID 추가
                    boundary, // 경계 데이터
                    area, // 면적 (㎡)
                    owner_count: estimatedOwnerCount, // 소유자 수 (building_units 기준)
                    official_price: officialPrice ?? undefined, // 개별공시지가
                    land_category: landCategory ?? undefined, // 지목
                    road_address: roadAddress ?? undefined, // 도로명 주소
                });

                if (!landLotSaved) {
                    logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) land_lots save failed: ${pnu}`);
                    failedAddresses.push({
                        address,
                        reason: 'DB save failed - 필지 정보 저장 실패',
                        index: currentIndex,
                    });
                    continue;
                }

                // Step 3.5: 건물 정보 저장 (buildings, building_units)
                if (buildingInfo && buildingInfo.buildingType !== 'NONE') {
                    try {
                        const buildingSaved = await supabaseService.saveBuildingWithUnits(pnu, buildingInfo);
                        if (buildingSaved) {
                            logger.debug(
                                `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Building info saved: ${pnu} (type: ${buildingInfo.buildingType}, units: ${buildingInfo.units.length})`
                            );
                        } else {
                            logger.warn(
                                `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Building info save failed: ${pnu}, continuing...`
                            );
                        }
                    } catch (buildingSaveError: any) {
                        logger.warn(
                            `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Building info save error for ${pnu}: ${
                                buildingSaveError?.message || 'Unknown error'
                            }`
                        );
                    }
                }

                // Step 4: union_land_lots 테이블에 조합-필지 관계 저장
                const unionLandLotSaved = await supabaseService.createUnionLandLot(request.unionId, pnu, address);

                if (!unionLandLotSaved) {
                    logger.warn(
                        `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) union_land_lots save failed: ${pnu}`
                    );
                    failedAddresses.push({
                        address,
                        reason: 'DB save failed - 조합-필지 관계 저장 실패',
                        index: currentIndex,
                    });
                    continue;
                }

                // 성공
                successCount++;
                successfulPnus.push(pnu);
                logger.debug(
                    `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Successfully saved: ${address} -> ${pnu}`
                );
            } catch (err: any) {
                logger.error(`[GIS ${jobId}] Address processing error (${address})`, err);
                failedAddresses.push({
                    address,
                    reason: `Error: ${err.message || 'Unknown error'}`,
                    index: currentIndex,
                });
            }

            // 진행률 업데이트 (처리된 항목 기준, 성공/실패 모두 포함)
            job.processedCount = i + 1;
            const progress = Math.round((job.processedCount / job.totalCount) * 100);

            // 10% 단위로 또는 마지막일 때 로깅
            if (progress % 10 === 0 || job.processedCount === job.totalCount) {
                logger.info(
                    `[GIS ${jobId}] Progress: ${progress}% (${job.processedCount}/${job.totalCount}, success: ${successCount})`
                );
            }

            // Supabase 상태 업데이트
            await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress);
        }

        // 완료 처리
        const finalStatus = failedAddresses.length === job.totalCount ? 'FAILED' : 'COMPLETED';
        const errorLog =
            failedAddresses.length > 0
                ? JSON.stringify({
                      failedCount: failedAddresses.length,
                      successCount,
                      totalCount: job.totalCount,
                      failedAddresses: failedAddresses.slice(0, 100), // 최대 100개만 저장
                  })
                : null;

        const previewData = {
            successCount,
            failedCount: failedAddresses.length,
            totalCount: job.totalCount,
            successfulPnus: successfulPnus.slice(0, 50), // 프리뷰용 최대 50개
        };

        logger.info(
            `[GIS ${jobId}] Collection completed - Success: ${successCount}, Failed: ${failedAddresses.length}, Total: ${job.totalCount}`
        );

        this.updateJobStatus(jobId, {
            status: finalStatus === 'COMPLETED' ? 'completed' : 'failed',
            completedAt: new Date(),
        });

        await supabaseService.updateSyncJobStatus(
            jobId,
            finalStatus as 'PROCESSING' | 'COMPLETED' | 'FAILED',
            100,
            errorLog || undefined,
            previewData
        );
    }

    private updateJobStatus(jobId: string, update: Partial<GisJobInfo>) {
        const job = this.jobs.get(jobId);
        if (job) {
            Object.assign(job, update);
            this.jobs.set(jobId, job);
        }
    }

    getJobStatus(jobId: string) {
        return this.jobs.get(jobId);
    }

    /**
     * 공동주택공시가격 일괄 재동기화 작업 추가 (2026-04)
     * 해당 조합 소속 공동주택(VILLA / APARTMENT / MIXED) 세대의 official_price를
     * VWorld 공동주택가격 API로 재조회해 building_units에 갱신한다.
     */
    async addApartmentPriceSyncJob(
        request: ApartmentPriceSyncRequest
    ): Promise<{ jobId: string; totalPnu: number }> {
        const jobId = uuidv4();

        // 1. 공동주택 대상 조회
        const targets = await supabaseService.listApartmentBuildingTargets(request.unionId);
        const totalPnu = targets.length;

        const jobInfo: GisJobInfo = {
            jobId,
            unionId: request.unionId,
            totalCount: totalPnu,
            processedCount: 0,
            status: 'pending',
            createdAt: new Date(),
        };
        this.jobs.set(jobId, jobInfo);

        // 2. sync_jobs 테이블 등록
        try {
            const { error } = await supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                job_type: 'APARTMENT_PRICE_SYNC',
                status: 'PROCESSING',
                progress: 0,
            });
            if (error) {
                logger.error(`sync_jobs insert error (${jobId}): ${JSON.stringify(error)}`);
            } else {
                logger.info(`Apartment price sync job added: ${jobId} (targets: ${totalPnu})`);
            }
        } catch (error) {
            logger.error(`sync_jobs registration failed (${jobId})`, error);
        }

        // 3. 대상 없으면 바로 완료 처리
        if (totalPnu === 0) {
            this.updateJobStatus(jobId, { status: 'completed', completedAt: new Date() });
            await supabaseService.updateSyncJobStatus(jobId, 'COMPLETED', 100, undefined, {
                successCount: 0,
                failedCount: 0,
                totalCount: 0,
                message: '대상 공동주택이 없습니다.',
            });
            return { jobId, totalPnu: 0 };
        }

        // 4. 큐 등록
        this.queue
            .add(async () => {
                await this.processApartmentPriceSync(jobId, targets);
            })
            .catch((err) => {
                logger.error(`Apartment price sync job ${jobId} fatal error`, err);
                this.updateJobStatus(jobId, { status: 'failed', error: err.message });
                supabaseService.updateSyncJobStatus(jobId, 'FAILED', 0, err.message);
            });

        return { jobId, totalPnu };
    }

    /**
     * 공동주택공시가격 재동기화 워커 핸들러 (2026-04)
     * 각 PNU에 대해 gisService.getApartmentHousePrices()를 호출하고
     * (building_id, dong, ho) 매칭으로 building_units.official_price를 갱신한다.
     * 개별 세대 갱신 실패는 fire-and-forget (배치 전체를 막지 않음).
     */
    private async processApartmentPriceSync(jobId: string, targets: ApartmentPriceSyncTarget[]): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job) return;

        logger.info(`[APT-PRICE ${jobId}] Apartment price sync started (targets: ${targets.length})`);
        this.updateJobStatus(jobId, { status: 'processing', startedAt: new Date() });

        let successPnuCount = 0;
        let updatedUnitCount = 0;
        const failedEntries: Array<{ pnu: string; reason: string }> = [];

        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const currentIndex = i + 1;

            try {
                const prices = await gisService.getApartmentHousePrices(target.pnu);

                if (!prices || prices.length === 0) {
                    logger.warn(
                        `[APT-PRICE ${jobId}] (${currentIndex}/${targets.length}) No apartment price for PNU: ${target.pnu}`
                    );
                    failedEntries.push({ pnu: target.pnu, reason: '공시가격 조회 결과 없음' });
                } else {
                    // 각 (dong, ho) 결과를 building_units에 갱신
                    for (const entry of prices) {
                        const updated = await supabaseService.updateBuildingUnitPrice(
                            target.buildingId,
                            entry.dong ?? null,
                            entry.ho ?? null,
                            entry.officialPrice
                        );
                        if (updated) {
                            updatedUnitCount++;
                        }
                    }
                    successPnuCount++;
                    logger.debug(
                        `[APT-PRICE ${jobId}] (${currentIndex}/${targets.length}) Updated ${prices.length} units for PNU: ${target.pnu}`
                    );
                }
            } catch (err: any) {
                logger.warn(
                    `[APT-PRICE ${jobId}] (${currentIndex}/${targets.length}) Error for PNU ${target.pnu}: ${
                        err?.message || 'Unknown error'
                    }`
                );
                failedEntries.push({ pnu: target.pnu, reason: `Error: ${err?.message || 'Unknown error'}` });
            }

            // 진행률 갱신
            job.processedCount = currentIndex;
            const progress = Math.round((job.processedCount / job.totalCount) * 100);
            if (progress % 10 === 0 || job.processedCount === job.totalCount) {
                logger.info(
                    `[APT-PRICE ${jobId}] Progress: ${progress}% (${job.processedCount}/${job.totalCount}, success PNU: ${successPnuCount}, updated units: ${updatedUnitCount})`
                );
            }
            await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress);
        }

        // 완료 처리
        const finalStatus = failedEntries.length === job.totalCount ? 'FAILED' : 'COMPLETED';
        const errorLog =
            failedEntries.length > 0
                ? JSON.stringify({
                      failedCount: failedEntries.length,
                      successCount: successPnuCount,
                      totalCount: job.totalCount,
                      failedEntries: failedEntries.slice(0, 100),
                  })
                : null;

        const previewData = {
            successCount: successPnuCount,
            failedCount: failedEntries.length,
            totalCount: job.totalCount,
            updatedUnitCount,
        };

        logger.info(
            `[APT-PRICE ${jobId}] Completed — success PNU: ${successPnuCount}, failed: ${failedEntries.length}, updated units: ${updatedUnitCount}`
        );

        this.updateJobStatus(jobId, {
            status: finalStatus === 'COMPLETED' ? 'completed' : 'failed',
            completedAt: new Date(),
        });

        await supabaseService.updateSyncJobStatus(
            jobId,
            finalStatus as 'PROCESSING' | 'COMPLETED' | 'FAILED',
            100,
            errorLog || undefined,
            previewData
        );
    }

    /**
     * 개별주택가격 일괄 재동기화 작업 추가 (2026-05)
     * 해당 조합 소속 단독주택(DETACHED_HOUSE)의 official_price를
     * VWorld 개별주택가격 API로 재조회해 building_units에 갱신한다.
     */
    async addIndividualHousingPriceSyncJob(
        request: IndividualHousingPriceSyncRequest
    ): Promise<{ jobId: string; totalPnu: number }> {
        const jobId = uuidv4();

        const targets = await supabaseService.listIndividualHousingBuildingTargets(request.unionId);
        const totalPnu = targets.length;

        const jobInfo: GisJobInfo = {
            jobId,
            unionId: request.unionId,
            totalCount: totalPnu,
            processedCount: 0,
            status: 'pending',
            createdAt: new Date(),
        };
        this.jobs.set(jobId, jobInfo);

        try {
            const { error } = await supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                job_type: 'INDIVIDUAL_HOUSING_PRICE_SYNC',
                status: 'PROCESSING',
                progress: 0,
            });
            if (error) {
                logger.error(`sync_jobs insert error (${jobId}): ${JSON.stringify(error)}`);
            } else {
                logger.info(`Individual housing price sync job added: ${jobId} (targets: ${totalPnu})`);
            }
        } catch (error) {
            logger.error(`sync_jobs registration failed (${jobId})`, error);
        }

        if (totalPnu === 0) {
            this.updateJobStatus(jobId, { status: 'completed', completedAt: new Date() });
            await supabaseService.updateSyncJobStatus(jobId, 'COMPLETED', 100, undefined, {
                successCount: 0,
                failedCount: 0,
                totalCount: 0,
                message: '대상 개별주택이 없습니다.',
            });
            return { jobId, totalPnu: 0 };
        }

        this.queue
            .add(async () => {
                await this.processIndividualHousingPriceSync(jobId, targets);
            })
            .catch((err) => {
                logger.error(`Individual housing price sync job ${jobId} fatal error`, err);
                this.updateJobStatus(jobId, { status: 'failed', error: err.message });
                supabaseService.updateSyncJobStatus(jobId, 'FAILED', 0, err.message);
            });

        return { jobId, totalPnu };
    }

    /**
     * 개별주택가격 재동기화 워커 핸들러 (2026-05)
     * 각 PNU에 대해 gisService.getIndividualHousingPrice()를 호출하고
     * 건물에 연결된 building_units 전체 official_price를 갱신한다.
     */
    private async processIndividualHousingPriceSync(
        jobId: string,
        targets: IndividualHousingPriceSyncTarget[]
    ): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job) return;

        logger.info(`[INDVD-HOUSE-PRICE ${jobId}] Individual housing price sync started (targets: ${targets.length})`);
        this.updateJobStatus(jobId, { status: 'processing', startedAt: new Date() });

        let successPnuCount = 0;
        let updatedUnitCount = 0;
        const failedEntries: Array<{ pnu: string; reason: string }> = [];

        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const currentIndex = i + 1;

            try {
                const price = await gisService.getIndividualHousingPrice(target.pnu);

                if (price === null || price === undefined) {
                    logger.warn(
                        `[INDVD-HOUSE-PRICE ${jobId}] (${currentIndex}/${targets.length}) No individual housing price for PNU: ${target.pnu}`
                    );
                    failedEntries.push({ pnu: target.pnu, reason: '개별주택가격 조회 결과 없음' });
                } else {
                    const updatedCount = await supabaseService.updateBuildingUnitsPriceByBuildingId(
                        target.buildingId,
                        price
                    );
                    if (updatedCount > 0) {
                        successPnuCount++;
                        updatedUnitCount += updatedCount;
                        logger.debug(
                            `[INDVD-HOUSE-PRICE ${jobId}] (${currentIndex}/${targets.length}) Updated building ${target.buildingId}: ${price} (${updatedCount} units)`
                        );
                    } else {
                        failedEntries.push({ pnu: target.pnu, reason: 'DB 갱신 대상 unit 없음' });
                    }
                }
            } catch (err: any) {
                logger.warn(
                    `[INDVD-HOUSE-PRICE ${jobId}] (${currentIndex}/${targets.length}) Error for PNU ${target.pnu}: ${
                        err?.message || 'Unknown error'
                    }`
                );
                failedEntries.push({ pnu: target.pnu, reason: `Error: ${err?.message || 'Unknown error'}` });
            }

            job.processedCount = currentIndex;
            const progress = Math.round((job.processedCount / job.totalCount) * 100);
            if (progress % 10 === 0 || job.processedCount === job.totalCount) {
                logger.info(
                    `[INDVD-HOUSE-PRICE ${jobId}] Progress: ${progress}% (${job.processedCount}/${job.totalCount}, success PNU: ${successPnuCount}, updated units: ${updatedUnitCount})`
                );
            }
            await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress);
        }

        const finalStatus = failedEntries.length === job.totalCount ? 'FAILED' : 'COMPLETED';
        const errorLog =
            failedEntries.length > 0
                ? JSON.stringify({
                      failedCount: failedEntries.length,
                      successCount: successPnuCount,
                      totalCount: job.totalCount,
                      failedEntries: failedEntries.slice(0, 100),
                  })
                : null;

        const previewData = {
            successCount: successPnuCount,
            failedCount: failedEntries.length,
            totalCount: job.totalCount,
            updatedUnitCount,
        };

        logger.info(
            `[INDVD-HOUSE-PRICE ${jobId}] Completed — success PNU: ${successPnuCount}, failed: ${failedEntries.length}, updated units: ${updatedUnitCount}`
        );

        this.updateJobStatus(jobId, {
            status: finalStatus === 'COMPLETED' ? 'completed' : 'failed',
            completedAt: new Date(),
        });

        await supabaseService.updateSyncJobStatus(
            jobId,
            finalStatus as 'PROCESSING' | 'COMPLETED' | 'FAILED',
            100,
            errorLog || undefined,
            previewData
        );
    }

    /**
     * 토지 공시지가 일괄 재동기화 작업 추가 (2026-04)
     * 해당 조합의 land_lots 전체 PNU에 대해 VWorld 개별공시지가 API를
     * 재조회해 land_lots.official_price 를 갱신한다.
     */
    async addLandPriceSyncJob(
        request: LandPriceSyncRequest
    ): Promise<{ jobId: string; totalPnu: number }> {
        const jobId = uuidv4();

        // 1. 토지 대상 조회 (전체 무조건 재조회)
        const targets = await supabaseService.listLandPriceTargetsByUnion(request.unionId);
        const totalPnu = targets.length;

        const jobInfo: GisJobInfo = {
            jobId,
            unionId: request.unionId,
            totalCount: totalPnu,
            processedCount: 0,
            status: 'pending',
            createdAt: new Date(),
        };
        this.jobs.set(jobId, jobInfo);

        // 2. sync_jobs 테이블 등록
        try {
            const { error } = await supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                job_type: 'LAND_PRICE_SYNC',
                status: 'PROCESSING',
                progress: 0,
            });
            if (error) {
                logger.error(`sync_jobs insert error (${jobId}): ${JSON.stringify(error)}`);
            } else {
                logger.info(`Land price sync job added: ${jobId} (targets: ${totalPnu})`);
            }
        } catch (error) {
            logger.error(`sync_jobs registration failed (${jobId})`, error);
        }

        // 3. 대상 없으면 바로 완료 처리
        if (totalPnu === 0) {
            this.updateJobStatus(jobId, { status: 'completed', completedAt: new Date() });
            await supabaseService.updateSyncJobStatus(jobId, 'COMPLETED', 100, undefined, {
                successCount: 0,
                failedCount: 0,
                totalCount: 0,
                message: '대상 토지가 없습니다.',
            });
            return { jobId, totalPnu: 0 };
        }

        // 4. 큐 등록
        this.queue
            .add(async () => {
                await this.processLandPriceSync(jobId, targets);
            })
            .catch((err) => {
                logger.error(`Land price sync job ${jobId} fatal error`, err);
                this.updateJobStatus(jobId, { status: 'failed', error: err.message });
                supabaseService.updateSyncJobStatus(jobId, 'FAILED', 0, err.message);
            });

        return { jobId, totalPnu };
    }

    /**
     * 토지 공시지가 재동기화 워커 핸들러 (2026-04)
     * 각 PNU에 대해 gisService.getOfficialLandPrice()를 호출하고
     * land_lots.official_price 를 갱신한다.
     * 개별 필지 갱신 실패는 fire-and-forget (배치 전체를 막지 않음).
     */
    private async processLandPriceSync(jobId: string, targets: LandPriceSyncTarget[]): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job) return;

        logger.info(`[LAND-PRICE ${jobId}] Land price sync started (targets: ${targets.length})`);
        this.updateJobStatus(jobId, { status: 'processing', startedAt: new Date() });

        let successCount = 0;
        const failedEntries: Array<{ pnu: string; reason: string }> = [];

        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const currentIndex = i + 1;

            try {
                const price = await gisService.getOfficialLandPrice(target.pnu);

                if (price === null || price === undefined) {
                    logger.warn(
                        `[LAND-PRICE ${jobId}] (${currentIndex}/${targets.length}) No land price for PNU: ${target.pnu}`
                    );
                    failedEntries.push({ pnu: target.pnu, reason: '공시지가 조회 결과 없음' });
                } else {
                    const updated = await supabaseService.updateLandLotPrice(job.unionId, target.pnu, price);
                    if (updated) {
                        successCount++;
                        logger.debug(
                            `[LAND-PRICE ${jobId}] (${currentIndex}/${targets.length}) Updated PNU ${target.pnu}: ${price}`
                        );
                    } else {
                        failedEntries.push({ pnu: target.pnu, reason: 'DB 갱신 실패' });
                    }
                }
            } catch (err: any) {
                logger.warn(
                    `[LAND-PRICE ${jobId}] (${currentIndex}/${targets.length}) Error for PNU ${target.pnu}: ${
                        err?.message || 'Unknown error'
                    }`
                );
                failedEntries.push({ pnu: target.pnu, reason: `Error: ${err?.message || 'Unknown error'}` });
            }

            // 진행률 갱신
            job.processedCount = currentIndex;
            const progress = Math.round((job.processedCount / job.totalCount) * 100);
            if (progress % 10 === 0 || job.processedCount === job.totalCount) {
                logger.info(
                    `[LAND-PRICE ${jobId}] Progress: ${progress}% (${job.processedCount}/${job.totalCount}, success: ${successCount})`
                );
            }
            await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress);
        }

        // 완료 처리
        const finalStatus = failedEntries.length === job.totalCount ? 'FAILED' : 'COMPLETED';
        const errorLog =
            failedEntries.length > 0
                ? JSON.stringify({
                      failedCount: failedEntries.length,
                      successCount,
                      totalCount: job.totalCount,
                      failedEntries: failedEntries.slice(0, 100),
                  })
                : null;

        const previewData = {
            successCount,
            failedCount: failedEntries.length,
            totalCount: job.totalCount,
        };

        logger.info(
            `[LAND-PRICE ${jobId}] Completed — success: ${successCount}, failed: ${failedEntries.length}`
        );

        this.updateJobStatus(jobId, {
            status: finalStatus === 'COMPLETED' ? 'completed' : 'failed',
            completedAt: new Date(),
        });

        await supabaseService.updateSyncJobStatus(
            jobId,
            finalStatus as 'PROCESSING' | 'COMPLETED' | 'FAILED',
            100,
            errorLog || undefined,
            previewData
        );
    }
}

export const gisQueueService = new GisQueueService();
export default gisQueueService;

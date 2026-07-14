import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import {
    ApartmentHouseOfficialPrice,
    BuildingExternalRefInfo,
    gisService,
    IndividualHousingOfficialPrice,
} from './gis.service';
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
import { persistSyncJobOrThrow } from './sync-job-admission';

const logger = createLogger('GIS-QUEUE');

/**
 * 실패한 주소 정보
 */
interface FailedAddress {
    address: string;
    reason: string;
    index: number;
}

type IndividualHousingPriceFailureCode =
    | 'NO_OFFICIAL_HOUSING_PRICE'
    | 'WRONG_BUILDING_TYPE_CANDIDATE'
    | 'DB_UPDATE_TARGET_MISSING'
    | 'INDIVIDUAL_HOUSING_PRICE_ERROR';

interface IndividualHousingPriceFailure {
    pnu: string;
    buildingId?: string;
    reason: string;
    code?: IndividualHousingPriceFailureCode;
    attemptedPnus?: string[];
    matchedPnu?: string;
}

type IndividualHousingPriceResolution =
    | {
          status: 'FOUND';
          price: IndividualHousingOfficialPrice;
          requestedPnu: string;
          matchedPnu: string;
          attemptedPnus: string[];
      }
    | {
          status: 'APARTMENT_PRICE_CANDIDATE';
          requestedPnu: string;
          matchedPnu: string;
          attemptedPnus: string[];
          apartmentPrices: ApartmentHouseOfficialPrice[];
      }
    | {
          status: 'NO_DATA';
          requestedPnu: string;
          attemptedPnus: string[];
      };

type ApartmentPriceResolution =
    | {
          status: 'FOUND';
          requestedPnu: string;
          matchedPnu: string;
          attemptedPnus: string[];
          prices: ApartmentHouseOfficialPrice[];
      }
    | {
          status: 'NO_DATA';
          requestedPnu: string;
          attemptedPnus: string[];
      };

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

    private buildApartmentPriceExternalRefs(
        pnu: string,
        prices: ApartmentHouseOfficialPrice[]
    ): Array<{
        source: 'APART_HOUSING_PRICE';
        externalId: string;
        externalName: string | null;
        pnu: string;
        metadata: Record<string, unknown>;
    }> {
        const refs = new Map<
            string,
            {
                source: 'APART_HOUSING_PRICE';
                externalId: string;
                externalName: string | null;
                pnu: string;
                metadata: Record<string, unknown>;
            }
        >();

        for (const price of prices) {
            if (!price.externalId) continue;

            const sourcePnu = price.sourcePnu || pnu;
            const key = `${price.externalId}:${sourcePnu}`;
            const existing = refs.get(key);
            if (existing) {
                existing.metadata = {
                    ...existing.metadata,
                    unitCount: Number(existing.metadata.unitCount ?? 0) + 1,
                };
                continue;
            }

            refs.set(key, {
                source: 'APART_HOUSING_PRICE',
                externalId: price.externalId,
                externalName: price.externalName,
                pnu: sourcePnu,
                metadata: {
                    ...price.metadata,
                    requestedPnu: pnu,
                    unitCount: 1,
                },
            });
        }

        return Array.from(refs.values());
    }

    private buildIndividualHousingExternalRefs(
        pnu: string,
        price: IndividualHousingOfficialPrice
    ): Array<{
        source: 'INDIVIDUAL_HOUSING_PRICE';
        externalId: string;
        externalName: string | null;
        pnu: string;
        metadata: Record<string, unknown>;
    }> {
        if (!price.externalId) return [];

        return [
            {
                source: 'INDIVIDUAL_HOUSING_PRICE',
                externalId: price.externalId,
                externalName: price.externalName,
                pnu: price.sourcePnu || pnu,
                metadata: {
                    ...price.metadata,
                    requestedPnu: pnu,
                },
            },
        ];
    }

    private buildBuildingPnuMap(
        targets: Array<{ pnu: string; buildingId: string }>
    ): Map<string, string[]> {
        const pnuMap = new Map<string, Set<string>>();

        for (const target of targets) {
            if (!pnuMap.has(target.buildingId)) {
                pnuMap.set(target.buildingId, new Set<string>());
            }
            pnuMap.get(target.buildingId)?.add(target.pnu);
        }

        return new Map(
            Array.from(pnuMap.entries()).map(([buildingId, pnus]) => [
                buildingId,
                Array.from(pnus).sort(),
            ])
        );
    }

    private getCandidatePnusForBuilding(
        target: IndividualHousingPriceSyncTarget,
        buildingPnuMap: Map<string, string[]>
    ): string[] {
        const buildingPnus = buildingPnuMap.get(target.buildingId) ?? [];
        return Array.from(new Set([target.pnu, ...buildingPnus].filter(Boolean)));
    }

    private async resolveApartmentHousePrices(
        target: ApartmentPriceSyncTarget,
        buildingPnuMap: Map<string, string[]>
    ): Promise<ApartmentPriceResolution> {
        const candidatePnus = this.getCandidatePnusForBuilding(target, buildingPnuMap);
        const attemptedPnus: string[] = [];

        for (const candidatePnu of candidatePnus) {
            attemptedPnus.push(candidatePnu);
            const prices = await gisService.getApartmentHousePrices(candidatePnu);
            if (prices && prices.length > 0) {
                return {
                    status: 'FOUND',
                    requestedPnu: target.pnu,
                    matchedPnu: candidatePnu,
                    attemptedPnus,
                    prices,
                };
            }
        }

        return {
            status: 'NO_DATA',
            requestedPnu: target.pnu,
            attemptedPnus,
        };
    }

    private async resolveIndividualHousingPrice(
        target: IndividualHousingPriceSyncTarget,
        buildingPnuMap: Map<string, string[]>
    ): Promise<IndividualHousingPriceResolution> {
        const candidatePnus = this.getCandidatePnusForBuilding(target, buildingPnuMap);
        const attemptedPnus: string[] = [];

        for (const candidatePnu of candidatePnus) {
            attemptedPnus.push(candidatePnu);
            const price = await gisService.getIndividualHousingPrice(candidatePnu);
            if (price) {
                return {
                    status: 'FOUND',
                    price,
                    requestedPnu: target.pnu,
                    matchedPnu: candidatePnu,
                    attemptedPnus,
                };
            }
        }

        for (const candidatePnu of candidatePnus) {
            const apartmentPrices = await gisService.getApartmentHousePrices(candidatePnu);
            if (apartmentPrices && apartmentPrices.length > 0) {
                return {
                    status: 'APARTMENT_PRICE_CANDIDATE',
                    requestedPnu: target.pnu,
                    matchedPnu: candidatePnu,
                    attemptedPnus,
                    apartmentPrices,
                };
            }
        }

        return {
            status: 'NO_DATA',
            requestedPnu: target.pnu,
            attemptedPnus,
        };
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

        await persistSyncJobOrThrow(jobId, request.unionId, () =>
            supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                job_type: 'GIS_MAP',
                status: 'PROCESSING',
                progress: 0,
                preview_data: {
                    actorUserId: request.actorUserId,
                    source: 'GIS_MAP',
                    totalCount: request.addresses.length,
                },
            }).select('id, union_id').single()
        );
        this.jobs.set(jobId, jobInfo);
        logger.info(`GIS job added: ${jobId} (parcels: ${request.addresses.length})`);

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
                    externalRefs: BuildingExternalRefInfo[];
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
                                buildingInfo.externalRefs = [
                                    ...buildingInfo.externalRefs,
                                    ...this.buildApartmentPriceExternalRefs(pnu, apartmentPrices),
                                ];
                                // 동/호 정규화 — 건축물대장(BldRgstHubService)과 VWorld 공시가격 API의
                                // 표기 차이(지층/지하/패딩/접미사) 흡수
                                const normalizeDong = (v: string | null | undefined): string | null => {
                                    if (v == null) return null;
                                    let t = String(v).trim().replace(/동$/, '');
                                    t = t.replace(/^0+(\d)/, '$1'); // 앞 0 제거
                                    return t.length === 0 ? null : t;
                                };
                                const normalizeHo = (v: string | null | undefined): string | null => {
                                    if (v == null) return null;
                                    let t = String(v).trim().replace(/호$/, '');
                                    // 지층/지하 → B 접두사 통일
                                    if (/^(지층|지하|B-?)/i.test(t)) {
                                        const digits = t.replace(/[^\d]/g, '');
                                        return 'B' + (digits || '1');
                                    }
                                    // 앞 0 제거 (예: '01' → '1', '101' 그대로)
                                    t = t.replace(/^0+(\d)/, '$1');
                                    return t.length === 0 ? null : t;
                                };
                                buildingInfo.units = buildingInfo.units.map((unit) => {
                                    const uDong = normalizeDong(unit.dong);
                                    const uHo = normalizeHo(unit.ho);
                                    const match = apartmentPrices.find((p) => {
                                        const pDong = normalizeDong(p.dong);
                                        const pHo = normalizeHo(p.ho);
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
                            if (housingPrice != null && housingPrice.officialPrice > 0) {
                                buildingInfo.externalRefs = [
                                    ...buildingInfo.externalRefs,
                                    ...this.buildIndividualHousingExternalRefs(pnu, housingPrice),
                                ];
                                // 단독주택은 보통 unit이 1개. 전체 unit에 동일 가격 적용.
                                buildingInfo.units = buildingInfo.units.map((unit) => ({
                                    ...unit,
                                    officialPrice: housingPrice.officialPrice,
                                }));
                                logger.info(
                                    `[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Individual housing price for ${pnu}: ${housingPrice.officialPrice.toLocaleString()}원`
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
        await persistSyncJobOrThrow(jobId, request.unionId, () =>
            supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                job_type: 'APARTMENT_PRICE_SYNC',
                status: 'PROCESSING',
                progress: 0,
                preview_data: {
                    actorUserId: request.actorUserId,
                    source: 'APARTMENT_PRICE_SYNC',
                    totalCount: totalPnu,
                },
            }).select('id, union_id').single()
        );
        this.jobs.set(jobId, jobInfo);
        logger.info(`Apartment price sync job added: ${jobId} (targets: ${totalPnu})`);

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
        let linkedUserPropertyCount = 0;
        let linkedPropertyUnitCount = 0;
        let skippedUnitCount = 0;
        let linkSkippedCount = 0;
        let fallbackSuccessCount = 0;
        let skippedDuplicateBuildingCount = 0;
        const buildingPnuMap = this.buildBuildingPnuMap(targets);
        const processedBuildingIds = new Set<string>();
        const failedEntries: Array<{ pnu: string; reason: string }> = [];

        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const currentIndex = i + 1;

            try {
                if (processedBuildingIds.has(target.buildingId)) {
                    skippedDuplicateBuildingCount++;
                    logger.debug(
                        `[APT-PRICE ${jobId}] (${currentIndex}/${targets.length}) Skipped duplicate building target: ${target.buildingId} / ${target.pnu}`
                    );
                } else {
                    const resolution = await this.resolveApartmentHousePrices(target, buildingPnuMap);

                    if (resolution.status === 'NO_DATA') {
                        processedBuildingIds.add(target.buildingId);
                        logger.warn(
                            `[APT-PRICE ${jobId}] (${currentIndex}/${targets.length}) No apartment price for PNU: ${target.pnu} (attempted: ${resolution.attemptedPnus.join(', ')})`
                        );
                        failedEntries.push({ pnu: target.pnu, reason: '공시가격 조회 결과 없음' });
                    } else {
                        processedBuildingIds.add(target.buildingId);
                        if (resolution.matchedPnu !== target.pnu) {
                            fallbackSuccessCount++;
                            logger.info(
                                `[APT-PRICE ${jobId}] (${currentIndex}/${targets.length}) Apartment price fallback matched: requested=${target.pnu}, matched=${resolution.matchedPnu}`
                            );
                        }

                        await supabaseService.upsertBuildingExternalRefs(
                            this.buildApartmentPriceExternalRefs(resolution.matchedPnu, resolution.prices).map((ref) => ({
                                buildingId: target.buildingId,
                                ...ref,
                                metadata: {
                                    ...ref.metadata,
                                    requestedPnu: target.pnu,
                                    matchedPnu: resolution.matchedPnu,
                                    attemptedPnus: resolution.attemptedPnus,
                                },
                            }))
                        );

                        const syncResult = await supabaseService.upsertApartmentOfficialPriceUnits(
                            target.buildingId,
                            resolution.matchedPnu,
                            resolution.prices
                        );

                        updatedUnitCount += syncResult.upsertedCount;
                        skippedUnitCount += syncResult.skippedCount;
                        linkedUserPropertyCount += syncResult.linkedUserPropertyCount;
                        linkedPropertyUnitCount += syncResult.linkedPropertyUnitCount;
                        linkSkippedCount += syncResult.linkSkippedCount;
                        successPnuCount++;
                        logger.debug(
                            `[APT-PRICE ${jobId}] (${currentIndex}/${targets.length}) Synced apartment units for PNU ${resolution.matchedPnu}: upserted=${syncResult.upsertedCount}, skipped=${syncResult.skippedCount}, linkedUserProperties=${syncResult.linkedUserPropertyCount}, linkedPropertyUnits=${syncResult.linkedPropertyUnitCount}`
                        );
                    }
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
                    `[APT-PRICE ${jobId}] Progress: ${progress}% (${job.processedCount}/${job.totalCount}, success buildings: ${successPnuCount}, fallback: ${fallbackSuccessCount}, upserted units: ${updatedUnitCount}, linked user properties: ${linkedUserPropertyCount})`
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
            skippedUnitCount,
            linkedUserPropertyCount,
            linkedPropertyUnitCount,
            linkSkippedCount,
            fallbackSuccessCount,
            skippedDuplicateBuildingCount,
        };

        logger.info(
            `[APT-PRICE ${jobId}] Completed — success buildings: ${successPnuCount}, fallback: ${fallbackSuccessCount}, skipped duplicates: ${skippedDuplicateBuildingCount}, failed: ${failedEntries.length}, upserted units: ${updatedUnitCount}, linked user properties: ${linkedUserPropertyCount}, linked property units: ${linkedPropertyUnitCount}`
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
        await persistSyncJobOrThrow(jobId, request.unionId, () =>
            supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                job_type: 'INDIVIDUAL_HOUSING_PRICE_SYNC',
                status: 'PROCESSING',
                progress: 0,
                preview_data: {
                    actorUserId: request.actorUserId,
                    source: 'INDIVIDUAL_HOUSING_PRICE_SYNC',
                    totalCount: totalPnu,
                },
            }).select('id, union_id').single()
        );
        this.jobs.set(jobId, jobInfo);
        logger.info(`Individual housing price sync job added: ${jobId} (targets: ${totalPnu})`);

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
     * 각 PNU에 대해 개별주택가격을 조회하고, 없으면 같은 건물의 다른 PNU로 보정 조회한다.
     * 그래도 없으면 공동주택공시가격 API를 진단 조회하여 건물 유형 보정 후보를 남긴다.
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
        let fallbackSuccessCount = 0;
        let apartmentCandidateCount = 0;
        let skippedDuplicateBuildingCount = 0;
        const buildingPnuMap = this.buildBuildingPnuMap(targets);
        const updatedBuildingIds = new Set<string>();
        const diagnosticBuildingIds = new Set<string>();
        const failedEntries: IndividualHousingPriceFailure[] = [];

        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const currentIndex = i + 1;

            try {
                if (updatedBuildingIds.has(target.buildingId) || diagnosticBuildingIds.has(target.buildingId)) {
                    skippedDuplicateBuildingCount++;
                    logger.debug(
                        `[INDVD-HOUSE-PRICE ${jobId}] (${currentIndex}/${targets.length}) Skipped duplicate building target: ${target.buildingId} / ${target.pnu}`
                    );
                } else {
                    const resolution = await this.resolveIndividualHousingPrice(target, buildingPnuMap);

                    if (resolution.status === 'NO_DATA') {
                        diagnosticBuildingIds.add(target.buildingId);
                        logger.warn(
                            `[INDVD-HOUSE-PRICE ${jobId}] (${currentIndex}/${targets.length}) No individual housing price for PNU: ${target.pnu} (attempted: ${resolution.attemptedPnus.join(', ')})`
                        );
                        failedEntries.push({
                            pnu: target.pnu,
                            buildingId: target.buildingId,
                            reason: '개별주택가격 조회 결과 없음',
                            code: 'NO_OFFICIAL_HOUSING_PRICE',
                            attemptedPnus: resolution.attemptedPnus,
                        });
                    } else if (resolution.status === 'APARTMENT_PRICE_CANDIDATE') {
                        apartmentCandidateCount++;
                        diagnosticBuildingIds.add(target.buildingId);

                        await supabaseService.upsertBuildingExternalRefs(
                            this.buildApartmentPriceExternalRefs(
                                resolution.matchedPnu,
                                resolution.apartmentPrices
                            ).map((ref) => ({
                                buildingId: target.buildingId,
                                ...ref,
                                metadata: {
                                    ...ref.metadata,
                                    requestedPnu: target.pnu,
                                    matchedPnu: resolution.matchedPnu,
                                    diagnosticSource: 'INDIVIDUAL_HOUSING_PRICE_SYNC',
                                },
                            }))
                        );

                        logger.warn(
                            `[INDVD-HOUSE-PRICE ${jobId}] (${currentIndex}/${targets.length}) Apartment price data found for DETACHED_HOUSE target. building=${target.buildingId}, requested=${target.pnu}, matched=${resolution.matchedPnu}, units=${resolution.apartmentPrices.length}`
                        );
                        failedEntries.push({
                            pnu: target.pnu,
                            buildingId: target.buildingId,
                            reason: '공동주택공시가격 조회됨 - 건물 유형 분류 확인 필요',
                            code: 'WRONG_BUILDING_TYPE_CANDIDATE',
                            attemptedPnus: resolution.attemptedPnus,
                            matchedPnu: resolution.matchedPnu,
                        });
                    } else {
                        const { price } = resolution;
                        if (resolution.matchedPnu !== target.pnu) {
                            fallbackSuccessCount++;
                            logger.info(
                                `[INDVD-HOUSE-PRICE ${jobId}] (${currentIndex}/${targets.length}) Individual housing price fallback matched: requested=${target.pnu}, matched=${resolution.matchedPnu}`
                            );
                        }

                        await supabaseService.upsertBuildingExternalRefs(
                            this.buildIndividualHousingExternalRefs(target.pnu, price).map((ref) => ({
                                buildingId: target.buildingId,
                                ...ref,
                                metadata: {
                                    ...ref.metadata,
                                    matchedPnu: resolution.matchedPnu,
                                    attemptedPnus: resolution.attemptedPnus,
                                },
                            }))
                        );

                        const { updatedCount } =
                            await supabaseService.updateBuildingUnitsOfficialPriceByBuildingId(
                                target.buildingId,
                                price,
                                target.pnu
                            );
                        if (updatedCount > 0) {
                            successPnuCount++;
                            updatedBuildingIds.add(target.buildingId);
                            updatedUnitCount += updatedCount;
                            logger.debug(
                                `[INDVD-HOUSE-PRICE ${jobId}] (${currentIndex}/${targets.length}) Updated building ${target.buildingId}: ${price.officialPrice} (${updatedCount} units)`
                            );
                        } else {
                            diagnosticBuildingIds.add(target.buildingId);
                            failedEntries.push({
                                pnu: target.pnu,
                                buildingId: target.buildingId,
                                reason: 'DB 갱신 대상 unit 없음',
                                code: 'DB_UPDATE_TARGET_MISSING',
                                attemptedPnus: resolution.attemptedPnus,
                                matchedPnu: resolution.matchedPnu,
                            });
                        }
                    }
                }
            } catch (err: any) {
                logger.warn(
                    `[INDVD-HOUSE-PRICE ${jobId}] (${currentIndex}/${targets.length}) Error for PNU ${target.pnu}: ${
                        err?.message || 'Unknown error'
                    }`
                );
                failedEntries.push({
                    pnu: target.pnu,
                    buildingId: target.buildingId,
                    reason: `Error: ${err?.message || 'Unknown error'}`,
                    code: 'INDIVIDUAL_HOUSING_PRICE_ERROR',
                });
            }

            job.processedCount = currentIndex;
            const progress = Math.round((job.processedCount / job.totalCount) * 100);
            if (progress % 10 === 0 || job.processedCount === job.totalCount) {
                logger.info(
                    `[INDVD-HOUSE-PRICE ${jobId}] Progress: ${progress}% (${job.processedCount}/${job.totalCount}, success buildings: ${successPnuCount}, fallback: ${fallbackSuccessCount}, apartment candidates: ${apartmentCandidateCount}, updated units: ${updatedUnitCount})`
                );
            }
            await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress);
        }

        const finalStatus = successPnuCount === 0 && apartmentCandidateCount === 0 ? 'FAILED' : 'COMPLETED';
        const errorLog =
            failedEntries.length > 0
                ? JSON.stringify({
                      failedCount: failedEntries.length,
                      successCount: successPnuCount,
                      fallbackSuccessCount,
                      apartmentCandidateCount,
                      skippedDuplicateBuildingCount,
                      totalCount: job.totalCount,
                      failedEntries: failedEntries.slice(0, 100),
                  })
                : null;

        const previewData = {
            successCount: successPnuCount,
            failedCount: failedEntries.length,
            totalCount: job.totalCount,
            updatedUnitCount,
            fallbackSuccessCount,
            apartmentCandidateCount,
            skippedDuplicateBuildingCount,
        };

        logger.info(
            `[INDVD-HOUSE-PRICE ${jobId}] Completed — success buildings: ${successPnuCount}, fallback: ${fallbackSuccessCount}, apartment candidates: ${apartmentCandidateCount}, failed: ${failedEntries.length}, updated units: ${updatedUnitCount}`
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
        await persistSyncJobOrThrow(jobId, request.unionId, () =>
            supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                job_type: 'LAND_PRICE_SYNC',
                status: 'PROCESSING',
                progress: 0,
                preview_data: {
                    actorUserId: request.actorUserId,
                    source: 'LAND_PRICE_SYNC',
                    totalCount: totalPnu,
                },
            }).select('id, union_id').single()
        );
        this.jobs.set(jobId, jobInfo);
        logger.info(`Land price sync job added: ${jobId} (targets: ${totalPnu})`);

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

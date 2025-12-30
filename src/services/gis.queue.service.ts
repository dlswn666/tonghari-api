import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { gisService } from './gis.service';
import { supabaseService } from './supabase.service';
import { GisSyncRequest, GisJobInfo } from '../types/gis.types';
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
            timeout: 600000 // 10분
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
            createdAt: new Date()
        };

        this.jobs.set(jobId, jobInfo);

        // Supabase sync_jobs 테이블에 초기 등록
        try {
            await supabaseService.getClient().from('sync_jobs').insert({
                id: jobId,
                union_id: request.unionId,
                status: 'PROCESSING',
                progress: 0
            });
            logger.info(`GIS job added: ${jobId} (parcels: ${request.addresses.length})`);
        } catch (error) {
            logger.error(`sync_jobs registration failed (${jobId})`, error);
        }

        this.queue.add(async () => {
            await this.processSyncJob(jobId, request);
        }).catch(err => {
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
                        index: currentIndex
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
                        index: currentIndex
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
                        logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Boundary not found for: ${pnu}`);
                    }
                } catch (boundaryError) {
                    logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Boundary fetch error for: ${pnu}`, boundaryError);
                    // 경계를 못 찾아도 계속 진행 (PNU와 주소는 저장)
                }

                // Step 2.6 (NEW): 소유자 정보 조회 (공공데이터 API)
                let ownerCount = 0;
                try {
                    // 토지 소유자 정보 조회 시도
                    const ownerInfo = await gisService.getOwnerInfo(pnu, 'LAND');
                    if (Array.isArray(ownerInfo) && ownerInfo.length > 0) {
                        ownerCount = ownerInfo.length;
                        logger.info(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Owner info found for ${pnu}: ${ownerCount}명`);
                    } else {
                        // 토지 소유자가 없으면 건물 소유자 조회 시도
                        const buildingOwnerInfo = await gisService.getOwnerInfo(pnu, 'BUILDING');
                        if (Array.isArray(buildingOwnerInfo) && buildingOwnerInfo.length > 0) {
                            ownerCount = buildingOwnerInfo.length;
                            logger.info(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Building owner info found for ${pnu}: ${ownerCount}명`);
                        } else {
                            logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Owner info not found for: ${pnu} (API may be restricted)`);
                        }
                    }
                } catch (ownerError: any) {
                    // 소유자 정보 조회 실패 시 로그만 남기고 계속 진행
                    logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Owner info fetch error for ${pnu}: ${ownerError?.message || 'Unknown error'}`);
                }

                // Step 3: land_lots 테이블에 필지 정보 저장 (경계 데이터 + 소유자 수 포함)
                const landLotSaved = await supabaseService.upsertLandLot({
                    pnu,
                    address,
                    boundary, // 경계 데이터 추가
                    owner_count: ownerCount, // 소유자 수 추가
                });

                if (!landLotSaved) {
                    logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) land_lots save failed: ${pnu}`);
                    failedAddresses.push({
                        address,
                        reason: 'DB save failed - 필지 정보 저장 실패',
                        index: currentIndex
                    });
                    continue;
                }

                // Step 4: union_land_lots 테이블에 조합-필지 관계 저장
                const unionLandLotSaved = await supabaseService.createUnionLandLot(
                    request.unionId,
                    pnu,
                    address
                );

                if (!unionLandLotSaved) {
                    logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) union_land_lots save failed: ${pnu}`);
                    failedAddresses.push({
                        address,
                        reason: 'DB save failed - 조합-필지 관계 저장 실패',
                        index: currentIndex
                    });
                    continue;
                }

                // 성공
                successCount++;
                successfulPnus.push(pnu);
                logger.debug(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Successfully saved: ${address} -> ${pnu}`);

            } catch (err: any) {
                logger.error(`[GIS ${jobId}] Address processing error (${address})`, err);
                failedAddresses.push({
                    address,
                    reason: `Error: ${err.message || 'Unknown error'}`,
                    index: currentIndex
                });
            }

            // 진행률 업데이트 (처리된 항목 기준, 성공/실패 모두 포함)
            job.processedCount = i + 1;
            const progress = Math.round((job.processedCount / job.totalCount) * 100);
            
            // 10% 단위로 또는 마지막일 때 로깅
            if (progress % 10 === 0 || job.processedCount === job.totalCount) {
                logger.info(`[GIS ${jobId}] Progress: ${progress}% (${job.processedCount}/${job.totalCount}, success: ${successCount})`);
            }

            // Supabase 상태 업데이트
            await supabaseService.updateSyncJobStatus(jobId, 'PROCESSING', progress);
        }

        // 완료 처리
        const finalStatus = failedAddresses.length === job.totalCount ? 'FAILED' : 'COMPLETED';
        const errorLog = failedAddresses.length > 0 
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

        logger.info(`[GIS ${jobId}] Collection completed - Success: ${successCount}, Failed: ${failedAddresses.length}, Total: ${job.totalCount}`);
        
        this.updateJobStatus(jobId, { 
            status: finalStatus === 'COMPLETED' ? 'completed' : 'failed', 
            completedAt: new Date() 
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
}

export const gisQueueService = new GisQueueService();
export default gisQueueService;

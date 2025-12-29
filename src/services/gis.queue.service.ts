import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { gisService } from './gis.service';
import { supabaseService } from './supabase.service';
import { GisSyncRequest, GisJobInfo } from '../types/gis.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('GIS-QUEUE');

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
            // @ts-ignore - sync_jobs 테이블이 추가되었음을 가정
            await (supabaseService as any).client.from('sync_jobs').insert({
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
        });

        return jobInfo;
    }

    private async processSyncJob(jobId: string, request: GisSyncRequest) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        logger.info(`[GIS ${jobId}] Collection process started`);
        this.updateJobStatus(jobId, { status: 'processing', startedAt: new Date() });

        for (let i = 0; i < request.addresses.length; i++) {
            const address = request.addresses[i];
            const currentIndex = i + 1;
            
            try {
                logger.debug(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Processing address: ${address}`);

                // Step 1: Geocoding (Address -> PNU)
                const geocodeData = await gisService.getPNUFromAddress(address);
                if (!geocodeData) {
                    logger.warn(`[GIS ${jobId}] (${currentIndex}/${job.totalCount}) Geocoding failed: ${address}`);
                    continue;
                }
                
                // 실제로는 브이월드 API 사양에 맞춰 PNU를 보충 수집하는 로직 필요
                const pnu = geocodeData.pnu; 

                // Step 2-5: 수집 및 DB 저장 로직 (GisService에 상세 구현)
                // ... (필지 경계, 건물 정보, 소유주 등)

                job.processedCount++;
                const progress = Math.round((job.processedCount / job.totalCount) * 100);
                
                // 10% 단위로 또는 마지막일 때 로깅
                if (progress % 10 === 0 || job.processedCount === job.totalCount) {
                    logger.info(`[GIS ${jobId}] Progress: ${progress}% (${job.processedCount}/${job.totalCount})`);
                }

                // Supabase 상태 업데이트
                // @ts-ignore
                await (supabaseService as any).client.from('sync_jobs').update({
                    progress,
                    updated_at: new Date().toISOString()
                }).eq('id', jobId);

            } catch (err) {
                logger.error(`[GIS ${jobId}] Address processing error (${address})`, err);
            }
        }

        logger.info(`[GIS ${jobId}] All parcels collection completed`);
        this.updateJobStatus(jobId, { status: 'completed', completedAt: new Date() });
        // @ts-ignore
        await (supabaseService as any).client.from('sync_jobs').update({
            status: 'COMPLETED',
            progress: 100,
            updated_at: new Date().toISOString()
        }).eq('id', jobId);
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

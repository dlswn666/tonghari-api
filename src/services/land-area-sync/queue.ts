/**
 * LAND_AREA_SYNC 큐 서비스 (DESIGN §8·§14.1).
 *
 * 기존 GIS 큐 패턴을 따른다: p-queue concurrency 2, durable sync_jobs INSERT 성공 후에만 메모리
 * queue admission, admission 실패 시 job 을 FAILED 로 기록한다. 각 job 은 AbortController 를
 * 가지며, 워커가 terminal/fatal 로 끝나면 abort 해 늦은 callback 이 apply 를 호출하지 못하게 한다.
 *
 * discovery job 은 여기서 durable INSERT 한다. confirmation apply job 은 admission RPC 가 이미
 * INSERT 했으므로 이 큐는 memory admission(재실행)만 담당한다.
 */

import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env';
import type { DatabaseTarget } from '../../types/database.types';
import { assertLandAreaSyncEnabled } from '../../security/land-area-sync-execution-policy';
import {
    assertLandAreaSyncCanaryAllowed,
    assertLandAreaSyncScopeAllowed,
} from '../../security/land-area-sync-canary-policy';
import { getSupabaseService } from '../supabase.service';
import { persistSyncJobOrThrow } from '../sync-job-admission';
import { createLogger } from '../../utils/logger';
import {
    landAreaSyncAdapter,
    buildingHubAuthFromEnv,
    vworldAuthFromEnv,
    type LandAreaSyncAdapter,
} from './adapter';
import {
    insertDiscoveryJob,
    getScopedJob,
    freezeScopeSnapshot,
    writeDiscoveryTerminal,
    writeScopeState,
    writeAppliedIssues,
    markScopedFailed,
} from './repository';
import {
    readPropertyUnitCandidates,
    readBuildingUnitCandidates,
    readCurrentLandTuples,
} from './readers';
import { runLandAreaSyncJob, type LandAreaSyncDeps } from './service';
import type { LandAreaSyncDiscoveryRequest, LandAreaSyncJobInfo } from '../../types/land-area-sync-job.types';

const logger = createLogger('LAND-AREA-SYNC-QUEUE');

interface JobHandle {
    unionId: string;
    databaseTarget: DatabaseTarget;
    controller: AbortController;
}

class LandAreaSyncQueueService {
    private queue: PQueue;
    private jobs: Map<string, JobHandle>;
    private readonly adapter: LandAreaSyncAdapter;

    constructor(adapter: LandAreaSyncAdapter = landAreaSyncAdapter) {
        this.queue = new PQueue({ concurrency: 2, timeout: 600000 });
        this.jobs = new Map();
        this.adapter = adapter;
    }

    private key(databaseTarget: DatabaseTarget, jobId: string): string {
        return `${databaseTarget}:${jobId}`;
    }

    /**
     * discovery job 을 durable INSERT 한 뒤 메모리 queue 에 admission 한다. INSERT 실패는 throw
     * (route 가 503 매핑). INSERT 후 admission 실패면 durable job 을 FAILED 로 기록하고 throw.
     */
    async addDiscoveryJob(request: LandAreaSyncDiscoveryRequest): Promise<LandAreaSyncJobInfo> {
        assertLandAreaSyncEnabled(env.LAND_AREA_SYNC_ENABLED);
        assertLandAreaSyncCanaryAllowed(
            env.LAND_AREA_SYNC_ALLOWED_TARGETS,
            request.databaseTarget,
            request.unionId,
            request.anchorPnu
        );

        const jobId = uuidv4();
        const database = getSupabaseService(request.databaseTarget);

        await persistSyncJobOrThrow(jobId, request.unionId, () =>
            insertDiscoveryJob(database.getClient(), jobId, {
                unionId: request.unionId,
                anchorPnu: request.anchorPnu,
                actorUserId: request.actorUserId,
            })
        );

        try {
            this.admit(jobId, request.unionId, request.databaseTarget);
        } catch (admissionError) {
            await markScopedFailed(
                database.getClient(),
                jobId,
                request.unionId,
                'queue admission 실패로 작업을 시작하지 못했습니다.'
            );
            throw Object.assign(new Error('queue admission 실패'), {
                code: 'DEFERRED_QUEUE_ADMISSION_FINALIZE_FAILED',
                cause: admissionError,
            });
        }

        logger.info(`LAND_AREA_SYNC discovery job added: ${jobId} (anchor: ${request.anchorPnu})`);
        return {
            jobId,
            unionId: request.unionId,
            anchorPnu: request.anchorPnu,
            status: 'pending',
            createdAt: new Date(),
        };
    }

    /**
     * confirmation admission RPC 가 이미 INSERT 한 apply job 을 재실행 admission 한다.
     */
    admitApplyJob(
        jobId: string,
        unionId: string,
        anchorPnu: string,
        databaseTarget: DatabaseTarget
    ): void {
        assertLandAreaSyncEnabled(env.LAND_AREA_SYNC_ENABLED);
        assertLandAreaSyncCanaryAllowed(
            env.LAND_AREA_SYNC_ALLOWED_TARGETS,
            databaseTarget,
            unionId,
            anchorPnu
        );

        this.admit(jobId, unionId, databaseTarget);
        logger.info(`LAND_AREA_SYNC apply job admitted: ${jobId}`);
    }

    private admit(jobId: string, unionId: string, databaseTarget: DatabaseTarget): void {
        const controller = new AbortController();
        const key = this.key(databaseTarget, jobId);
        this.jobs.set(key, { unionId, databaseTarget, controller });

        this.queue
            .add(async () => {
                try {
                    await runLandAreaSyncJob({
                        jobId,
                        unionId,
                        deps: this.buildDeps(databaseTarget),
                        signal: controller.signal,
                    });
                } finally {
                    // terminal 도달 후 늦은 callback 이 apply 하지 못하도록 abort 한다.
                    controller.abort();
                    this.jobs.delete(key);
                }
            })
            .catch(async (err: unknown) => {
                controller.abort();
                this.jobs.delete(key);
                const message = err instanceof Error ? err.message : 'LAND_AREA_SYNC 워커 오류';
                logger.error(`LAND_AREA_SYNC job ${jobId} fatal error: ${message}`);
                await markScopedFailed(getSupabaseService(databaseTarget).getClient(), jobId, unionId, message).catch(
                    () => undefined
                );
            });
    }

    /** databaseTarget 별 orchestration deps 를 조립한다(adapter + supabase + repository + readers). */
    private buildDeps(databaseTarget: DatabaseTarget): LandAreaSyncDeps {
        const database = getSupabaseService(databaseTarget);
        const client = database.getClient();
        const hubAuth = buildingHubAuthFromEnv();
        const vworldAuth = vworldAuthFromEnv();

        return {
            now: () => new Date(),
            assertCanaryScopeAllowed: (unionId, scannedPnus) =>
                assertLandAreaSyncScopeAllowed(
                    env.LAND_AREA_SYNC_ALLOWED_TARGETS,
                    databaseTarget,
                    unionId,
                    scannedPnus
                ),
            scans: {
                scanTitle: (pnu, signal) => this.adapter.scanTitle(pnu, hubAuth, { signal }),
                scanAttached: (pnu, signal) => this.adapter.scanAttached(pnu, hubAuth, { signal }),
                scanBasis: (pnu, signal) => this.adapter.scanBasis(pnu, hubAuth, { signal }),
                scanExpos: (pnu, signal) => this.adapter.scanExpos(pnu, hubAuth, { signal }),
                scanLadfrl: (pnu, signal) => this.adapter.scanLadfrl(pnu, vworldAuth, { signal }),
                scanLdareg: (pnu, signal) => this.adapter.scanLdareg(pnu, vworldAuth, { signal }),
            },
            db: {
                resolveScope: (params) => database.resolveLandAreaSyncScope(params),
                applyRpc: (params) => database.applyPropertyLandAreaSync(params),
                getScopedJob: (jobId, unionId) => getScopedJob(client, jobId, unionId),
                freezeScopeSnapshot: (jobId, unionId, patch) => freezeScopeSnapshot(client, jobId, unionId, patch),
                writeDiscoveryTerminal: (jobId, unionId, input) => writeDiscoveryTerminal(client, jobId, unionId, input),
                writeScopeState: (jobId, unionId, scopeState) => writeScopeState(client, jobId, unionId, scopeState),
                writeAppliedIssues: (jobId, unionId, patch) => writeAppliedIssues(client, jobId, unionId, patch),
                markScopedFailed: (jobId, unionId, message) => markScopedFailed(client, jobId, unionId, message),
                readBuildingUnits: (unionId, scopePnus) => readBuildingUnitCandidates(client, unionId, scopePnus),
                readPropertyUnits: (unionId, scopePnus) => readPropertyUnitCandidates(client, unionId, scopePnus),
                readCurrentLandTuples: (unionId, ids) => readCurrentLandTuples(client, unionId, ids),
            },
        };
    }
}

export const landAreaSyncQueueService = new LandAreaSyncQueueService();
export { LandAreaSyncQueueService };
export default landAreaSyncQueueService;

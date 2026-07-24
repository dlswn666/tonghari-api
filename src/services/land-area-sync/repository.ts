/**
 * LAND_AREA_SYNC sync_jobs 리포지토리 (DESIGN §14.1).
 *
 * 모든 접근을 (id, union_id, job_type=LAND_AREA_SYNC) 스코프로 강제한다. 기존 id-only
 * `updateSyncJobStatus()` 를 이 경로에서 쓰지 않는다. snapshot CAS 는 DB 의 immutable snapshot
 * guard(migration [6]) 로 최종 보장되며, 여기서는 status=PROCESSING 전제만 추가로 건다.
 *
 * 순수 데이터 계층: SupabaseClient(service-role)를 주입받아 쿼리만 조립한다.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
    LAND_AREA_SYNC_JOB_TYPE,
    LAND_AREA_SYNC_SCHEMA_VERSION,
    type LandAreaSyncPreview,
} from '../../types/land-area-sync-job.types';

/** sync_jobs 행(LAND_AREA_SYNC 스코프에서 읽는 컬럼). */
export interface LandAreaSyncJobRow {
    id: string;
    union_id: string;
    status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
    progress: number;
    preview_data: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
    error_log: string | null;
}

const SELECT_COLUMNS = 'id, union_id, status, progress, preview_data, created_at, updated_at, error_log';

/** preview_data 에서 landAreaSync 서브트리를 방어적으로 꺼낸다. */
export function readLandAreaSync(row: LandAreaSyncJobRow): Partial<LandAreaSyncPreview> | null {
    const preview = row.preview_data;
    if (!preview || typeof preview !== 'object') return null;
    const land = (preview as Record<string, unknown>).landAreaSync;
    if (!land || typeof land !== 'object') return null;
    return land as Partial<LandAreaSyncPreview>;
}

export interface InsertDiscoveryJobInput {
    unionId: string;
    anchorPnu: string;
    actorUserId: string;
}

/**
 * discovery job durable INSERT. schemaVersion·anchorPnu 는 여기서 고정되며(guard immutable),
 * sourceDiscoveryJobId=null 로 두어 apply job(=string)과 구분된다. 성공하면 {id,union_id} 반환.
 */
export async function insertDiscoveryJob(
    client: SupabaseClient,
    jobId: string,
    input: InsertDiscoveryJobInput
): Promise<{ data: { id: string; union_id: string } | null; error: { message: string; code?: string } | null }> {
    return client
        .from('sync_jobs')
        .insert({
            id: jobId,
            union_id: input.unionId,
            job_type: LAND_AREA_SYNC_JOB_TYPE,
            status: 'PROCESSING',
            progress: 0,
            preview_data: {
                actorUserId: input.actorUserId,
                source: LAND_AREA_SYNC_JOB_TYPE,
                landAreaSync: {
                    schemaVersion: LAND_AREA_SYNC_SCHEMA_VERSION,
                    anchorPnu: input.anchorPnu,
                    sourceDiscoveryJobId: null,
                    admissionKey: jobId,
                },
            },
        })
        .select('id, union_id')
        .single();
}

/** id+union+type 스코프 단건 조회. */
export async function getScopedJob(
    client: SupabaseClient,
    jobId: string,
    unionId: string
): Promise<LandAreaSyncJobRow | null> {
    const { data, error } = await client
        .from('sync_jobs')
        .select(SELECT_COLUMNS)
        .eq('id', jobId)
        .eq('union_id', unionId)
        .eq('job_type', LAND_AREA_SYNC_JOB_TYPE)
        .maybeSingle();
    if (error) {
        throw Object.assign(new Error('LAND_AREA_SYNC job 조회 실패'), { code: 'JOB_LOOKUP_FAILED' });
    }
    return (data as LandAreaSyncJobRow | null) ?? null;
}

/** union+type+anchorPnu 최신 job 조회(latest). */
export async function getLatestScopedJob(
    client: SupabaseClient,
    unionId: string,
    anchorPnu: string
): Promise<LandAreaSyncJobRow | null> {
    const { data, error } = await client
        .from('sync_jobs')
        .select(SELECT_COLUMNS)
        .eq('union_id', unionId)
        .eq('job_type', LAND_AREA_SYNC_JOB_TYPE)
        .eq('preview_data->landAreaSync->>anchorPnu', anchorPnu)
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        throw Object.assign(new Error('LAND_AREA_SYNC latest 조회 실패'), { code: 'JOB_LOOKUP_FAILED' });
    }
    return (data as LandAreaSyncJobRow | null) ?? null;
}

/** response-loss 복구용 union+admissionKey exact 조회. actual job id는 admission key와 다를 수 있다. */
export async function getScopedAdmissionJob(
    client: SupabaseClient,
    admissionKey: string,
    unionId: string
): Promise<LandAreaSyncJobRow | null> {
    const { data, error } = await client
        .from('sync_jobs')
        .select(SELECT_COLUMNS)
        .eq('union_id', unionId)
        .eq('job_type', LAND_AREA_SYNC_JOB_TYPE)
        .eq('preview_data->landAreaSync->>admissionKey', admissionKey)
        .maybeSingle();
    if (error) {
        throw Object.assign(new Error('LAND_AREA_SYNC admission 조회 실패'), {
            code: 'JOB_LOOKUP_FAILED',
        });
    }
    return (data as LandAreaSyncJobRow | null) ?? null;
}

/** 현재 preview 를 읽어 landAreaSync 서브트리를 부분 병합한다(다른 job type 은 건드리지 않음). */
async function mergeLandAreaSync(
    client: SupabaseClient,
    jobId: string,
    unionId: string,
    patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
    const { data, error } = await client
        .from('sync_jobs')
        .select('preview_data')
        .eq('id', jobId)
        .eq('union_id', unionId)
        .eq('job_type', LAND_AREA_SYNC_JOB_TYPE)
        .maybeSingle();
    if (error) {
        throw Object.assign(new Error('preview_data 조회 실패'), { code: 'PREVIEW_LOOKUP_FAILED' });
    }
    const preview =
        data?.preview_data && typeof data.preview_data === 'object'
            ? (data.preview_data as Record<string, unknown>)
            : {};
    const land =
        preview.landAreaSync && typeof preview.landAreaSync === 'object'
            ? (preview.landAreaSync as Record<string, unknown>)
            : {};
    return {
        ...preview,
        landAreaSync: { ...land, ...patch },
    };
}

/**
 * snapshot CAS(한 번 고정). status=PROCESSING·id+union+type 스코프에서만 수행하고, scopeSnapshot·
 * branch·scopeState·scopeEvidence 를 병합한다. 이미 고정된 snapshot 을 바꾸려 하면 DB guard 가
 * 거부하므로 update 는 error 를 던진다. 성공 시 true.
 */
export async function freezeScopeSnapshot(
    client: SupabaseClient,
    jobId: string,
    unionId: string,
    patch: Pick<LandAreaSyncPreview, 'scopeState' | 'scopeEvidence' | 'scopeSnapshot' | 'branch'>
): Promise<boolean> {
    const previewData = await mergeLandAreaSync(client, jobId, unionId, {
        scopeState: patch.scopeState,
        scopeEvidence: patch.scopeEvidence,
        scopeSnapshot: patch.scopeSnapshot,
        branch: patch.branch,
    });
    const { data, error } = await client
        .from('sync_jobs')
        .update({ preview_data: previewData, updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .eq('union_id', unionId)
        .eq('job_type', LAND_AREA_SYNC_JOB_TYPE)
        .eq('status', 'PROCESSING')
        .select('id')
        .maybeSingle();
    if (error) {
        throw Object.assign(new Error('snapshot CAS 고정 실패'), { code: 'SNAPSHOT_CAS_FAILED', cause: error });
    }
    return data?.id === jobId;
}

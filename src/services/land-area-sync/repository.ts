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
    type LandAreaSyncCounts,
    type LandAreaSyncIssue,
    type LandAreaSyncOutcome,
    type LandAreaSyncScopeState,
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
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        throw Object.assign(new Error('LAND_AREA_SYNC latest 조회 실패'), { code: 'JOB_LOOKUP_FAILED' });
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
    return { ...preview, landAreaSync: { ...land, ...patch } };
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

export interface TerminalInput {
    status: 'COMPLETED' | 'FAILED';
    scopeState: LandAreaSyncScopeState;
    outcome: LandAreaSyncOutcome;
    counts: LandAreaSyncCounts;
    issues: LandAreaSyncIssue[];
    issuesTotal: number;
    issuesTruncated: boolean;
    errorLog?: string;
}

/**
 * discovery 경로 terminal 기록(§14.2). 보호 대상 6키는 건드리지 않고 scopeState/outcome/counts/
 * issues 만 병합한다. status=PROCESSING 에서만 전이한다.
 */
export async function writeDiscoveryTerminal(
    client: SupabaseClient,
    jobId: string,
    unionId: string,
    input: TerminalInput
): Promise<boolean> {
    const previewData = await mergeLandAreaSync(client, jobId, unionId, {
        scopeState: input.scopeState,
        outcome: input.outcome,
        counts: input.counts,
        issues: input.issues,
        issuesTotal: input.issuesTotal,
        issuesTruncated: input.issuesTruncated,
    });
    const update: Record<string, unknown> = {
        status: input.status,
        progress: 100,
        preview_data: previewData,
        updated_at: new Date().toISOString(),
    };
    if (input.errorLog !== undefined) update.error_log = input.errorLog;
    const { data, error } = await client
        .from('sync_jobs')
        .update(update)
        .eq('id', jobId)
        .eq('union_id', unionId)
        .eq('job_type', LAND_AREA_SYNC_JOB_TYPE)
        .eq('status', 'PROCESSING')
        .select('id')
        .maybeSingle();
    if (error) {
        throw Object.assign(new Error('terminal 기록 실패'), { code: 'TERMINAL_WRITE_FAILED', cause: error });
    }
    return data?.id === jobId;
}

/**
 * apply RPC 가 terminal(status=COMPLETED)을 이미 기록한 뒤, 보호 대상이 아닌 scopeState 만
 * 반영한다(SINGLE_PNU_CONFIRMED / MANUAL_OVERWRITE_CONFIRMATION_REQUIRED 등). status 는 건드리지
 * 않는다. id+union+type 스코프.
 */
export async function writeScopeState(
    client: SupabaseClient,
    jobId: string,
    unionId: string,
    scopeState: LandAreaSyncScopeState
): Promise<boolean> {
    const previewData = await mergeLandAreaSync(client, jobId, unionId, { scopeState });
    const { data, error } = await client
        .from('sync_jobs')
        .update({ preview_data: previewData, updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .eq('union_id', unionId)
        .eq('job_type', LAND_AREA_SYNC_JOB_TYPE)
        .select('id')
        .maybeSingle();
    if (error) return false;
    return data?.id === jobId;
}

/**
 * apply RPC 가 terminal(status=COMPLETED)을 이미 기록한 뒤, scopeState 와 함께 병합된 terminal
 * issues(discovery extraIssues 포함)를 반영한다(Finding 3). status 는 건드리지 않고 보호 대상 6키도
 * mergeLandAreaSync 로 보존한다(snapshot guard 통과). id+union+type 스코프.
 */
export async function writeAppliedIssues(
    client: SupabaseClient,
    jobId: string,
    unionId: string,
    patch: {
        scopeState: LandAreaSyncScopeState;
        issues: LandAreaSyncIssue[];
        issuesTotal: number;
        issuesTruncated: boolean;
    }
): Promise<boolean> {
    const previewData = await mergeLandAreaSync(client, jobId, unionId, {
        scopeState: patch.scopeState,
        issues: patch.issues,
        issuesTotal: patch.issuesTotal,
        issuesTruncated: patch.issuesTruncated,
    });
    const { data, error } = await client
        .from('sync_jobs')
        .update({ preview_data: previewData, updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .eq('union_id', unionId)
        .eq('job_type', LAND_AREA_SYNC_JOB_TYPE)
        .select('id')
        .maybeSingle();
    if (error) return false;
    return data?.id === jobId;
}

/**
 * id+union+type 스코프 FAILED 기록. RPC EXCEPTION(rollback) 후 job 을 FAILED 로 남기거나
 * admission 실패 시 사용한다. scopeState=FAILED·outcome=FAILED 로 병합한다.
 */
export async function markScopedFailed(
    client: SupabaseClient,
    jobId: string,
    unionId: string,
    message: string
): Promise<boolean> {
    const previewData = await mergeLandAreaSync(client, jobId, unionId, {
        scopeState: 'FAILED',
        outcome: 'FAILED',
    });
    const { data, error } = await client
        .from('sync_jobs')
        .update({
            status: 'FAILED',
            progress: 100,
            error_log: message,
            preview_data: previewData,
            updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('union_id', unionId)
        .eq('job_type', LAND_AREA_SYNC_JOB_TYPE)
        .select('id')
        .maybeSingle();
    if (error) return false;
    return data?.id === jobId;
}

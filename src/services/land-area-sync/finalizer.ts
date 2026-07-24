/**
 * LAND_AREA_SYNC non-apply terminal adapter.
 *
 * discovery/review/failed terminal은 public finalizer RPC만 사용한다.
 * APPLIED/PARTIAL terminal은 atomic apply RPC의 책임이며 이 모듈에서 만들지 않는다.
 */

import type { SupabaseService } from '../supabase.service';
import {
    getScopedJob,
    readLandAreaSync,
} from './repository';
import {
    normalizeStoredCounts,
    normalizeStoredIssues,
} from './preview';
import type { LandAreaSyncTerminalInput } from './service';

export async function writeDiscoveryTerminal(
    database: SupabaseService,
    jobId: string,
    unionId: string,
    input: LandAreaSyncTerminalInput
): Promise<boolean> {
    const { data, error } =
        await database.finalizeLandAreaSyncJob({
            p_union_id: unionId,
            p_sync_job_id: jobId,
            p_status: input.status,
            p_scope_state: input.scopeState,
            p_outcome: input.outcome,
            p_counts: input.counts,
            p_issues: input.issues,
            p_issues_total: input.issuesTotal,
            p_issues_truncated: input.issuesTruncated,
            p_error_log: input.errorLog ?? null,
        });
    if (error) {
        throw Object.assign(
            new Error('terminal finalizer RPC 실패'),
            { code: 'TERMINAL_WRITE_FAILED', cause: error }
        );
    }
    return data;
}

export async function markScopedFailed(
    database: SupabaseService,
    jobId: string,
    unionId: string,
    message: string
): Promise<boolean> {
    const row = await getScopedJob(
        database.getClient(),
        jobId,
        unionId
    );
    if (!row) return false;
    const current = readLandAreaSync(row);
    const counts = normalizeStoredCounts(current?.counts);
    const issues = normalizeStoredIssues(
        current?.issues,
        current?.issuesTotal,
        current?.issuesTruncated
    );
    const { data, error } =
        await database.finalizeLandAreaSyncJob({
            p_union_id: unionId,
            p_sync_job_id: jobId,
            p_status: 'FAILED',
            p_scope_state: 'FAILED',
            p_outcome: 'FAILED',
            p_counts: counts,
            p_issues: issues.issues,
            p_issues_total: issues.issuesTotal,
            p_issues_truncated: issues.issuesTruncated,
            p_error_log: message,
        });
    return error ? false : data;
}

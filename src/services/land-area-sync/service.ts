/**
 * LAND_AREA_SYNC discovery/apply 오케스트레이션 (DESIGN §8·§13·§14).
 *
 * 한 job(discovery 또는 apply)에 대해 §8 흐름도 순서로 파이프라인을 실행한다:
 *   title seed → DB resolver → gate 입력 scan → 공통 gate → 분기 scan → 분류·매칭 →
 *   3층 hash·snapshot CAS 고정 → write barrier 충족 시 apply RPC 정확히 1회(또는 0회) → terminal.
 *
 * 외부 HTTP·DB 접근은 전부 주입(deps)한다. transaction 은 apply RPC 내부에서만 열리므로 이
 * 오케스트레이터의 모든 scan/resolve 는 DB transaction 밖이다. terminal/fatal 후 늦은 callback 은
 * AbortSignal 로 차단하고, apply RPC 자체도 terminal job 을 거부한다(이중 방어).
 */

import {
    parseDbScopeResolution,
    resolveParcelScopeCompleteness,
    type DbScopeResolution,
    type BasePnuScan,
} from './scope';
import { BYLOT_SOURCE_POLICY, bylotBasisFallbackPlan } from './bylot';
import { assembleAttachedPnus, type AtchJibunRowInput } from '../gis-shared/pnu';
import { buildScopeEvidence, buildScopeSnapshot, capIssues, sanitizeIssue, emptyCounts, type CappedIssues } from './preview';
import { assembleLdaregApply, type LdaregPnuScan } from './ldareg-branch';
import { readLandAreaSync, type LandAreaSyncJobRow } from './repository';
import type {
    BrTitleRow,
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    LadfrlRow,
    LdaregRow,
    StrictScan,
    LandAreaSyncIssueCode,
} from '../../types/land-area-sync.types';
import type {
    BuildingUnitCandidate,
    PropertyUnitCandidate,
} from './matcher';
import type {
    LandAreaSyncStrategy,
    LandAreaSyncScopeState,
    LandAreaSyncOutcome,
    LandAreaSyncScanCompleteness,
    LandAreaSyncCounts,
    LandAreaSyncIssue,
    LandAreaSyncLandTuple,
    LandAreaSyncProposedArea,
    LandAreaSyncScopeSnapshot,
    LandAreaSyncConfirmation,
    LandAreaSyncApplyLadfrlItem,
    LandAreaSyncApplyLdaregItem,
    ApplyPropertyLandAreaSyncParams,
    ResolveScopeParams,
} from '../../types/land-area-sync-job.types';

// ── 주입 계약 ─────────────────────────────────────────────────────

export interface LandAreaSyncScanDeps {
    scanTitle(pnu: string, signal?: AbortSignal): Promise<StrictScan<BrTitleRow>>;
    scanAttached(pnu: string, signal?: AbortSignal): Promise<StrictScan<BrAtchJibunRow>>;
    scanBasis(pnu: string, signal?: AbortSignal): Promise<StrictScan<BrBasisOulnRow>>;
    scanExpos(pnu: string, signal?: AbortSignal): Promise<StrictScan<BrExposRow>>;
    scanLadfrl(pnu: string, signal?: AbortSignal): Promise<StrictScan<LadfrlRow>>;
    scanLdareg(pnu: string, signal?: AbortSignal): Promise<StrictScan<LdaregRow>>;
}

export interface LandAreaSyncTerminalInput {
    status: 'COMPLETED' | 'FAILED';
    scopeState: LandAreaSyncScopeState;
    outcome: LandAreaSyncOutcome;
    counts: LandAreaSyncCounts;
    issues: LandAreaSyncIssue[];
    issuesTotal: number;
    issuesTruncated: boolean;
    errorLog?: string;
}

export interface LandAreaSyncDbDeps {
    resolveScope(params: ResolveScopeParams): Promise<{ data: unknown; error: { message: string } | null }>;
    applyRpc(
        params: ApplyPropertyLandAreaSyncParams
    ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
    getScopedJob(jobId: string, unionId: string): Promise<LandAreaSyncJobRow | null>;
    freezeScopeSnapshot(
        jobId: string,
        unionId: string,
        patch: {
            scopeState: LandAreaSyncScopeState;
            scopeEvidence: ReturnType<typeof buildScopeEvidence>;
            scopeSnapshot: LandAreaSyncScopeSnapshot;
            branch: LandAreaSyncStrategy;
        }
    ): Promise<boolean>;
    writeDiscoveryTerminal(jobId: string, unionId: string, input: LandAreaSyncTerminalInput): Promise<boolean>;
    writeScopeState(jobId: string, unionId: string, scopeState: LandAreaSyncScopeState): Promise<boolean>;
    /**
     * apply RPC 성공 뒤(terminal=COMPLETED 은 RPC 가 이미 기록) scopeState 와 함께 병합된
     * terminal issues 를 반영한다(Finding 3). RPC 가 알 수 없는 discovery 단계 extraIssues 를
     * 보존하기 위한 경로. status 는 건드리지 않는다.
     */
    writeAppliedIssues(
        jobId: string,
        unionId: string,
        patch: {
            scopeState: LandAreaSyncScopeState;
            issues: LandAreaSyncIssue[];
            issuesTotal: number;
            issuesTruncated: boolean;
        }
    ): Promise<boolean>;
    markScopedFailed(jobId: string, unionId: string, message: string): Promise<boolean>;
    readBuildingUnits(unionId: string, scopePnus: string[]): Promise<BuildingUnitCandidate[]>;
    readPropertyUnits(unionId: string, scopePnus: string[]): Promise<PropertyUnitCandidate[]>;
    readCurrentLandTuples(unionId: string, propertyUnitIds: string[]): Promise<LandAreaSyncLandTuple[]>;
}

export interface LandAreaSyncDeps {
    scans: LandAreaSyncScanDeps;
    db: LandAreaSyncDbDeps;
    now(): Date;
}

export interface RunLandAreaSyncArgs {
    jobId: string;
    unionId: string;
    deps: LandAreaSyncDeps;
    signal?: AbortSignal;
}

// ── 유틸 ──────────────────────────────────────────────────────────

function str(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function membershipArray(m: unknown): Array<Record<string, unknown>> {
    return Array.isArray(m) ? m.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

function aborted(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
}

/** title rows → 정렬된 distinct root 관리 PK(mgmUpBldrgstPk 우선). */
function deriveRootPks(scan: StrictScan<BrTitleRow>): string[] {
    if (scan.state !== 'COMPLETE') return [];
    const set = new Set<string>();
    for (const r of scan.rows) {
        const up = str(r.mgmUpBldrgstPk).trim();
        const self = str(r.mgmBldrgstPk).trim();
        const root = up.length > 0 ? up : self;
        if (root.length > 0) set.add(root);
    }
    return [...set].sort();
}

/** COMPLETE row 만 반환. */
function rows<T>(scan: StrictScan<T>): T[] {
    return scan.state === 'COMPLETE' ? scan.rows : [];
}

function requiredScanState(scan: StrictScan<unknown>): 'OK' | 'FAILED' | 'INCOMPLETE' {
    if (scan.state === 'FAILED') return 'FAILED';
    if (scan.state === 'INCOMPLETE') return 'INCOMPLETE';
    return 'OK'; // COMPLETE / COMPLETE_ZERO
}

// ── 메인 오케스트레이션 ────────────────────────────────────────────

export async function runLandAreaSyncJob(args: RunLandAreaSyncArgs): Promise<void> {
    const { jobId, unionId, deps, signal } = args;
    const scanStartedAt = deps.now().toISOString();

    const jobRow = await deps.db.getScopedJob(jobId, unionId);
    if (!jobRow) {
        throw Object.assign(new Error('LAND_AREA_SYNC job 을 찾을 수 없습니다.'), { code: 'JOB_NOT_FOUND' });
    }
    const land = readLandAreaSync(jobRow) ?? {};
    const anchorPnu = str(land.anchorPnu);
    if (!/^[0-9]{19}$/.test(anchorPnu)) {
        await deps.db.markScopedFailed(jobId, unionId, 'anchor PNU 가 유효하지 않습니다.');
        return;
    }
    const isApplyJob = typeof land.sourceDiscoveryJobId === 'string' && land.confirmation != null;
    const overwriteManualConfirmed =
        isApplyJob && (land.confirmation as { overwriteManualConfirmed?: boolean } | null)?.overwriteManualConfirmed === true;

    // ── Phase 1: title seed(외부 호출 — transaction 밖) ──
    const titleSeed = await deps.scans.scanTitle(anchorPnu, signal);
    if (aborted(signal)) return;
    const rootPks = deriveRootPks(titleSeed);

    // ── Phase 2: DB resolver(read-only) ──
    const resolveRes = await deps.db.resolveScope({
        p_union_id: unionId,
        p_anchor_pnu: anchorPnu,
        p_root_mgm_bldrgst_pks: rootPks,
    });
    if (resolveRes.error) {
        await deps.db.markScopedFailed(jobId, unionId, `scope resolver 실패: ${resolveRes.error.message}`);
        return;
    }
    const dbScope = parseDbScopeResolution(resolveRes.data);
    if (aborted(signal)) return;

    // ── Phase 3: gate 입력 scan 완료(LINKED: 전 base / no-cache: anchor) ──
    const basePnus = dbScope.dbState === 'LINKED' && dbScope.linkedPnus.length > 0 ? [...new Set(dbScope.linkedPnus)].sort() : [anchorPnu];
    const policy = BYLOT_SOURCE_POLICY.policy;
    const baseScans: BasePnuScan[] = [];
    const titleByPnu: Array<{ pnu: string; titleRows: BrTitleRow[] }> = [];
    for (const pnu of basePnus) {
        const title = pnu === anchorPnu ? titleSeed : await deps.scans.scanTitle(pnu, signal);
        if (aborted(signal)) return;
        const attached = await deps.scans.scanAttached(pnu, signal);
        if (aborted(signal)) return;
        baseScans.push({ pnu, title, attached });
        titleByPnu.push({ pnu, titleRows: rows(title) });
    }
    // basis fallback(정책이 fallback 일 때만) — 필요한 PNU 만 1회 조회.
    for (const pnu of bylotBasisFallbackPlan(titleByPnu, policy)) {
        const basis = await deps.scans.scanBasis(pnu, signal);
        if (aborted(signal)) return;
        const entry = baseScans.find((b) => b.pnu === pnu);
        if (entry) entry.basis = basis;
    }

    // ── Phase 4: 공통 gate ──
    const gate = resolveParcelScopeCompleteness({ dbScope, baseScans, policy });

    const attachedAll: BrAtchJibunRow[] = baseScans.flatMap((b) => rows(b.attached));
    const assembledAttached = assembleAttachedPnus(attachedAll as unknown as AtchJibunRowInput[]);
    const scopeEvidence = buildScopeEvidence(dbScope, {
        attachedRows: attachedAll.length,
        distinctAttachedPnuCount: new Set(assembledAttached.pairs.map((p) => p.attachedPnu)).size,
    });

    if (gate.state === 'FAILED') {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'FAILED',
            scopeState: 'FAILED',
            outcome: 'FAILED',
            issues: gate.issues.map((code) => ({ code })),
            counts: gateCounts(baseScans),
        });
        return;
    }
    if (gate.state === 'REVIEW_REQUIRED') {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: gate.issues.map((code) => ({ code })),
            counts: gateCounts(baseScans),
        });
        return;
    }

    const strategy: LandAreaSyncStrategy | null =
        gate.classification.kind === 'CLASSIFIED' ? gate.classification.family : null;
    if (!strategy) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: [{ code: 'BUILDING_CLASSIFICATION_CONFLICT' }],
            counts: gateCounts(baseScans),
        });
        return;
    }

    // ── Phase 5: 분기 ──
    const ctx: BranchContext = {
        jobId,
        unionId,
        deps,
        signal,
        anchorPnu,
        isApplyJob,
        overwriteManualConfirmed,
        confirmation: (land.confirmation as LandAreaSyncConfirmation | null | undefined) ?? null,
        scanStartedAt,
        dbScope,
        scopeEvidence,
        // gate 는 SINGLE_PNU_CONFIRMED 를 스스로 발급하지 않는다. 방어적으로 confirmation 요구로 취급.
        gateState: gate.state === 'LINKED_SCOPE_RESOLVED' ? 'LINKED_SCOPE_RESOLVED' : 'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
        scannedPnus: gate.scannedPnus,
        bylot: gate.bylot,
        dbScopeHash: gate.dbScopeHash,
        externalScopeDigest: gate.externalScopeDigest,
        rootPk: rootPks[0] ?? '',
        baseScans,
    };

    if (strategy === 'LADFRL') {
        await runLadfrlBranch(ctx);
    } else {
        await runLdaregBranch(ctx);
    }
}

// ── 분기 컨텍스트 ─────────────────────────────────────────────────

interface BranchContext {
    jobId: string;
    unionId: string;
    deps: LandAreaSyncDeps;
    signal?: AbortSignal;
    anchorPnu: string;
    isApplyJob: boolean;
    overwriteManualConfirmed: boolean;
    /** apply job(=확인 후속 job)의 immutable confirmation. discovery/LINKED apply 는 null. */
    confirmation: LandAreaSyncConfirmation | null;
    scanStartedAt: string;
    dbScope: DbScopeResolution;
    scopeEvidence: ReturnType<typeof buildScopeEvidence>;
    gateState: 'SINGLE_SCOPE_CONFIRMATION_REQUIRED' | 'LINKED_SCOPE_RESOLVED';
    scannedPnus: string[];
    bylot: import('./bylot').BylotResolution;
    dbScopeHash: string;
    externalScopeDigest: string;
    rootPk: string;
    baseScans: BasePnuScan[];
}

// ── LADFRL 분기 ───────────────────────────────────────────────────

async function runLadfrlBranch(ctx: BranchContext): Promise<void> {
    const { deps, jobId, unionId, signal } = ctx;
    const targetPnu = ctx.scannedPnus[0];

    // 단일 필지의 활성 property_unit 정확히 1건(membership 기준).
    const membership = membershipArray(ctx.dbScope.propertyMembership);
    const candidates = [...new Set(membership.filter((m) => str(m.pnu) === targetPnu).map((m) => str(m.propertyUnitId)))];
    if (candidates.length !== 1) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: [{ code: candidates.length === 0 ? 'PROPERTY_UNIT_NOT_FOUND' : 'PROPERTY_UNIT_AMBIGUOUS' }],
            counts: gateCounts(ctx.baseScans),
        });
        return;
    }
    const propertyUnitId = candidates[0];

    // 필수 branch scan: ladfrl.
    const ladfrl = await deps.scans.scanLadfrl(targetPnu, signal);
    if (aborted(signal)) return;
    const ladfrlState = requiredScanState(ladfrl);
    if (ladfrlState !== 'OK') {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'FAILED',
            scopeState: 'FAILED',
            outcome: 'FAILED',
            issues: [{ code: ladfrlState === 'INCOMPLETE' ? 'PAGINATION_INCOMPLETE' : 'PROVIDER_PROTOCOL_ERROR', targetPnu }],
            counts: gateCounts(ctx.baseScans),
        });
        return;
    }
    const ladfrlArea = extractLadfrlArea(ladfrl, targetPnu);

    const currentLandTuples = await deps.db.readCurrentLandTuples(unionId, [propertyUnitId]);
    const proposedLandAreas: LandAreaSyncProposedArea[] = [{ propertyUnitId, landArea: ladfrlArea ?? '0' }];
    const items: LandAreaSyncApplyLadfrlItem[] = [{ propertyUnitId, targetPnu, ladfrlArea }];

    const snapshot = buildScopeSnapshot({
        strategy: 'LADFRL',
        frozenAt: deps.now().toISOString(),
        scannedPnus: ctx.scannedPnus,
        bylot: ctx.bylot,
        dbScopeHash: ctx.dbScopeHash,
        externalScopeDigest: ctx.externalScopeDigest,
        propertyMembership: ctx.dbScope.propertyMembership,
        candidatePropertyUnitIds: [propertyUnitId],
        currentLandTuples,
        proposedLandAreas,
        componentMatchDigest: [{ targetPnu, ladfrlArea }],
        projectionItems: items,
    });

    const counts = { ...gateCounts(ctx.baseScans), landRegistryRows: rows(ladfrl).length, matchedPropertyUnits: 1 };

    if (ctx.isApplyJob) {
        // 확인된 apply job — snapshot 은 이미 고정. 재실행 fresh digest 로 apply RPC 호출.
        await callApplyAndRecord(ctx, 'LADFRL', snapshot, items, counts);
        return;
    }

    // discovery: LADFRL 은 항상 SYSTEM_ADMIN 확인 필요(§13.3). snapshot 고정 후 confirmation 대기.
    await freezeAndOfferConfirmation(ctx, 'LADFRL', 'SINGLE_SCOPE_CONFIRMATION_REQUIRED', snapshot, counts);
}

function extractLadfrlArea(scan: StrictScan<LadfrlRow>, targetPnu: string): string | null {
    if (scan.state !== 'COMPLETE') return null;
    const row = scan.rows.find((r) => str(r.pnu) === targetPnu) ?? scan.rows[0];
    if (!row) return null;
    const v = str(row.lndpclAr).trim();
    return v.length > 0 ? v : null;
}

// ── LDAREG 분기 ───────────────────────────────────────────────────

async function runLdaregBranch(ctx: BranchContext): Promise<void> {
    const { deps, jobId, unionId, signal } = ctx;
    const scannedPnus = [...new Set(ctx.scannedPnus)].sort();

    // 대상 PNU별 필수 scan: ldareg + ladfrl + expos.
    const perPnu: LdaregPnuScan[] = [];
    let ldaregRegistryRows = 0;
    for (const pnu of scannedPnus) {
        const ldareg = await deps.scans.scanLdareg(pnu, signal);
        if (aborted(signal)) return;
        const ladfrl = await deps.scans.scanLadfrl(pnu, signal);
        if (aborted(signal)) return;
        const expos = await deps.scans.scanExpos(pnu, signal);
        if (aborted(signal)) return;

        for (const [scan, incompleteIssue, failedIssue] of [
            [ldareg, 'PAGINATION_INCOMPLETE', 'LDAREG_PERMISSION_REQUIRED'],
            [ladfrl, 'PAGINATION_INCOMPLETE', 'PROVIDER_PROTOCOL_ERROR'],
            [expos, 'PAGINATION_INCOMPLETE', 'PROVIDER_PROTOCOL_ERROR'],
        ] as const) {
            const st = requiredScanState(scan);
            if (st !== 'OK') {
                await finalizeDiscoveryTerminal(deps, jobId, unionId, {
                    status: 'FAILED',
                    scopeState: 'FAILED',
                    outcome: 'FAILED',
                    issues: [{ code: st === 'INCOMPLETE' ? incompleteIssue : failedIssue, targetPnu: pnu }],
                    counts: gateCounts(ctx.baseScans),
                });
                return;
            }
        }
        ldaregRegistryRows += rows(ldareg).length;
        perPnu.push({ pnu, ldaregRows: rows(ldareg), exposRows: rows(expos) });
    }

    const buildingUnits = await deps.db.readBuildingUnits(unionId, scannedPnus);
    const propertyUnits = await deps.db.readPropertyUnits(unionId, scannedPnus);
    if (aborted(signal)) return;

    const assembled = assembleLdaregApply({
        unionId,
        scannedPnus,
        rootIdentity: ctx.rootPk,
        perPnu,
        buildingUnits,
        propertyUnits,
    });

    const items: LandAreaSyncApplyLdaregItem[] = assembled.items;
    const candidateIds = assembled.matchedPropertyUnitIds;
    const currentLandTuples = await deps.db.readCurrentLandTuples(unionId, candidateIds);
    const proposedLandAreas: LandAreaSyncProposedArea[] = items.map((item) => ({
        propertyUnitId: item.propertyUnitId,
        landArea: sumCurrentNumerators(item),
    }));

    const snapshot = buildScopeSnapshot({
        strategy: 'LDAREG',
        frozenAt: deps.now().toISOString(),
        scannedPnus,
        bylot: ctx.bylot,
        dbScopeHash: ctx.dbScopeHash,
        externalScopeDigest: ctx.externalScopeDigest,
        propertyMembership: ctx.dbScope.propertyMembership,
        candidatePropertyUnitIds: candidateIds,
        currentLandTuples,
        proposedLandAreas,
        componentMatchDigest: assembled.componentMatchDigest,
        projectionItems: items,
    });

    const counts: LandAreaSyncCounts = {
        ...gateCounts(ctx.baseScans),
        landRegistryRows: ldaregRegistryRows,
        exposureRows: assembled.counts.exposureRows,
        parsedRows: assembled.counts.parsedRows,
        matchedPropertyUnits: candidateIds.length,
    };

    if (ctx.gateState === 'SINGLE_SCOPE_CONFIRMATION_REQUIRED') {
        // 확인된 apply job 을 confirmation 재제안보다 먼저 처리한다(LADFRL 패턴 미러).
        // 재실행 시 DB evidence 는 불변이라 gate 가 다시 SINGLE 을 반환하는데, 여기서 순서가 뒤바뀌면
        // 이미 snapshot 이 고정된 apply job 에 재freeze 를 시도하다가 migration [6] snapshot guard 에
        // 거부돼 job 이 FAILED 로 죽는다. apply 경로는 재freeze 없이 §13.4 barrier 를 거쳐 RPC 로 간다.
        if (ctx.isApplyJob) {
            await callApplyAndRecord(ctx, 'LDAREG', snapshot, items, counts, assembled.issues);
            return;
        }
        // no-cache single LDAREG discovery — snapshot 고정 후 확인 대기.
        await freezeAndOfferConfirmation(ctx, 'LDAREG', 'SINGLE_SCOPE_CONFIRMATION_REQUIRED', snapshot, counts, assembled.issues);
        return;
    }

    // LINKED_SCOPE_RESOLVED — apply job 이든 discovery LINKED 든 적용 시도.
    if (ctx.isApplyJob) {
        await callApplyAndRecord(ctx, 'LDAREG', snapshot, items, counts, assembled.issues);
        return;
    }

    // discovery LINKED: snapshot 고정 후 apply RPC 1회.
    const frozen = await deps.db.freezeScopeSnapshot(jobId, unionId, {
        scopeState: 'LINKED_SCOPE_RESOLVED',
        scopeEvidence: ctx.scopeEvidence,
        scopeSnapshot: snapshot,
        branch: 'LDAREG',
    });
    if (!frozen) {
        await deps.db.markScopedFailed(jobId, unionId, 'snapshot CAS 고정에 실패했습니다.');
        return;
    }
    await callApplyAndRecord(ctx, 'LDAREG', snapshot, items, counts, assembled.issues);
}

function sumCurrentNumerators(item: LandAreaSyncApplyLdaregItem): string {
    let sum = 0;
    for (const c of item.components) {
        if (c.sourceState !== 'CURRENT') continue;
        const n = Number(c.ratioNumerator);
        if (Number.isFinite(n)) sum += n;
    }
    return (Math.round(sum * 1e4) / 1e4).toString();
}

// ── 공통 terminal/apply ────────────────────────────────────────────

async function freezeAndOfferConfirmation(
    ctx: BranchContext,
    branch: LandAreaSyncStrategy,
    scopeState: LandAreaSyncScopeState,
    snapshot: LandAreaSyncScopeSnapshot,
    counts: LandAreaSyncCounts,
    extraIssues: LandAreaSyncIssue[] = []
): Promise<void> {
    const { deps, jobId, unionId } = ctx;
    const frozen = await deps.db.freezeScopeSnapshot(jobId, unionId, {
        scopeState,
        scopeEvidence: ctx.scopeEvidence,
        scopeSnapshot: snapshot,
        branch,
    });
    if (!frozen) {
        await deps.db.markScopedFailed(jobId, unionId, 'snapshot CAS 고정에 실패했습니다.');
        return;
    }
    await finalizeDiscoveryTerminal(deps, jobId, unionId, {
        status: 'COMPLETED',
        scopeState,
        outcome: 'REVIEW_REQUIRED',
        issues: extraIssues,
        counts,
    });
}

/**
 * write barrier(§13.1) 충족 시 apply RPC 를 정확히 1회 호출한다. terminal/fatal 후 늦은 callback 은
 * AbortSignal 로 0회. RPC EXCEPTION(rollback) 은 job 을 FAILED 로 기록한다. 성공 시 RPC 가
 * terminal 을 이미 썼으므로 scopeState(+병합 issues)만 반영한다.
 *
 * §13.4 barrier: 확인된 apply job 은 재실행 결과(membership+scopeHash)가 discovery 확인 시점과
 * 정확히 일치할 때만 RPC 를 호출한다. 어긋나면 기존값을 유지하고 REVIEW_REQUIRED 로 종결(apply 0).
 */
async function callApplyAndRecord(
    ctx: BranchContext,
    strategy: LandAreaSyncStrategy,
    snapshot: LandAreaSyncScopeSnapshot,
    items: LandAreaSyncApplyLadfrlItem[] | LandAreaSyncApplyLdaregItem[],
    counts: LandAreaSyncCounts,
    extraIssues: LandAreaSyncIssue[] = []
): Promise<void> {
    const { deps, jobId, unionId, signal } = ctx;
    if (aborted(signal)) return; // terminal/fatal 이후 apply 금지

    // §13.4 barrier — 확인된 apply job 은 재실행 scope 가 discovery 확인 시점과 exact 일치해야 apply.
    // DB apply RPC 도 동일 lineage 를 재검증하지만(이중 방어), 여기서 먼저 걸러 재실행 scope 가 바뀐
    // 경우 불필요한 write transaction 을 열지 않고 apply RPC 를 0회로 만든다.
    if (ctx.isApplyJob && ctx.confirmation) {
        const scopeMatches = snapshot.scopeHash === ctx.confirmation.confirmedDiscoveryScopeHash;
        const membershipMatches =
            snapshot.propertyMembershipHash === ctx.confirmation.confirmedPropertyMembershipHash;
        if (!scopeMatches || !membershipMatches) {
            // 확인 대상·재실행 scope 불일치 → 기존값 유지, apply 0, REVIEW_REQUIRED.
            await finalizeDiscoveryTerminal(deps, jobId, unionId, {
                status: 'COMPLETED',
                scopeState: 'REVIEW_REQUIRED',
                outcome: 'REVIEW_REQUIRED',
                issues: [{ code: 'LAND_SCOPE_CONFIRMATION_MISMATCH' }, ...extraIssues],
                counts,
            });
            return;
        }
    }

    const scanCompleteness: LandAreaSyncScanCompleteness = 'COMPLETE';
    const res = await deps.db.applyRpc({
        p_union_id: unionId,
        p_sync_job_id: jobId,
        p_strategy: strategy,
        p_scan_started_at: ctx.scanStartedAt,
        p_scan_completeness: scanCompleteness,
        p_db_scope_hash: snapshot.dbScopeHash,
        p_external_scope_digest: snapshot.externalScopeDigest,
        p_scope_hash: snapshot.scopeHash,
        p_scanned_pnus: snapshot.scannedPnus,
        p_items: items,
        p_result_summary: { counts },
    });

    if (res.error) {
        // RPC EXCEPTION → 전체 rollback. API 가 job 을 FAILED 로 기록한다.
        await deps.db.markScopedFailed(jobId, unionId, `apply RPC 실패: ${res.error.message}`);
        return;
    }

    const rpcIssues = parseRpcIssues(res.data);
    const outcome = str((res.data as { outcome?: unknown })?.outcome) as LandAreaSyncOutcome;
    const issueCodes = new Set(rpcIssues.map((i) => i.code as string));
    const scopeState = deriveApplyScopeState(ctx, outcome, issueCodes);

    // Finding 3 — discovery 단계 extraIssues(component 단위 RATIO_PARSE_FAILED·matcher NO_CHANGE·
    // dedup conflict 등)는 RPC 가 재계산할 수 없다(해당 component 는 p_items 에서 이미 제외). RPC 가
    // 쓴 terminal issues 에 병합해 유실을 막는다. extraIssues 가 없으면 기존 경로(scopeState 만) 유지.
    if (extraIssues.length > 0) {
        const merged = mergeTerminalIssues(rpcIssues, extraIssues);
        await deps.db.writeAppliedIssues(jobId, unionId, {
            scopeState,
            issues: merged.issues,
            issuesTotal: merged.issuesTotal,
            issuesTruncated: merged.issuesTruncated,
        });
        return;
    }
    await deps.db.writeScopeState(jobId, unionId, scopeState);
}

/** apply RPC 반환 issues 를 §17.3 allowlist 로 정제해 뽑는다(임의 필드 유입 방지). */
function parseRpcIssues(data: unknown): LandAreaSyncIssue[] {
    const arr = (data as { issues?: unknown })?.issues;
    if (!Array.isArray(arr)) return [];
    return arr
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map((x) =>
            sanitizeIssue({
                code: str(x.code) as LandAreaSyncIssueCode,
                propertyUnitId: typeof x.propertyUnitId === 'string' ? x.propertyUnitId : undefined,
                targetPnu: typeof x.targetPnu === 'string' ? x.targetPnu : undefined,
                dong: typeof x.dong === 'string' ? x.dong : undefined,
                ho: typeof x.ho === 'string' ? x.ho : undefined,
            })
        );
}

/**
 * RPC terminal issues 와 discovery extraIssues 를 병합한다(Finding 3). sanitize 후 (code·
 * propertyUnitId·targetPnu·dong·ho) 정체성 기준으로 중복을 제거하고, capIssues 로 200건 상한·
 * truncated 규칙을 SINGLE 경로(finalizeDiscoveryTerminal)와 동일하게 적용한다. RPC issues 를 앞에
 * 두어 상한 절단 시 RPC 결과가 우선 보존된다.
 */
function mergeTerminalIssues(rpcIssues: LandAreaSyncIssue[], extraIssues: LandAreaSyncIssue[]): CappedIssues {
    const seen = new Set<string>();
    const deduped: LandAreaSyncIssue[] = [];
    for (const issue of [...rpcIssues, ...extraIssues]) {
        const s = sanitizeIssue(issue);
        const key = `${s.code}|${s.propertyUnitId ?? ''}|${s.targetPnu ?? ''}|${s.dong ?? ''}|${s.ho ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(s);
    }
    return capIssues(deduped);
}

function deriveApplyScopeState(
    ctx: BranchContext,
    outcome: LandAreaSyncOutcome,
    issueCodes: Set<string>
): LandAreaSyncScopeState {
    if (outcome === 'REVIEW_REQUIRED') {
        if (issueCodes.has('MANUAL_OVERWRITE_CONFIRMATION_REQUIRED')) {
            return 'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED';
        }
        return 'REVIEW_REQUIRED';
    }
    // APPLIED / PARTIAL / NO_DATA
    if (ctx.isApplyJob) {
        // MANUAL overwrite(LINKED) 확인 apply 는 LINKED, 그 외 확인 apply 는 SINGLE_PNU_CONFIRMED.
        return ctx.overwriteManualConfirmed ? 'LINKED_SCOPE_RESOLVED' : 'SINGLE_PNU_CONFIRMED';
    }
    return 'LINKED_SCOPE_RESOLVED';
}

async function finalizeDiscoveryTerminal(
    deps: LandAreaSyncDeps,
    jobId: string,
    unionId: string,
    input: {
        status: 'COMPLETED' | 'FAILED';
        scopeState: LandAreaSyncScopeState;
        outcome: LandAreaSyncOutcome;
        issues: LandAreaSyncIssue[];
        counts: LandAreaSyncCounts;
        errorLog?: string;
    }
): Promise<void> {
    const capped = capIssues(input.issues);
    await deps.db.writeDiscoveryTerminal(jobId, unionId, {
        status: input.status,
        scopeState: input.scopeState,
        outcome: input.outcome,
        counts: input.counts,
        issues: capped.issues,
        issuesTotal: capped.issuesTotal,
        issuesTruncated: capped.issuesTruncated,
        errorLog: input.errorLog,
    });
}

/** gate 단계까지의 scan row count 를 counts 골격에 채운다. */
function gateCounts(baseScans: BasePnuScan[]): LandAreaSyncCounts {
    const counts = emptyCounts();
    for (const b of baseScans) {
        counts.titleRows += rows(b.title).length;
        counts.attachedRows += rows(b.attached).length;
        if (b.basis) counts.basisRows += rows(b.basis).length;
    }
    return counts;
}

export type { LandAreaSyncIssueCode };

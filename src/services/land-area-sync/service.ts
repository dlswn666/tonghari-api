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
import {
    assembleLdaregApply,
    selectCanonicalExposSourcePnu,
    type LdaregPnuScan,
} from './ldareg-branch';
import { resolveScopeLadfrlAreas } from './ladfrl-scope';
import {
    isOptionalRegistryManagementPkValid,
    normalizeRegistryManagementPk,
} from './registry-pk';
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

/**
 * 한 title scan → 정렬된 distinct root 관리 PK. 계열 grouping 목적이므로 up-PK 우선
 * (`mgmUpBldrgstPk` 있으면 그 값, 없으면 `mgmBldrgstPk`). anchor title 로 뽑은 결과가
 * resolver 호출 입력(`p_root_mgm_bldrgst_pks`)이자 snapshot.resolverRootPks 로 고정된다(C1).
 * ⚠️ up-PK/self-PK 축 선택은 Phase 0 실측 확정 항목이며, matcher 2단계·expos root 비교와
 * 동일 축(up 우선)을 쓴다. bylot reduce 는 이와 별개로 정확 PK(self) 축을 유지한다.
 */
function deriveRootPks(scan: StrictScan<BrTitleRow>): string[] {
    return collectRootPks([scan]);
}

/**
 * gate 입력으로 채택된 전 base title 의 계열 root 를 통일 유도한다(C1). matcher 의 scopeRootIdentity
 * 는 anchor title 단독이 아니라 전 base title 계열 기준(up-PK 우선)으로 뽑아 anchor 가 up-PK 를
 * 누락한 component 여도 계열 root 가 흔들리지 않게 한다.
 */
function deriveSeriesRootPks(baseScans: BasePnuScan[]): string[] {
    return collectRootPks(baseScans.map((b) => b.title));
}

/** title scan 묶음에서 up-PK 우선 root 를 정렬·dedup 수집한다. */
function collectRootPks(scans: StrictScan<BrTitleRow>[]): string[] {
    const set = new Set<string>();
    for (const scan of scans) {
        if (scan.state !== 'COMPLETE') continue;
        for (const r of scan.rows) {
            const root =
                normalizeRegistryManagementPk(r.mgmUpBldrgstPk) ??
                normalizeRegistryManagementPk(r.mgmBldrgstPk);
            if (root) set.add(root);
        }
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
    const basePnus =
        dbScope.dbState === 'LINKED' && dbScope.linkedBasePnus.length > 0
            ? [...new Set(dbScope.linkedBasePnus)].sort()
            : [anchorPnu];
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
    const assembledAttached = assembleAttachedPnus(
        attachedAll.map((row) => ({
            ...row,
            mgmBldrgstPk: normalizeRegistryManagementPk(row.mgmBldrgstPk) ?? '',
        })) as unknown as AtchJibunRowInput[]
    );
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
        // matcher scopeRootIdentity: 전 base title 계열 root(up-PK 우선, C1).
        rootPk: deriveSeriesRootPks(baseScans)[0] ?? '',
        // resolver 호출 입력(anchor title 계열 root) — snapshot.resolverRootPks 로 고정한다(C1 계약).
        resolverRootPks: rootPks,
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
    /** matcher scopeRootIdentity(전 base title 계열 root, up-PK 우선). */
    rootPk: string;
    /** resolver 호출에 실제 쓴 root 식별자(anchor title 계열, 정렬·dedup). snapshot 고정 대상(C1). */
    resolverRootPks: string[];
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
    if (ladfrl.state === 'COMPLETE_ZERO') {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: ctx.gateState,
            outcome: 'NO_DATA',
            issues: [],
            counts: {
                ...gateCounts(ctx.baseScans),
                landRegistryRows: 0,
                matchedPropertyUnits: 0,
            },
        });
        return;
    }
    const ladfrlScope = resolveScopeLadfrlAreas(
        [{ pnu: targetPnu, rows: rows(ladfrl) }],
        [targetPnu]
    );
    if (!ladfrlScope.ok) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'FAILED',
            scopeState: 'FAILED',
            outcome: 'FAILED',
            issues: [{ code: 'PROVIDER_PROTOCOL_ERROR', targetPnu }],
            counts: gateCounts(ctx.baseScans),
        });
        return;
    }
    const ladfrlArea = ladfrlScope.totalArea;

    const currentLandTuples = await deps.db.readCurrentLandTuples(unionId, [propertyUnitId]);
    const proposedLandAreas: LandAreaSyncProposedArea[] = [{ propertyUnitId, landArea: ladfrlArea ?? '0' }];
    const items: LandAreaSyncApplyLadfrlItem[] = [{ propertyUnitId, targetPnu, ladfrlArea }];

    const snapshot = buildScopeSnapshot({
        strategy: 'LADFRL',
        frozenAt: deps.now().toISOString(),
        scannedPnus: ctx.scannedPnus,
        resolverRootPks: ctx.resolverRootPks,
        bylot: ctx.bylot,
        dbScopeHash: ctx.dbScopeHash,
        externalScopeDigest: ctx.externalScopeDigest,
        propertyMembership: ctx.dbScope.propertyMembership,
        candidatePropertyUnitIds: [propertyUnitId],
        currentLandTuples,
        proposedLandAreas,
        ladfrlAreaEvidence: {
            parcels: ladfrlScope.areas,
            totalArea: ladfrlScope.totalArea,
        },
        replicationEvidence: null,
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

// ── LDAREG 분기 ───────────────────────────────────────────────────

async function runLdaregBranch(ctx: BranchContext): Promise<void> {
    const { deps, jobId, unionId, signal } = ctx;
    const scannedPnus = [...new Set(ctx.scannedPnus)].sort();

    // 대상 PNU별 필수 scan: ldareg + ladfrl + expos.
    const perPnu: LdaregPnuScan[] = [];
    const ladfrlScopeScans: Array<{ pnu: string; rows: LadfrlRow[] }> = [];
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
        if (
            rows(expos).some(
                (row) =>
                    normalizeRegistryManagementPk(row.mgmBldrgstPk) === null ||
                    !isOptionalRegistryManagementPkValid(row.mgmUpBldrgstPk)
            )
        ) {
            await finalizeDiscoveryTerminal(deps, jobId, unionId, {
                status: 'FAILED',
                scopeState: 'FAILED',
                outcome: 'FAILED',
                issues: [{ code: 'PROVIDER_PROTOCOL_ERROR', targetPnu: pnu }],
                counts: gateCounts(ctx.baseScans),
            });
            return;
        }
        ldaregRegistryRows += rows(ldareg).length;
        ladfrlScopeScans.push({ pnu, rows: rows(ladfrl) });
        perPnu.push({
            pnu,
            ldaregRows: rows(ldareg),
            exposRows: rows(expos),
        });
    }

    // 모든 resolved scope PNU가 exactly-one distinct positive finite LADFRL 면적을 가져야
    // LDAREG 분모 기준 합계를 만든다. 누락·0·상충·PNU 혼입은 apply 0으로 닫는다.
    const scopeLadfrl = resolveScopeLadfrlAreas(ladfrlScopeScans, scannedPnus);
    if (!scopeLadfrl.ok) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'FAILED',
            scopeState: 'FAILED',
            outcome: 'FAILED',
            issues: [
                {
                    code: 'PROVIDER_PROTOCOL_ERROR',
                    ...(scopeLadfrl.targetPnu ? { targetPnu: scopeLadfrl.targetPnu } : {}),
                },
            ],
            counts: gateCounts(ctx.baseScans),
        });
        return;
    }

    const buildingUnits = await deps.db.readBuildingUnits(unionId, scannedPnus);
    const propertyUnits = await deps.db.readPropertyUnits(unionId, scannedPnus);
    if (aborted(signal)) return;
    const canonicalBasePnus =
        ctx.dbScope.dbState === 'LINKED'
            ? [...new Set(ctx.dbScope.linkedBasePnus)].sort()
            : [...new Set(ctx.baseScans.map((scan) => scan.pnu))].sort();
    const expectedCanonicalSourcePnu = canonicalBasePnus[0];
    const canonicalSourcePnu = selectCanonicalExposSourcePnu(canonicalBasePnus, perPnu);
    if (
        !expectedCanonicalSourcePnu ||
        canonicalSourcePnu === null ||
        canonicalSourcePnu !== expectedCanonicalSourcePnu
    ) {
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: [{ code: 'LDAREG_IDENTITY_CONFLICT' }],
            counts: gateCounts(ctx.baseScans),
        });
        return;
    }

    const assembled = assembleLdaregApply({
        unionId,
        scannedPnus,
        rootIdentity: ctx.rootPk,
        perPnu,
        scopeLadfrlAreas: scopeLadfrl.areas,
        scopeLadfrlTotal: scopeLadfrl.totalArea,
        canonicalSourcePnu,
        buildingUnits,
        propertyUnits,
    });

    const counts: LandAreaSyncCounts = {
        ...gateCounts(ctx.baseScans),
        landRegistryRows: ldaregRegistryRows,
        exposureRows: assembled.counts.exposureRows,
        parsedRows: assembled.counts.parsedRows,
        matchedPropertyUnits: assembled.matchedPropertyUnitIds.length,
    };
    if (assembled.blocking || assembled.replicationEvidence === null) {
        // 분모/ratio 또는 raw multiset·최종 property match replica 불일치는 일부 component만
        // 골라 적용하지 않는다. job 전체를 REVIEW로 닫고 apply RPC는 0회다.
        await finalizeDiscoveryTerminal(deps, jobId, unionId, {
            status: 'COMPLETED',
            scopeState: 'REVIEW_REQUIRED',
            outcome: 'REVIEW_REQUIRED',
            issues: assembled.issues,
            counts,
        });
        return;
    }

    const items: LandAreaSyncApplyLdaregItem[] = assembled.items;
    const candidateIds = assembled.matchedPropertyUnitIds;
    const currentLandTuples = await deps.db.readCurrentLandTuples(unionId, candidateIds);
    const proposedLandAreas: LandAreaSyncProposedArea[] = items
        .filter((item) => item.components.some((component) => component.sourceState === 'CURRENT'))
        .map((item) => ({
            propertyUnitId: item.propertyUnitId,
            landArea: sumCurrentNumerators(item),
        }));

    const snapshot = buildScopeSnapshot({
        strategy: 'LDAREG',
        frozenAt: deps.now().toISOString(),
        scannedPnus,
        resolverRootPks: ctx.resolverRootPks,
        bylot: ctx.bylot,
        dbScopeHash: ctx.dbScopeHash,
        externalScopeDigest: ctx.externalScopeDigest,
        propertyMembership: ctx.dbScope.propertyMembership,
        candidatePropertyUnitIds: candidateIds,
        currentLandTuples,
        proposedLandAreas,
        ladfrlAreaEvidence: {
            parcels: scopeLadfrl.areas,
            totalArea: scopeLadfrl.totalArea,
        },
        replicationEvidence: assembled.replicationEvidence,
        componentMatchDigest: assembled.componentMatchDigest,
        projectionItems: items,
    });

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
    const numeratorByIdentity = new Map<string, string>();
    for (const c of item.components) {
        if (c.sourceState !== 'CURRENT') continue;
        if (!numeratorByIdentity.has(c.sourceIdentity)) {
            numeratorByIdentity.set(c.sourceIdentity, c.ratioNumerator);
        }
    }
    const values = [...numeratorByIdentity.values()].map((value) =>
        canonicalUnsignedDecimal(value)
    );
    if (values.length === 0) return '0';
    const scale = Math.max(...values.map((value) => value.split('.')[1]?.length ?? 0));
    let total = 0n;
    for (const value of values) {
        const [whole, fraction = ''] = value.split('.');
        total += BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
    }
    if (scale === 0) return total.toString();
    const digits = total.toString().padStart(scale + 1, '0');
    const whole = digits.slice(0, -scale);
    const fraction = digits.slice(-scale).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

function canonicalUnsignedDecimal(value: string): string {
    if (!/^\d+(?:\.\d+)?$/.test(value)) {
        throw new Error('검증되지 않은 LDAREG 분자입니다.');
    }
    const [whole, fraction = ''] = value.split('.');
    const canonicalWhole = whole.replace(/^0+(?=\d)/, '');
    const canonicalFraction = fraction.replace(/0+$/, '');
    return canonicalFraction ? `${canonicalWhole}.${canonicalFraction}` : canonicalWhole;
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
    const scopeState = deriveApplyScopeState(ctx, strategy, outcome, issueCodes);

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
    strategy: LandAreaSyncStrategy,
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
        // MANUAL overwrite(LINKED)는 LDAREG(다중 PNU 계열) 확인 apply 에만 해당한다. LADFRL 은
        // 단일 PNU 전략이라 overwrite 확인 apply 여도 SINGLE_PNU_CONFIRMED 로 표기한다(원장 승격 —
        // 기존엔 overwriteManualConfirmed=true 인 LADFRL 을 LINKED_SCOPE_RESOLVED 로 오표기했다).
        return strategy !== 'LADFRL' && ctx.overwriteManualConfirmed
            ? 'LINKED_SCOPE_RESOLVED'
            : 'SINGLE_PNU_CONFIRMED';
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

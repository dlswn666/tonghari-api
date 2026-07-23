import assert from 'node:assert/strict';
import test from 'node:test';
import { runLandAreaSyncJob, type LandAreaSyncDeps } from '../src/services/land-area-sync/service';
import type { LandAreaSyncJobRow } from '../src/services/land-area-sync/repository';
import { HOUSING_PURPOSE_ALLOWLIST } from '../src/services/land-area-sync/housing-purpose-allowlist.fixture';
import type {
    BrTitleRow,
    LadfrlRow,
    LdaregRow,
    StrictScan,
} from '../src/types/land-area-sync.types';
import type { LandAreaSyncIssue } from '../src/types/land-area-sync-job.types';

const ANCHOR = '1168010100107360024';
const PROP_ID = '11111111-1111-4111-8111-111111111111';
const PK = 'PK-ROOT';
const DETACHED = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'DETACHED')!;
const MULTIPLEX = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'MULTIPLEX')!;

function titleComplete(pair: typeof DETACHED): StrictScan<BrTitleRow> {
    return {
        state: 'COMPLETE',
        rows: [{ mgmBldrgstPk: PK, bylotCnt: '0', regstrGbCd: pair.regstrGbCd, mainPurpsCd: pair.mainPurpsCd, mainPurpsCdNm: pair.mainPurpsCdNm }],
        totalCount: 1,
        pagesFetched: 1,
    };
}
function zero<T>(): StrictScan<T> {
    return { state: 'COMPLETE_ZERO', rows: [], totalCount: 0, pagesFetched: 1 };
}
function failed<T>(): StrictScan<T> {
    return { state: 'FAILED', issue: { kind: 'HTTP_ERROR', endpoint: 'getBrTitleInfo', message: 'x', httpStatus: 500 } };
}
function ladfrlComplete(): StrictScan<LadfrlRow> {
    return { state: 'COMPLETE', rows: [{ pnu: ANCHOR, lndpclAr: '100.5' }], totalCount: 1, pagesFetched: 1 };
}
/** CURRENT 대지권 1건. expos 를 zero 로 두면 matcher 가 NO_CHANGE(PROPERTY_UNIT_NOT_FOUND) 를 낸다. */
function ldaregCurrent(): StrictScan<LdaregRow> {
    return {
        state: 'COMPLETE',
        rows: [{ pnu: ANCHOR, agbldgSn: '1', ldaQotaRate: '100/1000', clsSeCode: '1', buldDongNm: '101', buldFloorNm: '3', buldHoNm: '301' }],
        totalCount: 1,
        pagesFetched: 1,
    };
}

interface Spy {
    freezeCalls: number;
    applyCalls: number;
    terminalCalls: Array<{ status: string; scopeState: string; outcome: string }>;
    /** writeDiscoveryTerminal 로 넘어간 issues(terminalCalls 와 index 대응). */
    terminalIssues: LandAreaSyncIssue[][];
    scopeStateCalls: string[];
    failedCalls: string[];
    lastApplyParams: unknown;
    /** freezeScopeSnapshot 로 고정된 snapshot 의 scope/membership hash. */
    frozenSnapshots: Array<{ scopeHash: string; propertyMembershipHash: string }>;
    /** writeAppliedIssues(Finding 3 병합 경로) 호출 인자. */
    appliedIssuesCalls: Array<{ scopeState: string; issues: LandAreaSyncIssue[]; issuesTotal: number; issuesTruncated: boolean }>;
}

function makeDeps(opts: {
    resolver: unknown;
    scans?: Partial<LandAreaSyncDeps['scans']>;
    applyResult?: { data: unknown; error: { message: string; code?: string } | null };
    membership?: unknown;
    onReadProperty?: () => void;
    /** getScopedJob 이 돌려줄 preview_data 오버라이드(apply job 시나리오용). */
    jobPreviewData?: Record<string, unknown>;
    spy: Spy;
}): LandAreaSyncDeps {
    const { spy } = opts;
    const defaultScans: LandAreaSyncDeps['scans'] = {
        scanTitle: async () => titleComplete(DETACHED),
        scanAttached: async () => zero(),
        scanBasis: async () => zero(),
        scanExpos: async () => zero(),
        scanLadfrl: async () => ladfrlComplete(),
        scanLdareg: async () => zero<LdaregRow>(),
    };
    return {
        now: () => new Date('2026-07-23T00:00:00.000Z'),
        scans: { ...defaultScans, ...opts.scans },
        db: {
            resolveScope: async () => ({ data: opts.resolver, error: null }),
            applyRpc: async (params) => {
                spy.applyCalls += 1;
                spy.lastApplyParams = params;
                return opts.applyResult ?? { data: { outcome: 'NO_DATA', issues: [] }, error: null };
            },
            getScopedJob: async (): Promise<LandAreaSyncJobRow> => ({
                id: 'job-1',
                union_id: 'union-1',
                status: 'PROCESSING',
                progress: 0,
                preview_data: opts.jobPreviewData ?? { landAreaSync: { schemaVersion: 2, anchorPnu: ANCHOR, sourceDiscoveryJobId: null } },
                created_at: '', updated_at: '', error_log: null,
            }),
            freezeScopeSnapshot: async (_j, _u, patch) => {
                spy.freezeCalls += 1;
                spy.frozenSnapshots.push({
                    scopeHash: patch.scopeSnapshot.scopeHash,
                    propertyMembershipHash: patch.scopeSnapshot.propertyMembershipHash,
                });
                return true;
            },
            writeDiscoveryTerminal: async (_j, _u, input) => {
                spy.terminalCalls.push({ status: input.status, scopeState: input.scopeState, outcome: input.outcome });
                spy.terminalIssues.push(input.issues);
                return true;
            },
            writeScopeState: async (_j, _u, s) => { spy.scopeStateCalls.push(s); return true; },
            writeAppliedIssues: async (_j, _u, patch) => {
                spy.appliedIssuesCalls.push({
                    scopeState: patch.scopeState,
                    issues: patch.issues,
                    issuesTotal: patch.issuesTotal,
                    issuesTruncated: patch.issuesTruncated,
                });
                return true;
            },
            markScopedFailed: async (_j, _u, m) => { spy.failedCalls.push(m); return true; },
            readBuildingUnits: async () => [],
            readPropertyUnits: async () => { opts.onReadProperty?.(); return []; },
            readCurrentLandTuples: async () => [],
        },
    };
}

function emptySpy(): Spy {
    return {
        freezeCalls: 0,
        applyCalls: 0,
        terminalCalls: [],
        terminalIssues: [],
        scopeStateCalls: [],
        failedCalls: [],
        lastApplyParams: null,
        frozenSnapshots: [],
        appliedIssuesCalls: [],
    };
}

/** apply job(=확인 후속 job) preview_data. sourceDiscoveryJobId+confirmation 이 있으면 isApplyJob=true. */
function applyJobPreview(confirmation: {
    confirmedDiscoveryScopeHash: string;
    confirmedPropertyMembershipHash: string;
    overwriteManualConfirmed?: boolean;
}): Record<string, unknown> {
    return {
        landAreaSync: {
            schemaVersion: 2,
            anchorPnu: ANCHOR,
            sourceDiscoveryJobId: 'disc-1',
            confirmation: { overwriteManualConfirmed: false, ...confirmation },
        },
    };
}

function noEvidence(membership: unknown): unknown {
    return {
        dbState: 'NO_EVIDENCE', rootBuildingIdentities: [PK], componentPnus: [ANCHOR], linkedPnus: [],
        linkedEvidenceKeys: [], pendingEvidenceKeys: [], blockingEvidence: [], openUnresolvedEvidenceKeys: [],
        componentTruncated: false, propertyMembership: membership, dbScopeHash: 'db-hash-noevidence',
    };
}
function linked(membership: unknown): unknown {
    return {
        dbState: 'LINKED', rootBuildingIdentities: [PK], componentPnus: [ANCHOR], linkedPnus: [ANCHOR],
        linkedEvidenceKeys: ['k1'], pendingEvidenceKeys: [], blockingEvidence: [], openUnresolvedEvidenceKeys: [],
        componentTruncated: false, propertyMembership: membership, dbScopeHash: 'db-hash-linked',
    };
}

const MEMBER = [{ propertyUnitId: PROP_ID, pnu: ANCHOR, buildingUnitId: null }];

test('gate FAILED(title 실패)는 job 을 FAILED 로 종결하고 apply RPC 를 0회 호출한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({ resolver: noEvidence(MEMBER), scans: { scanTitle: async () => failed<BrTitleRow>() }, spy });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 0);
    assert.deepEqual(spy.terminalCalls, [{ status: 'FAILED', scopeState: 'FAILED', outcome: 'FAILED' }]);
});

test('LADFRL discovery(no-cache single)는 snapshot 을 CAS 고정하고 확인 대기(REVIEW), apply 0회', async () => {
    const spy = emptySpy();
    const deps = makeDeps({ resolver: noEvidence(MEMBER), spy });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.freezeCalls, 1, 'snapshot 은 정확히 1회 CAS 고정');
    assert.equal(spy.applyCalls, 0, 'LADFRL discovery 는 apply 하지 않는다');
    assert.equal(spy.terminalCalls.length, 1);
    assert.equal(spy.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
    assert.equal(spy.terminalCalls[0].outcome, 'REVIEW_REQUIRED');
});

test('LDAREG LINKED discovery 는 snapshot 을 1회 고정하고 apply RPC 를 정확히 1회 호출한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        applyResult: { data: { outcome: 'NO_DATA', issues: [] }, error: null },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.freezeCalls, 1, 'CAS 는 1회');
    assert.equal(spy.applyCalls, 1, 'apply 는 정확히 1회');
    assert.deepEqual(spy.scopeStateCalls, ['LINKED_SCOPE_RESOLVED']);
    assert.equal(spy.failedCalls.length, 0);
});

test('LDAREG 필수 scan(ldareg) FAILED 는 write barrier 로 apply 0회 + FAILED', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX), scanLdareg: async () => failed<LdaregRow>() },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.terminalCalls[0].status, 'FAILED');
});

test('apply RPC EXCEPTION(rollback)은 job 을 FAILED 로 기록한다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        applyResult: { data: null, error: { message: 'SCOPE_CHANGED_DURING_SYNC', code: '40001' } },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 1);
    assert.equal(spy.scopeStateCalls.length, 0);
    assert.equal(spy.failedCalls.length, 1);
    assert.match(spy.failedCalls[0], /apply RPC 실패/);
});

test('terminal/fatal 후 늦은 callback(AbortSignal)은 apply RPC 를 호출하지 못한다', async () => {
    const spy = emptySpy();
    const controller = new AbortController();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        // readPropertyUnits 시점에 terminal 이 발생한 것으로 시뮬레이션(abort). 이후 apply 는 차단돼야 한다.
        onReadProperty: () => controller.abort(),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps, signal: controller.signal });
    assert.equal(spy.applyCalls, 0, 'abort 이후 apply 호출 0회');
});

// ── apply-lineage 경로(확인 후속 job) — Finding 1·2 ─────────────────────────────

test('LADFRL 확인 apply job: 재실행 scope 일치 → apply RPC 정확히 1회, 재freeze 0회, SINGLE_PNU_CONFIRMED', async () => {
    // 1) discovery 를 먼저 돌려 고정될 scopeHash/membershipHash 를 캡처한다(동일 deps → 결정적).
    const disc = emptySpy();
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps: makeDeps({ resolver: noEvidence(MEMBER), spy: disc }) });
    assert.equal(disc.frozenSnapshots.length, 1, 'discovery 는 snapshot 을 1회 고정');
    const frozen = disc.frozenSnapshots[0];

    // 2) 같은 scope 로 확인된 apply job 을 재실행 → §13.4 barrier 통과 → apply RPC.
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        jobPreviewData: applyJobPreview({
            confirmedDiscoveryScopeHash: frozen.scopeHash,
            confirmedPropertyMembershipHash: frozen.propertyMembershipHash,
        }),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 1, 'apply RPC 정확히 1회');
    assert.equal(spy.freezeCalls, 0, '이미 고정된 apply job 은 재freeze 하지 않는다');
    assert.deepEqual(spy.scopeStateCalls, ['SINGLE_PNU_CONFIRMED']);
    assert.equal(spy.terminalCalls.length, 0, 'terminal 은 apply RPC 가 기록(서비스는 scopeState 만)');
    assert.equal(spy.failedCalls.length, 0);
});

test('LADFRL 확인 apply job: 재실행 scopeHash 불일치 → apply RPC 0회 + REVIEW_REQUIRED', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        jobPreviewData: applyJobPreview({
            confirmedDiscoveryScopeHash: 'WRONG-SCOPE-HASH',
            confirmedPropertyMembershipHash: 'WRONG-MEMBERSHIP-HASH',
        }),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 0, '불일치 시 apply RPC 0회');
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.terminalCalls.length, 1);
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
    assert.equal(spy.terminalCalls[0].outcome, 'REVIEW_REQUIRED');
    assert.ok(spy.terminalIssues[0].some((i) => i.code === 'LAND_SCOPE_CONFIRMATION_MISMATCH'), 'mismatch issue 기록');
});

test('LDAREG(single 확인) apply job: 재실행 scope 일치 → apply RPC 정확히 1회, 재freeze 0회, SINGLE_PNU_CONFIRMED', async () => {
    // Finding 1 회귀 가드: 수정 전에는 SINGLE 분기가 isApplyJob 보다 먼저 와서 apply job 이
    // freezeAndOfferConfirmation(재freeze)로 떨어져 apply 0회였다. 수정 후 barrier 를 거쳐 apply 1회.
    const disc = emptySpy();
    await runLandAreaSyncJob({
        jobId: 'job-1', unionId: 'union-1',
        deps: makeDeps({ resolver: noEvidence(MEMBER), scans: { scanTitle: async () => titleComplete(MULTIPLEX) }, spy: disc }),
    });
    assert.equal(disc.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED', 'discovery 는 확인 대기');
    const frozen = disc.frozenSnapshots[0];

    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        jobPreviewData: applyJobPreview({
            confirmedDiscoveryScopeHash: frozen.scopeHash,
            confirmedPropertyMembershipHash: frozen.propertyMembershipHash,
        }),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 1, 'apply RPC 정확히 1회(재freeze 없이 barrier 통과)');
    assert.equal(spy.freezeCalls, 0, '이미 고정된 apply job 은 재freeze 하지 않는다');
    assert.deepEqual(spy.scopeStateCalls, ['SINGLE_PNU_CONFIRMED']);
    assert.equal(spy.terminalCalls.length, 0);
});

test('LDAREG(single 확인) apply job: 재실행 scopeHash 불일치 → apply RPC 0회 + REVIEW_REQUIRED', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: noEvidence(MEMBER),
        scans: { scanTitle: async () => titleComplete(MULTIPLEX) },
        jobPreviewData: applyJobPreview({
            confirmedDiscoveryScopeHash: 'WRONG-SCOPE-HASH',
            confirmedPropertyMembershipHash: 'WRONG-MEMBERSHIP-HASH',
        }),
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    assert.equal(spy.applyCalls, 0, '불일치 시 apply RPC 0회');
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
    assert.ok(spy.terminalIssues[0].some((i) => i.code === 'LAND_SCOPE_CONFIRMATION_MISMATCH'), 'mismatch issue 기록');
});

// ── Finding 3: LINKED 즉시적용 경로에서 discovery extraIssue 병합 ───────────────

test('LINKED LDAREG 즉시적용: discovery extraIssue 가 terminal issues 에 병합되고 RPC 반환 issue 와 dedup 된다', async () => {
    const spy = emptySpy();
    const deps = makeDeps({
        resolver: linked(MEMBER),
        scans: {
            scanTitle: async () => titleComplete(MULTIPLEX),
            scanLdareg: async () => ldaregCurrent(), // CURRENT 대지권 1건
            scanExpos: async () => zero(), // 전유부 0 → matcher NO_CHANGE(PROPERTY_UNIT_NOT_FOUND) extraIssue
        },
        applyResult: {
            data: {
                outcome: 'NO_DATA',
                issues: [
                    { code: 'LDAREG_IDENTITY_CONFLICT', targetPnu: ANCHOR }, // RPC 고유 issue
                    { code: 'PROPERTY_UNIT_NOT_FOUND', targetPnu: ANCHOR }, // discovery extraIssue 와 동일(dedup 대상)
                ],
            },
            error: null,
        },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });

    assert.equal(spy.applyCalls, 1, 'LINKED 즉시적용은 apply RPC 1회');
    assert.equal(spy.appliedIssuesCalls.length, 1, 'extraIssue 가 있으면 병합 경로로 terminal issues 를 기록');
    assert.equal(spy.scopeStateCalls.length, 0, '병합 경로는 writeScopeState 대신 writeAppliedIssues 사용');
    const merged = spy.appliedIssuesCalls[0];
    assert.equal(merged.scopeState, 'LINKED_SCOPE_RESOLVED');
    const codes = merged.issues.map((i) => i.code);
    assert.ok(codes.includes('PROPERTY_UNIT_NOT_FOUND'), 'discovery extraIssue(유실되던 값) 보존');
    assert.ok(codes.includes('LDAREG_IDENTITY_CONFLICT'), 'RPC 반환 issue 보존');
    assert.equal(codes.filter((c) => c === 'PROPERTY_UNIT_NOT_FOUND').length, 1, 'RPC 반환 issue 와 중복 dedup');
});

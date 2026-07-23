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

interface Spy {
    freezeCalls: number;
    applyCalls: number;
    terminalCalls: Array<{ status: string; scopeState: string; outcome: string }>;
    scopeStateCalls: string[];
    failedCalls: string[];
    lastApplyParams: unknown;
}

function makeDeps(opts: {
    resolver: unknown;
    scans?: Partial<LandAreaSyncDeps['scans']>;
    applyResult?: { data: unknown; error: { message: string; code?: string } | null };
    membership?: unknown;
    onReadProperty?: () => void;
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
                preview_data: { landAreaSync: { schemaVersion: 2, anchorPnu: ANCHOR, sourceDiscoveryJobId: null } },
                created_at: '', updated_at: '', error_log: null,
            }),
            freezeScopeSnapshot: async () => { spy.freezeCalls += 1; return true; },
            writeDiscoveryTerminal: async (_j, _u, input) => {
                spy.terminalCalls.push({ status: input.status, scopeState: input.scopeState, outcome: input.outcome });
                return true;
            },
            writeScopeState: async (_j, _u, s) => { spy.scopeStateCalls.push(s); return true; },
            markScopedFailed: async (_j, _u, m) => { spy.failedCalls.push(m); return true; },
            readBuildingUnits: async () => [],
            readPropertyUnits: async () => { opts.onReadProperty?.(); return []; },
            readCurrentLandTuples: async () => [],
        },
    };
}

function emptySpy(): Spy {
    return { freezeCalls: 0, applyCalls: 0, terminalCalls: [], scopeStateCalls: [], failedCalls: [], lastApplyParams: null };
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

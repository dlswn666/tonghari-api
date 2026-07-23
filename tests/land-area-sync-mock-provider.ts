/**
 * LAND_AREA_SYNC 통합 테스트 공용 mock provider 하네스 (DESIGN §8·§10~§14).
 *
 * 실제 `LandAreaSyncAdapter` 에 주입 httpClient 를 물려 discovery 전 구간
 * (scan→DB resolver→gate→분류→매칭→preview→apply barrier)을 관통시키는 도구다.
 * DB 계층(resolver/applyRpc/freeze/terminal/read)은 실 DB 가 없으므로 spy 로 주입한다.
 *
 * 이 파일은 `*.test.ts` 가 아니므로 `node --test` 가 테스트로 실행하지 않고,
 * 통합/보안 테스트 두 파일이 import 해서만 쓴다(헬퍼 중복 방지).
 */

import { LandAreaSyncAdapter, STRICT_SCAN_PAGE_SIZE } from '../src/services/land-area-sync/adapter';
import type { LandAreaSyncDeps } from '../src/services/land-area-sync/service';
import type { LandAreaSyncJobRow } from '../src/services/land-area-sync/repository';
import { HOUSING_PURPOSE_ALLOWLIST } from '../src/services/land-area-sync/housing-purpose-allowlist.fixture';
import type { HttpRequest, HttpResponse } from '../src/types/land-area-sync.types';
import type {
    LandAreaSyncIssue,
    LandAreaSyncScopeSnapshot,
    LandAreaSyncScopeEvidence,
} from '../src/types/land-area-sync-job.types';

// ── 상수 ─────────────────────────────────────────────────────────

export const ANCHOR = '1168010100107360024';
export const SIBLING = '1168010100107360025';
export const THIRD = '1168010100107360026';
export const PROP_ID = '11111111-1111-4111-8111-111111111111';
export const PK = 'PK-ROOT';

export const DETACHED = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'DETACHED')!;
export const MULTIPLEX = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'MULTIPLEX')!;

export type EndpointName =
    | 'getBrTitleInfo'
    | 'getBrAtchJibunInfo'
    | 'getBrExposInfo'
    | 'getBrBasisOulnInfo'
    | 'ladfrlList'
    | 'ldaregList';

const HUB_ENDPOINTS = new Set<EndpointName>([
    'getBrTitleInfo',
    'getBrAtchJibunInfo',
    'getBrExposInfo',
    'getBrBasisOulnInfo',
]);
const VWORLD_CONTAINER: Record<string, string> = {
    ladfrlList: 'ladfrlVOList',
    ldaregList: 'ldaregVOList',
};

// ── envelope 빌더(adapter.test.ts 와 동일 shape) ────────────────────

export function ok(data: unknown, headers: Record<string, string> = {}): HttpResponse {
    return { status: 200, data, headers };
}
export function httpError(status: number): HttpResponse {
    return { status, data: {}, headers: {} };
}

/** Building HUB 성공 envelope */
export function hubBody(totalCount: number, rows: unknown[]): unknown {
    return {
        response: {
            header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
            body: {
                totalCount,
                pageNo: 1,
                numOfRows: STRICT_SCAN_PAGE_SIZE,
                items: rows.length === 0 ? '' : { item: rows.length === 1 ? rows[0] : rows },
            },
        },
    };
}

/** V-World NED 성공 envelope(wrapper 키 = 내부 배열 키) */
export function vworldBody(container: string, totalCount: number, rows: unknown[]): unknown {
    return {
        [container]: {
            totalCount,
            pageNo: 1,
            numOfRows: STRICT_SCAN_PAGE_SIZE,
            [container]: rows,
        },
    };
}

// ── raw provider row 빌더 ──────────────────────────────────────────

/** 표제부 raw row(canary·추가 필드는 extra 로 주입) */
export function titleRow(
    pk: string,
    bylotCnt: string,
    pair: typeof DETACHED = DETACHED,
    extra: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        mgmBldrgstPk: pk,
        bylotCnt,
        regstrGbCd: pair.regstrGbCd,
        mainPurpsCd: pair.mainPurpsCd,
        mainPurpsCdNm: pair.mainPurpsCdNm,
        ...extra,
    };
}

/** 19자리 base/attached PNU 쌍을 getBrAtchJibunInfo raw row 로 분해한다. */
export function attachedRow(basePnu: string, attachedPnu: string, pk = PK): Record<string, unknown> {
    const dec = (p: string) => ({
        sigunguCd: p.slice(0, 5),
        bjdongCd: p.slice(5, 10),
        platGbCd: p.slice(10, 11) === '2' ? '1' : '0',
        bun: p.slice(11, 15),
        ji: p.slice(15, 19),
    });
    const b = dec(basePnu);
    const a = dec(attachedPnu);
    return {
        mgmBldrgstPk: pk,
        sigunguCd: b.sigunguCd,
        bjdongCd: b.bjdongCd,
        platGbCd: b.platGbCd,
        bun: b.bun,
        ji: b.ji,
        atchSigunguCd: a.sigunguCd,
        atchBjdongCd: a.bjdongCd,
        atchPlatGbCd: a.platGbCd,
        atchBun: a.bun,
        atchJi: a.ji,
    };
}

/** 대지권등록부 raw row(canary·추가 필드는 extra 로 주입) */
export function ldaregRow(
    pnu: string,
    over: Partial<Record<string, unknown>> = {},
    extra: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        pnu,
        agbldgSn: '1',
        buldFloorNm: '3층',
        buldHoNm: '301',
        ldaQotaRate: '181.7/15622.1',
        clsSeCode: '0',
        clsSeCodeNm: '유효',
        ...over,
        ...extra,
    };
}

/** 전유부 raw row */
export function exposRow(pk = PK, floor = '3층', ho = '301'): Record<string, unknown> {
    return { mgmBldrgstPk: pk, flrNoNm: floor, hoNm: ho };
}

/** 토지대장 raw row */
export function ladfrlRow(pnu: string, lndpclAr = '100.5', extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { pnu, lndpclAr, ...extra };
}

// ── envelope 반환 route 헬퍼(route 는 항상 완전한 envelope 를 돌려줘야 한다) ──

/** Building HUB 성공 envelope(rows → COMPLETE_ZERO 는 rows=[]). */
export function hubEnv(rows: unknown[]): unknown {
    return hubBody(rows.length, rows);
}
/** V-World 토지대장 envelope */
export function ladfrlEnv(rows: unknown[]): unknown {
    return vworldBody('ladfrlVOList', rows.length, rows);
}
/** V-World 대지권등록부 envelope */
export function ldaregEnv(rows: unknown[]): unknown {
    return vworldBody('ldaregVOList', rows.length, rows);
}

// ── mock provider(주입 httpClient) ─────────────────────────────────

/** endpoint 별 응답 함수. keyPnu 로 PNU 를 구분한다. 반환은 envelope data 또는 HttpResponse. */
export type ProviderRoutes = Partial<Record<EndpointName, (keyPnu: string) => unknown>>;

export interface CapturedCall {
    url: string;
    endpoint: EndpointName;
    keyPnu: string;
    params: Record<string, unknown>;
}

/** Building HUB 요청 파라미터에서 재구성한 keyPnu(landGbn 문자 제외 18자리). */
export function hubKey(pnu: string): string {
    return pnu.slice(0, 10) + pnu.slice(11);
}

function isHttpResponse(v: unknown): v is HttpResponse {
    return typeof v === 'object' && v !== null && 'status' in v && 'data' in v;
}

/** 주입 httpClient + 호출 캡처. 정의 안 된 endpoint 는 COMPLETE_ZERO envelope. */
export function mockProvider(routes: ProviderRoutes): { httpClient: (req: HttpRequest) => Promise<HttpResponse>; calls: CapturedCall[] } {
    const calls: CapturedCall[] = [];
    const httpClient = async (req: HttpRequest): Promise<HttpResponse> => {
        const endpoint = req.url.split('/').pop() as EndpointName;
        const p = req.params;
        const keyPnu = HUB_ENDPOINTS.has(endpoint)
            ? `${p.sigunguCd}${p.bjdongCd}${p.bun}${p.ji}`
            : String(p.pnu);
        calls.push({ url: req.url, endpoint, keyPnu, params: p });

        const route = routes[endpoint];
        if (!route) {
            // 정의 안 됨 → 해당 provider 유형의 COMPLETE_ZERO
            return ok(
                HUB_ENDPOINTS.has(endpoint)
                    ? hubBody(0, [])
                    : vworldBody(VWORLD_CONTAINER[endpoint], 0, [])
            );
        }
        const r = route(keyPnu);
        return isHttpResponse(r) ? r : ok(r);
    };
    return { httpClient, calls };
}

// ── DB spy ─────────────────────────────────────────────────────────

export interface Spy {
    freezeCalls: number;
    applyCalls: number;
    terminalCalls: Array<{ status: string; scopeState: string; outcome: string }>;
    terminalIssues: LandAreaSyncIssue[][];
    scopeStateCalls: string[];
    failedCalls: string[];
    /** applyRpc 로 넘어간 마지막 params(p_items 등). */
    lastApplyParams: unknown;
    /** freezeScopeSnapshot 로 고정된 전체 snapshot·evidence(보안 스윕용). */
    frozenSnapshots: Array<{ scopeSnapshot: LandAreaSyncScopeSnapshot; scopeEvidence: LandAreaSyncScopeEvidence }>;
    appliedIssuesCalls: Array<{ scopeState: string; issues: LandAreaSyncIssue[]; issuesTotal: number; issuesTruncated: boolean }>;
    /** read-model 호출 흔적(쓰기 경로 부재 검증용). */
    reads: string[];
}

export function emptySpy(): Spy {
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
        reads: [],
    };
}

export const MEMBER = [{ propertyUnitId: PROP_ID, pnu: ANCHOR, buildingUnitId: null }];

/** DB resolver jsonb 결과 빌더. */
export function noEvidence(membership: unknown = MEMBER, over: Record<string, unknown> = {}): unknown {
    return {
        dbState: 'NO_EVIDENCE', rootBuildingIdentities: [PK], componentPnus: [ANCHOR], linkedPnus: [],
        linkedEvidenceKeys: [], pendingEvidenceKeys: [], blockingEvidence: [], openUnresolvedEvidenceKeys: [],
        componentTruncated: false, propertyMembership: membership, dbScopeHash: 'db-hash-noevidence', ...over,
    };
}
export function linked(linkedPnus: string[], membership: unknown = MEMBER, over: Record<string, unknown> = {}): unknown {
    return {
        dbState: 'LINKED', rootBuildingIdentities: [PK], componentPnus: [...linkedPnus], linkedPnus: [...linkedPnus],
        linkedEvidenceKeys: ['k1'], pendingEvidenceKeys: [], blockingEvidence: [], openUnresolvedEvidenceKeys: [],
        componentTruncated: false, propertyMembership: membership, dbScopeHash: 'db-hash-linked', ...over,
    };
}

// ── property/building read-model 후보 ──────────────────────────────

export interface IntegrationConfig {
    resolver: unknown;
    routes: ProviderRoutes;
    /** 인증(secret canary 주입 지점). */
    hubAuth?: { serviceKey: string };
    vworldAuth?: { key: string; domain: string };
    applyResult?: { data: unknown; error: { message: string; code?: string } | null };
    /** getScopedJob 이 돌려줄 preview_data(apply job 시나리오용). */
    jobPreviewData?: Record<string, unknown>;
    /** readPropertyUnits 결과(matcher 후보). */
    propertyUnits?: unknown[];
    /** readBuildingUnits 결과(matcher 후보). */
    buildingUnits?: unknown[];
    /** readCurrentLandTuples 결과. */
    currentLandTuples?: unknown[];
    /** adapter 로 물린 scan 을 특정 endpoint 만 직접 주입으로 덮어쓴다(경계 테스트용). */
    scanOverrides?: Partial<LandAreaSyncDeps['scans']>;
    spy: Spy;
}

/** 실 adapter + 주입 httpClient + spy DB 로 orchestration deps 를 조립한다. */
export function buildIntegrationDeps(config: IntegrationConfig): {
    deps: LandAreaSyncDeps;
    calls: CapturedCall[];
} {
    const { spy } = config;
    const { httpClient, calls } = mockProvider(config.routes);
    const adapter = new LandAreaSyncAdapter({ httpClient, sleep: async () => undefined, random: () => 0 });
    const hubAuth = config.hubAuth ?? { serviceKey: 'test-service-key' };
    const vworldAuth = config.vworldAuth ?? { key: 'test-vworld-key', domain: 'test.example.com' };

    const deps: LandAreaSyncDeps = {
        now: () => new Date('2026-07-23T00:00:00.000Z'),
        scans: {
            scanTitle: (pnu, signal) => adapter.scanTitle(pnu, hubAuth, { signal }),
            scanAttached: (pnu, signal) => adapter.scanAttached(pnu, hubAuth, { signal }),
            scanBasis: (pnu, signal) => adapter.scanBasis(pnu, hubAuth, { signal }),
            scanExpos: (pnu, signal) => adapter.scanExpos(pnu, hubAuth, { signal }),
            scanLadfrl: (pnu, signal) => adapter.scanLadfrl(pnu, vworldAuth, { signal }),
            scanLdareg: (pnu, signal) => adapter.scanLdareg(pnu, vworldAuth, { signal }),
            ...config.scanOverrides,
        },
        db: {
            resolveScope: async () => ({ data: config.resolver, error: null }),
            applyRpc: async (params) => {
                spy.applyCalls += 1;
                spy.lastApplyParams = params;
                return config.applyResult ?? { data: { outcome: 'NO_DATA', issues: [] }, error: null };
            },
            getScopedJob: async (): Promise<LandAreaSyncJobRow> => ({
                id: 'job-1',
                union_id: 'union-1',
                status: 'PROCESSING',
                progress: 0,
                preview_data:
                    config.jobPreviewData ?? { landAreaSync: { schemaVersion: 2, anchorPnu: ANCHOR, sourceDiscoveryJobId: null } },
                created_at: '', updated_at: '', error_log: null,
            }),
            freezeScopeSnapshot: async (_j, _u, patch) => {
                spy.freezeCalls += 1;
                spy.frozenSnapshots.push({ scopeSnapshot: patch.scopeSnapshot, scopeEvidence: patch.scopeEvidence });
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
            readBuildingUnits: async () => { spy.reads.push('readBuildingUnits'); return (config.buildingUnits ?? []) as never; },
            readPropertyUnits: async () => { spy.reads.push('readPropertyUnits'); return (config.propertyUnits ?? []) as never; },
            readCurrentLandTuples: async () => { spy.reads.push('readCurrentLandTuples'); return (config.currentLandTuples ?? []) as never; },
        },
    };
    return { deps, calls };
}

/** apply job(=확인 후속 job) preview_data. sourceDiscoveryJobId+confirmation → isApplyJob=true. */
export function applyJobPreview(confirmation: {
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

/** LDAREG happy-path 매칭이 성립하는 property_unit 후보(ldareg-branch happy path 와 동일 계약). */
export const LDAREG_PROPERTY = {
    id: PROP_ID,
    unionId: 'union-1',
    buildingUnitId: null,
    pnu: ANCHOR,
    isDeleted: false,
    dong: null,
    ho: '301',
};

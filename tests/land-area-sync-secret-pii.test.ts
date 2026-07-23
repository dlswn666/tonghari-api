/**
 * LAND_AREA_SYNC secret/PII 비유출 검증 (DESIGN §14.2·§17.3 / Phase 2 Exit "preview·로그 secret/PII 0").
 *
 * mock provider 응답에 canary(소유자명·연락처·API key·JWT·raw body)를 심고 전 구간을 관통시킨
 * 뒤, preview_data(snapshot·evidence)·issues·scopeState·error_log 등 "밖으로 나가는" 표면을
 * 직렬화해 canary 가 0회 등장함을 프로그램적으로 assert 한다. apply RPC payload(감사 대상 write)
 * 에도 소유자명·연락처·secret 이 §7.3 allowlist 밖으로 새지 않음을 함께 확인한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runLandAreaSyncJob } from '../src/services/land-area-sync/service';
import { LandAreaSyncAdapter } from '../src/services/land-area-sync/adapter';
import type { HttpRequest, HttpResponse, StrictScan, BrTitleRow } from '../src/types/land-area-sync.types';
import {
    ANCHOR,
    PK,
    MULTIPLEX,
    LDAREG_PROPERTY,
    buildIntegrationDeps,
    emptySpy,
    linked,
    noEvidence,
    titleRow,
    ldaregRow,
    exposRow,
    ladfrlRow,
    hubEnv,
    ladfrlEnv,
    ldaregEnv,
    ok,
    type Spy,
} from './land-area-sync-mock-provider';

// ── canary 세트 ────────────────────────────────────────────────────

const API_KEY = 'API_KEY_CANARY_zzz9';
const OWNER = 'OWNER_NAME_CANARY_홍길동';
const PHONE = 'PHONE_CANARY_01012345678';
const JWT = 'JWT_CANARY.eyJhbGciOiJIUzI1NiJ9.sig';
const RAW = 'RAW_BODY_CANARY_blob';
const STACK = 'at Object.<anonymous> STACK_CANARY (/srv/app.js:12:3)';
const CANARIES = [API_KEY, OWNER, PHONE, JWT, RAW, STACK, 'CANARY'];

/** 감시 표면(preview_data + 로그)만 직렬화한다. apply RPC payload 는 별도로 검사. */
function previewLogSurface(spy: Spy): string {
    return JSON.stringify({
        frozenSnapshots: spy.frozenSnapshots,
        terminalCalls: spy.terminalCalls,
        terminalIssues: spy.terminalIssues,
        scopeStateCalls: spy.scopeStateCalls,
        appliedIssuesCalls: spy.appliedIssuesCalls,
        failedCalls: spy.failedCalls,
    });
}

function assertNoCanary(serialized: string, label: string): void {
    for (const c of CANARIES) {
        assert.ok(!serialized.includes(c), `${label} 에 canary "${c}" 가 노출되면 안 된다`);
    }
}

// canary 를 §7.3 allowlist 밖 필드에 심는다(소유자명·연락처·토큰·raw echo).
const CANARY_LDAREG_EXTRA = { posesnNm: OWNER, ownerTelno: PHONE, sessionToken: JWT, rawEcho: RAW, stack: STACK };
const CANARY_TITLE_EXTRA = { ownerNm: OWNER, ownerTelno: PHONE, rawEcho: RAW };

// ── 1. 관통 스윕: LINKED LDAREG discovery(매칭 성공) preview·로그 canary 0 ─

test('LINKED LDAREG discovery: preview_data(snapshot)·scopeState·로그에 provider canary 0회, apply payload 에도 secret/PII 0', async () => {
    const spy = emptySpy();
    const { deps } = buildIntegrationDeps({
        resolver: linked([ANCHOR]),
        hubAuth: { serviceKey: API_KEY },
        vworldAuth: { key: API_KEY, domain: 'test.example.com' },
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX, CANARY_TITLE_EXTRA)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ldaregList: () => ldaregEnv([ldaregRow(ANCHOR, {}, CANARY_LDAREG_EXTRA)]),
            // I2: 같은 실행의 LADFRL 면적을 ldaregRow 기본 비율 분모(15622.1)와 일치시켜야 CURRENT
            // component 가 §12.1 분모 대조를 통과해 apply 된다(양성 대조 대상). canary(ownerNm)는 유지.
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR, '15622.1', { ownerNm: OWNER })]),
            getBrExposInfo: () => hubEnv([{ ...exposRow(), ownerNm: OWNER, ownerTelno: PHONE }]),
        },
        propertyUnits: [LDAREG_PROPERTY],
        applyResult: { data: { outcome: 'APPLIED', issues: [] }, error: null },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });

    assert.equal(spy.freezeCalls, 1, 'snapshot 이 실제로 고정되어 스윕 대상이 존재해야 한다');
    assert.equal(spy.applyCalls, 1);
    // 양성 대조: canary 를 심은 row 가 실제로 파이프라인을 관통했음을 확인한다(빈 데이터 false-pass 방지).
    const payload = JSON.stringify(spy.lastApplyParams);
    assert.ok(payload.includes('181.7/15622.1'), '양성 대조 — canary row 의 allowlist 값(ratio)은 payload 에 존재해야 한다');
    // (1) preview_data + 로그 표면: canary 0.
    assertNoCanary(previewLogSurface(spy), 'preview/log 표면');
    // (2) apply RPC payload: 소유자명·연락처·secret·JWT·raw 는 §7.3 allowlist 밖이므로 0.
    //     (payload 는 감사 대상 write 라 ratio·PNU·buldNm 등 allowlist 값은 정상 포함)
    for (const c of [API_KEY, OWNER, PHONE, JWT, RAW, STACK]) {
        assert.ok(!payload.includes(c), `apply payload 에 "${c}" 가 새면 안 된다`);
    }
});

// ── 2. 이슈 표면 스윕: 매칭 실패(extraIssue) 경로 canary 0 ──────────

test('매칭 실패로 issue 가 preview 에 실릴 때도 issue 는 code·PNU·UUID 뿐 — provider canary 0회', async () => {
    const spy = emptySpy();
    const { deps } = buildIntegrationDeps({
        resolver: linked([ANCHOR]),
        hubAuth: { serviceKey: API_KEY },
        vworldAuth: { key: API_KEY, domain: 'test.example.com' },
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX, CANARY_TITLE_EXTRA)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ldaregList: () => ldaregEnv([ldaregRow(ANCHOR, {}, CANARY_LDAREG_EXTRA)]),
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
            getBrExposInfo: () => hubEnv([]), // 전유부 0 → matcher NO_CHANGE → PROPERTY_UNIT_NOT_FOUND issue
        },
        propertyUnits: [], // 후보 없음 → 매칭 실패
        applyResult: { data: { outcome: 'NO_DATA', issues: [] }, error: null },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });

    // extraIssue 병합 경로(appliedIssuesCalls)에 issue 가 실렸는지 확인 후 canary 스윕.
    assert.ok(spy.appliedIssuesCalls.length + spy.terminalIssues.flat().length > 0, 'issue 표면이 존재해야 스윕이 의미 있다');
    assertNoCanary(previewLogSurface(spy), 'issue 표면');
});

// ── 3. adapter 실패 issue: raw body·resultMsg·secret·stack trace 비유출 ─

function scriptedAdapter(handler: (req: HttpRequest) => HttpResponse): LandAreaSyncAdapter {
    const httpClient = async (req: HttpRequest): Promise<HttpResponse> => handler(req);
    return new LandAreaSyncAdapter({ httpClient, sleep: async () => undefined, random: () => 0 });
}

test('adapter FAILED issue 는 고정 요약만 — provider raw body·resultMsg·secret·stack trace 0회', async () => {
    // (a) HTTP 200 provider error envelope: resultMsg 에 canary 를 잔뜩 심는다.
    const providerErr = scriptedAdapter(() =>
        ok({
            response: {
                header: { resultCode: '30', resultMsg: `NO KEY ${API_KEY} ${OWNER} ${RAW} ${STACK}` },
                body: { ownerNm: OWNER, ownerTelno: PHONE, items: '' },
            },
        })
    );
    const r1 = await providerErr.scanTitle(ANCHOR, { serviceKey: API_KEY });
    assert.equal(r1.state, 'FAILED');
    if (r1.state === 'FAILED') assert.equal(r1.issue.providerCode, '30'); // 식별 코드만
    assertNoCanary(JSON.stringify(r1), 'provider-error FAILED issue');

    // (b) schema 오류(garbage body + secret echo).
    const schemaErr = scriptedAdapter(() => ok({ garbage: OWNER, echoedKey: API_KEY, stack: STACK }));
    const r2 = await schemaErr.scanLdareg(ANCHOR, { key: API_KEY, domain: 'd' });
    assert.equal(r2.state, 'FAILED');
    assertNoCanary(JSON.stringify(r2), 'schema-error FAILED issue');

    // (c) HTTP 500 + canary body(재시도 소진 후 FAILED).
    const httpErr = scriptedAdapter(() => ({ status: 500, data: { ownerNm: OWNER, blob: RAW }, headers: {} }));
    const r3 = await httpErr.scanTitle(ANCHOR, { serviceKey: API_KEY });
    assert.equal(r3.state, 'FAILED');
    assertNoCanary(JSON.stringify(r3), 'http-error FAILED issue');
});

// ── 4. 서비스 경계: scan issue.message 의 canary 가 preview/로그로 전파되지 않는다 ─

test('필수 scan FAILED 의 issue.message canary 는 terminal issue·error_log 로 전파되지 않는다(코드만 사용)', async () => {
    const spy = emptySpy();
    // adapter 대신 직접 주입한 FAILED scan — issue.message 에 canary 를 심는다.
    const poisoned: StrictScan<BrTitleRow> = {
        state: 'FAILED',
        issue: { kind: 'HTTP_ERROR', endpoint: 'getBrTitleInfo', message: `boom ${OWNER} ${API_KEY} ${RAW} ${STACK}`, httpStatus: 500 },
    };
    const { deps } = buildIntegrationDeps({
        resolver: noEvidence(),
        routes: {},
        scanOverrides: { scanTitle: async () => poisoned },
        spy,
    });
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });

    assert.equal(spy.terminalCalls[0].status, 'FAILED', 'title 실패 → FAILED 종결');
    // 서비스는 scan issue.message 를 읽지 않고 고정 issue code 만 쓴다.
    assertNoCanary(previewLogSurface(spy), 'scan message 경계');
    assert.ok(
        spy.terminalIssues[0].some((i) => i.code === 'PROVIDER_PROTOCOL_ERROR'),
        '고정 issue code(PROVIDER_PROTOCOL_ERROR)만 기록'
    );
});

/**
 * LAND_AREA_SYNC mock-provider 통합 테스트 (DESIGN §19.2 / Phase 2 Exit §18).
 *
 * 실 adapter + 주입 httpClient 로 discovery 전 구간(scan→DB resolver→gate→분류→매칭→
 * preview→apply barrier)을 관통시켜, 유닛 테스트로는 보증할 수 없는 오케스트레이션 불변을
 * 검증한다:
 *  - 필수 scan 하나라도 실패하면 apply RPC 0회(전 구간).
 *  - LINKED 다중 base 의 non-anchor scan 을 gate 전에 완료하고, 한 page 실패/불일치면 apply 0.
 *  - reverse-only(부속-only) anchor 전 구간, COMPLETE_ZERO 5종 outcome 분리(§10.7·§14.2).
 *  - terminal 후 늦은 callback 차단, building_unit/property_unit 직접 INSERT 경로 부재.
 *  - 모든 Building HUB/V-World strict 요청이 HTTPS.
 *
 * 중복 회피: adapter pagination·bylot·gate 판정·ratio/identity/normalizer/matcher·service
 * apply-lineage 등 유닛 커버 항목은 재작성하지 않고, 통합 수준 갭만 채운다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runLandAreaSyncJob } from '../src/services/land-area-sync/service';
import {
    ANCHOR,
    SIBLING,
    PK,
    DETACHED,
    MULTIPLEX,
    LDAREG_PROPERTY,
    buildIntegrationDeps,
    emptySpy,
    noEvidence,
    linked,
    hubKey,
    titleRow,
    attachedRow,
    ldaregRow,
    exposRow,
    ladfrlRow,
    httpError,
    hubEnv,
    ladfrlEnv,
    ldaregEnv,
    type ProviderRoutes,
    type Spy,
} from './land-area-sync-mock-provider';

async function run(config: {
    resolver: unknown;
    routes: ProviderRoutes;
    applyResult?: { data: unknown; error: { message: string; code?: string } | null };
    propertyUnits?: unknown[];
    buildingUnits?: unknown[];
    currentLandTuples?: unknown[];
    spy: Spy;
}) {
    const { deps, calls } = buildIntegrationDeps(config);
    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });
    return { calls, spy: config.spy };
}

// ── 1. 관통 + HTTPS 전수 (reverse-only/부속-only anchor 전 구간) ─────

test('no-cache single LADFRL discovery: scan→resolver→gate→분류→preview→confirmation 관통, apply 0, 모든 요청 HTTPS', async () => {
    const spy = emptySpy();
    const { calls } = await run({
        resolver: noEvidence(),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
            getBrAtchJibunInfo: () => hubEnv([]), // ATTACHED_COMPLETE_ZERO
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR, '100.5')]),
        },
        spy,
    });
    // 부속-only anchor(자체 title + bylot0 + ATTACHED_COMPLETE_ZERO) → SINGLE_SCOPE_CONFIRMATION_REQUIRED.
    assert.equal(spy.freezeCalls, 1, 'snapshot 은 정확히 1회 CAS 고정');
    assert.equal(spy.applyCalls, 0, 'LADFRL discovery 는 확인 전 apply 하지 않는다');
    assert.equal(spy.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
    assert.equal(spy.terminalCalls[0].outcome, 'REVIEW_REQUIRED');
    // 모든 strict 요청은 HTTPS(§10.3·§10.6 — inspector HTTP 상수 재사용 금지).
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => c.url.startsWith('https://')), 'every request must be HTTPS');
    // TITLE_ONLY 정책 → basis endpoint 는 호출되지 않는다(BASIS_COMPLETE_ZERO 소비 안 함).
    assert.ok(!calls.some((c) => c.endpoint === 'getBrBasisOulnInfo'), 'basis 는 TITLE_ONLY 에서 미호출');
    // LADFRL 분기이므로 ldareg 는 호출되지 않는다.
    assert.ok(!calls.some((c) => c.endpoint === 'ldaregList'));
});

// ── 2. 필수 scan 실패 매트릭스 — 전 구간 apply 0 ───────────────────

test('필수 scan 실패는 전 구간에서 apply RPC 0회 + FAILED (title/ladfrl/ldareg/expos)', async () => {
    // (a) title(gate 필수) 실패 → FAILED
    {
        const spy = emptySpy();
        await run({ resolver: noEvidence(), routes: { getBrTitleInfo: () => httpError(503) }, spy });
        assert.equal(spy.applyCalls, 0, 'title 실패 apply 0');
        assert.equal(spy.terminalCalls[0].status, 'FAILED');
    }
    // (b) LADFRL 분기 필수 ladfrl 실패 → FAILED
    {
        const spy = emptySpy();
        await run({
            resolver: noEvidence(),
            routes: {
                getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
                ladfrlList: () => httpError(503),
            },
            spy,
        });
        assert.equal(spy.applyCalls, 0, 'ladfrl 실패 apply 0');
        assert.equal(spy.terminalCalls[0].status, 'FAILED');
    }
    // (c) LDAREG 분기 필수 ldareg 실패 → FAILED (single-PNU LINKED 다세대)
    {
        const spy = emptySpy();
        await run({
            resolver: linked([ANCHOR]),
            routes: {
                getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX)]),
                ldaregList: () => httpError(503),
                ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
            },
            spy,
        });
        assert.equal(spy.applyCalls, 0, 'ldareg 실패 apply 0');
        assert.equal(spy.terminalCalls[0].status, 'FAILED');
    }
    // (d) LDAREG 분기 필수 expos 실패 → FAILED
    {
        const spy = emptySpy();
        await run({
            resolver: linked([ANCHOR]),
            routes: {
                getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX)]),
                ldaregList: () => ldaregEnv([ldaregRow(ANCHOR)]),
                ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
                getBrExposInfo: () => httpError(503),
            },
            spy,
        });
        assert.equal(spy.applyCalls, 0, 'expos 실패 apply 0');
        assert.equal(spy.terminalCalls[0].status, 'FAILED');
    }
});

// ── 3. LINKED 다중 base: 비앵커 base page 실패 → 전체 FAILED, apply 0 ─

test('LINKED 다중 base 중 non-anchor title page 실패 시 전체 FAILED, apply 0, 비앵커 base 도 gate 전 scan', async () => {
    const spy = emptySpy();
    const { calls } = await run({
        resolver: linked([ANCHOR, SIBLING], undefined, {
            linkedBasePnus: [ANCHOR, SIBLING],
        }),
        routes: {
            getBrTitleInfo: (keyPnu) =>
                keyPnu === hubKey(SIBLING) ? httpError(503) : hubEnv([titleRow(PK, '1', MULTIPLEX)]),
            getBrAtchJibunInfo: () => hubEnv([]),
        },
        spy,
    });
    assert.equal(spy.applyCalls, 0, '한 base 실패면 전체 apply 0');
    assert.equal(spy.terminalCalls[0].status, 'FAILED');
    // 비앵커 base(SIBLING)의 title 을 gate 전에 실제로 조회했다(전 base scan 완료 요건).
    assert.ok(
        calls.some((c) => c.endpoint === 'getBrTitleInfo' && c.keyPnu === hubKey(SIBLING)),
        'non-anchor base 도 scan 되어야 한다'
    );
});

// ── 4. LINKED 다중 base: 비앵커 분류 불일치 → REVIEW_REQUIRED, apply 0 ─

test('LINKED 다중 base 의 non-anchor 분류 불일치(일반+집합 혼재) → REVIEW_REQUIRED, apply 0', async () => {
    const spy = emptySpy();
    const { calls } = await run({
        resolver: linked([ANCHOR, SIBLING], undefined, {
            linkedBasePnus: [ANCHOR, SIBLING],
        }),
        routes: {
            getBrTitleInfo: (keyPnu) =>
                keyPnu === hubKey(SIBLING) ? hubEnv([titleRow(PK, '1', DETACHED)]) : hubEnv([titleRow(PK, '1', MULTIPLEX)]),
            getBrAtchJibunInfo: (keyPnu) =>
                keyPnu === hubKey(ANCHOR) ? hubEnv([attachedRow(ANCHOR, SIBLING)]) : hubEnv([]),
        },
        spy,
    });
    assert.equal(spy.applyCalls, 0, '분류 불일치면 apply 0');
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
    assert.equal(spy.terminalCalls[0].outcome, 'REVIEW_REQUIRED');
    assert.ok(calls.some((c) => c.endpoint === 'getBrTitleInfo' && c.keyPnu === hubKey(SIBLING)));
});

// ── 5. LDAREG LINKED 다세대 multi-PNU: 한 PNU 필수 page 실패 → 전체 FAILED, apply 0 ─

test('LDAREG LINKED 다세대: 한 PNU 의 ldareg page 실패 시 전체 FAILED, apply 0 (부분합 미적용)', async () => {
    const spy = emptySpy();
    const { calls } = await run({
        resolver: linked([ANCHOR, SIBLING]),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '1', MULTIPLEX)]),
            getBrAtchJibunInfo: (keyPnu) =>
                keyPnu === hubKey(ANCHOR) ? hubEnv([attachedRow(ANCHOR, SIBLING)]) : hubEnv([]),
            ldaregList: (keyPnu) => (keyPnu === SIBLING ? httpError(503) : ldaregEnv([ldaregRow(ANCHOR)])),
            ladfrlList: (keyPnu) => ladfrlEnv([ladfrlRow(keyPnu)]),
            getBrExposInfo: () => hubEnv([exposRow()]),
        },
        propertyUnits: [LDAREG_PROPERTY],
        spy,
    });
    assert.equal(spy.applyCalls, 0, 'multi-PNU 필수 page 실패 → apply 0');
    assert.equal(spy.terminalCalls[0].status, 'FAILED');
    assert.ok(calls.some((c) => c.endpoint === 'ldaregList' && c.keyPnu === SIBLING), '비앵커 PNU 의 ldareg 도 조회');
});

test('실측형 LINKED: base만 title/expos nonzero, full scope LDAREG replica와 LADFRL 합계를 identity별 1회 투영한다', async () => {
    const spy = emptySpy();
    const { calls } = await run({
        resolver: linked([ANCHOR, SIBLING]),
        routes: {
            // linkedBasePnus=[ANCHOR]이므로 title/bylot/attached gate scan은 base만 수행한다.
            getBrTitleInfo: () => hubEnv([titleRow(PK, '1', MULTIPLEX)]),
            getBrAtchJibunInfo: () => hubEnv([attachedRow(ANCHOR, SIBLING)]),
            // branch strict scan은 full linkedPnus를 유지한다.
            ldaregList: (pnu) =>
                ldaregEnv([
                    ldaregRow(pnu, {
                        ldaQotaRate: '24.6/364.6',
                    }),
                ]),
            ladfrlList: (pnu) =>
                ladfrlEnv([
                    ladfrlRow(pnu, pnu === ANCHOR ? '177.6' : '187'),
                ]),
            getBrExposInfo: (keyPnu) =>
                keyPnu === hubKey(ANCHOR) ? hubEnv([exposRow()]) : hubEnv([]),
        },
        propertyUnits: [LDAREG_PROPERTY],
        applyResult: { data: { outcome: 'APPLIED', issues: [] }, error: null },
        spy,
    });

    assert.ok(
        !calls.some(
            (call) =>
                call.endpoint === 'getBrTitleInfo' &&
                call.keyPnu === hubKey(SIBLING)
        ),
        'attached-only PNU는 title/base 분류 scan에서 제외'
    );
    assert.ok(
        calls.some(
            (call) => call.endpoint === 'ldaregList' && call.keyPnu === SIBLING
        ),
        'LDAREG는 full linked scope 조회'
    );
    assert.ok(
        calls.some(
            (call) => call.endpoint === 'getBrExposInfo' && call.keyPnu === hubKey(SIBLING)
        ),
        'attached expos COMPLETE_ZERO도 strict 조회'
    );
    assert.equal(spy.applyCalls, 1);

    const params = spy.lastApplyParams as {
        p_items: Array<{
            propertyUnitId: string;
            expectedTargetPnus: string[];
            components: Array<{
                targetPnu: string;
                sourceIdentity: string;
                sourceRecord: { pnu: string };
            }>;
        }>;
    };
    assert.equal(params.p_items.length, 1);
    assert.deepEqual(params.p_items[0].expectedTargetPnus, [ANCHOR, SIBLING].sort());
    assert.equal(params.p_items[0].components.length, 2, 'PNU별 provenance 보존');
    assert.equal(
        new Set(params.p_items[0].components.map((component) => component.sourceIdentity)).size,
        1,
        'target PNU 독립 identity'
    );
    assert.deepEqual(
        params.p_items[0].components.map((component) => component.sourceRecord.pnu).sort(),
        [ANCHOR, SIBLING].sort()
    );

    const snapshot = spy.frozenSnapshots[0].scopeSnapshot;
    assert.deepEqual(snapshot.proposedLandAreas, [
        { propertyUnitId: LDAREG_PROPERTY.id, landArea: '24.6' },
    ]);
    assert.deepEqual(snapshot.ladfrlAreaEvidence, {
        version: 'land-area-sync.ladfrl-scope.v1',
        parcels: [
            { pnu: ANCHOR, area: '177.6' },
            { pnu: SIBLING, area: '187' },
        ].sort((a, b) => a.pnu.localeCompare(b.pnu)),
        totalArea: '364.6',
    });
    assert.equal(snapshot.replicationEvidence?.canonicalSourcePnu, ANCHOR);
    assert.equal(snapshot.replicationEvidence?.rowCount, 1);
    assert.equal(snapshot.replicationEvidence?.exactReplica, true);
});

// ── 6. COMPLETE_ZERO 5종 outcome 분리 (§10.7·§14.2) ────────────────

test('TITLE_COMPLETE_ZERO → REVIEW_REQUIRED(분류 불가), apply 0', async () => {
    const spy = emptySpy();
    await run({ resolver: noEvidence(), routes: { getBrTitleInfo: () => hubEnv([]) }, spy });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.terminalCalls[0].scopeState, 'REVIEW_REQUIRED');
    assert.ok(
        spy.terminalIssues[0].some((i) => i.code === 'BUILDING_CLASSIFICATION_CONFLICT'),
        'title zero 는 분류 불가 REVIEW'
    );
});

test('ATTACHED_COMPLETE_ZERO(+title bylot0 single) → SINGLE_SCOPE_CONFIRMATION_REQUIRED, apply 0', async () => {
    const spy = emptySpy();
    await run({
        resolver: noEvidence(),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
        },
        spy,
    });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 1);
    assert.equal(spy.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
});

test('LADFRL_COMPLETE_ZERO → COMPLETED+NO_DATA, 기존 tuple 유지, snapshot/apply 0', async () => {
    const spy = emptySpy();
    await run({
        resolver: noEvidence(),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ladfrlList: () => ladfrlEnv([]), // LADFRL_COMPLETE_ZERO
        },
        spy,
    });
    assert.equal(spy.applyCalls, 0);
    assert.equal(spy.freezeCalls, 0);
    assert.equal(spy.terminalCalls[0].status, 'COMPLETED');
    assert.equal(spy.terminalCalls[0].outcome, 'NO_DATA');
    assert.equal(spy.terminalCalls[0].scopeState, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
});

test('LDAREG_COMPLETE_ZERO(LINKED) → apply RPC 1회·NO_DATA (TITLE/ATTACHED/LADFRL zero 와 분리)', async () => {
    const spy = emptySpy();
    await run({
        resolver: linked([ANCHOR]),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ldaregList: () => ldaregEnv([]), // LDAREG_COMPLETE_ZERO
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
            getBrExposInfo: () => hubEnv([exposRow()]),
        },
        propertyUnits: [LDAREG_PROPERTY],
        applyResult: { data: { outcome: 'NO_DATA', issues: [] }, error: null },
        spy,
    });
    // LINKED 즉시적용 경로 — LDAREG zero 는 lifecycle 평가용 empty-component item으로 호출.
    assert.equal(spy.applyCalls, 1, 'LDAREG zero 는 apply RPC 1회(NO_DATA)');
    const params = spy.lastApplyParams as {
        p_items: unknown[];
        p_result_summary: { extraIssues: unknown[] };
    };
    assert.deepEqual(params.p_items, [
        {
            propertyUnitId: LDAREG_PROPERTY.id,
            expectedTargetPnus: [ANCHOR],
            components: [],
        },
    ]);
    assert.deepEqual(params.p_result_summary.extraIssues, []);
});

test('BASIS_COMPLETE_ZERO 는 TITLE_ONLY 정책에서 소비되지 않는다(basis endpoint 미호출)', async () => {
    // basis 원천 정책이 TITLE_ONLY 이므로 basis fallback plan 이 빈 배열 → basis scan 자체가 없다.
    // BASIS_COMPLETE_ZERO 의 outcome 분리는 bylot 유닛 테스트(FALLBACK 정책)에서 UNAVAILABLE 로 검증됨.
    const spy = emptySpy();
    const { calls } = await run({
        resolver: noEvidence(),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', DETACHED)]),
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
        },
        spy,
    });
    assert.ok(!calls.some((c) => c.endpoint === 'getBrBasisOulnInfo'), 'TITLE_ONLY 는 basis 미호출');
});

// ── 7. building_unit/property_unit 직접 INSERT 경로 부재 ───────────

test('전 구간에서 unit 쓰기 경로는 apply RPC 뿐 — building_unit/property_unit 직접 INSERT 0', async () => {
    const spy = emptySpy();
    const { deps } = buildIntegrationDeps({
        resolver: linked([ANCHOR]),
        routes: {
            getBrTitleInfo: () => hubEnv([titleRow(PK, '0', MULTIPLEX)]),
            getBrAtchJibunInfo: () => hubEnv([]),
            ldaregList: () => ldaregEnv([ldaregRow(ANCHOR)]),
            ladfrlList: () => ladfrlEnv([ladfrlRow(ANCHOR)]),
            getBrExposInfo: () => hubEnv([exposRow()]),
        },
        propertyUnits: [LDAREG_PROPERTY],
        applyResult: { data: { outcome: 'APPLIED', issues: [] }, error: null },
        spy,
    });

    // (구조) db 계약에 building_unit/property_unit 을 INSERT/CREATE 하는 메서드가 없다.
    const dbKeys = Object.keys(deps.db);
    assert.ok(
        !dbKeys.some((k) => /insert|create/i.test(k)),
        `db deps 에 insert/create 계열 메서드가 없어야 한다: ${dbKeys.join(',')}`
    );
    // unit 을 만지는 유일한 mutating 경로는 applyRpc(감사되는 SECURITY DEFINER RPC).
    assert.ok(dbKeys.includes('applyRpc'));

    await runLandAreaSyncJob({ jobId: 'job-1', unionId: 'union-1', deps });

    // (동작) 후보는 read-model 로만 조회되고, unit write 는 apply RPC 정확히 1회로 수렴한다.
    assert.ok(spy.reads.includes('readBuildingUnits'));
    assert.ok(spy.reads.includes('readPropertyUnits'));
    assert.equal(spy.applyCalls, 1, 'unit write 는 apply RPC 1회로만');
    assert.equal(spy.failedCalls.length, 0);
});

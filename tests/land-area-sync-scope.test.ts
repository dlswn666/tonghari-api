import assert from 'node:assert/strict';
import test from 'node:test';
import {
    resolveParcelScopeCompleteness,
    computeScopeHash,
    verifySinglePnuConfirmation,
    parseDbScopeResolution,
    callParcelScopeResolver,
    SCOPE_HASH_VERSION,
    type DbScopeResolution,
    type BasePnuScan,
    type ParcelScopeInput,
} from '../src/services/land-area-sync/scope';
import { HOUSING_PURPOSE_ALLOWLIST } from '../src/services/land-area-sync/housing-purpose-allowlist.fixture';
import type { BrTitleRow, BrAtchJibunRow, StrictScan, ProviderIssue } from '../src/types/land-area-sync.types';

const DETACHED = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'DETACHED')!;
const MULTIPLEX = HOUSING_PURPOSE_ALLOWLIST.find((p) => p.category === 'MULTIPLEX')!;

const ANCHOR = '1168010100107360024';
const OTHER_PNU = '1168010100107360025';
const PK = '1002003004005';

// ── scan 빌더 ─────────────────────────────────────────────────────

function titleComplete(rows: BrTitleRow[]): StrictScan<BrTitleRow> {
    return { state: 'COMPLETE', rows, totalCount: rows.length, pagesFetched: 1 };
}
function attachedComplete(rows: BrAtchJibunRow[]): StrictScan<BrAtchJibunRow> {
    return { state: 'COMPLETE', rows, totalCount: rows.length, pagesFetched: 1 };
}
function zero<T>(): StrictScan<T> {
    return { state: 'COMPLETE_ZERO', rows: [], totalCount: 0, pagesFetched: 1 };
}
function failed<T>(): StrictScan<T> {
    const issue: ProviderIssue = { kind: 'HTTP_ERROR', endpoint: 'getBrTitleInfo', message: 'x', httpStatus: 500 };
    return { state: 'FAILED', issue };
}
function incomplete<T>(): StrictScan<T> {
    const issue: ProviderIssue = { kind: 'PAGINATION_MISMATCH', endpoint: 'getBrAtchJibunInfo', message: 'x' };
    return { state: 'INCOMPLETE', issue };
}

function titleRow(pk: string, bylotCnt: string, pair = DETACHED): BrTitleRow {
    return {
        mgmBldrgstPk: pk,
        bylotCnt,
        regstrGbCd: pair.regstrGbCd,
        mainPurpsCd: pair.mainPurpsCd,
        mainPurpsCdNm: pair.mainPurpsCdNm,
    };
}

/** 19자리 base/attached PNU 쌍을 getBrAtchJibunInfo row로 분해한다. */
function attachedRow(basePnu: string, attachedPnu: string, pk: string): BrAtchJibunRow {
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

function db(over: Partial<DbScopeResolution> = {}): DbScopeResolution {
    return {
        dbState: 'NO_EVIDENCE',
        rootBuildingIdentities: [PK],
        componentPnus: [ANCHOR],
        linkedBasePnus: [],
        linkedPnus: [],
        linkedEvidenceKeys: [],
        pendingEvidenceKeys: [],
        blockingEvidence: [],
        openUnresolvedEvidenceKeys: [],
        componentTruncated: false,
        propertyMembership: [],
        dbScopeHash: 'db-hash-abc',
        ...over,
    };
}

function base(over: Partial<BasePnuScan> = {}): BasePnuScan {
    return {
        pnu: ANCHOR,
        title: titleComplete([titleRow(PK, '0')]),
        attached: zero<BrAtchJibunRow>(),
        ...over,
    };
}

function gate(over: Partial<ParcelScopeInput> = {}): ParcelScopeInput {
    return { dbScope: db(), baseScans: [base()], policy: 'TITLE_ONLY', ...over };
}

// ── FAILED 우선순위 ───────────────────────────────────────────────

test('title FAILED → FAILED (basis로 대체하지 않음)', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ baseScans: [base({ title: failed<BrTitleRow>() })], dbScope: db({ dbState: 'BLOCKING_EVIDENCE', blockingEvidence: [{ sourceKind: 'API_RELATION', sourceId: 'u', state: 'CONFLICT' }] }) })
    );
    assert.equal(r.state, 'FAILED');
    assert.ok(r.issues.includes('PROVIDER_PROTOCOL_ERROR'));
});

test('attached INCOMPLETE → FAILED / ATTACHED_SCAN_INCOMPLETE', () => {
    const r = resolveParcelScopeCompleteness(gate({ baseScans: [base({ attached: incomplete<BrAtchJibunRow>() })] }));
    assert.equal(r.state, 'FAILED');
    assert.ok(r.issues.includes('ATTACHED_SCAN_INCOMPLETE'));
});

// ── 부속-only anchor → SINGLE_SCOPE_CONFIRMATION_REQUIRED ──────────

test('부속-only anchor(자체 title + bylot0 + ATTACHED_COMPLETE_ZERO)는 SINGLE_SCOPE_CONFIRMATION_REQUIRED', () => {
    const r = resolveParcelScopeCompleteness(gate());
    assert.equal(r.state, 'SINGLE_SCOPE_CONFIRMATION_REQUIRED');
    assert.deepEqual(r.issues, []);
    assert.equal(r.scannedPnus.length, 1);
});

test('자동 single 승격 금지 — gate는 SINGLE_PNU_CONFIRMED를 스스로 반환하지 않는다', () => {
    const r = resolveParcelScopeCompleteness(gate());
    assert.notEqual(r.state, 'SINGLE_PNU_CONFIRMED');
});

// ── no-cache + attached row → conflict ────────────────────────────

test('cache 없음 + attached row → REVIEW (관계 생성·승격 없음)', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ baseScans: [base({ title: titleComplete([titleRow(PK, '1')]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, PK)]) })] })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_CACHE_SCAN_CONFLICT'));
});

test('bylot0 + attached row → REVIEW / BYLOT_ATTACHED_COUNT_MISMATCH', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ baseScans: [base({ title: titleComplete([titleRow(PK, '0')]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, PK)]) })] })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('BYLOT_ATTACHED_COUNT_MISMATCH'));
});

// ── expected PK coverage / unavailable ────────────────────────────

test('orphan attached PK(coverage 누락)는 REVIEW / BYLOT_COUNT_UNAVAILABLE', () => {
    // title은 PK만, attached는 PK+ORPHAN. 부속 row가 있으니 no-cache면 cache-scan conflict도 뜬다.
    const orphanPk = '9001002003006';
    const r = resolveParcelScopeCompleteness(
        gate({
            dbScope: db({
                dbState: 'LINKED',
                linkedBasePnus: [ANCHOR],
                linkedPnus: [ANCHOR, OTHER_PNU],
            }),
            baseScans: [base({ title: titleComplete([titleRow(PK, '1')]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, orphanPk)]) })],
        })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('BYLOT_COUNT_UNAVAILABLE'));
    assert.ok(r.expectedPks.includes(orphanPk));
});

// ── component too large ───────────────────────────────────────────

test('component 50 초과(truncated) → REVIEW / SCOPE_COMPONENT_TOO_LARGE', () => {
    const r = resolveParcelScopeCompleteness(gate({ dbScope: db({ componentTruncated: true }) }));
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_COMPONENT_TOO_LARGE'));
});

// ── PENDING / blocking ────────────────────────────────────────────

test('PENDING evidence → REVIEW / SCOPE_PENDING', () => {
    const r = resolveParcelScopeCompleteness(gate({ dbScope: db({ dbState: 'PENDING', pendingEvidenceKeys: ['API_RELATION:u1'] }) }));
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_PENDING'));
});

test('blocking evidence → REVIEW / SCOPE_BLOCKING_EVIDENCE', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ dbScope: db({ dbState: 'BLOCKING_EVIDENCE', blockingEvidence: [{ sourceKind: 'API_RELATION', sourceId: 'u', state: 'CONFLICT' }] }) })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_BLOCKING_EVIDENCE'));
});

// ── LINKED exact match ────────────────────────────────────────────

test('LINKED PNU와 complete attached scan이 exact 일치 → LINKED_SCOPE_RESOLVED (다세대)', () => {
    const r = resolveParcelScopeCompleteness({
        dbScope: db({ dbState: 'LINKED', linkedBasePnus: [ANCHOR], linkedPnus: [ANCHOR, OTHER_PNU], componentPnus: [ANCHOR, OTHER_PNU] }),
        baseScans: [
            base({ pnu: ANCHOR, title: titleComplete([titleRow(PK, '1', MULTIPLEX)]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, PK)]) }),
        ],
        policy: 'TITLE_ONLY',
    });
    assert.equal(r.state, 'LINKED_SCOPE_RESOLVED');
    assert.deepEqual(r.issues, []);
});

test('LINKED PNU와 attached 불일치 → REVIEW / SCOPE_NOT_LINKED', () => {
    const r = resolveParcelScopeCompleteness({
        dbScope: db({ dbState: 'LINKED', linkedBasePnus: [ANCHOR], linkedPnus: [ANCHOR, OTHER_PNU], componentPnus: [ANCHOR, OTHER_PNU] }),
        baseScans: [base({ pnu: ANCHOR, title: titleComplete([titleRow(PK, '0', MULTIPLEX)]), attached: zero<BrAtchJibunRow>() })],
        policy: 'TITLE_ONLY',
    });
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('SCOPE_NOT_LINKED'));
});

// ── 일반건축물 multi-PNU 금지 ─────────────────────────────────────

test('일반건축물(단독/다가구) LINKED 다중 PNU → REVIEW / MULTI_PNU_GENERAL_BUILDING', () => {
    const r = resolveParcelScopeCompleteness({
        dbScope: db({ dbState: 'LINKED', linkedBasePnus: [ANCHOR], linkedPnus: [ANCHOR, OTHER_PNU], componentPnus: [ANCHOR, OTHER_PNU] }),
        baseScans: [
            base({ pnu: ANCHOR, title: titleComplete([titleRow(PK, '1', DETACHED)]), attached: attachedComplete([attachedRow(ANCHOR, OTHER_PNU, PK)]) }),
        ],
        policy: 'TITLE_ONLY',
    });
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('MULTI_PNU_GENERAL_BUILDING'));
});

// ── 분류 혼재 차단 ────────────────────────────────────────────────

test('아파트 등 미지원 유형 → REVIEW / UNSUPPORTED_HOUSING_TYPE', () => {
    const r = resolveParcelScopeCompleteness(
        gate({ baseScans: [base({ title: titleComplete([{ mgmBldrgstPk: PK, bylotCnt: '0', regstrGbCd: '2', mainPurpsCd: '09999', mainPurpsCdNm: '아파트' }]) })] })
    );
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.ok(r.issues.includes('UNSUPPORTED_HOUSING_TYPE'));
});

// ── 3층 hash ──────────────────────────────────────────────────────

test('dbScopeHash는 DB resolver 값을 그대로 통과시킨다', () => {
    const r = resolveParcelScopeCompleteness(gate({ dbScope: db({ dbScopeHash: 'passthrough-xyz' }) }));
    assert.equal(r.dbScopeHash, 'passthrough-xyz');
});

test('externalScopeDigest는 결정론적 sha256 hex이며 정책·scan에 반응', () => {
    const a = resolveParcelScopeCompleteness(gate());
    const b = resolveParcelScopeCompleteness(gate());
    assert.match(a.externalScopeDigest, /^[0-9a-f]{64}$/);
    assert.equal(a.externalScopeDigest, b.externalScopeDigest);
    const c = resolveParcelScopeCompleteness(gate({ baseScans: [base({ title: titleComplete([titleRow(PK, '7')]) })] }));
    assert.notEqual(a.externalScopeDigest, c.externalScopeDigest);
    const d = resolveParcelScopeCompleteness(
        gate({
            baseScans: [
                base({
                    title: titleComplete([
                        {
                            ...titleRow(PK, '0', DETACHED),
                            etcPurps: '단독주택',
                        },
                    ]),
                }),
            ],
        })
    );
    assert.notEqual(a.externalScopeDigest, d.externalScopeDigest);
});

test('computeScopeHash: 결정론 + 키순서 무관 + dbScopeHash/externalScopeDigest 반영', () => {
    const inputBase = {
        strategy: 'LADFRL',
        candidatePropertyIds: ['p2', 'p1'],
        propertyMembership: [{ b: 2, a: 1 }],
        currentLandTuples: [{ pnu: ANCHOR, area: 100 }],
        proposedAreas: [{ pnu: ANCHOR, area: 100 }],
        componentMatchDigest: [],
        dbScopeHash: 'db-1',
        externalScopeDigest: 'ext-1',
    };
    const h1 = computeScopeHash(inputBase);
    // candidatePropertyIds 순서만 바꿈 → 동일 해시 (내부 정렬)
    const h2 = computeScopeHash({ ...inputBase, candidatePropertyIds: ['p1', 'p2'] });
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(h1, h2);
    // dbScopeHash 변경 → 해시 변경
    assert.notEqual(h1, computeScopeHash({ ...inputBase, dbScopeHash: 'db-2' }));
    // externalScopeDigest 변경 → 해시 변경
    assert.notEqual(h1, computeScopeHash({ ...inputBase, externalScopeDigest: 'ext-2' }));
    assert.ok(SCOPE_HASH_VERSION.length > 0);
});

// ── SINGLE_PNU_CONFIRMED 확인 (재실행 일치 시에만) ────────────────

test('verifySinglePnuConfirmation: property membership+scopeHash 일치 → SINGLE_PNU_CONFIRMED', () => {
    const prior = { scopeHash: 'h1', propertyMembership: [{ id: 'p1' }] };
    const current = { scopeHash: 'h1', propertyMembership: [{ id: 'p1' }] };
    assert.equal(verifySinglePnuConfirmation(prior, current).state, 'SINGLE_PNU_CONFIRMED');
});

test('verifySinglePnuConfirmation: 불일치 → REVIEW / LAND_SCOPE_CONFIRMATION_MISMATCH', () => {
    const prior = { scopeHash: 'h1', propertyMembership: [{ id: 'p1' }] };
    const r = verifySinglePnuConfirmation(prior, { scopeHash: 'h2', propertyMembership: [{ id: 'p1' }] });
    assert.equal(r.state, 'REVIEW_REQUIRED');
    assert.equal(r.state === 'REVIEW_REQUIRED' && r.issue, 'LAND_SCOPE_CONFIRMATION_MISMATCH');
});

// ── DB resolver 파싱·호출 ────────────────────────────────────────

test('parseDbScopeResolution: 누락 필드는 안전한 기본값', () => {
    const r = parseDbScopeResolution({ dbState: 'LINKED', dbScopeHash: 'x' });
    assert.equal(r.dbState, 'LINKED');
    assert.deepEqual(r.componentPnus, []);
    assert.deepEqual(r.blockingEvidence, []);
    assert.equal(r.componentTruncated, false);
});

test('parseDbScopeResolution: 알 수 없는 dbState는 REVIEW쪽으로 안전하게 BLOCKING_EVIDENCE 처리', () => {
    const r = parseDbScopeResolution({ dbState: 'WAT', dbScopeHash: 'x' });
    assert.equal(r.dbState, 'BLOCKING_EVIDENCE');
});

test('callParcelScopeResolver: 주입 caller로 호출하고 파싱된 결과 반환', async () => {
    const calls: unknown[] = [];
    const callResolver = async (params: unknown) => {
        calls.push(params);
        return { data: { dbState: 'NO_EVIDENCE', dbScopeHash: 'ok', componentPnus: [ANCHOR] }, error: null };
    };
    const res = await callParcelScopeResolver({ unionId: 'u1', anchorPnu: ANCHOR, rootMgmBldrgstPks: [PK] }, { callResolver });
    assert.equal(res.dbScopeHash, 'ok');
    assert.deepEqual(calls, [{ p_union_id: 'u1', p_anchor_pnu: ANCHOR, p_root_mgm_bldrgst_pks: [PK] }]);
});

test('callParcelScopeResolver: RPC error는 throw', async () => {
    const callResolver = async () => ({ data: null, error: { message: 'denied' } });
    await assert.rejects(() => callParcelScopeResolver({ unionId: 'u1', anchorPnu: ANCHOR, rootMgmBldrgstPks: [] }, { callResolver }));
});

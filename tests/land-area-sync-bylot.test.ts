import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseBylotCnt,
    reduceTitleBylotByPk,
    bylotBasisFallbackPlan,
    resolveBylotCounts,
    BYLOT_SOURCE_POLICY,
    type BylotResolverInput,
} from '../src/services/land-area-sync/bylot';
import type { BrTitleRow, BrBasisOulnRow } from '../src/types/land-area-sync.types';

const PK_A = '1111';
const PK_B = '2222';
const PK_C = '3333';

function titleRow(mgmBldrgstPk: string | number, bylotCnt: unknown): BrTitleRow {
    return { mgmBldrgstPk, bylotCnt: bylotCnt as string | number };
}
function basisRow(mgmBldrgstPk: string | number, bylotCnt: unknown): BrBasisOulnRow {
    return { mgmBldrgstPk, bylotCnt: bylotCnt as string | number };
}

function baseInput(over: Partial<BylotResolverInput> = {}): BylotResolverInput {
    return {
        policy: 'TITLE_ONLY',
        titleRows: [],
        basisRows: [],
        attachedPks: [],
        basisFallbackInvoked: false,
        ...over,
    };
}

function evidenceOf(res: ReturnType<typeof resolveBylotCounts>, pk: string) {
    return res.evidence.find((e) => e.mgmBldrgstPk === pk);
}

// ── 파서 (DESIGN §10.4, §19.2) ────────────────────────────────────

test('parseBylotCnt: "0"은 유효한 count 0', () => {
    assert.deepEqual(parseBylotCnt('0'), { valid: true, count: 0, raw: '0' });
});

test('parseBylotCnt: " 0 "은 공백 제거 후 count 0', () => {
    const r = parseBylotCnt(' 0 ');
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.count, 0);
});

test('parseBylotCnt: 양수 문자열은 정규화 count', () => {
    assert.deepEqual(parseBylotCnt('3'), { valid: true, count: 3, raw: '3' });
    assert.deepEqual(parseBylotCnt(' 12 '), { valid: true, count: 12, raw: ' 12 ' });
});

test('parseBylotCnt: null·undefined·빈 문자열은 invalid (0으로 변환하지 않음)', () => {
    assert.equal(parseBylotCnt(null).valid, false);
    assert.equal(parseBylotCnt(undefined).valid, false);
    assert.equal(parseBylotCnt('').valid, false);
    assert.equal(parseBylotCnt('   ').valid, false);
});

test('parseBylotCnt: 음수·소수·비숫자는 invalid', () => {
    assert.equal(parseBylotCnt('-1').valid, false);
    assert.equal(parseBylotCnt('3.5').valid, false);
    assert.equal(parseBylotCnt('1e3').valid, false);
    assert.equal(parseBylotCnt('abc').valid, false);
    assert.equal(parseBylotCnt('1,000').valid, false);
});

test('parseBylotCnt: overflow(safe integer 초과)는 invalid', () => {
    assert.equal(parseBylotCnt('99999999999999999999').valid, false);
});

test('parseBylotCnt: 숫자 타입 방어 — 정수는 허용, 소수·음수는 invalid', () => {
    assert.equal(parseBylotCnt(5).valid, true);
    assert.equal(parseBylotCnt(3.5).valid, false);
    assert.equal(parseBylotCnt(-2).valid, false);
});

// ── 관리 PK별 title reduce (DESIGN §10.4) ─────────────────────────

test('reduceTitleBylotByPk: 같은 PK 동일 valid 반복은 RESOLVED', () => {
    const m = reduceTitleBylotByPk([titleRow(1111, '2'), titleRow('001111', '2'), titleRow(PK_A, ' 2 ')]);
    assert.deepEqual(m.get(PK_A), { kind: 'RESOLVED', count: 2, raw: '2' });
});

test('reduceTitleBylotByPk: valid+null 혼재는 CONFLICT', () => {
    const m = reduceTitleBylotByPk([titleRow(PK_A, '2'), titleRow(PK_A, null)]);
    assert.equal(m.get(PK_A)?.kind, 'CONFLICT');
});

test('reduceTitleBylotByPk: valid+invalid 혼재는 CONFLICT', () => {
    const m = reduceTitleBylotByPk([titleRow(PK_A, '2'), titleRow(PK_A, 'x')]);
    assert.equal(m.get(PK_A)?.kind, 'CONFLICT');
});

test('reduceTitleBylotByPk: 복수 distinct valid는 CONFLICT', () => {
    const m = reduceTitleBylotByPk([titleRow(PK_A, '2'), titleRow(PK_A, '3')]);
    assert.equal(m.get(PK_A)?.kind, 'CONFLICT');
});

test('reduceTitleBylotByPk: 전부 invalid면 NO_VALID (fallback 후보)', () => {
    const m = reduceTitleBylotByPk([titleRow(PK_A, null), titleRow(PK_A, '')]);
    assert.equal(m.get(PK_A)?.kind, 'NO_VALID');
});

// ── 기본 정책 상수 ────────────────────────────────────────────────

test('BYLOT_SOURCE_POLICY 기본값은 TITLE_ONLY이며 versioned', () => {
    assert.equal(BYLOT_SOURCE_POLICY.policy, 'TITLE_ONLY');
    assert.ok(BYLOT_SOURCE_POLICY.version.length > 0);
});

// ── fallback plan (DESIGN §10.4: TITLE_ONLY basis 0, PNU당 1회) ────

test('bylotBasisFallbackPlan: TITLE_ONLY는 항상 빈 배열 (basis 호출 0)', () => {
    const plan = bylotBasisFallbackPlan(
        [{ pnu: '1'.repeat(19), titleRows: [titleRow(PK_A, null)] }],
        'TITLE_ONLY'
    );
    assert.deepEqual(plan, []);
});

test('bylotBasisFallbackPlan: FALLBACK 정책 + NO_VALID PK 있는 PNU는 정확히 1회', () => {
    const pnu = '1'.repeat(19);
    const plan = bylotBasisFallbackPlan(
        [{ pnu, titleRows: [titleRow(PK_A, null), titleRow(PK_A, ''), titleRow(PK_B, '2')] }],
        'TITLE_WITH_BASIS_FALLBACK'
    );
    assert.deepEqual(plan, [pnu]);
});

test('bylotBasisFallbackPlan: 모든 PK가 valid면 basis 불필요', () => {
    const plan = bylotBasisFallbackPlan(
        [{ pnu: '1'.repeat(19), titleRows: [titleRow(PK_A, '1'), titleRow(PK_B, '2')] }],
        'TITLE_WITH_BASIS_FALLBACK'
    );
    assert.deepEqual(plan, []);
});

// ── resolveBylotCounts: TITLE_ONLY ────────────────────────────────

test('resolveBylotCounts: title 유효값이 있으면 TITLE_ONLY로 RESOLVED', () => {
    const res = resolveBylotCounts(baseInput({ titleRows: [titleRow(PK_A, '0')] }));
    assert.equal(res.status, 'RESOLVED');
    const e = evidenceOf(res, PK_A)!;
    assert.equal(e.source, 'TITLE');
    assert.equal(e.count, 0);
    assert.equal(e.crossCheckState, 'TITLE_ONLY');
    assert.deepEqual(res.expectedPks, [PK_A]);
});

test('resolveBylotCounts: TITLE_ONLY + title 유효값 0개는 UNAVAILABLE (basisRows 무시)', () => {
    const res = resolveBylotCounts(
        baseInput({ titleRows: [titleRow(PK_A, null)], basisRows: [basisRow(PK_A, '4')], basisFallbackInvoked: false })
    );
    assert.equal(res.status, 'REVIEW_REQUIRED');
    assert.ok(res.issues.includes('BYLOT_COUNT_UNAVAILABLE'));
    const e = evidenceOf(res, PK_A)!;
    assert.equal(e.source, null);
    assert.equal(e.count, null);
    assert.equal(e.crossCheckState, 'UNAVAILABLE');
});

test('resolveBylotCounts: 같은 PK 복수 distinct valid는 SOURCE_CONFLICT', () => {
    const res = resolveBylotCounts(baseInput({ titleRows: [titleRow(PK_A, '1'), titleRow(PK_A, '2')] }));
    assert.equal(res.status, 'REVIEW_REQUIRED');
    assert.ok(res.issues.includes('BYLOT_COUNT_SOURCE_CONFLICT'));
    assert.equal(evidenceOf(res, PK_A)!.crossCheckState, 'CONFLICT');
});

// ── resolveBylotCounts: FALLBACK ──────────────────────────────────

test('resolveBylotCounts: FALLBACK + title NO_VALID + basis 정확히 1건 → FALLBACK_RESOLVED', () => {
    const res = resolveBylotCounts(
        baseInput({
            policy: 'TITLE_WITH_BASIS_FALLBACK',
            titleRows: [titleRow(PK_A, null)],
            basisRows: [basisRow(PK_A, '3')],
            basisFallbackInvoked: true,
        })
    );
    assert.equal(res.status, 'RESOLVED');
    const e = evidenceOf(res, PK_A)!;
    assert.equal(e.source, 'BASIS_FALLBACK');
    assert.equal(e.count, 3);
    assert.equal(e.crossCheckState, 'FALLBACK_RESOLVED');
});

test('resolveBylotCounts: FALLBACK basis 0 유효건(BASIS_COMPLETE_ZERO 포함) → UNAVAILABLE', () => {
    const res = resolveBylotCounts(
        baseInput({
            policy: 'TITLE_WITH_BASIS_FALLBACK',
            titleRows: [titleRow(PK_A, null)],
            basisRows: [],
            basisFallbackInvoked: true,
        })
    );
    assert.equal(res.status, 'REVIEW_REQUIRED');
    assert.ok(res.issues.includes('BYLOT_COUNT_UNAVAILABLE'));
    assert.equal(evidenceOf(res, PK_A)!.crossCheckState, 'UNAVAILABLE');
});

test('resolveBylotCounts: FALLBACK basis 유효 2건 이상 → SOURCE_CONFLICT', () => {
    const res = resolveBylotCounts(
        baseInput({
            policy: 'TITLE_WITH_BASIS_FALLBACK',
            titleRows: [titleRow(PK_A, null)],
            basisRows: [basisRow(PK_A, '3'), basisRow(PK_A, '4')],
            basisFallbackInvoked: true,
        })
    );
    assert.equal(res.status, 'REVIEW_REQUIRED');
    assert.ok(res.issues.includes('BYLOT_COUNT_SOURCE_CONFLICT'));
    assert.equal(evidenceOf(res, PK_A)!.crossCheckState, 'CONFLICT');
});

test('resolveBylotCounts: fallback 호출 시 title-valid PK 교차검증 일치 → MATCHED', () => {
    const res = resolveBylotCounts(
        baseInput({
            policy: 'TITLE_WITH_BASIS_FALLBACK',
            titleRows: [titleRow(PK_A, null), titleRow(PK_B, '5')],
            basisRows: [basisRow(PK_A, '3'), basisRow(PK_B, '5')],
            basisFallbackInvoked: true,
        })
    );
    assert.equal(res.status, 'RESOLVED');
    assert.equal(evidenceOf(res, PK_A)!.crossCheckState, 'FALLBACK_RESOLVED');
    const b = evidenceOf(res, PK_B)!;
    assert.equal(b.source, 'TITLE');
    assert.equal(b.count, 5);
    assert.equal(b.crossCheckState, 'MATCHED');
});

test('resolveBylotCounts: fallback 교차검증 불일치 → SOURCE_CONFLICT', () => {
    const res = resolveBylotCounts(
        baseInput({
            policy: 'TITLE_WITH_BASIS_FALLBACK',
            titleRows: [titleRow(PK_A, null), titleRow(PK_B, '5')],
            basisRows: [basisRow(PK_A, '3'), basisRow(PK_B, '9')],
            basisFallbackInvoked: true,
        })
    );
    assert.equal(res.status, 'REVIEW_REQUIRED');
    assert.ok(res.issues.includes('BYLOT_COUNT_SOURCE_CONFLICT'));
    assert.equal(evidenceOf(res, PK_B)!.crossCheckState, 'CONFLICT');
});

test('resolveBylotCounts: fallback 호출됐지만 title-valid PK의 basis 없음 → CROSS_CHECK_NOT_AVAILABLE, title 값 유지', () => {
    const res = resolveBylotCounts(
        baseInput({
            policy: 'TITLE_WITH_BASIS_FALLBACK',
            titleRows: [titleRow(PK_A, null), titleRow(PK_B, '5')],
            basisRows: [basisRow(PK_A, '3')], // PK_B의 basis row 없음
            basisFallbackInvoked: true,
        })
    );
    assert.equal(res.status, 'RESOLVED');
    const b = evidenceOf(res, PK_B)!;
    assert.equal(b.source, 'TITLE');
    assert.equal(b.count, 5);
    assert.equal(b.crossCheckState, 'CROSS_CHECK_NOT_AVAILABLE');
});

test('resolveBylotCounts: fallback은 exact PK만 채택 — 다른 PK basis로 채우지 않음', () => {
    const res = resolveBylotCounts(
        baseInput({
            policy: 'TITLE_WITH_BASIS_FALLBACK',
            titleRows: [titleRow(PK_A, null)],
            basisRows: [basisRow(PK_C, '7')], // 다른 PK의 basis
            basisFallbackInvoked: true,
        })
    );
    assert.equal(res.status, 'REVIEW_REQUIRED');
    assert.equal(evidenceOf(res, PK_A)!.crossCheckState, 'UNAVAILABLE');
    assert.equal(evidenceOf(res, PK_A)!.count, null);
});

// ── expected PK 집합 / orphan coverage (DESIGN §10.4) ─────────────

test('resolveBylotCounts: attached에만 있는 orphan PK는 UNAVAILABLE, expected에 포함', () => {
    const res = resolveBylotCounts(baseInput({ titleRows: [titleRow(PK_A, '1')], attachedPks: [PK_A, PK_B] }));
    assert.deepEqual(res.expectedPks, [PK_A, PK_B]);
    assert.equal(res.status, 'REVIEW_REQUIRED');
    assert.ok(res.issues.includes('BYLOT_COUNT_UNAVAILABLE'));
    assert.equal(evidenceOf(res, PK_B)!.crossCheckState, 'UNAVAILABLE');
});

test('resolveBylotCounts: 결과는 결정론적으로 정렬된 expectedPks/evidence', () => {
    const res = resolveBylotCounts(
        baseInput({ titleRows: [titleRow('3', '1'), titleRow('1', '1')], attachedPks: ['2'] })
    );
    assert.deepEqual(res.expectedPks, ['1', '2', '3']);
    assert.deepEqual(res.evidence.map((e) => e.mgmBldrgstPk), ['1', '2', '3']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseLdaQotaRate,
    isDenominatorWithinTolerance,
    checkDenominatorAgainstArea,
    RATIO_DENOMINATOR_ABS_TOLERANCE,
    RATIO_DENOMINATOR_REL_TOLERANCE,
} from '../src/services/land-area-sync/ratio';

// ── 허용 형식 (§12.1) ────────────────────────────────────────────────

test('표준 형식 파싱: 181.7/15622.1', () => {
    const r = parseLdaQotaRate('181.7/15622.1');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.numerator, 181.7);
    assert.equal(r.ok && r.denominator, 15622.1);
    assert.equal(r.ok && r.numeratorText, '181.7');
    assert.equal(r.ok && r.denominatorText, '15622.1');
});

test('슬래시 주변 공백 변형 허용: "181.7 / 15622.1"', () => {
    const r = parseLdaQotaRate('181.7 / 15622.1');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.numerator, 181.7);
    assert.equal(r.ok && r.denominator, 15622.1);
});

test('양끝 공백은 복사본에서만 trim, 원문(raw)은 그대로 보존', () => {
    const original = '  181.7/15622.1  ';
    const r = parseLdaQotaRate(original);
    assert.equal(r.ok, true);
    assert.equal(r.raw, original); // 원문 보존
    assert.equal(r.ok && r.numeratorText, '181.7');
    assert.equal(r.ok && r.denominatorText, '15622.1');
});

test('정수 분자·분모도 허용', () => {
    const r = parseLdaQotaRate('100/200');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.numerator, 100);
    assert.equal(r.ok && r.denominator, 200);
});

test('분자 = 분모 경계 허용(1/1)', () => {
    const r = parseLdaQotaRate('1/1');
    assert.equal(r.ok, true);
});

// ── 거부 목록 (§12.1) ────────────────────────────────────────────────

test('빈 문자열·공백만 → EMPTY, 원문 보존', () => {
    for (const raw of ['', '   ']) {
        const r = parseLdaQotaRate(raw);
        assert.equal(r.ok, false);
        assert.equal(!r.ok && r.reason, 'EMPTY');
        assert.equal(!r.ok && r.issue, 'RATIO_PARSE_FAILED');
        assert.equal(r.raw, raw);
    }
});

test('슬래시 없음·다중 슬래시 → MALFORMED_STRUCTURE', () => {
    for (const raw of ['181.7', '1/2/3', '/100', '100/']) {
        const r = parseLdaQotaRate(raw);
        assert.equal(r.ok, false, `expected fail: ${raw}`);
        assert.equal(!r.ok && r.reason, 'MALFORMED_STRUCTURE');
    }
});

test('분모 0 → DENOMINATOR_ZERO', () => {
    const r = parseLdaQotaRate('100/0');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'DENOMINATOR_ZERO');
});

test('0 분자 → NUMERATOR_NOT_POSITIVE', () => {
    const r = parseLdaQotaRate('0/100');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'NUMERATOR_NOT_POSITIVE');
});

test('음수 분자 → NUMERATOR_NOT_POSITIVE', () => {
    const r = parseLdaQotaRate('-5/100');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'NUMERATOR_NOT_POSITIVE');
});

test('분자 > 분모 → NUMERATOR_EXCEEDS_DENOMINATOR', () => {
    const r = parseLdaQotaRate('200/100');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'NUMERATOR_EXCEEDS_DENOMINATOR');
});

test('지수 표기 → EXPONENT_NOTATION', () => {
    for (const raw of ['1e2/100', '181.7/1.5E4', '1E1/2']) {
        const r = parseLdaQotaRate(raw);
        assert.equal(r.ok, false, `expected fail: ${raw}`);
        assert.equal(!r.ok && r.reason, 'EXPONENT_NOTATION');
    }
});

test('임의 문자 → NON_NUMERIC', () => {
    for (const raw of ['abc/100', '18a.7/100', '181.7/15,622.1', '１８/２０과']) {
        const r = parseLdaQotaRate(raw);
        assert.equal(r.ok, false, `expected fail: ${raw}`);
        assert.equal(!r.ok && r.reason, 'NON_NUMERIC');
    }
});

test('overflow(초장문 숫자 → 무한대) → OVERFLOW', () => {
    const r = parseLdaQotaRate('100/' + '9'.repeat(400));
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'OVERFLOW');
});

// ── 분모-LADFRL 면적 허용오차 (§7.5) ─────────────────────────────────

test('허용오차 상수는 절대 0.1㎡ / 상대 0.00001', () => {
    assert.equal(RATIO_DENOMINATOR_ABS_TOLERANCE, 0.1);
    assert.equal(RATIO_DENOMINATOR_REL_TOLERANCE, 0.00001);
});

test('작은 면적: 0.1㎡ 절대오차가 상대오차보다 큼 → 0.1이 경계', () => {
    const area = 100; // rel = 0.001 < 0.1 → tol = 0.1
    assert.equal(isDenominatorWithinTolerance(100.1, area), true); // 경계 이내(<=)
    assert.equal(isDenominatorWithinTolerance(99.9, area), true);
    assert.equal(isDenominatorWithinTolerance(100.11, area), false);
    assert.equal(isDenominatorWithinTolerance(99.89, area), false);
});

test('큰 면적: 상대오차(area×0.00001)가 0.1보다 큼 → 상대가 경계', () => {
    const area = 1_000_000; // rel = 10 > 0.1 → tol = 10
    assert.equal(isDenominatorWithinTolerance(1_000_010, area), true); // 경계 이내
    assert.equal(isDenominatorWithinTolerance(999_990, area), true);
    assert.equal(isDenominatorWithinTolerance(1_000_011, area), false);
    assert.equal(isDenominatorWithinTolerance(999_989, area), false);
});

test('checkDenominatorAgainstArea: 불일치 시 RATIO_DENOMINATOR_MISMATCH issue', () => {
    assert.deepEqual(checkDenominatorAgainstArea(15622.1, 15622.1), { ok: true });
    const mismatch = checkDenominatorAgainstArea(15000, 15622.1);
    assert.equal(mismatch.ok, false);
    assert.equal(!mismatch.ok && mismatch.issue, 'RATIO_DENOMINATOR_MISMATCH');
});

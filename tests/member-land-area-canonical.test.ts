import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isLandAreaUnchanged,
    normalizeLandAreaDecimal,
} from '../src/services/member.land-area-canonical';

test('normalizeLandAreaDecimal: 숫자는 소수점 4자리 문자열로 정규화한다', () => {
    assert.equal(normalizeLandAreaDecimal(19.7), '19.7000');
    assert.equal(normalizeLandAreaDecimal(80), '80.0000');
});

test('normalizeLandAreaDecimal: 문자열 입력도 동일하게 정규화한다', () => {
    assert.equal(normalizeLandAreaDecimal('19.70'), '19.7000');
    assert.equal(normalizeLandAreaDecimal('80.00'), '80.0000');
    assert.equal(normalizeLandAreaDecimal('19.7'), '19.7000');
});

test('normalizeLandAreaDecimal: null/undefined는 null을 반환한다', () => {
    assert.equal(normalizeLandAreaDecimal(null), null);
    assert.equal(normalizeLandAreaDecimal(undefined), null);
});

test('normalizeLandAreaDecimal: 파싱 불가 문자열은 null을 반환한다(NaN 취급)', () => {
    assert.equal(normalizeLandAreaDecimal('abc'), null);
    assert.equal(normalizeLandAreaDecimal(''), null);
});

test('normalizeLandAreaDecimal: 소수 5자리 이하는 반올림한다', () => {
    // 5번째 소수가 6이면 4번째 자리를 올림한다
    assert.equal(normalizeLandAreaDecimal(19.70006), '19.7001');
    // 5번째 소수가 4 이하면 그대로 버림된다(19.70과 동일한 값으로 취급)
    assert.equal(normalizeLandAreaDecimal(19.70004), '19.7000');
});

test('isLandAreaUnchanged: 19.70과 19.7은 동일하다(DESIGN §15.3)', () => {
    assert.equal(isLandAreaUnchanged(19.7, '19.70'), true);
    assert.equal(isLandAreaUnchanged('19.70', 19.7), true);
});

test('isLandAreaUnchanged: 표현만 다른 동일 값은 변경 없음으로 판정한다', () => {
    assert.equal(isLandAreaUnchanged('80.00', 80), true);
    assert.equal(isLandAreaUnchanged(80, 80), true);
});

test('isLandAreaUnchanged: 실제 값이 다르면 변경으로 판정한다', () => {
    assert.equal(isLandAreaUnchanged(80, 81), false);
    assert.equal(isLandAreaUnchanged('80.00', 80.01), false);
});

test('isLandAreaUnchanged: 한쪽만 null이면 변경으로 판정한다', () => {
    assert.equal(isLandAreaUnchanged(null, 80), false);
    assert.equal(isLandAreaUnchanged(80, null), false);
    assert.equal(isLandAreaUnchanged(undefined, 80), false);
});

test('isLandAreaUnchanged: 양쪽 다 null/undefined이면 변경 없음으로 판정한다', () => {
    assert.equal(isLandAreaUnchanged(null, null), true);
    assert.equal(isLandAreaUnchanged(undefined, undefined), true);
    assert.equal(isLandAreaUnchanged(null, undefined), true);
});

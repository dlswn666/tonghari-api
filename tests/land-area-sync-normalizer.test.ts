import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeUnitSegment,
    normalizeUnitTuple,
    unitTupleKey,
    detectUnitNormalizationCollisions,
} from '../src/services/land-area-sync/normalizer';
import { BASEMENT_PREFIX_CODEBOOK } from '../src/services/land-area-sync/unit-normalization.fixture';

// ── 허용 변환 (§12.3) ────────────────────────────────────────────────

test('NFKC: 전각 숫자·문자를 반각으로 정규화', () => {
    // 전각 '１０１' → '101'
    assert.equal(normalizeUnitSegment('１０１'), '101');
});

test('양끝 trim + 내부 허용 공백 제거', () => {
    assert.equal(normalizeUnitSegment('  101 동  '), '101');
    assert.equal(normalizeUnitSegment('1 0 1'), '101');
});

test('정확한 `제` 접두사 제거', () => {
    assert.equal(normalizeUnitSegment('제101동'), '101');
    assert.equal(normalizeUnitSegment('제502호'), '502');
});

test('정확한 `동`/`호` 접미사 제거', () => {
    assert.equal(normalizeUnitSegment('101동'), '101');
    assert.equal(normalizeUnitSegment('502호'), '502');
    assert.equal(normalizeUnitSegment('가동'), '가'); // 문자 동명도 접미사만 제거
});

test('숫자 leading zero 정규화', () => {
    assert.equal(normalizeUnitSegment('007동'), '7');
    assert.equal(normalizeUnitSegment('0101호'), '101');
    assert.equal(normalizeUnitSegment('010'), '10');
    assert.equal(normalizeUnitSegment('000'), '0'); // 최소 한 자리 유지
});

// ── 지하 codebook → B (§12.3) ────────────────────────────────────────

test('codebook 지하 표기만 B로 통일: 지하1·지1·B1·b01 → B1', () => {
    assert.equal(normalizeUnitSegment('지하1'), 'B1');
    assert.equal(normalizeUnitSegment('지1'), 'B1');
    assert.equal(normalizeUnitSegment('B1'), 'B1');
    assert.equal(normalizeUnitSegment('b01'), 'B1'); // 소문자 + leading zero
});

test('지하 표기 + 층: 지하1층·지1층·B01층 → B1층 (층 접미사는 보존)', () => {
    assert.equal(normalizeUnitSegment('지하1층'), 'B1층');
    assert.equal(normalizeUnitSegment('지1층'), 'B1층');
    assert.equal(normalizeUnitSegment('B01층'), 'B1층');
});

test('codebook 미정의 형태·숫자 없는 지하는 매핑하지 않음', () => {
    // '지하' 뒤 숫자 없음 → 매핑 안 함
    assert.equal(normalizeUnitSegment('지하'), '지하');
    // codebook 최소집합에 예시 3형태의 근거 prefix만 존재
    assert.deepEqual([...BASEMENT_PREFIX_CODEBOOK], ['지하', '지', 'B', 'b']);
});

// ── 금지 사항 (§12.3): contains/endsWith/fuzzy 없음 ─────────────────

test('다른 원문은 다른 key를 유지(임의 축약·contains 없음)', () => {
    assert.notEqual(normalizeUnitSegment('101'), normalizeUnitSegment('1101'));
    assert.notEqual(normalizeUnitSegment('101'), normalizeUnitSegment('102'));
});

// ── tuple / key ──────────────────────────────────────────────────────

test('normalizeUnitTuple + unitTupleKey: 서로 다른 원문이 같은 key로 수렴', () => {
    const a = normalizeUnitTuple({ dong: '제101동', floor: '지하1층', ho: '0202호' });
    const b = normalizeUnitTuple({ dong: '101', floor: 'B1층', ho: '202' });
    assert.equal(unitTupleKey(a), unitTupleKey(b));
});

test('unitTupleKey는 지정 필드 부분집합만 결합', () => {
    const t = normalizeUnitTuple({ dong: '101', floor: '3', ho: '202', room: '1' });
    assert.equal(unitTupleKey(t, ['dong', 'ho']), unitTupleKey(normalizeUnitTuple({ dong: '101', ho: '202' }), ['dong', 'ho']));
});

// ── 정규화 충돌 감지 (§12.3): 다른 원문 → 같은 key = 매칭 제외 ─────────

test('서로 다른 원문이 같은 normalized key로 충돌하면 collision으로 감지', () => {
    const collisions = detectUnitNormalizationCollisions([
        { raw: '007호', normalized: normalizeUnitSegment('007호') },
        { raw: '00007호', normalized: normalizeUnitSegment('00007호') },
        { raw: '101호', normalized: normalizeUnitSegment('101호') },
    ]);
    // '7' 로 수렴하는 두 원문만 충돌
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].key, '7');
    assert.deepEqual(collisions[0].rawVariants.sort(), ['00007호', '007호']);
});

test('동일 원문 반복은 충돌이 아님', () => {
    const collisions = detectUnitNormalizationCollisions([
        { raw: '101호', normalized: '101' },
        { raw: '101호', normalized: '101' },
    ]);
    assert.equal(collisions.length, 0);
});

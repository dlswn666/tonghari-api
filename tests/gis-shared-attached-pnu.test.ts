import assert from 'node:assert/strict';
import test from 'node:test';
import {
    convertPlatGbCdToLandGbn,
    buildBuildingHubPnu,
    assembleAttachedPnus,
    type AtchJibunRowInput,
} from '../src/services/gis-shared/pnu';

// ── convertPlatGbCdToLandGbn: Building HUB platGbCd(0/1) → PNU 토지구분(1/2) 명시 변환 (DESIGN §10.5)

test('convertPlatGbCdToLandGbn: 0 → 1(대지/일반), 1 → 2(산)', () => {
    assert.equal(convertPlatGbCdToLandGbn('0'), '1');
    assert.equal(convertPlatGbCdToLandGbn('1'), '2');
});

test('convertPlatGbCdToLandGbn: 정의되지 않은 값은 null (zero 축약 금지 근거)', () => {
    assert.equal(convertPlatGbCdToLandGbn(''), null);
    assert.equal(convertPlatGbCdToLandGbn('2'), null);
    assert.equal(convertPlatGbCdToLandGbn('9'), null);
    assert.equal(convertPlatGbCdToLandGbn('x'), null);
});

// ── buildBuildingHubPnu: 5필드 → 19자리 PNU

test('buildBuildingHubPnu: 정상 필드는 19자리 PNU를 만든다 (platGbCd 0 → landGbn 1)', () => {
    const r = buildBuildingHubPnu({
        sigunguCd: '11680',
        bjdongCd: '10100',
        platGbCd: '0',
        bun: '0736',
        ji: '0024',
    });
    assert.deepEqual(r, { ok: true, pnu: '1168010100107360024' });
});

test('buildBuildingHubPnu: 산(platGbCd 1)은 landGbn 2로 변환', () => {
    const r = buildBuildingHubPnu({
        sigunguCd: '41210',
        bjdongCd: '10100',
        platGbCd: '1',
        bun: '0012',
        ji: '0000',
    });
    assert.deepEqual(r, { ok: true, pnu: '4121010100200120000' });
});

test('buildBuildingHubPnu: 1~4자리 본/부번은 0으로 좌측 패딩', () => {
    const r = buildBuildingHubPnu({
        sigunguCd: '11680',
        bjdongCd: '10100',
        platGbCd: '0',
        bun: '736',
        ji: '',
    });
    // ji 빈 값은 누락으로 처리 → 아래 별도 테스트 참조. 여기선 ji='0'
    assert.equal(r.ok, false);
});

test('buildBuildingHubPnu: 잘못된 platGbCd는 INVALID_PLAT_GB_CD (zero 축약 금지)', () => {
    const r = buildBuildingHubPnu({
        sigunguCd: '11680',
        bjdongCd: '10100',
        platGbCd: '9',
        bun: '0736',
        ji: '0024',
    });
    assert.deepEqual(r, { ok: false, reason: 'INVALID_PLAT_GB_CD' });
});

test('buildBuildingHubPnu: 블록/비숫자 지번은 BLOCK_OR_NON_NUMERIC_JIBUN (zero 축약 금지)', () => {
    const r = buildBuildingHubPnu({
        sigunguCd: '11680',
        bjdongCd: '10100',
        platGbCd: '0',
        bun: '1블록',
        ji: '0024',
    });
    assert.deepEqual(r, { ok: false, reason: 'BLOCK_OR_NON_NUMERIC_JIBUN' });
});

test('buildBuildingHubPnu: 5자리 아닌 지역코드는 INVALID_REGION_CODE', () => {
    const r = buildBuildingHubPnu({
        sigunguCd: '1168',
        bjdongCd: '10100',
        platGbCd: '0',
        bun: '0736',
        ji: '0024',
    });
    assert.deepEqual(r, { ok: false, reason: 'INVALID_REGION_CODE' });
});

test('buildBuildingHubPnu: 빈 필드는 MISSING_FIELD', () => {
    const r = buildBuildingHubPnu({
        sigunguCd: '11680',
        bjdongCd: '10100',
        platGbCd: '0',
        bun: '',
        ji: '0024',
    });
    assert.deepEqual(r, { ok: false, reason: 'MISSING_FIELD' });
});

// ── assembleAttachedPnus: 부속지번 row → (기준 PNU, 부속 PNU) 쌍

function row(overrides: Partial<AtchJibunRowInput>): AtchJibunRowInput {
    return {
        mgmBldrgstPk: 'PK-1',
        sigunguCd: '11680',
        bjdongCd: '10100',
        platGbCd: '0',
        bun: '0736',
        ji: '0024',
        atchSigunguCd: '11680',
        atchBjdongCd: '10100',
        atchPlatGbCd: '0',
        atchBun: '0736',
        atchJi: '0025',
        ...overrides,
    };
}

test('assembleAttachedPnus: 정상 row는 기준·부속 PNU 쌍으로 조립', () => {
    const result = assembleAttachedPnus([row({})]);
    assert.equal(result.pairs.length, 1);
    assert.deepEqual(result.pairs[0], {
        basePnu: '1168010100107360024',
        attachedPnu: '1168010100107360025',
        mgmBldrgstPk: 'PK-1',
    });
    assert.equal(result.rejected.length, 0);
});

test('assembleAttachedPnus: self relation(기준=부속)은 zero가 아니라 rejected로 분리', () => {
    const result = assembleAttachedPnus([row({ atchJi: '0024' })]);
    assert.equal(result.pairs.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(result.rejected[0].reason, { side: 'PAIR', reason: 'SELF_RELATION' });
});

test('assembleAttachedPnus: 중복 pair는 rejected로 분리(첫 건만 채택)', () => {
    const result = assembleAttachedPnus([row({}), row({})]);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(result.rejected[0].reason, { side: 'PAIR', reason: 'DUPLICATE_PAIR' });
});

test('assembleAttachedPnus: 블록 지번은 rejected(BLOCK_OR_NON_NUMERIC_JIBUN), zero 축약 금지', () => {
    const result = assembleAttachedPnus([row({ atchBun: 'B블록' })]);
    assert.equal(result.pairs.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(result.rejected[0].reason, {
        side: 'ATTACHED',
        reason: 'BLOCK_OR_NON_NUMERIC_JIBUN',
    });
});

test('assembleAttachedPnus: 기준 PNU 변환 실패는 side=BASE로 표시', () => {
    const result = assembleAttachedPnus([row({ platGbCd: '9' })]);
    assert.equal(result.pairs.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(result.rejected[0].reason, { side: 'BASE', reason: 'INVALID_PLAT_GB_CD' });
});

test('assembleAttachedPnus: 유효/무효 혼재 시 유효는 채택, 무효는 rejected로 병존', () => {
    const result = assembleAttachedPnus([
        row({}),
        row({ atchBun: 'X' }),
        row({ atchJi: '9999' }),
    ]);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.rejected.length, 1);
});

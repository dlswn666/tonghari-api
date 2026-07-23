import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleLdaregApply } from '../src/services/land-area-sync/ldareg-branch';
import type { PropertyUnitCandidate } from '../src/services/land-area-sync/matcher';

const ANCHOR = '1168010100107360024';
const PROP_ID = '11111111-1111-4111-8111-111111111111';
const PK = 'PK-ROOT';

const property: PropertyUnitCandidate = {
    id: PROP_ID,
    unionId: 'union-1',
    buildingUnitId: null,
    pnu: ANCHOR,
    isDeleted: false,
    dong: null,
    ho: '301',
};

test('LDAREG 매칭 happy path: 문자열 numeratorText/denominatorText 로 component 를 조립한다', () => {
    const result = assembleLdaregApply({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    {
                        pnu: ANCHOR,
                        agbldgSn: '1',
                        buldNm: '가나빌',
                        buldFloorNm: '3층',
                        buldHoNm: '301',
                        ldaQotaRate: '181.7/15622.1',
                        clsSeCode: '0',
                        clsSeCodeNm: '유효',
                    },
                ],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });

    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.propertyUnitId, PROP_ID);
    assert.deepEqual(item.expectedTargetPnus, [ANCHOR]);
    assert.equal(item.components.length, 1);
    const c = item.components[0];
    assert.equal(c.sourceState, 'CURRENT');
    assert.equal(c.targetPnu, ANCHOR);
    // ratio.ts 의 문자열 텍스트를 그대로 소비한다(JS float 금지).
    assert.equal(c.ratioNumerator, '181.7');
    assert.equal(c.ratioDenominator, '15622.1');
    assert.equal(c.ratioRaw, '181.7/15622.1');
    assert.equal(c.matchMethod, 'PNU_DONG_HO');
    assert.equal(c.matchedBuildingUnitId, null);
    assert.equal(result.counts.parsedRows, 1);
    assert.deepEqual(result.matchedPropertyUnitIds, [PROP_ID]);
});

test('매칭 실패(후보 없음)는 component 를 만들지 않고 issue 로 남긴다(tuple 보존)', () => {
    const result = assembleLdaregApply({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '9', buldFloorNm: '9층', buldHoNm: '999', ldaQotaRate: '1/2', clsSeCode: '0' }],
                exposRows: [],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });
    assert.equal(result.items.length, 0);
    assert.ok(result.issues.length >= 1);
});

test('C1: 총괄표제부 집합건물(expos mgmUpBldrgstPk ≠ mgmBldrgstPk)도 up-PK 축으로 매칭된다(ROOT_MISMATCH 회귀 가드)', () => {
    // scope root(계열 up-PK)와 expos self-PK 가 다른 필지. 수정 전에는 expos.rootIdentity 가 self-PK 라
    // 2단계에서 ROOT_MISMATCH → 전량 NO_CHANGE 였다. 수정 후 두 축 모두 up-PK 우선으로 매칭된다.
    const result = assembleLdaregApply({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: 'UP-ROOT', // 계열 root(up-PK)
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: '0', clsSeCodeNm: '유효' },
                ],
                // 동별 self-PK 는 up-PK 와 다르지만 up-PK 는 계열 root 와 일치.
                exposRows: [{ mgmUpBldrgstPk: 'UP-ROOT', mgmBldrgstPk: 'SELF-DONG-A', flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });
    assert.equal(result.items.length, 1, 'up-PK 축 일치 → component 생성');
    assert.equal(result.items[0].components[0].sourceState, 'CURRENT');
    assert.ok(!result.issues.some((i) => i.code === 'LDAREG_IDENTITY_CONFLICT'), 'ROOT_MISMATCH 없음');
});

test('I1: FALLBACK identity 는 대표 row 의 정확한 source_record 를 뽑는다(첫 row 오염 회귀 가드)', () => {
    // 같은 PNU 에 서로 다른 두 세대(둘 다 agbldgSn 없음 → FALLBACK). 수정 전에는 find 술어가 항상-true 라
    // 두 record 모두 첫 row 의 source_record(buldNm '동A')를 가져갔다. 수정 후 각자 정확한 row 를 가리킨다.
    const propA: PropertyUnitCandidate = { id: '11111111-1111-4111-8111-1111111111a1', unionId: 'union-1', buildingUnitId: null, pnu: ANCHOR, isDeleted: false, dong: null, ho: '301' };
    const propB: PropertyUnitCandidate = { id: '11111111-1111-4111-8111-1111111111b2', unionId: 'union-1', buildingUnitId: null, pnu: ANCHOR, isDeleted: false, dong: null, ho: '501' };
    const result = assembleLdaregApply({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '', buldNm: '동A', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '100/15000', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '', buldNm: '동B', buldFloorNm: '5층', buldHoNm: '501', ldaQotaRate: '200/15000', clsSeCode: '0' },
                ],
                exposRows: [
                    { mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' },
                    { mgmBldrgstPk: PK, flrNoNm: '5층', hoNm: '501' },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [propA, propB],
    });
    assert.equal(result.items.length, 2, '두 세대 모두 매칭');
    const byProp = new Map(result.items.map((i) => [i.propertyUnitId, i.components[0]]));
    const cA = byProp.get(propA.id)!;
    const cB = byProp.get(propB.id)!;
    // 각 component 는 자신의 원본 row 에서 source_record 를 뽑아야 한다(오염 시 둘 다 '동A'/'301').
    assert.equal(cA.sourceRecord.buldNm, '동A');
    assert.equal(cA.sourceRecord.buldHoNm, '301');
    assert.equal(cB.sourceRecord.buldNm, '동B');
    assert.equal(cB.sourceRecord.buldHoNm, '501');
});

test('I2: 분모가 same-run LADFRL 면적과 허용오차를 벗어나면 RATIO_DENOMINATOR_MISMATCH 로 제외한다', () => {
    const result = assembleLdaregApply({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '100/15000', clsSeCode: '0' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
                ladfrlArea: 20000, // 분모 15000 과 크게 불일치
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });
    assert.equal(result.items.length, 0, '불일치 component 는 제외');
    assert.ok(result.issues.some((i) => i.code === 'RATIO_DENOMINATOR_MISMATCH'), 'mismatch issue 기록');
    assert.equal(result.counts.parsedRows, 0);
});

test('I2: 분모가 same-run LADFRL 면적과 일치하면 정상 조립, 면적 null 이면 대조를 건너뛴다(RPC 이중검증 위임)', () => {
    const match = assembleLdaregApply({
        unionId: 'union-1', scannedPnus: [ANCHOR], rootIdentity: PK,
        perPnu: [{ pnu: ANCHOR, ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: '0' }], exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }], ladfrlArea: 15622.1 }],
        buildingUnits: [], propertyUnits: [property],
    });
    assert.equal(match.items.length, 1, '분모 일치 → 조립');
    assert.ok(!match.issues.some((i) => i.code === 'RATIO_DENOMINATOR_MISMATCH'));

    const skip = assembleLdaregApply({
        unionId: 'union-1', scannedPnus: [ANCHOR], rootIdentity: PK,
        perPnu: [{ pnu: ANCHOR, ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '100/15000', clsSeCode: '0' }], exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }], ladfrlArea: null }],
        buildingUnits: [], propertyUnits: [property],
    });
    assert.equal(skip.items.length, 1, '면적 null → same-run 대조 skip, 조립 유지');
    assert.ok(!skip.issues.some((i) => i.code === 'RATIO_DENOMINATOR_MISMATCH'));
});

test('원장 승격: clsSeCode 불명확(ambiguous)이면 CURRENT 유지하되 LDAREG_IDENTITY_CONFLICT issue 1건을 남긴다', () => {
    const result = assembleLdaregApply({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                // clsSeCode 'X7' / clsSeCodeNm 'ZZZ' → mapClsSeCodeToSourceState ambiguous=true (CURRENT 유지).
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: 'X7', clsSeCodeNm: 'ZZZ' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });
    assert.equal(result.items.length, 1, 'ambiguous 여도 CURRENT 로 유지·적용');
    assert.equal(result.items[0].components[0].sourceState, 'CURRENT');
    assert.ok(result.issues.some((i) => i.code === 'LDAREG_IDENTITY_CONFLICT'), 'ambiguous 표시 issue 1건');
});

test('CLOSED(명시 말소)는 retiredReason 을 가진 CLOSED component 로 만든다', () => {
    const result = assembleLdaregApply({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: '2', clsSeCodeNm: '말소' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
    });
    assert.equal(result.items.length, 1);
    const c = result.items[0].components[0];
    assert.equal(c.sourceState, 'CLOSED');
    assert.ok(c.retiredReason && c.retiredReason.length > 0);
});

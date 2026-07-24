import assert from 'node:assert/strict';
import test from 'node:test';
import {
    assembleLdaregApply,
    selectCanonicalExposSourcePnu,
    validateLdaregReplication,
    type LdaregBranchInput,
} from '../src/services/land-area-sync/ldareg-branch';
import type { PropertyUnitCandidate } from '../src/services/land-area-sync/matcher';

const ANCHOR = '1168010100107360024';
const PROP_ID = '11111111-1111-4111-8111-111111111111';
const PK = '1002003004005';

const property: PropertyUnitCandidate = {
    id: PROP_ID,
    unionId: 'union-1',
    buildingUnitId: null,
    pnu: ANCHOR,
    isDeleted: false,
    dong: null,
    ho: '301',
};

function assemble(
    input: Omit<
        LdaregBranchInput,
        'scopeLadfrlAreas' | 'scopeLadfrlTotal' | 'canonicalSourcePnu'
    > & {
        scopeLadfrlAreas?: LdaregBranchInput['scopeLadfrlAreas'];
        scopeLadfrlTotal?: string;
        canonicalSourcePnu?: string;
    }
) {
    const scopeLadfrlTotal = input.scopeLadfrlTotal ?? '15622.1';
    return assembleLdaregApply({
        ...input,
        canonicalSourcePnu: input.canonicalSourcePnu ?? input.scannedPnus[0],
        scopeLadfrlTotal,
        scopeLadfrlAreas:
            input.scopeLadfrlAreas ??
            [{ pnu: input.scannedPnus[0], area: scopeLadfrlTotal }],
    });
}

test('LDAREG 매칭 happy path: 문자열 numeratorText/denominatorText 로 component 를 조립한다', () => {
    const result = assemble({
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
    const result = assemble({
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
    assert.equal(result.blocking, true, 'nonzero raw를 empty apply payload로 보내지 않는다');
});

test('C1: 총괄표제부 집합건물(expos mgmUpBldrgstPk ≠ mgmBldrgstPk)도 up-PK 축으로 매칭된다(ROOT_MISMATCH 회귀 가드)', () => {
    // scope root(계열 up-PK)와 expos self-PK 가 다른 필지. 수정 전에는 expos.rootIdentity 가 self-PK 라
    // 2단계에서 ROOT_MISMATCH → 전량 NO_CHANGE 였다. 수정 후 두 축 모두 up-PK 우선으로 매칭된다.
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: '9001002003004', // 계열 root(up-PK)
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: '0', clsSeCodeNm: '유효' },
                ],
                // 동별 self-PK 는 up-PK 와 다르지만 up-PK 는 계열 root 와 일치.
                exposRows: [{ mgmUpBldrgstPk: 9001002003004, mgmBldrgstPk: '9001002003005', flrNoNm: '3층', hoNm: '301' }],
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
    const result = assemble({
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
        scopeLadfrlTotal: '15000',
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

test('I2: 분모가 same-run LADFRL scope 합계와 다르면 전역 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '100/15000', clsSeCode: '0' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlTotal: '20000',
    });
    assert.equal(result.items.length, 0, '불일치 component 는 제외');
    assert.ok(result.issues.some((i) => i.code === 'RATIO_DENOMINATOR_MISMATCH'), 'mismatch issue 기록');
    assert.equal(result.counts.parsedRows, 0);
    assert.equal(result.blocking, true);
});

test('I2: 단일 PNU 분모가 same-run LADFRL scope 합계와 일치하면 정상 조립한다', () => {
    const match = assemble({
        unionId: 'union-1', scannedPnus: [ANCHOR], rootIdentity: PK,
        perPnu: [{ pnu: ANCHOR, ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '181.7/15622.1', clsSeCode: '0' }], exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }] }],
        buildingUnits: [], propertyUnits: [property],
    });
    assert.equal(match.items.length, 1, '분모 일치 → 조립');
    assert.ok(!match.issues.some((i) => i.code === 'RATIO_DENOMINATOR_MISMATCH'));
    assert.equal(match.blocking, false);
});

test('I2: 실측 177.6+187=364.6을 유일한 분모 기준으로 사용하고 개별 PNU OR 정책을 허용하지 않는다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR, '1168010100107360025'],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
            {
                pnu: '1168010100107360025',
                ldaregRows: [{ pnu: '1168010100107360025', agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' }],
                exposRows: [],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [
            { pnu: ANCHOR, area: '177.6' },
            { pnu: '1168010100107360025', area: '187' },
        ],
        scopeLadfrlTotal: '364.6',
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].components.length, 2, 'PNU별 provenance component 보존');
    assert.equal(result.items[0].components[0].ratioNumerator, '24.6');
    assert.equal(
        new Set(result.items[0].components.map((component) => component.sourceIdentity)).size,
        1,
        'target PNU 독립 canonical identity 공유'
    );
    assert.equal(result.blocking, false);
    assert.ok(
        result.componentMatchDigest.some(
            (entry) =>
                JSON.stringify(entry).includes('177.6') &&
                JSON.stringify(entry).includes('187') &&
                JSON.stringify(entry).includes('364.6')
        )
    );
});

test('I2: CURRENT 행의 분모가 섞이면 정상 component가 일부 있어도 job 전체 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '2', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/177.6', clsSeCode: '0' },
                ],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '364.6' }],
        scopeLadfrlTotal: '364.6',
    });
    assert.equal(result.blocking, true);
    assert.ok(result.issues.some((issue) => issue.code === 'RATIO_DENOMINATOR_MISMATCH'));
});

test('Phase 0 실측: base expos nonzero+attached expos zero exact replica는 PNU별 provenance를 보존한다', () => {
    const sibling = '1168010100107360025';
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR, sibling],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [{ pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' }],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
            {
                pnu: sibling,
                ldaregRows: [{ pnu: sibling, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '24.6/364.6', clsSeCode: '0' }],
                exposRows: [],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [
            { pnu: ANCHOR, area: '177.6' },
            { pnu: sibling, area: '187' },
        ],
        scopeLadfrlTotal: '364.6',
    });
    assert.equal(result.blocking, false);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].components.length, 2);
    assert.deepEqual(
        result.items[0].components.map((component) => component.targetPnu),
        [ANCHOR, sibling]
    );
    assert.equal(
        new Set(result.items[0].components.map((component) => component.sourceIdentity)).size,
        1
    );
});

test('LDAREG replica multiset은 일부 누락·ratio/state 변조·한쪽 duplicate를 모두 차단한다', () => {
    const sibling = '1168010100107360025';
    const row = (pnu: string, over: Record<string, unknown> = {}) => ({
        pnu,
        agbldgSn: '1',
        buldFloorNm: '3층',
        buldHoNm: '301',
        ldaQotaRate: '24.6/364.6',
        clsSeCode: '0',
        clsSeCodeNm: '유효',
        ...over,
    });
    const scan = (attachedRows: ReturnType<typeof row>[]) =>
        validateLdaregReplication(
            [ANCHOR, sibling],
            [
                { pnu: ANCHOR, ldaregRows: [row(ANCHOR)], exposRows: [] },
                { pnu: sibling, ldaregRows: attachedRows, exposRows: [] },
            ],
            ANCHOR
        );

    assert.equal(scan([]).ok, false, '일부 누락');
    assert.equal(scan([row(sibling, { ldaQotaRate: '25/364.6' })]).ok, false, 'ratio 변조');
    assert.equal(scan([row(sibling, { clsSeCode: '2', clsSeCodeNm: '말소' })]).ok, false, 'state 변조');
    assert.equal(scan([row(sibling), row(sibling)]).ok, false, 'multiset 중복 개수 변조');
});

test('canonical expos source는 linked base의 nonzero exact dataset만 허용하고 attached zero는 무시한다', () => {
    const sibling = '1168010100107360025';
    const perPnu = [
        {
            pnu: ANCHOR,
            ldaregRows: [],
            exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
        },
        { pnu: sibling, ldaregRows: [], exposRows: [] },
    ];
    assert.equal(selectCanonicalExposSourcePnu([ANCHOR], perPnu), ANCHOR);
    assert.equal(selectCanonicalExposSourcePnu([sibling], perPnu), null);
    assert.equal(
        selectCanonicalExposSourcePnu([ANCHOR, sibling], perPnu),
        null,
        '두 번째 base의 expos zero를 attached zero처럼 무시하지 않는다'
    );
});

test('all-PNU LDAREG COMPLETE_ZERO는 active scope property별 empty component item을 만든다', () => {
    const sibling = '1168010100107360025';
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR, sibling],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
            { pnu: sibling, ldaregRows: [], exposRows: [] },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [
            { pnu: ANCHOR, area: '177.6' },
            { pnu: sibling, area: '187' },
        ],
        scopeLadfrlTotal: '364.6',
    });
    assert.equal(result.blocking, false);
    assert.equal(result.replicationEvidence?.rowCount, 0);
    assert.deepEqual(result.items, [
        {
            propertyUnitId: PROP_ID,
            expectedTargetPnus: [ANCHOR, sibling],
            components: [],
        },
    ]);
});

test('같은 property에 서로 다른 CURRENT sourceIdentity 2개가 매칭되면 apply 전에 전역 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/100', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '2', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '20/100', clsSeCode: '0' },
                ],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });
    assert.equal(result.blocking, true);
    assert.ok(result.issues.some((issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'));
});

test('같은 property에 CURRENT와 다른 CLOSED identity가 함께 매칭돼도 API에서 전역 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    { pnu: ANCHOR, agbldgSn: '1', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/100', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '2', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/100', clsSeCode: '2', clsSeCodeNm: '말소' },
                ],
                exposRows: [{ mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' }],
            },
        ],
        buildingUnits: [],
        propertyUnits: [property],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });
    assert.equal(result.blocking, true);
    assert.ok(result.issues.some((issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'));
});

test('dedup identity payload conflict는 정상 row가 남아도 partial apply하지 않고 전역 blocking한다', () => {
    const result = assemble({
        unionId: 'union-1',
        scannedPnus: [ANCHOR],
        rootIdentity: PK,
        perPnu: [
            {
                pnu: ANCHOR,
                ldaregRows: [
                    // agbldgSn 없음 + 같은 immutable tuple, ratio만 달라 같은 fallback identity conflict.
                    { pnu: ANCHOR, agbldgSn: '', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '10/100', clsSeCode: '0' },
                    { pnu: ANCHOR, agbldgSn: '', buldFloorNm: '3층', buldHoNm: '301', ldaQotaRate: '20/100', clsSeCode: '0' },
                    // 별도 정상 row가 있어도 partial apply 금지.
                    { pnu: ANCHOR, agbldgSn: '3', buldFloorNm: '5층', buldHoNm: '501', ldaQotaRate: '30/100', clsSeCode: '0' },
                ],
                exposRows: [
                    { mgmBldrgstPk: PK, flrNoNm: '3층', hoNm: '301' },
                    { mgmBldrgstPk: PK, flrNoNm: '5층', hoNm: '501' },
                ],
            },
        ],
        buildingUnits: [],
        propertyUnits: [
            property,
            {
                ...property,
                id: '22222222-2222-4222-8222-222222222222',
                ho: '501',
            },
        ],
        scopeLadfrlAreas: [{ pnu: ANCHOR, area: '100' }],
        scopeLadfrlTotal: '100',
    });
    assert.equal(result.blocking, true);
    assert.ok(result.issues.some((issue) => issue.code === 'LDAREG_IDENTITY_CONFLICT'));
});

test('원장 승격: clsSeCode 불명확(ambiguous)이면 CURRENT 유지하되 LDAREG_IDENTITY_CONFLICT issue 1건을 남긴다', () => {
    const result = assemble({
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
    const result = assemble({
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

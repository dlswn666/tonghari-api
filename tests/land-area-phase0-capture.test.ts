import assert from 'node:assert/strict';
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    BrTitleRow,
    LadfrlRow,
    LdaregRow,
    StrictScan,
} from '../src/types/land-area-sync.types';
import {
    LAND_AREA_PHASE0_MANIFEST_VERSION,
    buildLandAreaPhase0CapturePlan,
    captureLandAreaPhase0,
    parseLandAreaPhase0Manifest,
    resolveLandAreaPhase0OutputPath,
    type LandAreaPhase0CaptureAdapter,
    type LandAreaPhase0CaptureManifest,
} from '../src/verification/land-area-phase0-capture';
import {
    runLandAreaPhase0CaptureCli,
    writeLandAreaPhase0Artifact,
} from '../src/cli/phase0-land-area-capture';

const ZERO_PNU = '1168010100107000000';
const POSITIVE_PNU = '1168010100107360024';
const ATTACHED_PNU = '1168010100107360025';
const ZERO_PK = '1001001001001';
const ZERO_UP_PK = '1001001001002';
const POSITIVE_PK = '2002002002001';
const POSITIVE_UP_PK = '2002002002002';
const SECRET = 'SECRET-CANARY-DO-NOT-EMIT';
const DOMAIN = 'secret-domain.example';
const OWNER = 'OWNER-CANARY-DO-NOT-EMIT';
const CONTACT = '010-9999-9999';
const UNIT_DONG = 'UNIT-DONG-CANARY';
const UNIT_FLOOR = '지하1층';
const UNIT_HO = 'UNIT-HO-CANARY';
const UNKNOWN_KEY = 'unknownSecretFieldCanary';

const HUB_AUTH = { serviceKey: SECRET };
const VWORLD_AUTH = { key: `${SECRET}-VWORLD`, domain: DOMAIN };

function manifest(samples?: LandAreaPhase0CaptureManifest['samples']): LandAreaPhase0CaptureManifest {
    return {
        version: LAND_AREA_PHASE0_MANIFEST_VERSION,
        samples:
            samples ?? [
                { alias: 'zero-sample', expectedBylot: 'ZERO', pnu: ZERO_PNU },
                { alias: 'positive-sample', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
            ],
    };
}

function complete<T>(rows: T[]): StrictScan<T> {
    return {
        state: rows.length === 0 ? 'COMPLETE_ZERO' : 'COMPLETE',
        rows: rows as T[] & [],
        totalCount: rows.length,
        pagesFetched: 1,
    } as StrictScan<T>;
}

function titleRows(pnu: string): BrTitleRow[] {
    if (pnu === ZERO_PNU) {
        return [
            {
                pnu,
                mgmBldrgstPk: ZERO_PK,
                mgmUpBldrgstPk: ZERO_UP_PK,
                bylotCnt: '0',
                regstrGbCd: '1',
                regstrGbCdNm: '일반건축물대장',
                mainPurpsCd: '01000',
                mainPurpsCdNm: '단독주택',
                etcPurps: '주거시설',
                ownerNm: OWNER,
                [UNKNOWN_KEY]: SECRET,
            },
        ];
    }
    return [
        {
            pnu,
            mgmBldrgstPk: POSITIVE_PK,
            mgmUpBldrgstPk: POSITIVE_UP_PK,
            bylotCnt: '1',
            regstrGbCd: '2',
            regstrGbCdNm: '집합건축물대장',
            mainPurpsCd: '02003',
            mainPurpsCdNm: '다세대주택',
            etcPurps: `공동주택(다세대주택) ${OWNER}`,
            ownerTelno: CONTACT,
            [UNKNOWN_KEY]: SECRET,
        },
        {
            pnu,
            mgmBldrgstPk: POSITIVE_PK,
            bylotCnt: '1',
            regstrGbCd: '2',
            mainPurpsCd: SECRET,
        },
    ];
}

function basisRows(pnu: string): BrBasisOulnRow[] {
    return [
        {
            pnu,
            mgmBldrgstPk: pnu === ZERO_PNU ? ZERO_PK : POSITIVE_PK,
            bylotCnt: pnu === ZERO_PNU ? '0' : '1',
            ownerNm: OWNER,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function attachedRows(pnu: string): BrAtchJibunRow[] {
    if (pnu === ZERO_PNU) return [];
    return [
        {
            mgmBldrgstPk: POSITIVE_PK,
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
            ownerNm: OWNER,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function exposRows(pnu: string): BrExposRow[] {
    if (pnu === ATTACHED_PNU) return [];
    return [
        {
            pnu,
            mgmBldrgstPk: pnu === ZERO_PNU ? ZERO_PK : POSITIVE_PK,
            mgmUpBldrgstPk: pnu === ZERO_PNU ? ZERO_UP_PK : POSITIVE_UP_PK,
            dongNm: UNIT_DONG,
            flrNoNm: UNIT_FLOOR,
            hoNm: UNIT_HO,
            mainAtchGbCd: DOMAIN,
            ownerNm: OWNER,
            ownerTelno: CONTACT,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function ladfrlRows(pnu: string): LadfrlRow[] {
    return [
        {
            pnu,
            lndpclAr:
                pnu === ZERO_PNU
                    ? '100.5'
                    : pnu === ATTACHED_PNU
                      ? '187'
                      : '177.6',
            lndcgrCode: '08',
            ownerNm: OWNER,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function ldaregRows(pnu: string): LdaregRow[] {
    if (pnu === ZERO_PNU) return [];
    return [
        {
            pnu,
            agbldgSn: 'RAW-AGBLDG-SN',
            ldaQotaRate: '24.6/364.6',
            clsSeCode: '0',
            clsSeCodeNm: '유효',
            buldNm: UNIT_DONG,
            buldFloorNm: UNIT_FLOOR,
            buldHoNm: UNIT_HO,
            ownerNm: OWNER,
            contact: CONTACT,
            [UNKNOWN_KEY]: SECRET,
        },
    ];
}

function adapter(overrides: Partial<LandAreaPhase0CaptureAdapter> = {}) {
    const calls: Array<{ endpoint: string; pnu: string }> = [];
    const implementation: LandAreaPhase0CaptureAdapter = {
        async scanTitle(pnu) {
            calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(titleRows(pnu));
        },
        async scanBasis(pnu) {
            calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(basisRows(pnu));
        },
        async scanAttached(pnu) {
            calls.push({ endpoint: 'getBrAtchJibunInfo', pnu });
            return complete(attachedRows(pnu));
        },
        async scanExpos(pnu) {
            calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(exposRows(pnu));
        },
        async scanLadfrl(pnu) {
            calls.push({ endpoint: 'ladfrlList', pnu });
            return complete(ladfrlRows(pnu));
        },
        async scanLdareg(pnu) {
            calls.push({ endpoint: 'ldaregList', pnu });
            return complete(ldaregRows(pnu));
        },
        ...overrides,
    };
    return { implementation, calls };
}

test('manifest: version+samples와 ZERO/POSITIVE 최소 1개만 허용한다', () => {
    assert.deepEqual(parseLandAreaPhase0Manifest(manifest()), manifest());

    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                ...manifest(),
                serviceKey: SECRET,
            }),
        /허용되지 않은 키/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [{ alias: 'zero-only', expectedBylot: 'ZERO', pnu: ZERO_PNU }],
            }),
        /ZERO와 POSITIVE/
    );
});

test('manifest: 중복 alias는 대소문자와 무관하게 fail-closed', () => {
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: 'Case-A', expectedBylot: 'ZERO', pnu: ZERO_PNU },
                    { alias: 'case-a', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
                ],
            }),
        /alias가 중복/
    );
});

test('manifest: 중복 PNU, unknown sample key, 잘못된 alias/PNU를 거부한다', () => {
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: 'zero', expectedBylot: 'ZERO', pnu: ZERO_PNU },
                    { alias: 'positive', expectedBylot: 'POSITIVE', pnu: ZERO_PNU },
                ],
            }),
        /PNU가 중복/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: 'zero', expectedBylot: 'ZERO', pnu: ZERO_PNU, owner: OWNER },
                    { alias: 'positive', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
                ],
            }),
        /허용되지 않은 키/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: '../zero', expectedBylot: 'ZERO', pnu: ZERO_PNU },
                    { alias: 'positive', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
                ],
            }),
        /alias 형식/
    );
    assert.throws(
        () =>
            parseLandAreaPhase0Manifest({
                version: LAND_AREA_PHASE0_MANIFEST_VERSION,
                samples: [
                    { alias: 'zero', expectedBylot: 'ZERO', pnu: '123' },
                    { alias: 'positive', expectedBylot: 'POSITIVE', pnu: POSITIVE_PNU },
                ],
            }),
        /PNU 형식/
    );
});

test('dry plan: 비식별 계획만 만들고 HTTP 호출은 0회다', () => {
    const { calls } = adapter();
    const plan = buildLandAreaPhase0CapturePlan(manifest());
    assert.equal(calls.length, 0);
    assert.equal(plan.sampleCount, 2);
    assert.equal(plan.requestCount, 12);
    assert.equal(JSON.stringify(plan).includes(ZERO_PNU), false);
    assert.equal(JSON.stringify(plan).includes('zero-sample'), false);
    assert.match(plan.samples[0].pnuHash, /^[a-f0-9]{64}$/);
    assert.match(plan.samples[0].aliasHash, /^[a-f0-9]{64}$/);
});

test('live capture: sample 6 endpoint 뒤 linked scope LADFRL/LDAREG/expos를 순차 호출한다', async () => {
    const { implementation, calls } = adapter();
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'PASS');
    const baseEndpointOrder = [
        'getBrTitleInfo',
        'getBrBasisOulnInfo',
        'getBrAtchJibunInfo',
        'getBrExposInfo',
        'ladfrlList',
        'ldaregList',
    ];
    for (const pnu of [ZERO_PNU, POSITIVE_PNU]) {
        assert.deepEqual(
            calls
                .filter((call) => call.pnu === pnu)
                .map((call) => call.endpoint),
            baseEndpointOrder
        );
    }
    assert.deepEqual(
        calls.filter((call) => call.pnu === ATTACHED_PNU).map((call) => call.endpoint),
        ['ladfrlList', 'ldaregList', 'getBrExposInfo']
    );
    assert.deepEqual(
        artifact.samples.map((sample) => sample.aliasHash),
        artifact.samples.map((sample) => sample.aliasHash).sort()
    );
    for (const sample of artifact.samples) {
        assert.match(sample.aliasHash, /^[a-f0-9]{64}$/);
        assert.equal(sample.endpoints.length, 6);
        assert.ok(sample.endpoints.some((endpoint) => endpoint.endpoint === 'getBrBasisOulnInfo'));
    }
    assert.equal(JSON.stringify(artifact).includes('zero-sample'), false);
    assert.equal(JSON.stringify(artifact).includes('positive-sample'), false);
});

test('ZERO/POSITIVE: exact 관리 PK의 bylotCnt와 부속지번 수를 교차검증한다', async () => {
    const { implementation } = adapter();
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    const zero = artifact.samples.find((sample) => sample.expectedBylot === 'ZERO')!;
    const positive = artifact.samples.find((sample) => sample.expectedBylot === 'POSITIVE')!;
    assert.equal(zero.checks.bylotAttached.status, 'PASS');
    assert.equal(positive.checks.bylotAttached.status, 'PASS');
    assert.equal(zero.policyCandidate, 'TITLE_ONLY');
    assert.equal(positive.policyCandidate, 'TITLE_ONLY');
    assert.equal(zero.checks.titleBasis.status, 'PASS');
    assert.equal(positive.checks.titleBasis.status, 'PASS');
    assert.equal(zero.evidence.bylotByManagementPk.records[0].titleCount, 0);
    assert.equal(zero.evidence.bylotByManagementPk.records[0].attachedPairCount, 0);
    assert.equal(positive.evidence.bylotByManagementPk.records[0].titleCount, 1);
    assert.equal(positive.evidence.bylotByManagementPk.records[0].basisCount, 1);
    assert.equal(positive.evidence.bylotByManagementPk.records[0].attachedPairCount, 1);
    assert.match(
        positive.evidence.bylotByManagementPk.records[0].managementPkHash,
        /^[a-f0-9]{64}$/
    );
    assert.equal(positive.evidence.scopeLadfrl.status, 'PASS');
    assert.deepEqual(
        positive.evidence.scopeLadfrl.records.map((record) => record.area),
        ['177.6', '187']
    );
    assert.equal(positive.evidence.scopeLadfrl.totalArea, '364.6');
    assert.equal(positive.evidence.ldaregReplication.status, 'PASS');
    assert.equal(positive.evidence.ldaregReplication.rowCount, 1);
    assert.equal(positive.evidence.ldaregReplication.comparedPnuHashes.length, 2);
    assert.match(
        positive.evidence.ldaregReplication.rowMultisetDigest ?? '',
        /^[a-f0-9]{64}$/
    );
});

test('관리 PK numeric 응답은 digit string과 같은 canonical identity로 처리한다', async () => {
    const numeric = adapter({
        async scanTitle(pnu) {
            numeric.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(
                titleRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number(row.mgmBldrgstPk),
                    ...(row.mgmUpBldrgstPk === undefined
                        ? {}
                        : { mgmUpBldrgstPk: Number(row.mgmUpBldrgstPk) }),
                    bylotCnt: Number(row.bylotCnt),
                }))
            );
        },
        async scanBasis(pnu) {
            numeric.calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(
                basisRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number(row.mgmBldrgstPk),
                    bylotCnt: Number(row.bylotCnt),
                }))
            );
        },
        async scanAttached(pnu) {
            numeric.calls.push({ endpoint: 'getBrAtchJibunInfo', pnu });
            return complete(
                attachedRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number(row.mgmBldrgstPk),
                }))
            );
        },
        async scanExpos(pnu) {
            numeric.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                exposRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number(row.mgmBldrgstPk),
                    mgmUpBldrgstPk: Number(row.mgmUpBldrgstPk),
                }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: numeric.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(artifact.gate.status, 'PASS');
});

test('unsafe number·음수·소수·invalid string 관리 PK는 endpoint별로 fail-closed한다', async () => {
    const unsafe = adapter({
        async scanTitle(pnu) {
            unsafe.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(
                titleRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: Number.MAX_SAFE_INTEGER + 1,
                }))
            );
        },
        async scanBasis(pnu) {
            unsafe.calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(
                basisRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: 'PK-INVALID',
                }))
            );
        },
        async scanAttached(pnu) {
            unsafe.calls.push({ endpoint: 'getBrAtchJibunInfo', pnu });
            return complete(
                attachedRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: -1,
                }))
            );
        },
        async scanExpos(pnu) {
            unsafe.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                exposRows(pnu).map((row) => ({
                    ...row,
                    mgmBldrgstPk: 1.5,
                }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: unsafe.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(artifact.gate.status, 'FAIL');
    for (const code of [
        'TITLE_PK_INVALID',
        'BASIS_PK_INVALID',
        'ATTACHED_PK_INVALID',
        'EXPOS_PK_INVALID',
    ]) {
        assert.ok(artifact.gate.failureCodes.includes(code), code);
    }
});

test('exact-PK gate는 일부 PK만 맞거나 title에 없는 attached PK가 있어도 false-green하지 않는다', async () => {
    const partial = adapter({
        async scanTitle(pnu) {
            partial.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            if (pnu === ZERO_PNU) return complete(titleRows(pnu));
            return complete([
                ...titleRows(pnu),
                {
                    mgmBldrgstPk: '3003003003003',
                    bylotCnt: '1',
                    regstrGbCd: '2',
                    mainPurpsCd: '02003',
                },
            ]);
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: partial.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const positive = artifact.samples.find((sample) => sample.expectedBylot === 'POSITIVE')!;
    assert.equal(positive.checks.bylotAttached.status, 'FAIL');
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(artifact.gate.failureCodes.includes('BYLOT_ATTACHED_EXPECTATION_MISMATCH'));
});

test('title bylot이 ABSENT/NULL일 때만 같은 PK의 basis fallback 후보를 명시한다', async () => {
    const missingTitleBylot = adapter({
        async scanTitle(pnu) {
            missingTitleBylot.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(
                titleRows(pnu).map(({ bylotCnt: _bylotCnt, ...row }) => row)
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: missingTitleBylot.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'PASS');
    for (const sample of artifact.samples) {
        assert.equal(sample.policyCandidate, 'TITLE_WITH_BASIS_FALLBACK');
        assert.equal(sample.checks.titleBasis.status, 'PASS');
        assert.ok(
            sample.reviewCodes.includes('TITLE_WITH_BASIS_FALLBACK_CANDIDATE')
        );
        assert.equal(
            sample.evidence.bylotByManagementPk.records[0].titleBasisRelation,
            'FALLBACK_AVAILABLE'
        );
        const title = sample.endpoints.find(
            (endpoint) => endpoint.endpoint === 'getBrTitleInfo'
        )!;
        assert.equal(title.inventory.kind, 'TITLE');
        if (title.inventory.kind === 'TITLE') {
            assert.equal(title.inventory.records[0].bylot.presence, 'ABSENT');
            assert.equal(title.inventory.records[0].bylot.jsonType, 'undefined');
            assert.equal(title.inventory.records[0].bylot.parseState, 'INVALID');
        }
    }
});

test('title와 basis의 같은 관리 PK bylotCnt가 다르면 정책 후보를 만들지 않는다', async () => {
    const mismatch = adapter({
        async scanBasis(pnu) {
            mismatch.calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(
                basisRows(pnu).map((row) => ({
                    ...row,
                    bylotCnt: pnu === ZERO_PNU ? '1' : '2',
                }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: mismatch.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(
        artifact.gate.failureCodes.includes('TITLE_BASIS_EXACT_PK_MISMATCH')
    );
    assert.ok(
        artifact.samples.every((sample) => sample.policyCandidate === null)
    );
});

test('Building HUB title/basis/expos 응답은 manifest의 exact PNU와 일치해야 한다', async () => {
    const mismatch = adapter({
        async scanTitle(pnu) {
            mismatch.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete(
                titleRows(pnu).map((row) => ({ ...row, pnu: ZERO_PNU }))
            );
        },
        async scanBasis(pnu) {
            mismatch.calls.push({ endpoint: 'getBrBasisOulnInfo', pnu });
            return complete(
                basisRows(pnu).map((row) => ({ ...row, pnu: ZERO_PNU }))
            );
        },
        async scanExpos(pnu) {
            mismatch.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                exposRows(pnu).map((row) => ({ ...row, pnu: ZERO_PNU }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: mismatch.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(artifact.gate.failureCodes.includes('TITLE_PNU_EXACT_MISMATCH'));
    assert.ok(artifact.gate.failureCodes.includes('BASIS_PNU_EXACT_MISMATCH'));
    assert.ok(artifact.gate.failureCodes.includes('EXPOS_PNU_EXACT_MISMATCH'));
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    );
    assert.equal(positive?.policyCandidate, null);
});

test('scan FAILED/INCOMPLETE를 그대로 보존하고 나머지 endpoint도 호출한 뒤 최종 gate를 실패시킨다', async () => {
    const { implementation, calls } = adapter({
        async scanTitle() {
            calls.push({ endpoint: 'getBrTitleInfo', pnu: ZERO_PNU });
            return {
                state: 'FAILED',
                issue: {
                    kind: 'HTTP_ERROR',
                    endpoint: 'getBrTitleInfo',
                    message: SECRET,
                    httpStatus: 403,
                },
            };
        },
        async scanBasis() {
            calls.push({ endpoint: 'getBrBasisOulnInfo', pnu: ZERO_PNU });
            return {
                state: 'INCOMPLETE',
                issue: {
                    kind: 'PAGINATION_MISMATCH',
                    endpoint: 'getBrBasisOulnInfo',
                    message: SECRET,
                    pagesFetched: 1,
                    expectedTotalCount: 2,
                    receivedRows: 1,
                },
            };
        },
    });

    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const zero = artifact.samples.find((sample) => sample.expectedBylot === 'ZERO')!;
    assert.equal(zero.endpoints[0].state, 'FAILED');
    assert.equal(zero.endpoints[1].state, 'INCOMPLETE');
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(artifact.gate.failureCodes.includes('SCAN_FAILED'));
    assert.ok(artifact.gate.failureCodes.includes('SCAN_INCOMPLETE'));
    assert.equal(zero.policyCandidate, null);
    assert.equal(zero.checks.titleBasis.status, 'FAIL');
    assert.equal(calls.length, 15);
    assert.equal(JSON.stringify(artifact).includes(SECRET), false);
});

test('artifact는 결정론적으로 정렬되고 row 순서와 무관한 schema hash를 만든다', async () => {
    const firstAdapter = adapter();
    const secondAdapter = adapter({
        async scanTitle(pnu) {
            secondAdapter.calls.push({ endpoint: 'getBrTitleInfo', pnu });
            return complete([...titleRows(pnu)].reverse());
        },
    });

    const first = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: firstAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const second = await captureLandAreaPhase0({
        manifest: manifest([...manifest().samples].reverse()),
        adapter: secondAdapter.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });

    assert.deepEqual(first, second);
    assert.match(first.schemaHash, /^[a-f0-9]{64}$/);
    for (const sample of first.samples) {
        for (const endpoint of sample.endpoints) {
            assert.match(endpoint.schemaHash, /^[a-f0-9]{64}$/);
        }
    }
});

test('artifact는 raw PNU·관리 PK·agbldgSn·unit identity·PII·secret·domain·unknown field를 내보내지 않는다', async () => {
    const { implementation } = adapter();
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const serialized = JSON.stringify(artifact);

    for (const canary of [
        ZERO_PNU,
        POSITIVE_PNU,
        ATTACHED_PNU,
        ZERO_PK,
        ZERO_UP_PK,
        POSITIVE_PK,
        POSITIVE_UP_PK,
        'RAW-AGBLDG-SN',
        SECRET,
        DOMAIN,
        OWNER,
        CONTACT,
        UNIT_DONG,
        UNIT_FLOOR,
        UNIT_HO,
        UNKNOWN_KEY,
        'zero-sample',
        'positive-sample',
    ]) {
        assert.equal(serialized.includes(canary), false, `artifact leaked: ${canary}`);
    }
    for (const publicLabel of [
        '일반건축물대장',
        '집합건축물대장',
        '단독주택',
        '다세대주택',
        '유효',
        'MULTIPLEX_HOUSE',
        'otherPurposeHash',
    ]) {
        assert.equal(serialized.includes(publicLabel), true, `artifact omitted: ${publicLabel}`);
    }
    assert.match(serialized, /24\.6\/364\.6/);
    assert.match(serialized, /177\.6/);
    assert.match(serialized, /187/);
    assert.match(serialized, /364\.6/);
    assert.match(serialized, /02003/);
    assert.match(serialized, /지하#층/);
});

test('LADFRL/LDAREG positive evidence가 하나라도 없으면 gate는 fail-closed', async () => {
    const noLadfrl = adapter({
        async scanLadfrl(pnu) {
            noLadfrl.calls.push({ endpoint: 'ladfrlList', pnu });
            return complete([]);
        },
    });
    const first = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: noLadfrl.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(first.gate.status, 'FAIL');
    assert.ok(first.gate.failureCodes.includes('LADFRL_POSITIVE_EVIDENCE_MISSING'));

    const noLdareg = adapter({
        async scanLdareg(pnu) {
            noLdareg.calls.push({ endpoint: 'ldaregList', pnu });
            return complete([]);
        },
    });
    const second = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: noLdareg.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(second.gate.status, 'FAIL');
    assert.ok(second.gate.failureCodes.includes('LDAREG_POSITIVE_EVIDENCE_MISSING'));
});

test('LDAREG는 같은 PNU의 LADFRL 면적과 분모가 허용 오차 안에서 일치해야 한다', async () => {
    const denominatorMismatch = adapter({
        async scanLdareg(pnu) {
            denominatorMismatch.calls.push({ endpoint: 'ldaregList', pnu });
            return complete(
                ldaregRows(pnu).map((row) => ({
                    ...row,
                    ldaQotaRate: '24.6/9999.9',
                }))
            );
        },
    });
    const first = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: denominatorMismatch.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(first.gate.status, 'FAIL');
    assert.ok(first.gate.failureCodes.includes('LDAREG_DENOMINATOR_MISMATCH'));
    assert.ok(first.gate.failureCodes.includes('LDAREG_POSITIVE_EVIDENCE_MISSING'));

    const pnuMismatch = adapter({
        async scanLdareg(pnu) {
            pnuMismatch.calls.push({ endpoint: 'ldaregList', pnu });
            return complete(
                ldaregRows(pnu).map((row) => ({
                    ...row,
                    pnu: ZERO_PNU,
                }))
            );
        },
    });
    const second = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: pnuMismatch.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(second.gate.status, 'FAIL');
    assert.ok(second.gate.failureCodes.includes('LDAREG_PNU_EXACT_MISMATCH'));
    assert.ok(second.gate.failureCodes.includes('LDAREG_POSITIVE_EVIDENCE_MISSING'));

    const conflictingLadfrl = adapter({
        async scanLadfrl(pnu) {
            conflictingLadfrl.calls.push({ endpoint: 'ladfrlList', pnu });
            return complete([
                ...ladfrlRows(pnu),
                {
                    ...ladfrlRows(pnu)[0],
                    lndpclAr: pnu === ZERO_PNU ? '101.5' : '178.6',
                },
            ]);
        },
    });
    const third = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: conflictingLadfrl.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    assert.equal(third.gate.status, 'FAIL');
    assert.ok(third.gate.failureCodes.includes('LADFRL_AREA_CONFLICT'));
    assert.ok(third.gate.failureCodes.includes('LADFRL_SCOPE_AREA_INVALID'));
    assert.ok(third.gate.failureCodes.includes('LDAREG_DENOMINATOR_MISMATCH'));
    assert.ok(third.gate.failureCodes.includes('LADFRL_POSITIVE_EVIDENCE_MISSING'));
});

test('linked PNU의 LDAREG ratio가 base canonical multiset과 다르면 Phase 0 gate가 차단한다', async () => {
    const mutated = adapter({
        async scanLdareg(pnu) {
            mutated.calls.push({ endpoint: 'ldaregList', pnu });
            const rows = ldaregRows(pnu).map((row) =>
                pnu === ATTACHED_PNU
                    ? { ...row, ldaQotaRate: '25/364.6' }
                    : row
            );
            return complete(rows);
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: mutated.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const positive = artifact.samples.find(
        (sample) => sample.expectedBylot === 'POSITIVE'
    )!;
    assert.equal(positive.evidence.ldaregReplication.status, 'FAIL');
    assert.ok(positive.failureCodes.includes('LDAREG_SCOPE_REPLICA_INVALID'));
    assert.equal(artifact.gate.status, 'FAIL');
});

test('sanitized inventory는 200건으로 제한하고 전체 수·digest·truncated를 남긴다', async () => {
    const oversized = adapter({
        async scanExpos(pnu) {
            oversized.calls.push({ endpoint: 'getBrExposInfo', pnu });
            return complete(
                Array.from({ length: 201 }, (_, index) => ({
                    ...exposRows(pnu)[0],
                    hoNm: `${UNIT_HO}-${index}`,
                }))
            );
        },
    });
    const artifact = await captureLandAreaPhase0({
        manifest: manifest(),
        adapter: oversized.implementation,
        buildingHubAuth: HUB_AUTH,
        vworldAuth: VWORLD_AUTH,
    });
    const expos = artifact.samples[0].endpoints.find(
        (endpoint) => endpoint.endpoint === 'getBrExposInfo'
    )!;
    assert.equal(expos.inventory.kind, 'EXPOS');
    if (expos.inventory.kind === 'EXPOS') {
        assert.equal(expos.inventory.records.length, 200);
        assert.equal(expos.inventory.totalRecords, 201);
        assert.equal(expos.inventory.truncated, true);
        assert.match(expos.inventory.sanitizedDigest, /^[a-f0-9]{64}$/);
    }
    assert.equal(artifact.gate.status, 'FAIL');
    assert.ok(artifact.gate.failureCodes.includes('CAPTURE_INVENTORY_TRUNCATED'));
});

test('output path는 cwd/.phase0-land-area 바로 아래 JSON 파일만 허용한다', () => {
    const cwd = '/workspace/tonghari-api';
    assert.equal(
        resolveLandAreaPhase0OutputPath(cwd, 'capture.json'),
        '/workspace/tonghari-api/.phase0-land-area/capture.json'
    );
    assert.equal(
        resolveLandAreaPhase0OutputPath(cwd, '.phase0-land-area/capture-01.json'),
        '/workspace/tonghari-api/.phase0-land-area/capture-01.json'
    );
    for (const invalid of [
        '../capture.json',
        '.phase0-land-area/nested/capture.json',
        '/tmp/capture.json',
        '.phase0-land-area/../capture.json',
        'capture.txt',
        'owner name.json',
    ]) {
        assert.throws(() => resolveLandAreaPhase0OutputPath(cwd, invalid), /출력 경로/);
    }
});

test('secure writer는 디렉터리 0700·파일 0600으로 생성하고 기존 파일을 덮어쓰지 않는다', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'land-area-phase0-'));
    const outputPath = resolveLandAreaPhase0OutputPath(cwd, 'capture.json');
    const artifact = {
        version: 'test',
        schemaHash: 'a'.repeat(64),
        gate: { status: 'FAIL', failureCodes: ['TEST'] },
        samples: [],
    };

    await writeLandAreaPhase0Artifact(cwd, outputPath, artifact);
    assert.equal((await stat(path.join(cwd, '.phase0-land-area'))).mode & 0o777, 0o700);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), artifact);
    await assert.rejects(() => writeLandAreaPhase0Artifact(cwd, outputPath, artifact), /이미 존재/);

    const oversizedPath = resolveLandAreaPhase0OutputPath(cwd, 'oversized.json');
    await assert.rejects(
        () =>
            writeLandAreaPhase0Artifact(cwd, oversizedPath, {
                payload: 'x'.repeat(3 * 1024 * 1024),
            }),
        /artifact 크기/
    );
    await assert.rejects(() => access(oversizedPath));
});

test('CLI는 --input/--out만 받고 환경변수 키를 사용하며 stdout에 민감값을 출력하지 않는다', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'land-area-phase0-cli-'));
    const privateDir = path.join(cwd, '.phase0-land-area');
    const manifestPath = path.join(privateDir, 'manifest.json');
    await mkdir(privateDir, { mode: 0o700 });
    await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`, { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const output: string[] = [];
    const errors: string[] = [];
    const { implementation } = adapter();

    const exitCode = await runLandAreaPhase0CaptureCli(
        ['--input', manifestPath, '--out', 'capture.json'],
        {
            cwd,
            env: {
                DATA_PORTAL_API_KEY: SECRET,
                VWORLD_API_KEY: `${SECRET}-VWORLD`,
            },
            adapter: implementation,
            stdout: (message) => output.push(message),
            stderr: (message) => errors.push(message),
        }
    );

    assert.equal(exitCode, 0);
    assert.equal(errors.length, 0);
    const stdout = output.join('\n');
    assert.ok(stdout.length <= 256);
    for (const canary of [SECRET, DOMAIN, ZERO_PNU, POSITIVE_PNU, OWNER, CONTACT]) {
        assert.equal(stdout.includes(canary), false);
    }
    const artifactText = await readFile(path.join(cwd, '.phase0-land-area/capture.json'), 'utf8');
    assert.equal(artifactText.includes(SECRET), false);
    assert.equal(artifactText.includes('www.tonghari.kr'), false);
});

test('CLI는 추가 flag, 공개 권한 manifest, 누락 credential을 fail-closed로 거부한다', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'land-area-phase0-cli-invalid-'));
    const privateDir = path.join(cwd, '.phase0-land-area');
    const manifestPath = path.join(privateDir, 'manifest.json');
    const outsideManifestPath = path.join(cwd, 'outside-manifest.json');
    await mkdir(privateDir, { mode: 0o700 });
    await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`, { mode: 0o644 });
    await writeFile(outsideManifestPath, `${JSON.stringify(manifest())}\n`, { mode: 0o600 });
    await chmod(manifestPath, 0o644);
    await chmod(outsideManifestPath, 0o600);
    const { implementation } = adapter();

    assert.equal(
        await runLandAreaPhase0CaptureCli(
            ['--input', manifestPath, '--out', 'capture.json', '--verbose'],
            { cwd, env: {}, adapter: implementation, stdout: () => undefined, stderr: () => undefined }
        ),
        2
    );
    assert.equal(
        await runLandAreaPhase0CaptureCli(
            ['--input', manifestPath, '--out', 'capture.json'],
            {
                cwd,
                env: {
                    DATA_PORTAL_API_KEY: SECRET,
                    VWORLD_API_KEY: `${SECRET}-VWORLD`,
                    VWORLD_API_DOMAIN: DOMAIN,
                },
                adapter: implementation,
                stdout: () => undefined,
                stderr: () => undefined,
            }
        ),
        2
    );
    assert.equal(
        await runLandAreaPhase0CaptureCli(
            ['--input', outsideManifestPath, '--out', 'capture.json'],
            {
                cwd,
                env: {
                    DATA_PORTAL_API_KEY: SECRET,
                    VWORLD_API_KEY: `${SECRET}-VWORLD`,
                    VWORLD_API_DOMAIN: DOMAIN,
                },
                adapter: implementation,
                stdout: () => undefined,
                stderr: () => undefined,
            }
        ),
        2
    );

    await chmod(manifestPath, 0o600);
    assert.equal(
        await runLandAreaPhase0CaptureCli(
            ['--input', manifestPath, '--out', 'capture.json'],
            { cwd, env: {}, adapter: implementation, stdout: () => undefined, stderr: () => undefined }
        ),
        2
    );
});

test('capture 경로는 DB/queue/동기화 service/config env에 정적으로 연결되지 않는다', async () => {
    const verification = await readFile(
        path.join(process.cwd(), 'src/verification/land-area-phase0-capture.ts'),
        'utf8'
    );
    const cli = await readFile(path.join(process.cwd(), 'src/cli/phase0-land-area-capture.ts'), 'utf8');
    const combined = `${verification}\n${cli}`;

    assert.doesNotMatch(combined, /from ['"][^'"]*\/(?:repository|service|queue)['"]/);
    assert.doesNotMatch(combined, /from ['"][^'"]*config\/env['"]/);
    assert.doesNotMatch(combined, /supabase/i);
    assert.doesNotMatch(combined, /runLandAreaSyncJob|GisInspectService/);
});

test('production image는 compiled CLI와 node 사용자 전용 0700 artifact 디렉터리를 포함한다', async () => {
    const dockerfile = await readFile(path.join(process.cwd(), 'Dockerfile'), 'utf8');
    const dockerignore = await readFile(path.join(process.cwd(), '.dockerignore'), 'utf8');
    assert.match(dockerfile, /COPY --from=builder \/app\/dist \.\/dist/);
    assert.match(dockerfile, /mkdir -p logs \.phase0-land-area/);
    assert.match(dockerfile, /chown -R nodejs:nodejs logs \.phase0-land-area/);
    assert.match(dockerfile, /chmod 700 \.phase0-land-area/);
    assert.match(dockerfile, /USER nodejs/);
    assert.match(dockerignore, /^\.phase0-land-area$/m);
});

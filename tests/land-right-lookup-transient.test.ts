import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    LandRightLookupScopeConfirmationDeps,
    LandRightLookupNed,
    LandRightLookupRepository,
} from '../src/services/land-right-lookup/transient';
import {
    createSupabaseLandRightLookupRepository,
    LandRightLookupError,
    MAX_LAND_RIGHT_SCOPE_PNUS,
    lookupLandRightTransient,
} from '../src/services/land-right-lookup/transient';
import type { NedFetchResult } from '../src/services/land-right-lookup/ned';
import { HOUSING_PURPOSE_ALLOWLIST } from '../src/services/land-area-sync/housing-purpose-allowlist.fixture';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrTitleRow,
    ProviderIssue,
    StrictScan,
} from '../src/types/land-area-sync.types';

const UNION_ID = '11111111-1111-4111-8111-111111111111';
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';
const BASE_PNU = '1168010100107360024';
const ATTACHED_PNU = '1168010100107360025';
const SIBLING_PNU = '1168010100107360026';
const OFFICIAL_ATTACHED_PNU = '1168010100107360027';
const ROOT_PK = '1002003004005';
const DB_SCOPE_HASH = 'a'.repeat(64);
const DETACHED = HOUSING_PURPOSE_ALLOWLIST.find(
    (pair) => pair.category === 'DETACHED'
)!;
const MULTIPLEX = HOUSING_PURPOSE_ALLOWLIST.find(
    (pair) => pair.category === 'MULTIPLEX'
)!;

function relationQueryClient(rows: Record<string, unknown>[]) {
    return {
        from(table: string) {
            assert.equal(table, 'building_registry_land_lot_relations');
            const equals = new Map<string, unknown>();
            const members = new Map<string, unknown[]>();
            let rowLimit = Number.POSITIVE_INFINITY;
            const builder: Record<string, unknown> &
                PromiseLike<{ data: unknown[]; error: null }> = {
                select: () => builder,
                eq: (column: string, value: unknown) => {
                    equals.set(column, value);
                    return builder;
                },
                in: (column: string, values: unknown[]) => {
                    members.set(column, values);
                    return builder;
                },
                limit: (value: number) => {
                    rowLimit = value;
                    return builder;
                },
                abortSignal: () => builder,
                then: (resolve, reject) => {
                    const data = rows
                        .filter((row) =>
                            [...equals].every(
                                ([column, value]) => row[column] === value
                            )
                        )
                        .filter((row) =>
                            [...members].every(([column, values]) =>
                                values.includes(row[column])
                            )
                        )
                        .slice(0, rowLimit);
                    return Promise.resolve({ data, error: null }).then(
                        resolve,
                        reject
                    );
                },
            };
            return builder;
        },
    };
}

const baseProperty = {
    id: PROPERTY_ID,
    union_id: UNION_ID,
    building_unit_id: null,
    pnu: ATTACHED_PNU,
    property_address_jibun: '서울시 테스트 736-25',
    dong: '101동',
    ho: '201호',
    land_area: null,
    land_area_source: null,
    is_deleted: false,
};

function repository(
    overrides: Partial<LandRightLookupRepository> = {}
): LandRightLookupRepository {
    return {
        findPropertyUnit: async () => baseProperty,
        findDirectRelations: async () => [],
        findGroupRelations: async () => [],
        findLandLots: async (_unionId, pnus) =>
            pnus.map((pnu) => ({
                union_id: UNION_ID,
                pnu,
                address: `주소-${pnu.slice(-4)}`,
            })),
        findPropertyMembership: async (_unionId, pnus) =>
            pnus.includes(ATTACHED_PNU)
                ? [
                      {
                          id: PROPERTY_ID,
                          union_id: UNION_ID,
                          building_unit_id: null,
                          pnu: ATTACHED_PNU,
                          is_deleted: false,
                          dong: baseProperty.dong,
                          ho: baseProperty.ho,
                          land_area: null,
                          land_area_source: null,
                      },
                  ]
                : [],
        ...overrides,
    };
}

function ned(
    resolve: (
        source: 'ldareg' | 'ladfrl',
        pnu: string
    ) => NedFetchResult
) {
    const calls: Array<{ source: 'ldareg' | 'ladfrl'; pnu: string }> = [];
    const value: LandRightLookupNed = {
        async fetchLdareg(pnu) {
            calls.push({ source: 'ldareg', pnu });
            return resolve('ldareg', pnu);
        },
        async fetchLadfrl(pnu) {
            calls.push({ source: 'ladfrl', pnu });
            return resolve('ladfrl', pnu);
        },
    };
    return { value, calls };
}

const success = (
    source: 'ldareg' | 'ladfrl',
    pnu: string
): NedFetchResult => ({
    status: 'SUCCESS',
    records:
        source === 'ldareg'
            ? [
                  {
                      pnu,
                      agbldgSn: '1',
                      buldDongNm: '101동',
                      buldFloorNm: '2',
                      buldHoNm: '201호',
                      ldaQotaRate: '10/100',
                      ownerName: '응답하면 안 되는 필드',
                  },
              ]
            : [
                  {
                      pnu,
                      lndpclAr: '100',
                      lndcgrCodeNm: '대',
                      ownerName: '응답하면 안 되는 필드',
                  },
              ],
});

function complete<T>(rows: T[]): StrictScan<T> {
    return {
        state: 'COMPLETE',
        rows,
        totalCount: rows.length,
        pagesFetched: 1,
    };
}

function completeZero<T>(): StrictScan<T> {
    return {
        state: 'COMPLETE_ZERO',
        rows: [],
        totalCount: 0,
        pagesFetched: 1,
    };
}

function incomplete<T>(endpoint: ProviderIssue['endpoint']): StrictScan<T> {
    return {
        state: 'INCOMPLETE',
        issue: {
            kind: 'PAGINATION_MISMATCH',
            endpoint,
            message: '테스트 불완전 응답',
        },
    };
}

function titleRow(
    bylotCnt: string,
    pair = DETACHED,
    rootPk = ROOT_PK,
    pnu = ATTACHED_PNU
): BrTitleRow {
    return {
        mgmBldrgstPk: rootPk,
        bylotCnt,
        regstrGbCd: pair.regstrGbCd,
        mainPurpsCd: pair.mainPurpsCd,
        mainPurpsCdNm: pair.mainPurpsCdNm,
        sigunguCd: pnu.slice(0, 5),
        bjdongCd: pnu.slice(5, 10),
        platGbCd: pnu.slice(10, 11) === '2' ? '1' : '0',
        bun: pnu.slice(11, 15),
        ji: pnu.slice(15, 19),
    };
}

function attachedRow(
    basePnu: string,
    attachedPnu: string,
    rootPk = ROOT_PK
): BrAtchJibunRow {
    const split = (pnu: string) => ({
        sigunguCd: pnu.slice(0, 5),
        bjdongCd: pnu.slice(5, 10),
        platGbCd: pnu.slice(10, 11) === '2' ? '1' : '0',
        bun: pnu.slice(11, 15),
        ji: pnu.slice(15, 19),
    });
    const base = split(basePnu);
    const attached = split(attachedPnu);
    return {
        mgmBldrgstPk: rootPk,
        sigunguCd: base.sigunguCd,
        bjdongCd: base.bjdongCd,
        platGbCd: base.platGbCd,
        bun: base.bun,
        ji: base.ji,
        atchSigunguCd: attached.sigunguCd,
        atchBjdongCd: attached.bjdongCd,
        atchPlatGbCd: attached.platGbCd,
        atchBun: attached.bun,
        atchJi: attached.ji,
    };
}

function scopeResolverData(overrides: Record<string, unknown> = {}) {
    return {
        dbState: 'NO_EVIDENCE',
        rootBuildingIdentities: [ROOT_PK],
        componentPnus: [ATTACHED_PNU],
        linkedBasePnus: [],
        linkedPnus: [],
        linkedEvidenceKeys: [],
        pendingEvidenceKeys: [],
        blockingEvidence: [],
        openUnresolvedEvidenceKeys: [],
        componentTruncated: false,
        propertyMembership: [
            {
                propertyUnitId: PROPERTY_ID,
                pnu: ATTACHED_PNU,
                buildingUnitId: null,
            },
        ],
        dbScopeHash: DB_SCOPE_HASH,
        ...overrides,
    };
}

function scopeConfirmation(
    input: {
        title?: StrictScan<BrTitleRow>;
        attached?: StrictScan<BrAtchJibunRow>;
        basis?: StrictScan<BrBasisOulnRow>;
        resolver?:
            | unknown
            | ((anchorPnu: string) => unknown);
    } = {}
): LandRightLookupScopeConfirmationDeps & {
    calls: string[];
} {
    const calls: string[] = [];
    return {
        calls,
        buildingHub: {
            async scanTitle(pnu) {
                calls.push(`title:${pnu}`);
                return input.title ?? complete([titleRow('0')]);
            },
            async scanAttached(pnu) {
                calls.push(`attached:${pnu}`);
                return input.attached ?? completeZero();
            },
            async scanBasis(pnu) {
                calls.push(`basis:${pnu}`);
                return input.basis ?? completeZero();
            },
        },
        async callResolver(params) {
            calls.push(`resolver:${params.p_anchor_pnu}`);
            const configured = input.resolver;
            return {
                data:
                    typeof configured === 'function'
                        ? configured(params.p_anchor_pnu)
                        : configured ??
                          scopeResolverData({
                              componentPnus: [params.p_anchor_pnu],
                              propertyMembership:
                                  params.p_anchor_pnu === ATTACHED_PNU
                                      ? scopeResolverData()
                                            .propertyMembership
                                      : [],
                          }),
                error: null,
            };
        },
    };
}

function apartmentTitle(
    dong = '101동',
    rootPk = ROOT_PK,
    bylotCnt = '1'
): BrTitleRow {
    return {
        ...titleRow(bylotCnt, MULTIPLEX, rootPk),
        dongNm: dong,
        mainAtchGbCd: '0',
        mainPurpsCd: '02000',
        mainPurpsCdNm: '공동주택',
        etcPurps: '아파트',
        grndFlrCnt: 15,
        totArea: 9500,
    };
}

function apartmentProof(input: {
    title?: StrictScan<BrTitleRow>;
    attached?: StrictScan<BrAtchJibunRow>;
    basis?: StrictScan<BrBasisOulnRow>;
} = {}) {
    const otherPk = '9008007006005';
    return scopeConfirmation({
        title: complete([
            apartmentTitle('102동', otherPk),
            apartmentTitle('00101동'),
        ]),
        attached: complete([
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU, otherPk),
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU),
        ]),
        ...input,
    });
}

async function lookupApartment(proof = apartmentProof()) {
    return lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: ned(success).value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            scopeConfirmation: proof,
        }
    );
}

test('다동 아파트는 첫 표제부가 아니라 숫자 동 exact 대상 root와 전체 공식 부속지 근거를 쓴다', async () => {
    const proof = apartmentProof();
    const result = await lookupApartment(proof);
    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_INCOMPLETE');
    assert.equal(result.scopeResolution?.strategy, 'LDAREG');
    assert.equal(result.scopeResolution?.scopePnuCount, 2);
    assert.equal(result.scopeResolution?.buildingRootCount, 1,
        '전체 PNU의 동 수가 아니라 exact 선택된 대상 root 수다');
    assert.deepEqual(result.parcels.map((row) => row.pnu).sort(),
        [ATTACHED_PNU, OFFICIAL_ATTACHED_PNU].sort());
    assert.ok(proof.calls.includes(`resolver:${OFFICIAL_ATTACHED_PNU}`));
    assert.doesNotMatch(JSON.stringify(result.scopeResolution), new RegExp(ROOT_PK));
});

test('다동 아파트의 숫자 동 모호성·부속동·self/up 충돌·추정 명칭은 확인 후보가 아니다', async () => {
    const cases = [
        [apartmentTitle('102동', '9008007006005'), apartmentTitle('103동')],
        [apartmentTitle('101동', '9008007006005'), apartmentTitle('00101동')],
        [apartmentTitle(), { ...apartmentTitle(), dongNm: '0101' }],
        [apartmentTitle('102동', '9008007006005'), { ...apartmentTitle(), mgmUpBldrgstPk: '9008007006005' }],
        [apartmentTitle('102동', '9008007006005'), { ...apartmentTitle(), mainAtchGbCd: '1' }],
        [apartmentTitle('102동', '9008007006005'), apartmentTitle('제101동')],
        [apartmentTitle('102동', '9008007006005'), apartmentTitle('101동 1라인')],
        [apartmentTitle('102동', '9008007006005'), { ...apartmentTitle(), etcPurps: '아파트,근린생활시설' }],
        [apartmentTitle('102동', '9008007006005'), { ...apartmentTitle(), mainPurpsCd: '02001' }],
        [apartmentTitle('102동', '9008007006005'), { ...apartmentTitle(), regstrGbCd: '1' }],
        [apartmentTitle('102동', 'invalid'), apartmentTitle()],
    ];
    for (const titleRows of cases) {
        const result = await lookupApartment(apartmentProof({ title: complete(titleRows) }));
        assert.equal(result.scopeResolution, undefined, JSON.stringify(titleRows));
        assert.ok(result.warnings.includes('SCOPE_CONFIRMATION_EVIDENCE_CONFLICT'));
    }
});

test('아파트 전체 root bylot·부속지 원문 불완전이나 다른 동의 다른 범위는 추정 병합하지 않는다', async () => {
    const otherPk = '9008007006005';
    const proofs = [
        apartmentProof({ attached: incomplete('getBrAtchJibunInfo') }),
        apartmentProof({ title: incomplete('getBrTitleInfo') }),
        apartmentProof({ attached: complete([attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU)]) }),
        apartmentProof({ attached: complete([
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU),
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU),
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU, otherPk),
        ]) }),
        apartmentProof({ title: complete([
            apartmentTitle('101동', ROOT_PK, '2'), apartmentTitle('102동', otherPk),
        ]) }),
        apartmentProof({ title: complete([
            apartmentTitle(), apartmentTitle('102동', otherPk, '0'),
        ]) }),
        apartmentProof({ title: complete([
            apartmentTitle(), apartmentTitle('102동', otherPk, '2'),
        ]) }),
        apartmentProof({ attached: complete([
            attachedRow(ATTACHED_PNU, ATTACHED_PNU),
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU, otherPk),
        ]) }),
        apartmentProof({ attached: complete([
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU),
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU, otherPk),
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU, '9008007006999'),
        ]) }),
        apartmentProof({ attached: complete([
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU),
            attachedRow(ATTACHED_PNU, SIBLING_PNU, otherPk),
        ]) }),
        apartmentProof({ attached: complete([
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU),
            attachedRow(SIBLING_PNU, OFFICIAL_ATTACHED_PNU, otherPk),
        ]) }),
        apartmentProof({ title: complete([
            apartmentTitle(),
            { ...apartmentTitle('102동', otherPk), bylotCnt: undefined },
        ]), basis: incomplete('getBrBasisOulnInfo') }),
        apartmentProof({ title: complete([
            apartmentTitle(),
            { ...apartmentTitle('102동', otherPk), bylotCnt: undefined },
        ]), basis: completeZero() }),
    ];
    for (const proof of proofs) {
        const result = await lookupApartment(proof);
        assert.equal(result.scopeResolution, undefined);
    }
});

test('아파트는 단일 공식 동과 bylot0도 지원하되 단일 표제부의 다른 동을 자동 선택하지 않는다', async () => {
    for (const pair of [
        apartmentTitle('101동', ROOT_PK, '0'),
        { ...apartmentTitle('101동', ROOT_PK, '0'), mainPurpsCd: '02001', mainPurpsCdNm: '아파트' },
    ]) {
        const result = await lookupApartment(apartmentProof({
            title: complete([pair]), attached: completeZero(),
        }));
        assert.equal(result.scopeResolution?.strategy, 'LDAREG');
        assert.equal(result.scopeResolution?.scopePnuCount, 1);
    }
    const mismatch = await lookupApartment(apartmentProof({
        title: complete([apartmentTitle('102동', ROOT_PK, '0')]),
        attached: completeZero(),
    }));
    assert.equal(mismatch.scopeResolution, undefined);
});

test('아파트 scope digest는 제외 동의 식별과 전체 source 근거를 보존하고 순서만 바뀌면 같다', async () => {
    const otherPk = '9008007006005';
    const original = await lookupApartment();
    const reordered = await lookupApartment(apartmentProof({
        title: complete([apartmentTitle('00101동'), apartmentTitle('102동', otherPk)]),
        attached: complete([
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU),
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU, otherPk),
        ]),
    }));
    const renamedSibling = await lookupApartment(apartmentProof({
        title: complete([apartmentTitle('00101동'), apartmentTitle('103동', otherPk)]),
    }));
    assert.match(original.scopeResolution?.evidenceDigest ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.equal(original.scopeResolution?.evidenceDigest, reordered.scopeResolution?.evidenceDigest);
    assert.notEqual(original.scopeResolution?.evidenceDigest, renamedSibling.scopeResolution?.evidenceDigest);
});

test('다동 아파트는 대상 이외 동에 공식 부속지가 없는 경우에도 전체 bylot0 검증을 유지한다', async () => {
    const otherPk = '9008007006005';
    const result = await lookupApartment(apartmentProof({
        title: complete([apartmentTitle(), apartmentTitle('102동', otherPk, '0')]),
        attached: complete([attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU)]),
    }));
    assert.equal(result.scopeResolution?.scopePnuCount, 2);
});

test('다동 아파트 27개 동과 관리동의 공통 부속지를 임의 root 탈락 없이 검증한다', async () => {
    const rows = Array.from({ length: 27 }, (_, index) =>
        apartmentTitle(String(index + 101), index === 0 ? ROOT_PK : String(9008007006000 + index))
    );
    rows.push({
        ...titleRow('0', DETACHED, '9008007006100'),
        dongNm: '관리사무소', mainAtchGbCd: '1',
    });
    const result = await lookupApartment(apartmentProof({
        title: complete(rows),
        attached: complete(rows.slice(0, 27).map((row) =>
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU, String(row.mgmBldrgstPk))
        )),
    }));
    assert.equal(result.scopeResolution?.strategy, 'LDAREG');
    assert.equal(result.scopeResolution?.buildingRootCount, 1);
    assert.equal(result.scopeResolution?.scopePnuCount, 2);
});

test('group relation 조회는 (기준 PNU, 관리번호) exact pair를 교차곱 limit과 분리한다', async () => {
    const exactA = {
        union_id: UNION_ID,
        base_pnu: BASE_PNU,
        attached_pnu: ATTACHED_PNU,
        mgm_bldrgst_pk: 'root-a',
        projection_status: 'LINKED',
        is_active: true,
    };
    const exactB = {
        ...exactA,
        base_pnu: SIBLING_PNU,
        attached_pnu: '1168010100107360027',
        mgm_bldrgst_pk: 'root-b',
    };
    const crossProductRows = Array.from({ length: 101 }, (_, index) => ({
        ...exactA,
        attached_pnu: `116801010010737${String(index).padStart(4, '0')}`,
        mgm_bldrgst_pk: 'root-b',
    }));
    const client = relationQueryClient([
        ...crossProductRows,
        exactA,
        exactB,
    ]);
    const lookupRepository = createSupabaseLandRightLookupRepository(
        client as Parameters<typeof createSupabaseLandRightLookupRepository>[0]
    );

    const result = await lookupRepository.findGroupRelations(UNION_ID, [
        { basePnu: BASE_PNU, managementPk: 'root-a' },
        { basePnu: SIBLING_PNU, managementPk: 'root-b' },
    ]);

    assert.deepEqual(result, [exactA, exactB]);
});

test('attached 시작 PNU에서 같은 관리번호의 기준·형제 부속까지만 조회한다', async () => {
    const direct = {
        union_id: UNION_ID,
        base_pnu: BASE_PNU,
        attached_pnu: ATTACHED_PNU,
        mgm_bldrgst_pk: 'root-a',
        projection_status: 'LINKED',
        is_active: true,
    };
    const sibling = {
        ...direct,
        attached_pnu: SIBLING_PNU,
    };
    const unrelated = {
        ...direct,
        base_pnu: '1168010100107360090',
        attached_pnu: '1168010100107360091',
        mgm_bldrgst_pk: 'root-b',
    };
    const official = ned(success);
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findDirectRelations: async () => [direct],
                findGroupRelations: async () => [direct, sibling, unrelated],
            }),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(
        result.parcels.map(({ pnu, role, scopeGroup }) => ({
            pnu,
            role,
            scopeGroup,
        })),
        [
            { pnu: BASE_PNU, role: 'BASE', scopeGroup: 'group-1' },
            {
                pnu: ATTACHED_PNU,
                role: 'ATTACHED',
                scopeGroup: 'group-1',
            },
            {
                pnu: SIBLING_PNU,
                role: 'ATTACHED',
                scopeGroup: 'group-1',
            },
        ]
    );
    assert.equal(official.calls.length, 6);
    assert.equal(result.sources.ldareg.scans.length, 3);
    assert.ok(result.ldareg.every((row) => !('ownerName' in row)));
    assert.ok(result.ladfrl.every((row) => !('ownerName' in row)));
    assert.doesNotMatch(JSON.stringify(result), /server-only/);
});

test('서로 다른 관리번호 group은 합치지 않고 INCOMPLETE로 표시한다', async () => {
    const relationA = {
        union_id: UNION_ID,
        base_pnu: BASE_PNU,
        attached_pnu: ATTACHED_PNU,
        mgm_bldrgst_pk: 'root-a',
        projection_status: 'LINKED',
        is_active: true,
    };
    const relationB = {
        ...relationA,
        base_pnu: SIBLING_PNU,
        mgm_bldrgst_pk: 'root-b',
    };
    const official = ned(success);
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findDirectRelations: async () => [relationA, relationB],
                findGroupRelations: async () => [relationA, relationB],
            }),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_INCOMPLETE');
    assert.ok(result.warnings.includes('MULTIPLE_MANAGEMENT_ROOTS'));
    assert.deepEqual(
        [...new Set(result.parcels.map((parcel) => parcel.scopeGroup))],
        ['group-1', 'group-2']
    );
});

test('active 기준·부속 relation이 0건이면 공식자료가 있어도 Codex-safe INCOMPLETE다', async () => {
    const official = ned(success);
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_INCOMPLETE');
    assert.ok(result.warnings.includes('NO_ACTIVE_BASE_ATTACHED_RELATION'));
    assert.equal(result.ldareg.length, 1);
    assert.equal(result.ladfrl.length, 1);
});

test('relation 0 + strict target-only 근거는 자동 SUCCESS가 아니라 exact scope 확인 후보만 반환한다', async () => {
    const official = ned(success);
    const proof = scopeConfirmation();
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            scopeConfirmation: proof,
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_INCOMPLETE');
    assert.deepEqual(result.scopeResolution, {
        state: 'SCOPE_CONFIRMATION_REQUIRED',
        strategy: 'LADFRL',
        evidenceDigest: result.scopeResolution?.evidenceDigest,
        dbState: 'NO_EVIDENCE',
        reverseLookup: 'UNPROVEN',
        basePnuCount: 1,
        scopePnuCount: 1,
        propertyUnitCount: 1,
        buildingRootCount: 1,
    });
    assert.match(
        result.scopeResolution?.evidenceDigest ?? '',
        /^sha256:[a-f0-9]{64}$/
    );
    assert.deepEqual(result.warnings, [
        'NO_ACTIVE_BASE_ATTACHED_RELATION',
        'SCOPE_REVERSE_LOOKUP_UNPROVEN',
    ]);
    assert.deepEqual(result.parcels, [
        {
            pnu: ATTACHED_PNU,
            role: 'BASE',
            address: `주소-${ATTACHED_PNU.slice(-4)}`,
            scopeGroup: 'official-group-1',
        },
    ]);
    assert.ok(result.warnings.includes('NO_ACTIVE_BASE_ATTACHED_RELATION'));
    assert.ok(result.warnings.includes('SCOPE_REVERSE_LOOKUP_UNPROVEN'));
    assert.deepEqual(proof.calls, [
        `title:${ATTACHED_PNU}`,
        `resolver:${ATTACHED_PNU}`,
        `attached:${ATTACHED_PNU}`,
        `resolver:${ATTACHED_PNU}`,
    ]);
    assert.equal(
        proof.calls.some((call) => call.startsWith('basis:')),
        false,
        'TITLE_ONLY 정책은 basis를 조용히 호출하지 않는다'
    );
    assert.equal(official.calls.length, 2);
    assert.doesNotMatch(JSON.stringify(result.scopeResolution), new RegExp(ROOT_PK));
});

test('relation 0 title row의 요청 PNU 귀속이 없거나 다르면 scope 확인 후보를 발급하지 않는다', async () => {
    const missingIdentity = titleRow('0');
    delete missingIdentity.sigunguCd;
    delete missingIdentity.bjdongCd;
    delete missingIdentity.platGbCd;
    delete missingIdentity.bun;
    delete missingIdentity.ji;

    for (const title of [
        complete([missingIdentity]),
        complete([titleRow('0', DETACHED, ROOT_PK, BASE_PNU)]),
    ]) {
        const result = await lookupLandRightTransient(
            { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
            {
                repository: repository(),
                ned: ned(success).value,
                auth: { key: 'server-only', domain: 'admin.example.com' },
                scopeConfirmation: scopeConfirmation({ title }),
            }
        );

        assert.equal(result.scopeResolution, undefined);
        assert.ok(result.warnings.includes('SCOPE_CONFIRMATION_EVIDENCE_CONFLICT'));
    }
});

test('relation 0 + strict attached component는 모든 PNU 공식자료를 조회하되 확인 전 INCOMPLETE다', async () => {
    const official = ned(success);
    const proof = scopeConfirmation({
        title: complete([titleRow('1', MULTIPLEX)]),
        attached: complete([
            attachedRow(ATTACHED_PNU, OFFICIAL_ATTACHED_PNU),
        ]),
    });
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            scopeConfirmation: proof,
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.scopeResolution?.state, 'SCOPE_CONFIRMATION_REQUIRED');
    assert.equal(result.scopeResolution?.strategy, 'LDAREG');
    assert.equal(result.scopeResolution?.scopePnuCount, 2);
    assert.equal(result.scopeResolution?.basePnuCount, 1);
    assert.equal(official.calls.length, 4);
    assert.deepEqual(
        [...new Set(official.calls.map((call) => call.pnu))].sort(),
        [ATTACHED_PNU, OFFICIAL_ATTACHED_PNU].sort()
    );
    assert.deepEqual(
        result.parcels.map(({ pnu, role, scopeGroup }) => ({
            pnu,
            role,
            scopeGroup,
        })),
        [
            {
                pnu: ATTACHED_PNU,
                role: 'BASE',
                scopeGroup: 'official-group-1',
            },
            {
                pnu: OFFICIAL_ATTACHED_PNU,
                role: 'ATTACHED',
                scopeGroup: 'official-group-1',
            },
        ]
    );
    assert.doesNotMatch(JSON.stringify(result.scopeResolution), new RegExp(ROOT_PK));
});

test('LDAREG official component는 resolver와 fresh SELECT가 일치하는 복수 active property membership을 digest에 묶는다', async () => {
    const secondPropertyId = '33333333-3333-4333-8333-333333333333';
    let secondLandArea: string | null = null;
    const resolverMembership = [
        {
            propertyUnitId: PROPERTY_ID,
            pnu: ATTACHED_PNU,
            buildingUnitId: null,
        },
        {
            propertyUnitId: secondPropertyId,
            pnu: ATTACHED_PNU,
            buildingUnitId: null,
        },
    ];
    const lookupRepository = repository({
                findPropertyMembership: async () => [
                    {
                        id: PROPERTY_ID,
                        union_id: UNION_ID,
                        building_unit_id: null,
                        pnu: ATTACHED_PNU,
                        is_deleted: false,
                        dong: baseProperty.dong,
                        ho: baseProperty.ho,
                        land_area: null,
                        land_area_source: null,
                    },
                    {
                        id: secondPropertyId,
                        union_id: UNION_ID,
                        building_unit_id: null,
                        pnu: ATTACHED_PNU,
                        is_deleted: false,
                        dong: null,
                        ho: '202호',
                        land_area: secondLandArea,
                        land_area_source:
                            secondLandArea === null ? null : 'MANUAL',
                    },
                ],
            });
    const proof = scopeConfirmation({
        title: complete([titleRow('1', MULTIPLEX)]),
        attached: complete([
            attachedRow(
                ATTACHED_PNU,
                OFFICIAL_ATTACHED_PNU
            ),
        ]),
        resolver: (anchorPnu) =>
            scopeResolverData({
                componentPnus: [anchorPnu],
                propertyMembership:
                    anchorPnu === ATTACHED_PNU
                        ? resolverMembership
                        : [],
            }),
    });
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: lookupRepository,
            ned: ned(success).value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            scopeConfirmation: proof,
        }
    );

    assert.equal(result.scopeResolution?.strategy, 'LDAREG');
    assert.equal(result.scopeResolution?.scopePnuCount, 2);
    assert.equal(result.scopeResolution?.propertyUnitCount, 2);
    assert.doesNotMatch(
        JSON.stringify(result.scopeResolution),
        new RegExp(secondPropertyId)
    );

    secondLandArea = '42.0000';
    const afterSiblingWrite = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: lookupRepository,
            ned: ned(success).value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            scopeConfirmation: proof,
        }
    );
    assert.equal(
        afterSiblingWrite.scopeResolution?.evidenceDigest,
        result.scopeResolution?.evidenceDigest,
        '다른 scope member의 MANUAL write는 공식 scope digest를 바꾸지 않는다'
    );
});

test('scope 근거가 닫혀도 NED source가 FAILED면 confirmation projection을 제거한다', async () => {
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: ned((source, pnu) =>
                source === 'ldareg'
                    ? { status: 'FAILED', records: [], code: 'TIMEOUT' }
                    : success(source, pnu)
            ).value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            scopeConfirmation: scopeConfirmation(),
        }
    );

    assert.equal(result.status, 'FAILED');
    assert.equal(result.scopeResolution, undefined);
    assert.ok(
        result.warnings.includes(
            'SCOPE_CONFIRMATION_EVIDENCE_UNAVAILABLE'
        )
    );
    assert.equal(
        result.warnings.includes('SCOPE_REVERSE_LOOKUP_UNPROVEN'),
        false
    );
});

test('confirmation strategy source가 NO_DATA면 projection을 제거하고 HOLD한다', async () => {
    const official = ned((source, pnu) =>
        source === 'ladfrl'
            ? { status: 'NO_DATA', records: [] }
            : success(source, pnu)
    );
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            scopeConfirmation: scopeConfirmation(),
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_INCOMPLETE');
    assert.equal(result.sources.ladfrl.status, 'NO_DATA');
    assert.equal(result.scopeResolution, undefined);
    assert.ok(
        result.warnings.includes(
            'SCOPE_CONFIRMATION_EVIDENCE_UNAVAILABLE'
        )
    );
    assert.equal(
        result.warnings.includes('SCOPE_REVERSE_LOOKUP_UNPROVEN'),
        false
    );
});

test('pending/blocking/open·복수 root·invalid membership·strict scan 불완전은 scope 확인 후보를 만들지 않는다', async () => {
    const cases: Array<{
        name: string;
        proof: LandRightLookupScopeConfirmationDeps;
        lookupRepository?: LandRightLookupRepository;
    }> = [
        {
            name: 'pending',
            proof: scopeConfirmation({
                resolver: scopeResolverData({
                    dbState: 'PENDING',
                    pendingEvidenceKeys: ['API_RELATION:pending'],
                }),
            }),
        },
        {
            name: 'malformed raw resolver array',
            proof: scopeConfirmation({
                resolver: scopeResolverData({
                    pendingEvidenceKeys: [123],
                }),
            }),
        },
        {
            name: 'blocking/open',
            proof: scopeConfirmation({
                resolver: scopeResolverData({
                    dbState: 'BLOCKING_EVIDENCE',
                    blockingEvidence: [
                        {
                            sourceKind: 'API_RELATION',
                            sourceId: 'opaque',
                            state: 'CONFLICT',
                        },
                    ],
                    openUnresolvedEvidenceKeys: ['API_RELATION:open'],
                }),
            }),
        },
        {
            name: 'multiple roots',
            proof: scopeConfirmation({
                title: complete([
                    titleRow('0'),
                    titleRow('0', DETACHED, '9008007006005'),
                ]),
            }),
        },
        {
            name: 'target membership missing',
            proof: scopeConfirmation({
                resolver: scopeResolverData({
                    propertyMembership: [
                        {
                            propertyUnitId:
                                '33333333-3333-4333-8333-333333333333',
                            pnu: ATTACHED_PNU,
                            buildingUnitId: null,
                        },
                    ],
                }),
            }),
        },
        {
            name: 'attached incomplete',
            proof: scopeConfirmation({
                attached: incomplete('getBrAtchJibunInfo'),
            }),
        },
        {
            name: 'target tuple drift',
            proof: scopeConfirmation(),
            lookupRepository: repository({
                findPropertyMembership: async () => [
                    {
                        id: PROPERTY_ID,
                        union_id: UNION_ID,
                        building_unit_id: null,
                        pnu: ATTACHED_PNU,
                        is_deleted: false,
                        dong: '변경동',
                        ho: baseProperty.ho,
                        land_area: null,
                        land_area_source: null,
                    },
                ],
            }),
        },
        {
            name: 'LADFRL multiple active properties',
            proof: scopeConfirmation({
                resolver: scopeResolverData({
                    propertyMembership: [
                        {
                            propertyUnitId: PROPERTY_ID,
                            pnu: ATTACHED_PNU,
                            buildingUnitId: null,
                        },
                        {
                            propertyUnitId:
                                '33333333-3333-4333-8333-333333333333',
                            pnu: ATTACHED_PNU,
                            buildingUnitId: null,
                        },
                    ],
                }),
            }),
            lookupRepository: repository({
                findPropertyMembership: async () => [
                    {
                        id: PROPERTY_ID,
                        union_id: UNION_ID,
                        building_unit_id: null,
                        pnu: ATTACHED_PNU,
                        is_deleted: false,
                        dong: baseProperty.dong,
                        ho: baseProperty.ho,
                        land_area: null,
                        land_area_source: null,
                    },
                    {
                        id: '33333333-3333-4333-8333-333333333333',
                        union_id: UNION_ID,
                        building_unit_id: null,
                        pnu: ATTACHED_PNU,
                        is_deleted: false,
                        dong: null,
                        ho: null,
                        land_area: null,
                        land_area_source: null,
                    },
                ],
            }),
        },
        {
            name: 'target PNU drift inside official component',
            proof: scopeConfirmation({
                title: complete([titleRow('1', MULTIPLEX)]),
                attached: complete([
                    attachedRow(
                        ATTACHED_PNU,
                        OFFICIAL_ATTACHED_PNU
                    ),
                ]),
                resolver: (anchorPnu) =>
                    scopeResolverData({
                        componentPnus: [anchorPnu],
                        propertyMembership:
                            anchorPnu === OFFICIAL_ATTACHED_PNU
                                ? [
                                      {
                                          propertyUnitId: PROPERTY_ID,
                                          pnu: OFFICIAL_ATTACHED_PNU,
                                          buildingUnitId: null,
                                      },
                                  ]
                                : [],
                    }),
            }),
            lookupRepository: repository({
                findPropertyMembership: async () => [
                    {
                        id: PROPERTY_ID,
                        union_id: UNION_ID,
                        building_unit_id: null,
                        pnu: OFFICIAL_ATTACHED_PNU,
                        is_deleted: false,
                        dong: baseProperty.dong,
                        ho: baseProperty.ho,
                        land_area: null,
                        land_area_source: null,
                    },
                ],
            }),
        },
    ];

    for (const item of cases) {
        const result = await lookupLandRightTransient(
            { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
            {
                repository: item.lookupRepository ?? repository(),
                ned: ned(success).value,
                auth: { key: 'server-only', domain: 'admin.example.com' },
                scopeConfirmation: item.proof,
            }
        );
        assert.equal(result.status, 'INCOMPLETE', item.name);
        assert.equal(result.scopeResolution, undefined, item.name);
    }
});

test('공식 attached component가 20 PNU 상한을 넘으면 NED 호출 없이 INCOMPLETE로 닫는다', async () => {
    const attachedPnus = Array.from({ length: MAX_LAND_RIGHT_SCOPE_PNUS }, (_, index) =>
        `116801010010737${String(index + 1).padStart(4, '0')}`
    );
    const proof = scopeConfirmation({
        title: complete([
            titleRow(String(attachedPnus.length), MULTIPLEX),
        ]),
        attached: complete(
            attachedPnus.map((pnu) => attachedRow(ATTACHED_PNU, pnu))
        ),
    });
    const official = ned(success);
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            scopeConfirmation: proof,
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_LIMIT_EXCEEDED');
    assert.equal(result.scopeResolution, undefined);
    assert.equal(official.calls.length, 0);
});

test('기존 LINKED relation SUCCESS 경로는 scope confirmation RPC/HUB를 호출하지 않는다', async () => {
    const relation = {
        union_id: UNION_ID,
        base_pnu: BASE_PNU,
        attached_pnu: ATTACHED_PNU,
        mgm_bldrgst_pk: 'root-a',
        projection_status: 'LINKED',
        is_active: true,
    };
    const proof = scopeConfirmation();
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findDirectRelations: async () => [relation],
                findGroupRelations: async () => [relation],
            }),
            ned: ned(success).value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            scopeConfirmation: proof,
        }
    );

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.scopeResolution, undefined);
    assert.deepEqual(proof.calls, []);
});

test('request-level cap이 발생하면 앞선 성공 rows도 반환하지 않는다', async () => {
    const capped: LandRightLookupNed = {
        async fetchLdareg(pnu) {
            return success('ldareg', pnu);
        },
        async fetchLadfrl(_pnu, _auth, options) {
            options?.budget?.terminate(
                'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED'
            );
            return {
                status: 'INCOMPLETE',
                records: [],
                code: 'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED',
            };
        },
    };
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: capped,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED');
    assert.deepEqual(result.ldareg, []);
    assert.deepEqual(result.ladfrl, []);
    assert.deepEqual(result.sources.ldareg.scans, []);
});

test('overall deadline은 대기 중 repository 단계도 즉시 INCOMPLETE로 중단한다', async () => {
    const controller = new AbortController();
    const never = new Promise<null>(() => undefined);
    const lookup = lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findPropertyUnit: async () => never,
            }),
            ned: ned(success).value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
            signal: controller.signal,
        }
    );
    controller.abort('LOOKUP_DEADLINE_EXCEEDED');

    const result = await lookup;
    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'LOOKUP_DEADLINE_EXCEEDED');
    assert.equal(result.propertyUnit.id, PROPERTY_ID);
    assert.deepEqual(result.ldareg, []);
});

test('20 PNU를 넘는 relation scope는 provider 호출 없이 INCOMPLETE로 닫는다', async () => {
    const relations = Array.from(
        { length: MAX_LAND_RIGHT_SCOPE_PNUS },
        (_, index) => ({
            union_id: UNION_ID,
            base_pnu: BASE_PNU,
            attached_pnu: `116801010010736${String(index + 25).padStart(4, '0')}`,
            mgm_bldrgst_pk: 'root-large',
            projection_status: 'LINKED',
            is_active: true,
        })
    );
    const official = ned(success);
    let landLotReads = 0;
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findDirectRelations: async () => [relations[0]],
                findGroupRelations: async () => relations,
                findLandLots: async () => {
                    landLotReads += 1;
                    return [];
                },
            }),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.code, 'PROPERTY_SCOPE_LIMIT_EXCEEDED');
    assert.equal(result.sources.ldareg.scans.length, 0);
    assert.equal(landLotReads, 0);
    assert.equal(official.calls.length, 0);
});

test('relation 조회 실패는 단일 PNU provider 조회로 fallback하지 않는다', async () => {
    const official = ned(success);
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository({
                findDirectRelations: async () => {
                    throw new Error('db unavailable');
                },
            }),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'PROPERTY_SCOPE_LOOKUP_FAILED');
    assert.equal(result.sources.ldareg.scans.length, 0);
    assert.equal(official.calls.length, 0);
});

test('NULL/invalid PNU는 4xx 대신 provider 미호출 terminal FAILED다', async () => {
    for (const [pnu, code] of [
        [null, 'PROPERTY_PNU_MISSING'],
        ['invalid-pnu', 'PROPERTY_PNU_INVALID'],
    ] as const) {
        const official = ned(success);
        const result = await lookupLandRightTransient(
            { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
            {
                repository: repository({
                    findPropertyUnit: async () => ({ ...baseProperty, pnu }),
                }),
                ned: official.value,
                auth: { key: 'server-only', domain: 'admin.example.com' },
            }
        );
        assert.equal(result.status, 'FAILED');
        assert.equal(result.code, code);
        assert.equal(result.propertyUnit.pnu, pnu);
        assert.equal(official.calls.length, 0);
    }
});

test('provider 한 축이 실패하면 FAILED지만 성공한 공식자료는 안전 투영해 보여준다', async () => {
    const official = ned((source, pnu) =>
        source === 'ldareg'
            ? { status: 'FAILED', records: [], code: 'TIMEOUT' }
            : success(source, pnu)
    );
    const result = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: repository(),
            ned: official.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );

    assert.equal(result.status, 'FAILED');
    assert.equal(result.sources.ldareg.status, 'FAILED');
    assert.equal(result.sources.ladfrl.status, 'SUCCESS');
    assert.equal(result.ldareg.length, 0);
    assert.equal(result.ladfrl.length, 1);
    assert.ok(result.warnings.includes('LDAREG_FAILED'));
});

test('정상 source가 하나라도 있으면 SUCCESS이고 둘 다 빈 경우만 NO_DATA다', async () => {
    const linkedRelation = {
        union_id: UNION_ID,
        base_pnu: BASE_PNU,
        attached_pnu: ATTACHED_PNU,
        mgm_bldrgst_pk: 'root-a',
        projection_status: 'LINKED',
        is_active: true,
    };
    const linkedRepository = repository({
        findDirectRelations: async () => [linkedRelation],
        findGroupRelations: async () => [linkedRelation],
    });
    const noData: NedFetchResult = { status: 'NO_DATA', records: [] };
    const partial = ned((source, pnu) =>
        source === 'ldareg' ? noData : success(source, pnu)
    );
    const partialResult = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: linkedRepository,
            ned: partial.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );
    assert.equal(partialResult.status, 'SUCCESS');
    assert.equal(partialResult.sources.ldareg.status, 'NO_DATA');
    assert.equal(partialResult.sources.ladfrl.status, 'SUCCESS');

    const empty = ned(() => noData);
    const emptyResult = await lookupLandRightTransient(
        { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
        {
            repository: linkedRepository,
            ned: empty.value,
            auth: { key: 'server-only', domain: 'admin.example.com' },
        }
    );
    assert.equal(emptyResult.status, 'NO_DATA');
    assert.equal(emptyResult.ldareg.length, 0);
    assert.equal(emptyResult.ladfrl.length, 0);
});

test('cross-union/삭제 물건지와 기존 양수값은 provider 호출 전에 거부한다', async () => {
    const official = ned(success);
    await assert.rejects(
        () =>
            lookupLandRightTransient(
                { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
                {
                    repository: repository({
                        findPropertyUnit: async () => ({
                            ...baseProperty,
                            union_id:
                                '33333333-3333-4333-8333-333333333333',
                        }),
                    }),
                    ned: official.value,
                    auth: { key: 'server-only', domain: 'admin.example.com' },
                }
            ),
        (error: unknown) =>
            error instanceof LandRightLookupError && error.status === 404
    );

    await assert.rejects(
        () =>
            lookupLandRightTransient(
                { unionId: UNION_ID, propertyUnitId: PROPERTY_ID },
                {
                    repository: repository({
                        findPropertyUnit: async () => ({
                            ...baseProperty,
                            land_area: '10.0000',
                        }),
                    }),
                    ned: official.value,
                    auth: { key: 'server-only', domain: 'admin.example.com' },
                }
            ),
        (error: unknown) =>
            error instanceof LandRightLookupError && error.status === 409
    );
    assert.equal(official.calls.length, 0);
});

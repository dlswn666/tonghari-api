import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
    DEVELOPMENT_TARGET_MANIFEST_VERSION,
    DEVELOPMENT_TARGET_MANIFEST_VERSION_V2,
    DEVELOPMENT_TARGET_MANIFEST_VERSION_V3,
    computeDevelopmentActivePnuDigest,
    computeDevelopmentTargetDigest,
    computeDevelopmentTargetV2ManifestDigest,
    computeDevelopmentTargetV3ManifestDigest,
    developmentTargetScopeDigest,
    parseDevelopmentEvidenceManifest,
    parseDevelopmentTargetManifest,
    validateDevelopmentRunnerManifests,
    type DevelopmentTargetManifest,
} from '../src/operations/development-land-area-sync-runner';
import {
    CAPTURE_MAX_ATTEMPTS,
    CAPTURE_RETRY_DELAY_MS,
    RETRY_ELIGIBLE_MAX_RATIO,
    aggregateDevelopmentEvidenceCaptureIssueCodes,
    aggregateDevelopmentEvidenceCaptureEntries,
    assertDevelopmentEvidenceCaptureActiveIdentity,
    captureDevelopmentLandAreaEvidence,
    developmentEvidenceEntryFromSnapshot,
    hasStableDevelopmentActivePropertyIdentity,
    isDevelopmentEvidenceCapturePromotionEligible,
    isDevelopmentEvidenceCaptureRetryable,
} from '../src/operations/development-land-area-evidence-capture';
import type { DevelopmentEvidenceCaptureAuditEntry } from '../src/operations/development-land-area-evidence-capture';
import type { LandAreaSyncScopeSnapshot } from '../src/types/land-area-sync-job.types';

const UNION_ID = '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
const PNU = '1130510100107912166';
const ATTACHED_PNU = '1130510100107912167';
const THIRD_PNU = '1130510100107912168';
const PROPERTY_UNIT_ID =
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc949c';
const MIA_791_2280_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-791-2280-ldareg-api-readonly-target-20260725.json',
    import.meta.url
);
const MIA_AUTO_286_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-auto-286-target-20260725.json',
    import.meta.url
);
const MIA_FULL_299_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-full-299-api-readonly-target-20260728.json',
    import.meta.url
);
const MIA_FULL_278_OFFICIAL_COMPONENT_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-full-278-official-components-api-readonly-target-20260729.json',
    import.meta.url
);
const MIA_FULL_299_DELTA = [
    '1130510100107450049',
    '1130510100107450052',
    '1130510100107450076',
    '1130510100107912211',
    '1130510100107912212',
    '1130510100107912213',
    '1130510100107912267',
    '1130510100107912280',
    '1130510100107912320',
    '1130510100107912343',
    '1130510100107912344',
    '1130510100107912474',
    '1130510100107913568',
] as const;

function target(pnus = [PNU]): DevelopmentTargetManifest {
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        pnus,
        targetCount: pnus.length,
        manifestDigest: computeDevelopmentTargetDigest(
            'development',
            UNION_ID,
            pnus
        ),
        expectedPropertyUnitCount: 1,
        expectedUnionActivePropertyUnitCount: 429,
        expectedUnionActivePnuCount: 299,
    };
}

function snapshot(
    currentSource = 'LEGACY_UNKNOWN',
    currentLandArea = ''
): LandAreaSyncScopeSnapshot {
    return {
        frozenAt: '2026-07-25T00:00:00.000Z',
        strategy: 'LADFRL',
        scannedPnus: [PNU],
        resolverRootPks: ['1010111038'],
        bylotSourcePolicy: 'TITLE_ONLY',
        bylotEvidence: [],
        dbScopeHash: '1'.repeat(64),
        externalScopeDigest: '2'.repeat(64),
        scopeHash: '3'.repeat(64),
        candidatePropertyUnitIds: [PROPERTY_UNIT_ID],
        propertyMembershipHash: '4'.repeat(64),
        currentLandTuples: [
            {
                propertyUnitId: PROPERTY_UNIT_ID,
                landArea: currentLandArea,
                source: currentSource,
            },
        ],
        // jsonb key 순서를 모사해 landArea를 먼저 둔다.
        proposedLandAreas: [
            {
                landArea: '161',
                propertyUnitId: PROPERTY_UNIT_ID,
            },
        ],
        ladfrlAreaEvidence: {
            version: 'land-area-sync.ladfrl-scope.v1',
            parcels: [{ pnu: PNU, area: '161' }],
            totalArea: '161',
        },
        replicationEvidence: null,
        projectionInputDigest: '5'.repeat(64),
        canonicalVersion: 2,
    };
}

function targetV2(): DevelopmentTargetManifest {
    const allowedScopePnus = [PNU, ATTACHED_PNU];
    const identity = {
        databaseTarget: 'development' as const,
        unionId: UNION_ID,
        anchors: [PNU],
        allowedScopePnus,
        targetCount: 1,
        expectedPropertyUnitCount: 1,
        expectedUnionActivePropertyUnitCount: 1,
        expectedUnionActivePnuCount: 1,
        allowManualOverwrite: true as const,
    };
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION_V2,
        databaseTarget: 'development',
        ...identity,
        scopeDigest: computeDevelopmentTargetDigest(
            identity.databaseTarget,
            identity.unionId,
            identity.allowedScopePnus
        ),
        manifestDigest:
            computeDevelopmentTargetV2ManifestDigest(identity),
    };
}

function threePnuComponentTargetV3(): DevelopmentTargetManifest {
    const allowedScopePnus = [PNU, ATTACHED_PNU, THIRD_PNU];
    const expectedUnionActivePnus = [PNU];
    const identity = {
        databaseTarget: 'development' as const,
        unionId: UNION_ID,
        anchors: [PNU],
        allowedScopePnus,
        expectedUnionActivePnus,
        expectedUnionActivePnuDigest:
            computeDevelopmentActivePnuDigest(
                'development',
                UNION_ID,
                expectedUnionActivePnus
            ),
        targetCount: 1,
        expectedPropertyUnitCount: 1,
        expectedUnionActivePropertyUnitCount: 1,
        expectedUnionActivePnuCount: 1,
        allowManualOverwrite: true as const,
    };
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION_V3,
        databaseTarget: 'development',
        ...identity,
        scopeDigest: computeDevelopmentTargetDigest(
            identity.databaseTarget,
            identity.unionId,
            identity.allowedScopePnus
        ),
        manifestDigest:
            computeDevelopmentTargetV3ManifestDigest(identity),
    };
}

test('791-2280 API read-only target은 anchor 1건과 대표·부속지번 allowlist 2건을 고정한다', () => {
    const manifest = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_791_2280_TARGET_URL, 'utf8'))
    );
    assert.equal(
        manifest.version,
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    );
    if (
        manifest.version !==
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    ) {
        throw new Error('v2 target expected');
    }
    assert.deepEqual(manifest.anchors, ['1130510100107912280']);
    assert.deepEqual(manifest.allowedScopePnus, [
        '1130510100107912280',
        '1130510100107912281',
    ]);
    assert.equal(manifest.targetCount, 1);
    assert.equal(manifest.expectedPropertyUnitCount, 4);
    assert.equal(manifest.allowManualOverwrite, true);
    assert.equal(
        manifest.scopeDigest,
        computeDevelopmentTargetDigest(
            'development',
            UNION_ID,
            manifest.allowedScopePnus
        )
    );
    assert.equal(
        manifest.manifestDigest,
        computeDevelopmentTargetV2ManifestDigest(manifest)
    );
    assert.notEqual(
        manifest.manifestDigest,
        developmentTargetScopeDigest(manifest)
    );
});

test('미아7 전체 API 재조회 target은 활성 anchor 299건과 property unit 429건을 고정한다', () => {
    const auto286 = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_AUTO_286_TARGET_URL, 'utf8'))
    );
    const full299 = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_FULL_299_TARGET_URL, 'utf8'))
    );
    assert.equal(
        full299.version,
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    );
    if (
        auto286.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION ||
        full299.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V2
    ) {
        throw new Error('v1 auto286 and v2 full299 expected');
    }

    assert.equal(full299.anchors.length, 299);
    assert.equal(full299.targetCount, 299);
    assert.equal(full299.allowedScopePnus.length, 300);
    assert.equal(full299.expectedPropertyUnitCount, 429);
    assert.equal(full299.expectedUnionActivePropertyUnitCount, 429);
    assert.equal(full299.expectedUnionActivePnuCount, 299);
    assert.equal(full299.allowManualOverwrite, true);
    assert.equal(
        computeDevelopmentTargetDigest('development', UNION_ID, full299.anchors),
        '638977eb11e2e09afdb949179fe59e7944c2ed4c973fe2695bf0628239a2e219'
    );
    assert.equal(
        full299.scopeDigest,
        computeDevelopmentTargetDigest(
            'development',
            UNION_ID,
            full299.allowedScopePnus
        )
    );
    assert.equal(
        full299.manifestDigest,
        computeDevelopmentTargetV2ManifestDigest(full299)
    );

    const autoSet = new Set(auto286.pnus);
    assert.equal(
        auto286.pnus.every((pnu) => full299.anchors.includes(pnu)),
        true
    );
    assert.deepEqual(
        full299.anchors.filter((pnu) => !autoSet.has(pnu)),
        [...MIA_FULL_299_DELTA]
    );
    assert.equal(full299.anchors.includes('1130510100107912280'), true);
    assert.equal(full299.anchors.includes('1130510100107912281'), false);
    assert.equal(
        full299.allowedScopePnus.includes('1130510100107912280'),
        true
    );
    assert.equal(
        full299.allowedScopePnus.includes('1130510100107912281'),
        true
    );
    assert.deepEqual(
        full299.allowedScopePnus.filter(
            (pnu) => !full299.anchors.includes(pnu)
        ),
        ['1130510100107912281']
    );
});

test('미아7 component target은 활성 299 PNU를 공식 278 component·300 조회 scope로 고정한다', () => {
    const full299 = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_FULL_299_TARGET_URL, 'utf8'))
    );
    const component279 = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(MIA_FULL_278_OFFICIAL_COMPONENT_TARGET_URL, 'utf8')
        )
    );
    assert.equal(
        component279.version,
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    );
    if (
        full299.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V2 ||
        component279.version !==
            DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v2 full manifests expected');
    }

    assert.equal(component279.anchors.length, 278);
    assert.equal(component279.targetCount, 278);
    // 2026-08-01 개정: 3568은 조회 scope에서도 제외(어떤 anchor component도 스캔하지 않음)
    assert.equal(component279.allowedScopePnus.length, 300);
    // 2026-08-01 개정: 3568 도로지분 7건 제외(공식 LDAREG 원천 부재) → 422
    assert.equal(component279.expectedPropertyUnitCount, 422);
    assert.equal(
        component279.expectedUnionActivePropertyUnitCount,
        429
    );
    assert.equal(component279.expectedUnionActivePnuCount, 299);
    assert.deepEqual(
        component279.expectedUnionActivePnus,
        full299.anchors
    );
    assert.equal(
        component279.expectedUnionActivePnuDigest,
        computeDevelopmentActivePnuDigest(
            'development',
            UNION_ID,
            full299.anchors
        )
    );
    assert.deepEqual(
        component279.allowedScopePnus.filter(
            (pnu) =>
                !component279.expectedUnionActivePnus.includes(pnu)
        ),
        [
            '1130510100107030130',
            '1130510100107912281',
        ]
    );
    const officialAttachedActivePnus = [
        '1130510100107912216',
        '1130510100107912218',
        '1130510100107912228',
        '1130510100107912229',
        '1130510100107912245',
        '1130510100107912246',
        '1130510100107912247',
        '1130510100107912248',
        '1130510100107912249',
        '1130510100107912250',
        '1130510100107912339',
        '1130510100107912474',
        '1130510100107912918',
        '1130510100107912937',
        '1130510100107912953',
        '1130510100107912954',
    ];
    assert.deepEqual(
        full299.anchors.filter(
            (pnu) => !component279.anchors.includes(pnu)
        ),
        [
            '1130510100107450052',
            '1130510100107912212',
            '1130510100107912213',
            ...officialAttachedActivePnus,
            '1130510100107912344',
            '1130510100107913568',
        ].sort()
    );
    for (const attachedPnu of officialAttachedActivePnus) {
        assert.ok(
            component279.allowedScopePnus.includes(attachedPnu)
        );
        assert.ok(
            component279.expectedUnionActivePnus.includes(
                attachedPnu
            )
        );
    }
    assert.ok(
        component279.allowedScopePnus.includes(
            '1130510100107030130'
        ),
        '791-2244의 공식 query-only 부지번 703-130도 조회 scope에 포함한다'
    );
    assert.ok(
        !component279.expectedUnionActivePnus.includes(
            '1130510100107030130'
        )
    );
    assert.equal(
        component279.scopeDigest,
        computeDevelopmentTargetDigest(
            'development',
            UNION_ID,
            component279.allowedScopePnus
        )
    );
    assert.equal(
        component279.manifestDigest,
        computeDevelopmentTargetV3ManifestDigest(component279)
    );
    const changedActivePnus = component279.expectedUnionActivePnus
        .filter((pnu) => pnu !== '1130510100107450052')
        .concat('1130510100107912281')
        .sort();
    assert.throws(
        () =>
            parseDevelopmentTargetManifest({
                ...component279,
                expectedUnionActivePnus: changedActivePnus,
                expectedUnionActivePnuDigest:
                    computeDevelopmentActivePnuDigest(
                        'development',
                        UNION_ID,
                        changedActivePnus
                    ),
            }),
        /TARGET_MANIFEST_INVALID/
    );
    assert.throws(
        () =>
            parseDevelopmentTargetManifest({
                ...component279,
                expectedUnionActivePnuDigest: '0'.repeat(64),
            }),
        /TARGET_MANIFEST_INVALID/
    );
});

test('pinned v3 capture snapshot은 singleton까지 full-refresh official digest provenance로 기록한다', () => {
    const component279 = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(
                MIA_FULL_278_OFFICIAL_COMPONENT_TARGET_URL,
                'utf8'
            )
        )
    );
    if (
        component279.version !==
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 full target expected');
    }
    const fullSnapshot: LandAreaSyncScopeSnapshot = {
        ...snapshot(),
        developmentFullRefreshScopeResolution: {
            source:
                'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH',
            canonicalBasePnu: PNU,
            memberPnus: [PNU],
            managementPk: '1010111038',
            pairCount: 0,
            officialComponentDigest: 'a'.repeat(64),
            manifestDigest: component279.manifestDigest,
            scopeDigest: component279.scopeDigest,
        },
    };
    const entry = developmentEvidenceEntryFromSnapshot({
        target: component279,
        captureRunId: '30118336235',
        anchorPnu: PNU,
        snapshot: fullSnapshot,
    });
    assert.ok('kind' in entry.sourceReferences);
    if (!('kind' in entry.sourceReferences)) {
        throw new Error('official capture provenance expected');
    }
    assert.deepEqual(entry.sourceReferences, {
        kind: 'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE',
        captureRunId: '30118336235',
        snapshotReferenceSha256:
            entry.sourceReferences.snapshotReferenceSha256,
        officialComponentDigest: 'a'.repeat(64),
    });
});

test('pinned v3 공식 parcel singleton은 component를 위조하지 않는 별도 provenance로 기록한다', () => {
    const component279 = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(
                MIA_FULL_278_OFFICIAL_COMPONENT_TARGET_URL,
                'utf8'
            )
        )
    );
    if (
        component279.version !==
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 full target expected');
    }
    const parcelSnapshot: LandAreaSyncScopeSnapshot = {
        ...snapshot('MANUAL', '8.26'),
        developmentFullRefreshParcelResolution: {
            source:
                'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON',
            canonicalPnu: PNU,
            memberPnus: [PNU],
            officialParcelDigest: 'b'.repeat(64),
            manifestDigest: component279.manifestDigest,
            scopeDigest: component279.scopeDigest,
        },
    };
    const entry = developmentEvidenceEntryFromSnapshot({
        target: component279,
        captureRunId: '30118336235',
        anchorPnu: PNU,
        snapshot: parcelSnapshot,
    });
    assert.ok('kind' in entry.sourceReferences);
    if (!('kind' in entry.sourceReferences)) {
        throw new Error('official parcel capture provenance expected');
    }
    assert.deepEqual(entry.sourceReferences, {
        kind:
            'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_PARCEL_CAPTURE',
        captureRunId: '30118336235',
        snapshotReferenceSha256:
            entry.sourceReferences.snapshotReferenceSha256,
        officialParcelDigest: 'b'.repeat(64),
    });
    assert.equal(
        'officialComponentDigest' in entry.sourceReferences,
        false
    );
});

test('공식 parcel capture의 산출·digest는 기존 MANUAL 값과 무관하고 prestate만 보존한다', () => {
    const component279 = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(
                MIA_FULL_278_OFFICIAL_COMPONENT_TARGET_URL,
                'utf8'
            )
        )
    );
    if (
        component279.version !==
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 full target expected');
    }
    const parcelResolution = {
        source:
            'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON' as const,
        canonicalPnu: PNU,
        memberPnus: [PNU],
        officialParcelDigest: 'c'.repeat(64),
        manifestDigest: component279.manifestDigest,
        scopeDigest: component279.scopeDigest,
    };
    const first = developmentEvidenceEntryFromSnapshot({
        target: component279,
        captureRunId: '30118336235',
        anchorPnu: PNU,
        snapshot: {
            ...snapshot('MANUAL', '8.26'),
            developmentFullRefreshParcelResolution:
                parcelResolution,
        },
    });
    const second = developmentEvidenceEntryFromSnapshot({
        target: component279,
        captureRunId: '30118336235',
        anchorPnu: PNU,
        snapshot: {
            ...snapshot('MANUAL', '999'),
            developmentFullRefreshParcelResolution:
                parcelResolution,
        },
    });

    assert.deepEqual(
        first.sourceReferences,
        second.sourceReferences
    );
    assert.deepEqual(
        first.expectedProposedLandAreas,
        second.expectedProposedLandAreas
    );
    assert.notDeepEqual(
        first.allowedPrestates,
        second.allowedPrestates
    );
});

test('공식 parcel resolution은 다른 scope/no-data resolution과 동시 존재할 수 없다', () => {
    const component279 = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(
                MIA_FULL_278_OFFICIAL_COMPONENT_TARGET_URL,
                'utf8'
            )
        )
    );
    if (
        component279.version !==
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 full target expected');
    }
    assert.throws(
        () =>
            developmentEvidenceEntryFromSnapshot({
                target: component279,
                captureRunId: '30118336235',
                anchorPnu: PNU,
                snapshot: {
                    ...snapshot(),
                    developmentFullRefreshScopeResolution: {
                        source:
                            'SAME_RUN_OFFICIAL_DEVELOPMENT_FULL_REFRESH',
                        canonicalBasePnu: PNU,
                        memberPnus: [PNU],
                        managementPk: '1010111038',
                        pairCount: 0,
                        officialComponentDigest: 'a'.repeat(64),
                        manifestDigest:
                            component279.manifestDigest,
                        scopeDigest: component279.scopeDigest,
                    },
                    developmentFullRefreshParcelResolution: {
                        source:
                            'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON',
                        canonicalPnu: PNU,
                        memberPnus: [PNU],
                        officialParcelDigest: 'b'.repeat(64),
                        manifestDigest:
                            component279.manifestDigest,
                        scopeDigest: component279.scopeDigest,
                    },
                },
            }),
        /CAPTURE_OFFICIAL_PARCEL_RESOLUTION_INVALID/
    );
    assert.throws(
        () =>
            developmentEvidenceEntryFromSnapshot({
                target: component279,
                captureRunId: '30118336235',
                anchorPnu: PNU,
                snapshot: {
                    ...snapshot(),
                    scannedPnus: [PNU, PNU],
                    developmentFullRefreshParcelResolution: {
                        source:
                            'SAME_RUN_OFFICIAL_DEVELOPMENT_PARCEL_SINGLETON',
                        canonicalPnu: PNU,
                        memberPnus: [PNU, PNU],
                        officialParcelDigest: 'b'.repeat(64),
                        manifestDigest:
                            component279.manifestDigest,
                        scopeDigest: component279.scopeDigest,
                    },
                },
            }),
        /CAPTURE_OFFICIAL_PARCEL_RESOLUTION_INVALID/
    );
});

test('promotion gate는 full refresh에서도 verified no-data를 금지하고 component+parcel exact 합계만 허용한다', () => {
    assert.equal(
        isDevelopmentEvidenceCapturePromotionEligible({
            fullRefreshWriteEligible: true,
            targetCount: 6,
            sameRunOfficialComponentCount: 4,
            sameRunOfficialParcelCount: 2,
            verifiedNoDataCount: 0,
        }),
        true
    );
    assert.equal(
        isDevelopmentEvidenceCapturePromotionEligible({
            fullRefreshWriteEligible: true,
            targetCount: 6,
            sameRunOfficialComponentCount: 3,
            sameRunOfficialParcelCount: 2,
            verifiedNoDataCount: 1,
        }),
        false
    );
    assert.equal(
        isDevelopmentEvidenceCapturePromotionEligible({
            fullRefreshWriteEligible: false,
            targetCount: 1,
            sameRunOfficialComponentCount: 0,
            sameRunOfficialParcelCount: 0,
            verifiedNoDataCount: 0,
        }),
        true
    );
    assert.equal(
        isDevelopmentEvidenceCapturePromotionEligible({
            fullRefreshWriteEligible: false,
            targetCount: 1,
            sameRunOfficialComponentCount: 0,
            sameRunOfficialParcelCount: 1,
            verifiedNoDataCount: 0,
        }),
        false
    );
});

test('v3 전체 capture는 실행 직전 DEV 활성 429호·299 PNU exact 집합을 고정한다', () => {
    const full299 = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_FULL_299_TARGET_URL, 'utf8'))
    );
    const component279 = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(MIA_FULL_278_OFFICIAL_COMPONENT_TARGET_URL, 'utf8')
        )
    );
    if (
        full299.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V2 ||
        component279.version !==
            DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v2 full299 and v3 full278 expected');
    }
    const rows = Array.from(
        {
            length:
                component279.expectedUnionActivePropertyUnitCount,
        },
        (_, index) => ({
            id: `00000000-0000-4000-a000-${String(index + 1).padStart(12, '0')}`,
            pnu: full299.anchors[
                index < full299.anchors.length
                    ? index
                    : index - full299.anchors.length
            ],
        })
    );
    assert.doesNotThrow(() =>
        assertDevelopmentEvidenceCaptureActiveIdentity({
            target: component279,
            rows,
        })
    );

    const replacedActivePnu = '1130510100107450052';
    const replacementIndex = rows.findIndex(
        (row) => row.pnu === replacedActivePnu
    );
    assert.notEqual(replacementIndex, -1);
    const sameCountsDifferentPnu = rows.map((row) => ({
        ...row,
        pnu:
            row.pnu === replacedActivePnu
                ? '1130510100107912281'
                : row.pnu,
    }));
    assert.throws(
        () =>
            assertDevelopmentEvidenceCaptureActiveIdentity({
                target: component279,
                rows: sameCountsDifferentPnu,
            }),
        /CAPTURE_UNION_ACTIVE_PNU_SET_MISMATCH/
    );
    assert.throws(
        () =>
            assertDevelopmentEvidenceCaptureActiveIdentity({
                target: component279,
                rows: rows.slice(0, -1),
            }),
        /CAPTURE_UNION_ACTIVE_PROPERTY_SET_MISMATCH/
    );
});

test('278 official component capture는 anchor 밖 active PNU 21개를 허용하되 300 조회 scope 밖 PNU는 거부한다', () => {
    const full299 = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(MIA_FULL_299_TARGET_URL, 'utf8'))
    );
    const component279 = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(MIA_FULL_278_OFFICIAL_COMPONENT_TARGET_URL, 'utf8')
        )
    );
    if (
        full299.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V2 ||
        component279.version !==
            DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v2 full manifests expected');
    }
    const rows = Array.from(
        {
            length:
                component279.expectedUnionActivePropertyUnitCount,
        },
        (_, index) => ({
            id: `00000000-0000-4000-a000-${String(index + 1).padStart(12, '0')}`,
            pnu: full299.anchors[index % full299.anchors.length],
        })
    );

    assert.doesNotThrow(() =>
        assertDevelopmentEvidenceCaptureActiveIdentity({
            target: component279,
            rows,
        })
    );
    const replacedPnu = rows[0].pnu;
    const outsideScope = rows.map((row) => ({
        ...row,
        pnu:
            row.pnu === replacedPnu
                ? '1130510100109999999'
                : row.pnu,
    }));
    assert.throws(
        () =>
            assertDevelopmentEvidenceCaptureActiveIdentity({
                target: component279,
                rows: outsideScope,
            }),
        /CAPTURE_UNION_ACTIVE_PNU_SET_MISMATCH/
    );
});

test('동일 개수 active property ID가 교체되면 시작·종료 identity digest가 달라진다', () => {
    const targetManifest = threePnuComponentTargetV3();
    const initial =
        assertDevelopmentEvidenceCaptureActiveIdentity({
            target: targetManifest,
            rows: [{ id: PROPERTY_UNIT_ID, pnu: PNU }],
        });
    const changed =
        assertDevelopmentEvidenceCaptureActiveIdentity({
            target: targetManifest,
            rows: [
                {
                    id: '8ee4871c-41c5-4c17-9b41-b11b1db7bc55',
                    pnu: PNU,
                },
            ],
        });

    assert.equal(
        hasStableDevelopmentActivePropertyIdentity(
            initial,
            initial
        ),
        true
    );
    assert.equal(
        hasStableDevelopmentActivePropertyIdentity(
            initial,
            changed
        ),
        false
    );
    assert.equal(
        hasStableDevelopmentActivePropertyIdentity(initial, null),
        false
    );
});

test('read-only audit 집계는 식별자 없이 CAPTURED/NO_DATA/REVIEW/FAILED를 분리한다', () => {
    const base = {
        anchorPnu: PNU,
        strategy: null,
        scannedPnuCount: 0,
        propertyUnitCount: 0,
        snapshotReferenceSha256: null,
        applyRpcBlocked: false,
        failureCode: null,
        terminalScopeState: null,
        terminalOutcome: null,
        terminalIssueCodes: [],
        terminalIssuesTotal: 0,
        terminalIssuesTruncated: false,
        scopeResolutionSource: 'DB_RESOLVER',
        attempts: 1,
    } as const;
    const aggregate = aggregateDevelopmentEvidenceCaptureEntries([
        { ...base, status: 'CAPTURED' },
        {
            ...base,
            status: 'VERIFIED_NO_DATA',
            terminalOutcome: 'NO_DATA',
            scopeResolutionSource: 'VERIFIED_NO_DATA',
        },
        {
            ...base,
            status: 'FAILED',
            terminalOutcome: 'NO_DATA',
        },
        {
            ...base,
            status: 'FAILED',
            terminalScopeState: 'REVIEW_REQUIRED',
            terminalOutcome: 'REVIEW_REQUIRED',
        },
        {
            ...base,
            status: 'FAILED',
            terminalScopeState: 'FAILED',
            terminalOutcome: 'FAILED',
        },
    ]);
    assert.deepEqual(aggregate, {
        CAPTURED: 1,
        NO_DATA: 2,
        REVIEW: 1,
        FAILED: 1,
    });
    assert.equal(JSON.stringify(aggregate).includes(PNU), false);
    assert.equal(
        JSON.stringify(aggregate).includes(PROPERTY_UNIT_ID),
        false
    );
});

test('read-only 공개 진단은 개별 PNU를 가리키지 않는 issue code별 건수만 남긴다', () => {
    const base = {
        anchorPnu: PNU,
        strategy: null,
        scannedPnuCount: 0,
        propertyUnitCount: 0,
        snapshotReferenceSha256: null,
        applyRpcBlocked: false,
        failureCode: null,
        terminalScopeState: null,
        terminalOutcome: null,
        terminalIssueCodes: [],
        terminalIssuesTotal: 0,
        terminalIssuesTruncated: false,
        scopeResolutionSource: 'DB_RESOLVER',
        attempts: 1,
    } as const;
    const issueCounts =
        aggregateDevelopmentEvidenceCaptureIssueCodes([
            { ...base, status: 'CAPTURED' },
            {
                ...base,
                status: 'FAILED',
                terminalScopeState: 'REVIEW_REQUIRED',
                terminalOutcome: 'REVIEW_REQUIRED',
                terminalIssueCodes: [
                    'RATIO_PARSE_FAILED',
                    'PROPERTY_UNIT_NOT_FOUND',
                    'RATIO_PARSE_FAILED',
                ],
                failureCode: 'CAPTURE_REVIEW_REQUIRED',
            },
            {
                ...base,
                status: 'FAILED',
                terminalScopeState: 'FAILED',
                terminalOutcome: 'FAILED',
                failureCode: 'CAPTURE_DISCOVERY_FAILED',
            },
        ]);

    assert.deepEqual(issueCounts, [
        { code: 'PROPERTY_UNIT_NOT_FOUND', count: 1 },
        { code: 'RATIO_PARSE_FAILED', count: 1 },
    ]);
    const serialized = JSON.stringify(issueCounts);
    assert.equal(serialized.includes(PNU), false);
    assert.equal(serialized.includes(PROPERTY_UNIT_ID), false);
    assert.doesNotMatch(serialized, /\b[0-9]{19}\b/);
    assert.equal(serialized.includes('anchorIndex'), false);
});

test('read-only live snapshot은 runner가 재검증하는 strict evidence로 변환된다', () => {
    const targetManifest = target();
    const entry = developmentEvidenceEntryFromSnapshot({
        target: targetManifest,
        captureRunId: '30118336235',
        anchorPnu: PNU,
        snapshot: snapshot(),
    });

    assert.equal(entry.expectedStrategy, 'LADFRL');
    assert.deepEqual(entry.expectedPropertyUnitIds, [
        PROPERTY_UNIT_ID,
    ]);
    assert.deepEqual(entry.allowedPrestates, [
        {
            propertyUnitId: PROPERTY_UNIT_ID,
            landArea: null,
            landAreaSource: 'LEGACY_UNKNOWN',
        },
        {
            propertyUnitId: PROPERTY_UNIT_ID,
            landArea: '161',
            landAreaSource: 'LADFRL',
        },
    ]);
    assert.match(
        entry.parcelScopeEvidence.ref,
        /^captureRun=30118336235;snapshot=[0-9a-f]{64}$/
    );
    assert.doesNotThrow(() =>
        parseDevelopmentEvidenceManifest({
            version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
            databaseTarget: 'development',
            unionId: UNION_ID,
            manifestDigest: targetManifest.manifestDigest,
            entries: [entry],
        })
    );
});

test('자동 capture는 MANUAL prestate를 승인 evidence로 승격하지 않는다', () => {
    assert.throws(
        () =>
            developmentEvidenceEntryFromSnapshot({
                target: target(),
                captureRunId: '30118336235',
                anchorPnu: PNU,
                snapshot: snapshot('MANUAL'),
            }),
        /CAPTURE_MANUAL_PRESTATE_OUTSIDE_AUTO_TARGET/
    );
});

test('v2 API capture는 MANUAL 값을 동시성 guard로 보존하고 API 제안값과 정직한 provenance를 기록한다', () => {
    const targetManifest = targetV2();
    const manualSnapshot: LandAreaSyncScopeSnapshot = {
        ...snapshot('MANUAL', '8.26'),
        strategy: 'LDAREG',
        scannedPnus: [PNU, ATTACHED_PNU],
        proposedLandAreas: [
            {
                propertyUnitId: PROPERTY_UNIT_ID,
                landArea: '39.08',
            },
        ],
        ladfrlAreaEvidence: {
            version: 'land-area-sync.ladfrl-scope.v1',
            parcels: [
                { pnu: PNU, area: '73' },
                { pnu: ATTACHED_PNU, area: '102' },
            ],
            totalArea: '175',
        },
    };
    const entry = developmentEvidenceEntryFromSnapshot({
        target: targetManifest,
        captureRunId: '30118336235',
        anchorPnu: PNU,
        snapshot: manualSnapshot,
    });

    assert.equal(entry.allowManualOverwrite, true);
    assert.deepEqual(entry.allowedPrestates, [
        {
            propertyUnitId: PROPERTY_UNIT_ID,
            landArea: '8.26',
            landAreaSource: 'MANUAL',
        },
        {
            propertyUnitId: PROPERTY_UNIT_ID,
            landArea: '39.08',
            landAreaSource: 'LDAREG',
        },
    ]);
    assert.equal('kind' in entry.sourceReferences, true);
    if (!('kind' in entry.sourceReferences)) {
        throw new Error('API capture provenance expected');
    }
    assert.deepEqual(entry.sourceReferences, {
        kind: 'DEVELOPMENT_READ_ONLY_API_CAPTURE',
        captureRunId: '30118336235',
        snapshotReferenceSha256:
            entry.sourceReferences.snapshotReferenceSha256,
    });
    assert.match(
        entry.sourceReferences.snapshotReferenceSha256,
        /^[0-9a-f]{64}$/
    );
    assert.equal(
        JSON.stringify(entry.sourceReferences).includes(
            'workbookFileReferenceSha256'
        ),
        false
    );
    assert.doesNotThrow(() =>
        parseDevelopmentEvidenceManifest({
            version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION_V2,
            databaseTarget: 'development',
            unionId: UNION_ID,
            manifestDigest: targetManifest.manifestDigest,
            entries: [entry],
        })
    );
});

test('READ_ONLY same-run 1→3 official component는 전 PNU를 LDAREG/LADFRL scan해 issue 0 CAPTURED로 남기고 write 승격은 차단한다', async () => {
    const targetManifest = threePnuComponentTargetV3();
    if (
        targetManifest.version !==
        DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 target expected');
    }
    const managementPk = '1010111038';
    const ldaregPnus = new Set<string>();
    const ladfrlPnus = new Set<string>();
    let activeIdentityReads = 0;
    const result = await captureDevelopmentLandAreaEvidence({
        target: targetManifest,
        captureRunId: '30118336235',
        concurrency: 1,
        deps: {
            now: () => new Date('2026-07-28T00:00:00.000Z'),
            async readActivePropertyIdentity() {
                activeIdentityReads += 1;
                return [{ id: PROPERTY_UNIT_ID, pnu: PNU }];
            },
            async resolveScope() {
                return {
                    data: {
                        dbState: 'NO_EVIDENCE',
                        rootBuildingIdentities: [managementPk],
                        componentPnus: [PNU],
                        linkedBasePnus: [],
                        linkedPnus: [],
                        linkedEvidenceKeys: [],
                        pendingEvidenceKeys: [],
                        blockingEvidence: [],
                        openUnresolvedEvidenceKeys: [],
                        componentTruncated: false,
                        propertyMembership: [
                            {
                                propertyUnitId: PROPERTY_UNIT_ID,
                                pnu: PNU,
                                buildingUnitId: null,
                            },
                        ],
                        dbScopeHash: 'db-scope-no-evidence',
                    },
                    error: null,
                };
            },
            async readBuildingUnits() {
                return [];
            },
            async readPropertyUnits() {
                return [
                    {
                        id: PROPERTY_UNIT_ID,
                        unionId: UNION_ID,
                        buildingUnitId: null,
                        pnu: PNU,
                        isDeleted: false,
                        dong: '101',
                        ho: '301',
                    },
                ];
            },
            async readCurrentLandTuples() {
                return [
                    {
                        propertyUnitId: PROPERTY_UNIT_ID,
                        landArea: '',
                        source: 'LEGACY_UNKNOWN',
                    },
                ];
            },
            scans: {
                async scanTitle() {
                    return {
                        state: 'COMPLETE',
                        rows: [
                            {
                                mgmBldrgstPk: managementPk,
                                bylotCnt: '2',
                                regstrGbCd: '2',
                                mainPurpsCd: '02003',
                                mainPurpsCdNm: '다세대주택',
                            },
                        ],
                        totalCount: 1,
                        pagesFetched: 1,
                    };
                },
                async scanAttached() {
                    return {
                        state: 'COMPLETE',
                        rows: [
                            {
                                mgmBldrgstPk: managementPk,
                                sigunguCd: '11305',
                                bjdongCd: '10100',
                                platGbCd: '0',
                                bun: '0791',
                                ji: '2166',
                                atchSigunguCd: '11305',
                                atchBjdongCd: '10100',
                                atchPlatGbCd: '0',
                                atchBun: '0791',
                                atchJi: '2167',
                            },
                            {
                                mgmBldrgstPk: managementPk,
                                sigunguCd: '11305',
                                bjdongCd: '10100',
                                platGbCd: '0',
                                bun: '0791',
                                ji: '2166',
                                atchSigunguCd: '11305',
                                atchBjdongCd: '10100',
                                atchPlatGbCd: '0',
                                atchBun: '0791',
                                atchJi: '2168',
                            },
                        ],
                        totalCount: 2,
                        pagesFetched: 1,
                    };
                },
                async scanBasis(pnu) {
                    return {
                        state: 'COMPLETE',
                        rows: [{ pnu, mgmBldrgstPk: managementPk }],
                        totalCount: 1,
                        pagesFetched: 1,
                    };
                },
                async scanExpos(pnu) {
                    return {
                        state: 'COMPLETE',
                        rows: [
                            {
                                pnu,
                                mgmBldrgstPk: managementPk,
                                dongNm: '101',
                                flrNoNm: '3',
                                hoNm: '301',
                            },
                        ],
                        totalCount: 1,
                        pagesFetched: 1,
                    };
                },
                async scanLadfrl(pnu) {
                    ladfrlPnus.add(pnu);
                    return {
                        state: 'COMPLETE',
                        rows: [{ pnu, lndpclAr: '33.5' }],
                        totalCount: 1,
                        pagesFetched: 1,
                    };
                },
                async scanLdareg(pnu) {
                    ldaregPnus.add(pnu);
                    return {
                        state: 'COMPLETE',
                        rows: [
                            {
                                pnu,
                                agbldgSn: '1744',
                                ldaQotaRate: '10/100.5',
                                clsSeCode: '0',
                                clsSeCodeNm: '현행',
                                buldDongNm: '101',
                                buldFloorNm: '3',
                                buldHoNm: '301',
                            },
                        ],
                        totalCount: 1,
                        pagesFetched: 1,
                    };
                },
            },
        },
    });

    assert.deepEqual([...ldaregPnus].sort(), [
        PNU,
        ATTACHED_PNU,
        THIRD_PNU,
    ]);
    assert.deepEqual([...ladfrlPnus].sort(), [
        PNU,
        ATTACHED_PNU,
        THIRD_PNU,
    ]);
    assert.equal(result.audit.gate.status, 'PASS');
    assert.equal(activeIdentityReads, 2);
    assert.equal(result.audit.activePropertyIdentityStable, true);
    assert.equal(
        result.audit.initialActivePropertyIdentityDigest,
        result.audit.finalActivePropertyIdentityDigest
    );
    assert.equal(result.audit.redactedAggregate.CAPTURED, 1);
    assert.equal(result.audit.entries[0].status, 'CAPTURED');
    assert.deepEqual(result.audit.entries[0].terminalIssueCodes, []);
    assert.equal(result.audit.entries[0].terminalIssuesTotal, 0);
    assert.equal(
        result.audit.entries[0].scopeResolutionSource,
        'SAME_RUN_OFFICIAL_READ_ONLY'
    );
    assert.equal(result.audit.scannedPnuCount, 3);
    assert.equal(result.audit.sameRunOfficialComponentCount, 1);
    assert.equal(result.audit.verifiedNoDataCount, 0);
    assert.deepEqual(result.audit.promotionGate, {
        status: 'BLOCKED',
        writeEligible: false,
        failureCodes: [
            'SAME_RUN_OFFICIAL_SCOPE_NOT_DB_REVALIDATABLE',
        ],
    });
    assert.equal(
        result.audit.readOnlyGuards.propertyUnitWriteRpcCalls,
        0
    );
    assert.equal(result.evidence?.entries.length, 1);
    const [entry] = result.evidence?.entries ?? [];
    assert.ok(entry && 'kind' in entry.sourceReferences);
    if (!entry || !('kind' in entry.sourceReferences)) {
        throw new Error('same-run capture provenance expected');
    }
    assert.equal(
        entry.sourceReferences.kind,
        'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE'
    );
    if (
        entry.sourceReferences.kind !==
        'DEVELOPMENT_READ_ONLY_SAME_RUN_OFFICIAL_CAPTURE'
    ) {
        throw new Error('same-run capture provenance expected');
    }
    assert.match(
        entry.sourceReferences.officialComponentDigest,
        /^[0-9a-f]{64}$/
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                targetManifest,
                {
                    version:
                        'land-area-development-db-approval-manifest@1',
                    databaseTarget: 'development',
                    unionId: UNION_ID,
                    pnus: targetManifest.allowedScopePnus,
                    targetCount:
                        targetManifest.allowedScopePnus.length,
                    manifestDigest: targetManifest.scopeDigest,
                    enabled: true,
                },
                result.evidence!
            ),
        /TARGET_FULL_REFRESH_POLICY_MISMATCH/
    );
});

test('resolved scope가 승인 target을 벗어나면 capture 단계에서 중단한다', () => {
    const expanded = {
        ...snapshot(),
        scannedPnus: [PNU, '1130510100107912167'],
        ladfrlAreaEvidence: {
            version: 'land-area-sync.ladfrl-scope.v1' as const,
            parcels: [
                { pnu: PNU, area: '161' },
                { pnu: '1130510100107912167', area: '20' },
            ],
            totalArea: '181',
        },
    };
    assert.throws(
        () =>
            developmentEvidenceEntryFromSnapshot({
                target: target(),
                captureRunId: '30118336235',
                anchorPnu: PNU,
                snapshot: expanded,
            }),
        /CAPTURE_SCOPE_OUTSIDE_TARGET/
    );
});

test('재시도가 없는 실행은 attempts 1과 빈 retry 집계를 남긴다', () => {
    const entry: DevelopmentEvidenceCaptureAuditEntry = {
        anchorPnu: PNU,
        status: 'CAPTURED',
        strategy: 'LADFRL',
        scannedPnuCount: 1,
        propertyUnitCount: 1,
        snapshotReferenceSha256: '0'.repeat(64),
        applyRpcBlocked: true,
        failureCode: null,
        terminalScopeState: 'RESOLVED',
        terminalOutcome: 'APPLIED',
        terminalIssueCodes: [],
        terminalIssuesTotal: 0,
        terminalIssuesTruncated: false,
        scopeResolutionSource: 'DB_RESOLVER',
        attempts: 1,
    };
    assert.equal(isDevelopmentEvidenceCaptureRetryable(entry), false);
});

test('재시도 술어는 REVIEW·NO_DATA·CAPTURED를 제외하고 판정 미도달만 고른다', () => {
    const base: DevelopmentEvidenceCaptureAuditEntry = {
        anchorPnu: PNU,
        status: 'FAILED',
        strategy: null,
        scannedPnuCount: 0,
        propertyUnitCount: 0,
        snapshotReferenceSha256: null,
        applyRpcBlocked: false,
        failureCode: 'CAPTURE_DISCOVERY_FAILED',
        terminalScopeState: 'FAILED',
        terminalOutcome: 'FAILED',
        terminalIssueCodes: ['PROVIDER_PROTOCOL_ERROR'],
        terminalIssuesTotal: 1,
        terminalIssuesTruncated: false,
        scopeResolutionSource: 'DB_RESOLVER',
        attempts: 1,
    };

    assert.equal(isDevelopmentEvidenceCaptureRetryable(base), true);
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            status: 'CAPTURED',
        }),
        false
    );
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            status: 'VERIFIED_NO_DATA',
        }),
        false
    );
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            terminalOutcome: 'NO_DATA',
        }),
        false
    );
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            terminalOutcome: 'REVIEW_REQUIRED',
        }),
        false
    );
    assert.equal(
        isDevelopmentEvidenceCaptureRetryable({
            ...base,
            terminalScopeState: 'REVIEW_REQUIRED',
        }),
        false
    );
});

test('capture 재시도 상수는 설계값으로 고정된다', () => {
    assert.equal(CAPTURE_MAX_ATTEMPTS, 3);
    assert.equal(CAPTURE_RETRY_DELAY_MS, 60_000);
    assert.equal(RETRY_ELIGIBLE_MAX_RATIO, 0.25);
});

const RETRY_PNUS = [
    '1130510100107912166',
    '1130510100107912167',
    '1130510100107912168',
    '1130510100107912169',
];
const RETRY_PROPERTY_UNIT_IDS = [
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc9001',
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc9002',
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc9003',
    '5a1a4cbb-c8ad-45a3-ae40-b90665dc9004',
];

function retryTarget(): DevelopmentTargetManifest {
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        pnus: RETRY_PNUS,
        targetCount: RETRY_PNUS.length,
        manifestDigest: computeDevelopmentTargetDigest(
            'development',
            UNION_ID,
            RETRY_PNUS
        ),
        expectedPropertyUnitCount: RETRY_PNUS.length,
        expectedUnionActivePropertyUnitCount: RETRY_PNUS.length,
        expectedUnionActivePnuCount: RETRY_PNUS.length,
    };
}

test('재시도 픽스처는 실패 anchor 없이 완주하고 retry 집계가 비어 있다', async () => {
    let titleScans = 0;
    const result = await captureDevelopmentLandAreaEvidence({
        target: retryTarget(),
        captureRunId: '30418532695',
        concurrency: 1,
        sleep: async () => {},
        deps: alwaysFailingTitleDeps({
            onScanTitle: () => {
                titleScans += 1;
            },
            failFor: () => false,
        }) as never,
    });

    assert.equal(titleScans, RETRY_PNUS.length);
    assert.equal(result.audit.retry.rounds, 0);
    assert.equal(result.audit.retry.retriedAnchorCount, 0);
    assert.equal(result.audit.retry.skipped, 'NONE');
    for (const entry of result.audit.entries) {
        assert.equal(entry.attempts, 1);
    }
});

function alwaysFailingTitleDeps(input: {
    onScanTitle: (anchorPnu: string) => void;
    failFor?: (anchorPnu: string) => boolean;
}) {
    return {
        now: () => new Date('2026-07-30T00:00:00.000Z'),
        async readActivePropertyIdentity() {
            return RETRY_PNUS.map((pnu, index) => ({
                id: RETRY_PROPERTY_UNIT_IDS[index],
                pnu,
            }));
        },
        async resolveScope() {
            return {
                data: {
                    dbState: 'NO_EVIDENCE',
                    rootBuildingIdentities: [],
                    componentPnus: [PNU],
                    linkedBasePnus: [],
                    linkedPnus: [],
                    linkedEvidenceKeys: [],
                    pendingEvidenceKeys: [],
                    blockingEvidence: [],
                    openUnresolvedEvidenceKeys: [],
                    componentTruncated: false,
                    propertyMembership: [
                        {
                            propertyUnitId: PROPERTY_UNIT_ID,
                            pnu: PNU,
                            buildingUnitId: null,
                        },
                    ],
                    dbScopeHash: 'db-scope-no-evidence',
                },
                error: null,
            };
        },
        async readBuildingUnits() {
            return [];
        },
        async readPropertyUnits() {
            return [];
        },
        async readCurrentLandTuples() {
            return [];
        },
        scans: {
            async scanTitle(anchorPnu: string) {
                input.onScanTitle(anchorPnu);
                if (input.failFor?.(anchorPnu) ?? true) {
                    return {
                        state: 'FAILED' as const,
                        issue: {
                            kind: 'HTTP_ERROR' as const,
                            endpoint: 'getBrTitleInfo' as const,
                            message: 'http 500',
                            httpStatus: 500,
                        },
                    };
                }
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanAttached() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanBasis() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanExpos() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanLadfrl() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
            async scanLdareg() {
                return {
                    state: 'COMPLETE_ZERO' as const,
                    rows: [],
                    totalCount: 0,
                    pagesFetched: 1,
                };
            },
        },
    };
}

test('판정 미도달 anchor는 CAPTURE_MAX_ATTEMPTS까지 재시도하고 시도 수를 기록한다', async () => {
    let titleScans = 0;
    let slept = 0;
    const result = await captureDevelopmentLandAreaEvidence({
        target: retryTarget(),
        captureRunId: '30418532695',
        concurrency: 1,
        sleep: async (ms) => {
            slept += ms;
        },
        deps: alwaysFailingTitleDeps({
            onScanTitle: () => {
                titleScans += 1;
            },
            failFor: (pnu) => pnu === RETRY_PNUS[0],
        }) as never,
    });

    const failing = result.audit.entries.find(
        (entry) => entry.anchorPnu === RETRY_PNUS[0]
    );
    assert.ok(failing);
    // round1 4건 + round2 1건 + round3 1건
    assert.equal(titleScans, RETRY_PNUS.length + 2);
    assert.equal(failing.attempts, CAPTURE_MAX_ATTEMPTS);
    assert.equal(failing.terminalScopeState, 'FAILED');
    assert.equal(result.audit.retry.rounds, CAPTURE_MAX_ATTEMPTS - 1);
    assert.equal(result.audit.retry.retriedAnchorCount, 1);
    assert.equal(result.audit.retry.recoveredAnchorCount, 0);
    assert.equal(result.audit.retry.skipped, 'NONE');
    assert.equal(
        slept,
        CAPTURE_RETRY_DELAY_MS * (CAPTURE_MAX_ATTEMPTS - 1)
    );
    assert.equal(result.audit.readOnlyGuards.durableSyncJobWrites, 0);
    assert.equal(
        result.audit.readOnlyGuards.propertyUnitWriteRpcCalls,
        0
    );
});

test('첫 라운드에서 실패한 anchor가 다음 라운드에서 판정에 도달하면 회복으로 집계한다', async () => {
    let titleScans = 0;
    const seen = new Map<string, number>();
    const result = await captureDevelopmentLandAreaEvidence({
        target: retryTarget(),
        captureRunId: '30418532695',
        concurrency: 1,
        sleep: async () => {},
        deps: alwaysFailingTitleDeps({
            onScanTitle: (pnu) => {
                titleScans += 1;
                seen.set(pnu, (seen.get(pnu) ?? 0) + 1);
            },
            // RETRY_PNUS[0] 만 첫 시도에서 실패하고 두 번째 시도부터 성공한다.
            failFor: (pnu) =>
                pnu === RETRY_PNUS[0] && (seen.get(pnu) ?? 0) === 1,
        }) as never,
    });

    const recovered = result.audit.entries.find(
        (entry) => entry.anchorPnu === RETRY_PNUS[0]
    );
    assert.ok(recovered);
    // round1 4건 + round2 1건
    assert.equal(titleScans, RETRY_PNUS.length + 1);
    assert.equal(recovered.attempts, 2);
    assert.equal(result.audit.retry.rounds, 1);
    assert.equal(result.audit.retry.retriedAnchorCount, 1);
    assert.equal(result.audit.retry.recoveredAnchorCount, 1);
    assert.notEqual(recovered.terminalScopeState, 'FAILED');
});

test('실패가 임계 비율을 넘으면 재시도를 생략하고 사유를 남긴다', async () => {
    let titleScans = 0;
    let slept = 0;
    const result = await captureDevelopmentLandAreaEvidence({
        target: retryTarget(),
        captureRunId: '30418532695',
        concurrency: 1,
        sleep: async (ms) => {
            slept += ms;
        },
        deps: alwaysFailingTitleDeps({
            onScanTitle: () => {
                titleScans += 1;
            },
            failFor: () => true,
        }) as never,
    });

    assert.equal(titleScans, RETRY_PNUS.length);
    assert.equal(slept, 0);
    assert.equal(result.audit.retry.rounds, 0);
    assert.equal(result.audit.retry.retriedAnchorCount, 0);
    assert.equal(result.audit.retry.recoveredAnchorCount, 0);
    assert.equal(result.audit.retry.skipped, 'TOO_MANY_FAILURES');
    for (const entry of result.audit.entries) {
        assert.equal(entry.attempts, 1);
    }
});

// ── production target 축 (2026-08-12 캡처 일반화) ──────────────────────

function productionRetryTarget(): DevelopmentTargetManifest {
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION,
        databaseTarget: 'production',
        unionId: UNION_ID,
        pnus: RETRY_PNUS,
        targetCount: RETRY_PNUS.length,
        manifestDigest: computeDevelopmentTargetDigest(
            'production',
            UNION_ID,
            RETRY_PNUS
        ),
        expectedPropertyUnitCount: RETRY_PNUS.length,
        expectedUnionActivePropertyUnitCount: RETRY_PNUS.length,
        expectedUnionActivePnuCount: RETRY_PNUS.length,
    };
}

test('production target 캡처는 입구 가드를 통과하고 audit·identity digest에 production 축을 새긴다', async () => {
    const productionTarget = productionRetryTarget();
    const identityRows = RETRY_PNUS.map((pnu, index) => ({
        id: RETRY_PROPERTY_UNIT_IDS[index],
        pnu,
    }));

    // identity digest 는 환경 축을 포함한다 — 같은 행 집합이라도 dev 와 다르다.
    const productionIdentity =
        assertDevelopmentEvidenceCaptureActiveIdentity({
            target: productionTarget,
            rows: identityRows,
        });
    const developmentIdentity =
        assertDevelopmentEvidenceCaptureActiveIdentity({
            target: retryTarget(),
            rows: identityRows,
        });
    assert.equal(
        productionIdentity.pnuDigest,
        computeDevelopmentActivePnuDigest(
            'production',
            UNION_ID,
            [...RETRY_PNUS].sort()
        )
    );
    assert.notEqual(
        productionIdentity.pnuDigest,
        developmentIdentity.pnuDigest
    );
    assert.notEqual(
        productionIdentity.propertyIdentityDigest,
        developmentIdentity.propertyIdentityDigest
    );

    // 캡처 본체 — production target 이 CAPTURE_INPUT_INVALID 로 거부되지 않고,
    // audit/evidence 의 databaseTarget 이 target 을 그대로 따른다.
    const result = await captureDevelopmentLandAreaEvidence({
        target: productionTarget,
        captureRunId: '31700000001',
        concurrency: 1,
        sleep: async () => {},
        deps: alwaysFailingTitleDeps({
            onScanTitle: () => {},
            failFor: () => false,
        }) as never,
    });
    assert.equal(result.audit.databaseTarget, 'production');
    assert.equal(
        result.audit.capturedEvidence?.databaseTarget ?? 'production',
        'production'
    );

    // 미지의 환경 문자열은 여전히 입구에서 거부한다.
    await assert.rejects(
        captureDevelopmentLandAreaEvidence({
            target: {
                ...productionTarget,
                databaseTarget: 'staging',
            } as unknown as DevelopmentTargetManifest,
            captureRunId: '31700000001',
            concurrency: 1,
            deps: alwaysFailingTitleDeps({
                onScanTitle: () => {},
                failFor: () => false,
            }) as never,
        }),
        /CAPTURE_INPUT_INVALID/
    );
});

const MIA_FULL_278_PRODUCTION_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-full-278-official-components-api-readonly-production-target-20260812.json',
    import.meta.url
);

test('미아7 production target은 dev와 동일 집합에 production 축 digest 3종만 다르게 고정한다', () => {
    const development = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(
                MIA_FULL_278_OFFICIAL_COMPONENT_TARGET_URL,
                'utf8'
            )
        )
    );
    const production = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(MIA_FULL_278_PRODUCTION_TARGET_URL, 'utf8')
        )
    );
    if (
        development.version !==
            DEVELOPMENT_TARGET_MANIFEST_VERSION_V3 ||
        production.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 targets expected');
    }
    assert.equal(production.databaseTarget, 'production');
    // 집합·카운트는 dev 와 완전히 같다 (운영 활성 PNU 집합 md5 실측 일치, 2026-08-12).
    assert.deepEqual(production.anchors, development.anchors);
    assert.deepEqual(
        production.allowedScopePnus,
        development.allowedScopePnus
    );
    assert.deepEqual(
        production.expectedUnionActivePnus,
        development.expectedUnionActivePnus
    );
    assert.equal(production.targetCount, 278);
    assert.equal(production.expectedPropertyUnitCount, 422);
    assert.equal(
        production.expectedUnionActivePropertyUnitCount,
        429
    );
    assert.equal(production.expectedUnionActivePnuCount, 299);
    // digest 3종은 production 축 재계산 값으로 고정한다.
    assert.equal(
        production.expectedUnionActivePnuDigest,
        '730b3757852db56d11c5e0f11affd4f8d57a0624fefba856b474bf6d12da760f'
    );
    assert.equal(
        production.scopeDigest,
        '1ed934dea2bb3610a9cc98dececfed76998f4649cfe927f8f64dee62db7b8ba2'
    );
    assert.equal(
        production.manifestDigest,
        '352212dc1357e6e113ca0eeb269934664b4138d833d7bc81ca10d893ba7c024e'
    );
    // dev digest 와는 전부 달라야 한다 — 승인·allowlist 교차 재사용 불가의 근거.
    assert.notEqual(
        production.expectedUnionActivePnuDigest,
        development.expectedUnionActivePnuDigest
    );
    assert.notEqual(production.scopeDigest, development.scopeDigest);
    assert.notEqual(
        production.manifestDigest,
        development.manifestDigest
    );
});

const MIA_STANDARD_267_PRODUCTION_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-standard-267-api-readonly-production-target-20260812.json',
    import.meta.url
);

test('미아7 standard-267 production target은 REVIEW 11 anchor를 제외한 표준 계약 부분집합을 고정한다', () => {
    const full = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(MIA_FULL_278_PRODUCTION_TARGET_URL, 'utf8')
        )
    );
    const partial = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(
                MIA_STANDARD_267_PRODUCTION_TARGET_URL,
                'utf8'
            )
        )
    );
    if (
        full.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3 ||
        partial.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 targets expected');
    }
    assert.equal(partial.databaseTarget, 'production');
    assert.equal(partial.targetCount, 267);
    assert.equal(partial.anchors.length, 267);
    assert.equal(partial.allowedScopePnus.length, 268);
    // 운영 SQL 실측(2026-08-12): 268 스코프의 활성 물건 = 306.
    assert.equal(partial.expectedPropertyUnitCount, 306);
    // union 수준 활성 identity 는 전체 매니페스트와 동일하게 고정한다.
    assert.equal(partial.expectedUnionActivePropertyUnitCount, 429);
    assert.equal(partial.expectedUnionActivePnuCount, 299);
    assert.deepEqual(
        partial.expectedUnionActivePnus,
        full.expectedUnionActivePnus
    );
    assert.equal(
        partial.expectedUnionActivePnuDigest,
        full.expectedUnionActivePnuDigest
    );
    // anchors ⊂ full.anchors, 제외는 run 31556569354 의 REVIEW 11건 exact.
    const excluded = full.anchors.filter(
        (pnu) => !partial.anchors.includes(pnu)
    );
    assert.deepEqual(excluded, [
        '1130510100107450049',
        '1130510100107912155',
        '1130510100107912211',
        '1130510100107912227',
        '1130510100107912244',
        '1130510100107912267',
        '1130510100107912313',
        '1130510100107912315',
        '1130510100107912338',
        '1130510100107912343',
        '1130510100107912700',
    ]);
    // 스코프 = anchors ∪ 채택 relation attached(2281). 703-130 은 제외 anchor
    // (791-2244) 의 query-only 부속지번이므로 부분 스코프에 없어야 한다.
    assert.deepEqual(
        partial.allowedScopePnus.filter(
            (pnu) => !partial.anchors.includes(pnu)
        ),
        ['1130510100107912281']
    );
    assert.ok(
        !partial.allowedScopePnus.includes('1130510100107030130')
    );
    // digest 핀 — 저장소 함수 재계산 값.
    assert.equal(
        partial.scopeDigest,
        '64f8396f4936c6c14146dfab38a8d4e2c5f27eae33228dcc8b3a6599b3a0bded'
    );
    assert.equal(
        partial.manifestDigest,
        '126f2e167769b0b4aa361c7a648ec1025bd28cbf4247c48a84366213ce2b2ef1'
    );
});

const SOLSAM_FULL_1086_PRODUCTION_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/solsam-full-1086-api-readonly-production-target-20260904.json',
    import.meta.url
);

test('삼양동 full-1086 production target은 활성 필지 전체를 anchor 로 고정한다(전수 캡처용)', () => {
    const target = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(SOLSAM_FULL_1086_PRODUCTION_TARGET_URL, 'utf8')
        )
    );
    if (target.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3) {
        throw new Error('v3 target expected');
    }
    assert.equal(target.databaseTarget, 'production');
    assert.equal(target.unionId, '7c35ee21-34fc-4597-84db-ee63e5b0d351');
    // 운영 SQL 실측(2026-09-04): 활성 물건지 1,607 / 활성 PNU 1,086.
    assert.equal(target.targetCount, 1086);
    assert.equal(target.anchors.length, 1086);
    assert.deepEqual(target.allowedScopePnus, target.anchors);
    assert.deepEqual(target.expectedUnionActivePnus, target.anchors);
    assert.equal(target.expectedPropertyUnitCount, 1607);
    assert.equal(target.expectedUnionActivePropertyUnitCount, 1607);
    assert.equal(target.expectedUnionActivePnuCount, 1086);
    // 미아동(1130510100) 필지만 — 다른 법정동이 섞이면 조합 identity 가 틀린 것이다.
    assert.ok(target.anchors.every((pnu) => pnu.startsWith('11305101001')));
    assert.ok(target.anchors.includes('1130510100107912080'));
    // digest 핀 — 저장소 함수 재계산 값(생성기 scripts/solsam-land-area-target.ts).
    assert.equal(
        target.expectedUnionActivePnuDigest,
        '0dd0fa7f02372e6fa261d1fea69197bdd91982381c13681cd591f02aa47e9b39'
    );
    assert.equal(
        target.scopeDigest,
        '63b14927a98add032fd4a8cc3efd8bd388ebda56f86829bb10d702e10b54ed05'
    );
    assert.equal(
        target.manifestDigest,
        'e00a3afba002cb3b868c8fc44c2204b4a5896ab3cad75222e6282c74f56fa5e7'
    );
});

const SOLSAM_STANDARD_A_851_PRODUCTION_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/solsam-standard-a-851-api-readonly-production-target-20260904.json',
    import.meta.url
);
const SOLSAM_STANDARD_B_101_PRODUCTION_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/solsam-standard-b-101-api-readonly-production-target-20260904.json',
    import.meta.url
);

test('삼양동 standard A/B production target은 전수 target의 서로소 부분집합이며 union identity 를 공유한다', () => {
    const full = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(SOLSAM_FULL_1086_PRODUCTION_TARGET_URL, 'utf8'))
    );
    const a = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(SOLSAM_STANDARD_A_851_PRODUCTION_TARGET_URL, 'utf8')
        )
    );
    const b = parseDevelopmentTargetManifest(
        JSON.parse(
            readFileSync(SOLSAM_STANDARD_B_101_PRODUCTION_TARGET_URL, 'utf8')
        )
    );
    if (
        full.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3 ||
        a.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3 ||
        b.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3
    ) {
        throw new Error('v3 targets expected');
    }
    for (const partial of [a, b]) {
        assert.equal(partial.databaseTarget, 'production');
        assert.equal(partial.unionId, full.unionId);
        // 부분집합: anchors = allowedScopePnus ⊂ full.anchors, union identity 는 전수와 동일.
        assert.deepEqual(partial.allowedScopePnus, partial.anchors);
        assert.ok(partial.anchors.every((pnu) => full.anchors.includes(pnu)));
        assert.deepEqual(partial.expectedUnionActivePnus, full.expectedUnionActivePnus);
        assert.equal(
            partial.expectedUnionActivePnuDigest,
            full.expectedUnionActivePnuDigest
        );
        assert.equal(partial.expectedUnionActivePropertyUnitCount, 1607);
        assert.equal(partial.expectedUnionActivePnuCount, 1086);
        assert.equal(partial.targetCount, partial.anchors.length);
    }
    // 창 A(비-MANUAL) 851 anchor / 물건 965, 창 B(MANUAL) 101 anchor / 물건 137 — 운영 SQL 실측(2026-09-04).
    assert.equal(a.targetCount, 851);
    assert.equal(a.expectedPropertyUnitCount, 965);
    assert.equal(b.targetCount, 101);
    assert.equal(b.expectedPropertyUnitCount, 137);
    // 서로소 — 같은 필지가 두 창에 걸치면 approval·allowlist 가 겹친다.
    assert.equal(a.anchors.filter((pnu) => b.anchors.includes(pnu)).length, 0);
    // 제외 134 필지(감사 제외 51 ∪ 전수 캡처 REVIEW/FAILED 111) 는 어느 창에도 없다.
    assert.equal(
        full.anchors.length - a.anchors.length - b.anchors.length,
        134
    );
    for (const excludedPnu of [
        '1130510100107600091', // 760-91 편입<공부 (LEGACY, LADFRL 이면 과대)
        '1130510100107912008', // 791-2008 자영리베라 필지별 대지권 5필지
        '1130510100107913087', // 791-3087 등록부 오류 HOLD
        '1130510100113540014', // 1354-14 도로, 명부 공란
        '1130510100107912771', // 791-2771 비율형('1/4') — RATIO_DENOMINATOR_MISMATCH
    ]) {
        assert.ok(!a.anchors.includes(excludedPnu));
        assert.ok(!b.anchors.includes(excludedPnu));
    }
    // digest 핀 — 저장소 함수 재계산 값.
    assert.equal(
        a.scopeDigest,
        '9106a500d92a0800fbfde8db6c9fbd011d52ef884040c6a418adf9717caaf838'
    );
    assert.equal(
        a.manifestDigest,
        '9d7cefffc4c39783654364bc95793e5a7ddb933cac425ced76c05c750a965399'
    );
    assert.equal(
        b.scopeDigest,
        'e8529f6caa8150ac5054d69e4ff5fe2433395a047d8139fd92abd70df9665c74'
    );
    assert.equal(
        b.manifestDigest,
        '2edb14c69bff3203bbfc87ecad8cbb4d6518dce24c6df353cfef1917aa9c036e'
    );
});

const SOLSAM_G1_34_PRODUCTION_TARGET_URL = new URL(
    '../development-land-area-sync-manifests/solsam-g1-40-api-readonly-production-target-20260907.json',
    import.meta.url
);
const SOLSAM_EXCLUDE_STANDARD_URL = new URL(
    '../development-land-area-sync-manifests/solsam-exclude-standard-20260904.json',
    import.meta.url
);
const SOLSAM_G1_INCLUDE_URL = new URL(
    '../development-land-area-sync-manifests/solsam-g1-34-include-20260907.json',
    import.meta.url
);

test('삼양동 제외 목록(134)은 전수 − 창 A∪B 와 정확히 같고, 잔여 G1 target 은 그 부분집합이다', () => {
    const full = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(SOLSAM_FULL_1086_PRODUCTION_TARGET_URL, 'utf8'))
    );
    const a = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(SOLSAM_STANDARD_A_851_PRODUCTION_TARGET_URL, 'utf8'))
    );
    const b = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(SOLSAM_STANDARD_B_101_PRODUCTION_TARGET_URL, 'utf8'))
    );
    const g1 = parseDevelopmentTargetManifest(
        JSON.parse(readFileSync(SOLSAM_G1_34_PRODUCTION_TARGET_URL, 'utf8'))
    );
    const exclude = JSON.parse(readFileSync(SOLSAM_EXCLUDE_STANDARD_URL, 'utf8')) as {
        excluded_pnus: string[];
        entries: Array<{ pnu: string; bucket: string; option: string }>;
    };
    const include = JSON.parse(readFileSync(SOLSAM_G1_INCLUDE_URL, 'utf8')) as {
        included_pnus: string[];
    };
    // 제외 목록: 러너는 필지별 사람 확인 없이 confirm 을 자동 발급하고
    // allowManualOverwrite:true 이므로, 편입면적<공부면적 필지(예 791-3275 35.8㎡ vs
    // 토지대장 2,086㎡)는 이 목록에서 빠지는 순간 재실행 한 번에 조용히 덮인다.
    const excludedSet = new Set(exclude.excluded_pnus);
    assert.equal(exclude.excluded_pnus.length, 134);
    assert.equal(excludedSet.size, 134);
    assert.equal(exclude.entries.length, 134);
    const done = new Set([...a.anchors, ...b.anchors]);
    assert.deepEqual(
        full.anchors.filter((pnu) => !done.has(pnu)),
        [...excludedSet].sort()
    );
    for (const pnu of [
        '1130510100107913275', // 791-3275 시·도유지 도로, 편입 35.8 / 공부 2086
        '1130510100107600091', // 760-91 군유지 도로, 편입 532 / 공부 3134
        '1130510100108380080', // 838-80 사유 도로, 편입 5 / 공부 69
        '1130510100113540014', // 1354-14 토지 없음(NULL 이 정답)
        '1130510100107913087', // 791-3087 등록부 결함 HOLD
    ]) {
        assert.ok(excludedSet.has(pnu));
        assert.ok(!g1.anchors.includes(pnu));
    }
    // G1: 명시 포함 목록으로만 생성 — anchors == included_pnus, 제외 목록의 부분집합,
    // 창 A/B 와 서로소, union identity 는 전수와 동일.
    if (g1.version !== DEVELOPMENT_TARGET_MANIFEST_VERSION_V3) {
        throw new Error('v3 target expected');
    }
    assert.deepEqual(g1.anchors, [...include.included_pnus].sort());
    assert.deepEqual(g1.allowedScopePnus, g1.anchors);
    assert.ok(g1.anchors.every((pnu) => excludedSet.has(pnu)));
    assert.ok(g1.anchors.every((pnu) => !done.has(pnu)));
    assert.deepEqual(g1.expectedUnionActivePnus, full.expectedUnionActivePnus);
    assert.equal(g1.expectedUnionActivePnuDigest, full.expectedUnionActivePnuDigest);
    assert.equal(g1.databaseTarget, 'production');
    assert.equal(g1.unionId, full.unionId);
    assert.equal(g1.targetCount, 40);
    assert.equal(g1.expectedPropertyUnitCount, 75);
    assert.equal(g1.expectedUnionActivePropertyUnitCount, 1607);
    assert.equal(g1.expectedUnionActivePnuCount, 1086);
    // G1 에서 뺀 4필지(후속): 791-1934 유닛 identity, 791-4143 관계 채택, 760-50/51 조합 확인.
    for (const pnu of [
        '1130510100107911934',
        '1130510100107914143',
        '1130510100107600050',
        '1130510100107600051',
    ]) {
        assert.ok(excludedSet.has(pnu));
        assert.ok(!g1.anchors.includes(pnu));
    }
    // 제외 목록 entries 는 G1 필지를 옵션 (a) 계열로 분류하고 있어야 한다.
    const entryByPnu = new Map(exclude.entries.map((entry) => [entry.pnu, entry]));
    for (const pnu of g1.anchors) {
        assert.ok(entryByPnu.get(pnu)?.option.startsWith('a'), `${pnu} 는 G1(a) 여야 한다`);
    }
    // digest 핀 — 저장소 함수 재계산 값(2026-09-07).
    assert.equal(
        g1.scopeDigest,
        '13111c6f4e4e425ce710a1ab51f472cd65bbfa7386ac11374e0029f0d3708415'
    );
    assert.equal(
        g1.manifestDigest,
        'e3070b17d96a55be34ea1bc6926e0e28af71e5d6d4c4b145aabb7e7ede62ff5c'
    );
});

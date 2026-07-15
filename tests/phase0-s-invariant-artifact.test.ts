import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    PHASE0_S_ARTIFACT_VERSION,
    PHASE0_S_MEMBER_APPROVAL_VERSION,
    assertDisposableCloneArtifactPair,
    canonicalJson,
    createPhase0SnapshotArtifact,
    hashCanonicalValue,
    parsePhase0MemberImportApproval,
    parsePhase0SnapshotArtifact,
    verifyPhase0InvariantOperation,
    verifyPhase0MemberImport,
    type Phase0MemberImportApproval,
    type Phase0RawUnionSnapshot,
    type JsonValue,
    type SnapshotRow,
} from '../src/verification/phase0-s-artifact';
import {
    PHASE0_S_CLONE_CONFIRMATION,
    PHASE0_S_DEVELOPMENT_CONFIRMATION,
    assertDistinctPhase0UnionSelection,
    assertDisposableCloneTarget,
    capturePhase0CloneArtifact,
    extractMinorParcelSnapshotRows,
} from '../src/verification/phase0-s-clone-reader';

const SHARED_PNU = '1130510100107450062';

function baseUnion(alias: 'A' | 'B'): Phase0RawUnionSnapshot {
    const unionId = `union-${alias.toLowerCase()}`;
    const propertyId = `property-${alias.toLowerCase()}`;
    const ownershipId = `ownership-${alias.toLowerCase()}`;
    return {
        alias,
        unionId,
        propertyUnits: [{
            id: propertyId,
            union_id: unionId,
            pnu: SHARED_PNU,
            previous_pnu: null,
            building_unit_id: null,
            dong: null,
            ho: null,
            property_address_jibun: `주소-${alias}`,
            land_area: 40,
            building_area: null,
            is_deleted: false,
            created_at: '2026-07-15T00:00:00.000Z',
            updated_at: '2026-07-15T00:00:00.000Z',
        }],
        propertyOwnerships: [{
            id: ownershipId,
            union_id: unionId,
            property_unit_id: propertyId,
            user_id: `user-${alias.toLowerCase()}`,
            ownership_type: 'OWNER',
            ownership_ratio: 100,
            is_primary: true,
            is_active: true,
            created_at: '2026-07-15T00:00:00.000Z',
            updated_at: '2026-07-15T00:00:00.000Z',
        }],
        canonicalMemberProperties: [{
            property_ownership_id: ownershipId,
            union_id: unionId,
            id: propertyId,
            official_property_unit_id: propertyId,
            user_id: `user-${alias.toLowerCase()}`,
            pnu: SHARED_PNU,
            property_address_jibun: `주소-${alias}`,
            building_unit_id: null,
            dong: null,
            ho: null,
            is_active: true,
        }],
        minorParcelResults: [
            {
                snapshot_key: `GROUP:member-${alias}`,
                union_id: unionId,
                scope: 'MEMBER_GROUP',
                member_group_id: `member-${alias}`,
                property_unit_id: null,
                property_ownership_id: null,
                result: { status: 'REVIEW_NEEDED' },
            },
            {
                snapshot_key: `UNIT:member-${alias}:${ownershipId}:${propertyId}`,
                union_id: unionId,
                scope: 'PROPERTY_UNIT',
                member_group_id: `member-${alias}`,
                property_unit_id: propertyId,
                property_ownership_id: ownershipId,
                result: {
                    status: 'REVIEW_NEEDED',
                    building_presence_status: 'UNKNOWN',
                },
            },
        ],
        buildingLandLots: [{
            id: 'global-building-lot-shared',
            pnu: SHARED_PNU,
            building_id: 'global-building-1',
            previous_building_id: null,
        }],
        buildingOrphanSummary: [{
            snapshot_key: 'GLOBAL',
            building_count: 1,
            mapped_building_count: 1,
            orphan_count: 0,
            orphan_building_ids: [],
        }, {
            snapshot_key: 'BUILDING:global-building-1',
            building_id: 'global-building-1',
            is_orphan: false,
        }],
    };
}

function cloneRaw<T>(value: T): T {
    return structuredClone(value);
}

function fixtureArtifact(unions: Phase0RawUnionSnapshot[], label: string) {
    return createPhase0SnapshotArtifact({
        source: { kind: 'FIXTURE', label, projectRefHash: null },
        capturedAt: '2026-07-15T00:00:00.000Z',
        unions,
    });
}

function runPhase0Gate(args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/phase0-s-gate.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });
}

test('canonical JSON과 row hash는 object/row 반환 순서와 무관하다', () => {
    assert.equal(canonicalJson({ b: 2, a: { y: true, x: null } }), canonicalJson({ a: { x: null, y: true }, b: 2 }));

    const before = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'before');
    const reversed = [baseUnion('B'), baseUnion('A')];
    reversed.forEach((union) => {
        union.propertyUnits.reverse();
        union.propertyOwnerships.reverse();
    });
    const after = fixtureArtifact(reversed, 'after');
    const result = verifyPhase0InvariantOperation({
        before,
        after,
        operation: 'GIS_SYNC',
        unionAliases: ['A', 'B'],
    });

    assert.equal(result.passed, true);
    assert.equal(result.sharedPnuHashCount, 1);
});

test('GIS/가격 gate는 updated_at 한 컬럼과 타 조합 과소필지 변경도 실패시킨다', () => {
    const beforeRaw = [baseUnion('A'), baseUnion('B')];
    const afterRaw = cloneRaw(beforeRaw);
    afterRaw[0].propertyUnits[0].updated_at = '2026-07-15T01:00:00.000Z';
    (afterRaw[1].minorParcelResults[0].result as Record<string, string>).status = 'CANDIDATE';

    const result = verifyPhase0InvariantOperation({
        before: fixtureArtifact(beforeRaw, 'before'),
        after: fixtureArtifact(afterRaw, 'after'),
        operation: 'APT_PRICE',
        unionAliases: ['A', 'B'],
    });

    assert.equal(result.passed, false);
    assert.ok(result.violations.some((violation) =>
        violation.unionAlias === 'A' && violation.changedColumns?.includes('updated_at')));
    assert.ok(result.violations.some((violation) =>
        violation.unionAlias === 'B' && violation.dataset === 'minorParcelResults'));
});

test('공유 PNU가 없는 fixture는 값이 불변이어도 gate를 통과하지 못한다', () => {
    const unions = [baseUnion('A'), baseUnion('B')];
    unions[1].propertyUnits[0].pnu = '1130510100109999999';
    const artifact = fixtureArtifact(unions, 'missing-shared-pnu');
    const result = verifyPhase0InvariantOperation({
        before: artifact,
        after: artifact,
        operation: 'GIS_SYNC',
        unionAliases: ['A', 'B'],
    });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((violation) => violation.code === 'SHARED_PNU_FIXTURE_MISSING'));
});

test('삭제된 property_units에만 공유 PNU가 있으면 active shared-PNU gate를 통과하지 못한다', () => {
    const unions = [baseUnion('A'), baseUnion('B')];
    unions[0].propertyUnits[0].is_deleted = true;
    unions[1].propertyUnits[0].is_deleted = true;
    const artifact = fixtureArtifact(unions, 'deleted-shared-pnu');
    const result = verifyPhase0InvariantOperation({
        before: artifact,
        after: artifact,
        operation: 'GIS_SYNC',
        unionAliases: ['A', 'B'],
    });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((violation) => violation.code === 'SHARED_PNU_FIXTURE_MISSING'));
});

test('공유 PNU의 6-dataset 관계 coverage가 비거나 무관하면 gate를 fail-closed한다', () => {
    const cases: Array<{
        name: string;
        mutate: (union: Phase0RawUnionSnapshot) => void;
        parserError?: RegExp;
    }> = [
        {
            name: 'active ownership 없음',
            mutate: (union) => { union.propertyOwnerships[0].is_active = false; },
        },
        {
            name: 'canonical ownership 관계 없음',
            mutate: (union) => { union.canonicalMemberProperties[0].property_ownership_id = 'unrelated'; },
        },
        {
            name: 'canonical PNU 관계 없음',
            mutate: (union) => { union.canonicalMemberProperties[0].pnu = '1130510100109999999'; },
        },
        {
            name: 'minor UNIT 없음',
            mutate: (union) => {
                union.minorParcelResults = union.minorParcelResults.filter((row) => row.scope !== 'PROPERTY_UNIT');
            },
        },
        {
            name: 'minor GROUP 없음',
            mutate: (union) => {
                union.minorParcelResults = union.minorParcelResults.filter((row) => row.scope !== 'MEMBER_GROUP');
            },
        },
        {
            name: 'minor UNIT 결과 없음',
            mutate: (union) => {
                const unit = union.minorParcelResults.find((row) => row.scope === 'PROPERTY_UNIT')!;
                unit.result = null;
            },
        },
        {
            name: 'building mapping PNU 무관',
            mutate: (union) => { union.buildingLandLots[0].pnu = '1130510100109999999'; },
        },
        {
            name: 'orphan summary 없음',
            mutate: (union) => { union.buildingOrphanSummary = []; },
            parserError: /exactly one GLOBAL row/,
        },
        {
            name: 'mapping building이 orphan',
            mutate: (union) => {
                union.buildingOrphanSummary[0].orphan_count = 1;
                union.buildingOrphanSummary[0].mapped_building_count = 0;
                union.buildingOrphanSummary[0].orphan_building_ids = ['global-building-1'];
                union.buildingOrphanSummary[1].is_orphan = true;
            },
        },
    ];

    for (const fixtureCase of cases) {
        const unions = [baseUnion('A'), baseUnion('B')];
        fixtureCase.mutate(unions[1]);
        if (fixtureCase.parserError) {
            assert.throws(
                () => fixtureArtifact(unions, fixtureCase.name),
                fixtureCase.parserError,
                fixtureCase.name
            );
            continue;
        }
        const artifact = fixtureArtifact(unions, fixtureCase.name);
        const result = verifyPhase0InvariantOperation({
            before: artifact,
            after: artifact,
            operation: 'GIS_SYNC',
            unionAliases: ['A', 'B'],
        });
        assert.equal(result.passed, false, fixtureCase.name);
        assert.ok(
            result.violations.some((violation) => violation.code === 'SHARED_PNU_FIXTURE_MISSING'),
            fixtureCase.name
        );
    }
});

test('member import는 승인된 property-owned diff와 예상 과소필지 digest만 허용한다', () => {
    const beforeRaw = [baseUnion('A'), baseUnion('B')];
    const afterRaw = cloneRaw(beforeRaw);
    const property = afterRaw[0].propertyUnits[0];
    property.property_address_jibun = '승인된 새 주소-A';
    property.updated_at = '2026-07-15T01:00:00.000Z';
    const ownership = afterRaw[0].propertyOwnerships[0];
    ownership.ownership_ratio = 50;
    ownership.updated_at = '2026-07-15T01:00:00.000Z';
    (afterRaw[0].minorParcelResults[1].result as Record<string, string>).status = 'CANDIDATE';
    afterRaw[0].canonicalMemberProperties[0].property_address_jibun = '승인된 새 주소-A';

    const before = fixtureArtifact(beforeRaw, 'before-member');
    const after = fixtureArtifact(afterRaw, 'after-member');
    const targetAfter = after.unions.find((union) => union.alias === 'A')!;
    const propertyRow = targetAfter.datasets.propertyUnits.rows[0];
    const ownershipRow = targetAfter.datasets.propertyOwnerships.rows[0];
    const approval: Phase0MemberImportApproval = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest: targetAfter.datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: targetAfter.datasets.minorParcelResults.digest,
        changes: [
            {
                dataset: 'propertyUnits',
                operation: 'UPDATE',
                rowKeyHash: propertyRow.keyHash,
                changedColumns: ['property_address_jibun', 'updated_at'],
                matchAfterColumnHashes: {
                    property_address_jibun: propertyRow.columnHashes.property_address_jibun,
                    updated_at: propertyRow.columnHashes.updated_at,
                },
                source: 'PROPERTY_OWNED_INPUT',
            },
            {
                dataset: 'propertyOwnerships',
                operation: 'UPDATE',
                rowKeyHash: ownershipRow.keyHash,
                changedColumns: ['ownership_ratio', 'updated_at'],
                matchAfterColumnHashes: {
                    ownership_ratio: ownershipRow.columnHashes.ownership_ratio,
                    updated_at: ownershipRow.columnHashes.updated_at,
                },
                source: 'PROPERTY_OWNED_INPUT',
            },
        ],
    };

    const result = verifyPhase0MemberImport({ before, after, approval });
    assert.equal(result.passed, true, JSON.stringify(result.violations));
});

test('member import는 shared fixture가 따로 있어도 비공유 PNU의 property_units 승인을 거부한다', () => {
    const beforeRaw = [baseUnion('A'), baseUnion('B')];
    beforeRaw[0].propertyUnits.push({
        ...cloneRaw(beforeRaw[0].propertyUnits[0]),
        id: 'property-a-private',
        pnu: '1130510100109999999',
        property_address_jibun: '비공유 주소-A',
    });
    const afterRaw = cloneRaw(beforeRaw);
    afterRaw[0].propertyUnits[1].property_address_jibun = '승인된 비공유 새 주소-A';

    const before = fixtureArtifact(beforeRaw, 'before-non-shared-property');
    const after = fixtureArtifact(afterRaw, 'after-non-shared-property');
    const targetAfter = after.unions.find((union) => union.alias === 'A')!;
    const propertyRow = targetAfter.datasets.propertyUnits.rows.find(
        (row) => row.columnHashes.id === hashCanonicalValue('property-a-private')
    )!;
    const approval: Phase0MemberImportApproval = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest: targetAfter.datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: targetAfter.datasets.minorParcelResults.digest,
        changes: [{
            dataset: 'propertyUnits',
            operation: 'UPDATE',
            rowKeyHash: propertyRow.keyHash,
            changedColumns: ['property_address_jibun'],
            matchAfterColumnHashes: {
                property_address_jibun: propertyRow.columnHashes.property_address_jibun,
            },
            source: 'PROPERTY_OWNED_INPUT',
        }],
    };

    const result = verifyPhase0MemberImport({ before, after, approval });
    assert.equal(result.sharedPnuHashCount, 1);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((violation) =>
        violation.code === 'MEMBER_IMPORT_CHANGE_OUTSIDE_SHARED_PNU' &&
        violation.dataset === 'propertyUnits'
    ));
});

test('member import는 ownership을 after property chain으로 해소해 비공유 PNU 승인을 거부한다', () => {
    const beforeRaw = [baseUnion('A'), baseUnion('B')];
    beforeRaw[0].propertyUnits.push({
        ...cloneRaw(beforeRaw[0].propertyUnits[0]),
        id: 'property-a-private',
        pnu: '1130510100109999999',
        property_address_jibun: '비공유 주소-A',
    });
    beforeRaw[0].propertyOwnerships.push({
        ...cloneRaw(beforeRaw[0].propertyOwnerships[0]),
        id: 'ownership-a-private',
        property_unit_id: 'property-a-private',
    });
    const afterRaw = cloneRaw(beforeRaw);
    afterRaw[0].propertyOwnerships[1].ownership_ratio = 50;

    const before = fixtureArtifact(beforeRaw, 'before-non-shared-ownership');
    const after = fixtureArtifact(afterRaw, 'after-non-shared-ownership');
    const targetAfter = after.unions.find((union) => union.alias === 'A')!;
    const ownershipRow = targetAfter.datasets.propertyOwnerships.rows.find(
        (row) => row.columnHashes.id === hashCanonicalValue('ownership-a-private')
    )!;
    const approval: Phase0MemberImportApproval = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest: targetAfter.datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: targetAfter.datasets.minorParcelResults.digest,
        changes: [{
            dataset: 'propertyOwnerships',
            operation: 'UPDATE',
            rowKeyHash: ownershipRow.keyHash,
            changedColumns: ['ownership_ratio'],
            matchAfterColumnHashes: {
                ownership_ratio: ownershipRow.columnHashes.ownership_ratio,
            },
            source: 'PROPERTY_OWNED_INPUT',
        }],
    };

    const result = verifyPhase0MemberImport({ before, after, approval });
    assert.equal(result.sharedPnuHashCount, 1);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((violation) =>
        violation.code === 'MEMBER_IMPORT_CHANGE_OUTSIDE_SHARED_PNU' &&
        violation.dataset === 'propertyOwnerships'
    ));
});

test('member import 승인이 있어도 building_unit_id 연결은 항상 차단한다', () => {
    const beforeRaw = [baseUnion('A'), baseUnion('B')];
    const afterRaw = cloneRaw(beforeRaw);
    afterRaw[0].propertyUnits[0].building_unit_id = 'building-unit-unsafe';
    const before = fixtureArtifact(beforeRaw, 'before-member-link');
    const after = fixtureArtifact(afterRaw, 'after-member-link');
    const targetAfter = after.unions.find((union) => union.alias === 'A')!;
    const propertyRow = targetAfter.datasets.propertyUnits.rows[0];
    const approval: Phase0MemberImportApproval = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest: targetAfter.datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: targetAfter.datasets.minorParcelResults.digest,
        changes: [{
            dataset: 'propertyUnits',
            operation: 'UPDATE',
            rowKeyHash: propertyRow.keyHash,
            changedColumns: ['building_unit_id'],
            matchAfterColumnHashes: { building_unit_id: propertyRow.columnHashes.building_unit_id },
            source: 'PROPERTY_OWNED_INPUT',
        }],
    };
    const result = verifyPhase0MemberImport({ before, after, approval });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((violation) => violation.code === 'BUILDING_DERIVED_PROPERTY_FIELDS_FORBIDDEN'));
});

test('member import는 승인에 넣어도 dong/ho와 전역 building mapping/orphan 변경을 거부한다', () => {
    const beforeRaw = [baseUnion('A'), baseUnion('B')];
    const afterRaw = cloneRaw(beforeRaw);
    afterRaw[0].propertyUnits[0].dong = '101';
    for (const union of afterRaw) {
        union.buildingLandLots[0].building_id = 'global-building-2';
        union.buildingOrphanSummary[0].mapped_building_count = 0;
        union.buildingOrphanSummary[0].orphan_count = 1;
        union.buildingOrphanSummary[0].orphan_building_ids = ['global-building-1'];
        union.buildingOrphanSummary[1].is_orphan = true;
    }
    const before = fixtureArtifact(beforeRaw, 'before-member-global');
    const after = fixtureArtifact(afterRaw, 'after-member-global');
    const targetAfter = after.unions.find((union) => union.alias === 'A')!;
    const propertyRow = targetAfter.datasets.propertyUnits.rows[0];
    const approval: Phase0MemberImportApproval = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest: targetAfter.datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: targetAfter.datasets.minorParcelResults.digest,
        changes: [{
            dataset: 'propertyUnits',
            operation: 'UPDATE',
            rowKeyHash: propertyRow.keyHash,
            changedColumns: ['dong'],
            matchAfterColumnHashes: { dong: propertyRow.columnHashes.dong },
            source: 'PROPERTY_OWNED_INPUT',
        }],
    };
    const result = verifyPhase0MemberImport({ before, after, approval });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((violation) =>
        violation.code === 'BUILDING_DERIVED_PROPERTY_FIELDS_FORBIDDEN' &&
        violation.changedColumns?.includes('dong')));
    assert.ok(result.violations.some((violation) => violation.code === 'BUILDING_GLOBAL_STATE_CHANGED'));
    assert.ok(result.violations.some((violation) =>
        violation.code === 'PEER_UNION_CHANGED' && violation.dataset === 'buildingLandLots'));
});

test('artifact parser는 원문 row 필드와 변조된 digest를 거부한다', () => {
    const artifact = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'safe');
    const withRaw = cloneRaw(artifact) as unknown as Record<string, unknown>;
    const unions = withRaw.unions as Array<Record<string, unknown>>;
    const datasets = unions[0].datasets as Record<string, { rows: Array<Record<string, unknown>> }>;
    datasets.propertyUnits.rows[0].raw = { name: '노출 금지' };
    assert.throws(() => parsePhase0SnapshotArtifact(withRaw), /unsupported fields/);

    const tampered = cloneRaw(artifact);
    tampered.unions[0].datasets.propertyUnits.digest = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => parsePhase0SnapshotArtifact(tampered), /digest does not match rows/);

    const missingDataset = cloneRaw(artifact) as unknown as Record<string, unknown>;
    const missingUnions = missingDataset.unions as Array<Record<string, unknown>>;
    delete (missingUnions[0].datasets as Record<string, unknown>).canonicalMemberProperties;
    assert.throws(
        () => parsePhase0SnapshotArtifact(missingDataset),
        /plain JSON object/,
        'required datasets must fail closed instead of silently skipping verification'
    );
});

test('artifact v3는 v1/v2를 묵시적으로 수용하지 않고 위조 rowHash를 거부한다', () => {
    const artifact = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'row-commitment');
    assert.equal(artifact.schemaVersion, 'phase0-s-artifact/v3');
    assert.equal(PHASE0_S_ARTIFACT_VERSION, 'phase0-s-artifact/v3');

    for (const legacyVersion of ['phase0-s-artifact/v1', 'phase0-s-artifact/v2']) {
        const legacy = cloneRaw(artifact) as unknown as Record<string, unknown>;
        legacy.schemaVersion = legacyVersion;
        assert.throws(() => parsePhase0SnapshotArtifact(legacy), /unsupported artifact schemaVersion/);
    }

    const tampered = cloneRaw(artifact);
    tampered.unions[0].datasets.propertyUnits.rows[0].rowHash = `sha256:${'1'.repeat(64)}`;
    assert.throws(
        () => parsePhase0SnapshotArtifact(tampered),
        /rowHash does not commit to columnHashes/
    );
});

test('artifact v3는 유효한 SHA 형식의 위조 columnHash도 commitment 불일치로 거부한다', () => {
    const artifact = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'column-commitment');
    const tampered = cloneRaw(artifact);
    tampered.unions[0].datasets.propertyUnits.rows[0].columnHashes.updated_at =
        `sha256:${'2'.repeat(64)}`;
    assert.throws(
        () => parsePhase0SnapshotArtifact(tampered),
        /rowHash does not commit to columnHashes/
    );
});

test('sharedPnuHashes와 coverage commitment를 유효한 SHA로 위조해도 6-dataset 재계산이 거부한다', () => {
    const artifact = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'coverage-forgery');
    const forged = cloneRaw(artifact);
    forged.unions[0].sharedPnuHashes.push(hashCanonicalValue('forged-pnu'));
    forged.unions[0].sharedPnuHashes.sort();
    forged.unions[0].sharedPnuCoverageCommitment = hashCanonicalValue('forged-commitment');

    assert.throws(
        () => parsePhase0SnapshotArtifact(forged),
        /sharedPnuHashes do not match 6-dataset coverage/
    );

    const commitmentOnly = cloneRaw(artifact);
    commitmentOnly.unions[0].sharedPnuCoverageCommitment = hashCanonicalValue('forged-commitment');
    assert.throws(
        () => parsePhase0SnapshotArtifact(commitmentOnly),
        /sharedPnuCoverageCommitment does not match datasets/
    );
});

test('building orphan GLOBAL 행을 non-orphan status로 위장해 shared PNU coverage를 만들 수 없다', () => {
    const unions = [baseUnion('A'), baseUnion('B')];
    for (const union of unions) {
        union.buildingLandLots[0].building_id = 'dangling-mapped-building';
        union.buildingOrphanSummary[0].mapped_building_count = 0;
        union.buildingOrphanSummary[0].orphan_count = 1;
        union.buildingOrphanSummary[0].orphan_building_ids = ['global-building-1'];
        union.buildingOrphanSummary[1].is_orphan = true;
        union.buildingOrphanSummary[0].building_id = 'dangling-mapped-building';
        union.buildingOrphanSummary[0].is_orphan = false;
    }

    assert.throws(
        () => fixtureArtifact(unions, 'global-building-status-injection'),
        /GLOBAL row cannot contain building status fields/
    );
});

test('verifier 직접 호출도 columnHash 위조로 changedColumns를 숨기는 false-green을 차단한다', () => {
    const before = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'false-green-before');
    const after = cloneRaw(before);
    // rowHash/dataset digest를 그대로 둔 채 column hash만 바꾸면 과거 구현은 동일 row로 건너뛸 수 있었다.
    after.unions[0].datasets.propertyUnits.rows[0].columnHashes.updated_at =
        `sha256:${'3'.repeat(64)}`;

    assert.throws(
        () => verifyPhase0InvariantOperation({
            before,
            after,
            operation: 'ADVERSARIAL_FALSE_GREEN',
            unionAliases: ['A', 'B'],
        }),
        /rowHash does not commit to columnHashes/
    );
});

test('member approval parser도 최상위와 change의 미승인 필드를 fail-closed한다', () => {
    const artifact = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'approval-parser');
    const target = artifact.unions.find((union) => union.alias === 'A')!;
    const valid = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest: target.datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: target.datasets.minorParcelResults.digest,
        changes: [{
            dataset: 'propertyUnits',
            operation: 'UPDATE',
            rowKeyHash: target.datasets.propertyUnits.rows[0].keyHash,
            changedColumns: ['updated_at'],
            matchAfterColumnHashes: {
                updated_at: target.datasets.propertyUnits.rows[0].columnHashes.updated_at,
            },
            source: 'PROPERTY_OWNED_INPUT',
        }],
    };

    const legacyApproval = cloneRaw(valid) as unknown as Record<string, unknown>;
    legacyApproval.schemaVersion = 'phase0-s-member-approval/v1';
    assert.throws(
        () => parsePhase0MemberImportApproval(legacyApproval),
        /unsupported approval schemaVersion/
    );

    assert.throws(
        () => parsePhase0MemberImportApproval({ ...valid, rawRows: [] }),
        /unsupported fields/
    );
    const changeWithRaw = cloneRaw(valid);
    (changeWithRaw.changes[0] as unknown as Record<string, unknown>).raw = { pnu: SHARED_PNU };
    assert.throws(() => parsePhase0MemberImportApproval(changeWithRaw), /unsupported fields/);
});

test('member approval은 UPDATE/INSERT changedColumns 전체 after hash를 exact하게 요구한다', () => {
    const artifact = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'approval-exact-hashes');
    const target = artifact.unions.find((union) => union.alias === 'A')!;
    const baseApproval = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest: target.datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: target.datasets.minorParcelResults.digest,
        changes: [{
            dataset: 'propertyUnits',
            operation: 'UPDATE',
            rowKeyHash: target.datasets.propertyUnits.rows[0].keyHash,
            changedColumns: ['property_address_jibun', 'updated_at'],
            matchAfterColumnHashes: {
                property_address_jibun: target.datasets.propertyUnits.rows[0].columnHashes.property_address_jibun,
                updated_at: target.datasets.propertyUnits.rows[0].columnHashes.updated_at,
            },
            source: 'PROPERTY_OWNED_INPUT',
        }],
    };
    assert.doesNotThrow(() => parsePhase0MemberImportApproval(baseApproval));

    const missingHashes = cloneRaw(baseApproval) as unknown as Record<string, unknown>;
    delete ((missingHashes.changes as Array<Record<string, unknown>>)[0]).matchAfterColumnHashes;
    assert.throws(
        () => parsePhase0MemberImportApproval(missingHashes),
        /matchAfterColumnHashes must be a plain JSON object/
    );

    const partialUpdate = cloneRaw(baseApproval);
    delete partialUpdate.changes[0].matchAfterColumnHashes.updated_at;
    assert.throws(
        () => parsePhase0MemberImportApproval(partialUpdate),
        /must cover every changed column exactly/
    );

    const partialInsert = cloneRaw(baseApproval);
    partialInsert.changes[0].operation = 'INSERT';
    delete partialInsert.changes[0].matchAfterColumnHashes.updated_at;
    assert.throws(
        () => parsePhase0MemberImportApproval(partialInsert),
        /must cover every changed column exactly/
    );
});

test('member approval의 row/columns가 맞아도 expected after 값이 다르면 overwrite를 거부한다', () => {
    const beforeRaw = [baseUnion('A'), baseUnion('B')];
    const afterRaw = cloneRaw(beforeRaw);
    afterRaw[0].propertyUnits[0].property_address_jibun = '실제 입력값';
    const before = fixtureArtifact(beforeRaw, 'approval-value-before');
    const after = fixtureArtifact(afterRaw, 'approval-value-after');
    const targetAfter = after.unions.find((union) => union.alias === 'A')!;
    const approval: Phase0MemberImportApproval = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest: targetAfter.datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: targetAfter.datasets.minorParcelResults.digest,
        changes: [{
            dataset: 'propertyUnits',
            operation: 'UPDATE',
            rowKeyHash: targetAfter.datasets.propertyUnits.rows[0].keyHash,
            changedColumns: ['property_address_jibun'],
            matchAfterColumnHashes: {
                property_address_jibun: hashCanonicalValue('승인과 다른 값'),
            },
            source: 'PROPERTY_OWNED_INPUT',
        }],
    };

    const result = verifyPhase0MemberImport({ before, after, approval });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((violation) => violation.code === 'UNAPPROVED_MEMBER_DIFF'));
});

test('clone target gate는 운영 project/ref와 일반 외부 주소를 차단한다', () => {
    assert.throws(() => assertDisposableCloneTarget({
        url: 'https://prodref.supabase.co',
        confirmation: PHASE0_S_CLONE_CONFIRMATION,
        cloneProjectRef: 'prodref',
        productionProjectRef: 'prodref',
    }), /운영 project ref/);

    assert.throws(() => assertDisposableCloneTarget({
        url: 'https://db.example.com',
        confirmation: PHASE0_S_CLONE_CONFIRMATION,
        cloneProjectRef: 'clone',
        productionProjectRef: 'prod',
    }), /disposable clone/);

    const allowed = assertDisposableCloneTarget({
        url: 'https://cloneref.supabase.co',
        confirmation: PHASE0_S_CLONE_CONFIRMATION,
        cloneProjectRef: 'cloneref',
        productionProjectRef: 'prodref',
    });
    assert.equal(allowed.projectRef, 'cloneref');
    assert.equal(allowed.sourceKind, 'DISPOSABLE_CLONE');

    const development = assertDisposableCloneTarget({
        url: 'https://devref.supabase.co',
        confirmation: PHASE0_S_DEVELOPMENT_CONFIRMATION,
        cloneProjectRef: 'devref',
        productionProjectRef: 'prodref',
    });
    assert.equal(development.projectRef, 'devref');
    assert.equal(development.sourceKind, 'DEVELOPMENT_PROJECT');
});

test('capture/parser/verifier는 서로 다른 alias가 같은 조합 identity를 가리키는 것을 거부한다', () => {
    assert.throws(
        () => assertDistinctPhase0UnionSelection([
            { alias: 'A', unionId: 'same-union' },
            { alias: 'B', unionId: 'same-union' },
        ]),
        /identities must be pairwise distinct/
    );

    const duplicateRaw = [baseUnion('A'), baseUnion('B')];
    duplicateRaw[1].unionId = duplicateRaw[0].unionId;
    for (const dataset of [
        duplicateRaw[1].propertyUnits,
        duplicateRaw[1].propertyOwnerships,
        duplicateRaw[1].canonicalMemberProperties,
        duplicateRaw[1].minorParcelResults,
    ]) {
        dataset.forEach((row) => { row.union_id = duplicateRaw[0].unionId; });
    }
    assert.throws(
        () => fixtureArtifact(duplicateRaw, 'duplicate-union-capture'),
        /captured union identities must be pairwise distinct/
    );

    const artifact = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'duplicate-union-artifact');
    const tampered = cloneRaw(artifact);
    tampered.unions[1].unionIdHash = tampered.unions[0].unionIdHash;
    assert.throws(
        () => parsePhase0SnapshotArtifact(tampered),
        /artifact union identities must be pairwise distinct/
    );
    assert.throws(
        () => verifyPhase0InvariantOperation({
            before: tampered,
            after: tampered,
            operation: 'GIS_SYNC',
            unionAliases: ['A', 'B'],
        }),
        /artifact union identities must be pairwise distinct/
    );

    const approval: Phase0MemberImportApproval = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest:
            tampered.unions[0].datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: tampered.unions[0].datasets.minorParcelResults.digest,
        changes: [],
    };
    assert.throws(
        () => verifyPhase0MemberImport({ before: tampered, after: tampered, approval }),
        /artifact union identities must be pairwise distinct/
    );
});

test('capture CLI는 --union A=<same-id> --union B=<same-id>를 DB 접속 전에 거부한다', () => {
    const result = runPhase0Gate([
        'capture',
        '--union', 'A=same-union',
        '--union', 'B=same-union',
        '--out', '.phase0-s/duplicate-union.json',
        '--label', 'duplicate-union',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /capture union identities must be pairwise distinct/);
});

test('verify CLI 2종은 내부 verifier가 green인 FIXTURE before/after pair도 거부한다', () => {
    const artifact = fixtureArtifact([baseUnion('A'), baseUnion('B')], 'cli-fixture');
    const target = artifact.unions.find((union) => union.alias === 'A')!;
    const approval: Phase0MemberImportApproval = {
        schemaVersion: PHASE0_S_MEMBER_APPROVAL_VERSION,
        targetAlias: 'A',
        peerAliases: ['B'],
        expectedTargetCanonicalMemberPropertiesDigest: target.datasets.canonicalMemberProperties.digest,
        expectedTargetMinorParcelDigest: target.datasets.minorParcelResults.digest,
        changes: [],
    };
    assert.equal(verifyPhase0InvariantOperation({
        before: artifact,
        after: artifact,
        operation: 'GIS_SYNC',
        unionAliases: ['A', 'B'],
    }).passed, true);
    assert.equal(verifyPhase0MemberImport({ before: artifact, after: artifact, approval }).passed, true);
    assert.throws(
        () => assertDisposableCloneArtifactPair(artifact, artifact),
        /requires non-production database/
    );

    const directory = mkdtempSync(join(tmpdir(), 'phase0-s-cli-'));
    try {
        const beforePath = join(directory, 'before.json');
        const afterPath = join(directory, 'after.json');
        const approvalPath = join(directory, 'approval.json');
        writeFileSync(beforePath, JSON.stringify(artifact));
        writeFileSync(afterPath, JSON.stringify(artifact));
        writeFileSync(approvalPath, JSON.stringify(approval));

        const invariant = runPhase0Gate([
            'verify-invariant',
            '--before', beforePath,
            '--after', afterPath,
            '--operation', 'GIS_SYNC',
            '--union', 'A',
            '--union', 'B',
        ]);
        assert.equal(invariant.status, 1);
        assert.match(invariant.stderr, /requires non-production database/);

        const memberImport = runPhase0Gate([
            'verify-member-import',
            '--before', beforePath,
            '--after', afterPath,
            '--approval', approvalPath,
        ]);
        assert.equal(memberImport.status, 1);
        assert.match(memberImport.stderr, /requires non-production database/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verify CLI source gate는 disposable clone projectRefHash가 다르면 거부한다', () => {
    const before = createPhase0SnapshotArtifact({
        source: {
            kind: 'DISPOSABLE_CLONE',
            label: 'clone-before',
            projectRefHash: hashCanonicalValue('project:clone-a'),
        },
        capturedAt: '2026-07-15T00:00:00.000Z',
        unions: [baseUnion('A'), baseUnion('B')],
    });
    const after = createPhase0SnapshotArtifact({
        source: {
            kind: 'DISPOSABLE_CLONE',
            label: 'clone-after',
            projectRefHash: hashCanonicalValue('project:clone-b'),
        },
        capturedAt: '2026-07-15T00:00:00.000Z',
        unions: [baseUnion('A'), baseUnion('B')],
    });
    assert.throws(
        () => assertDisposableCloneArtifactPair(before, after),
        /matching non-null non-production projectRefHash/
    );
});

test('verify CLI source gate는 개발 프로젝트 artifact끼리만 비교한다', () => {
    const before = createPhase0SnapshotArtifact({
        source: {
            kind: 'DEVELOPMENT_PROJECT',
            label: 'dev-before',
            projectRefHash: hashCanonicalValue('project:dev-a'),
        },
        capturedAt: '2026-07-15T00:00:00.000Z',
        unions: [baseUnion('A'), baseUnion('B')],
    });
    const after = createPhase0SnapshotArtifact({
        source: {
            kind: 'DEVELOPMENT_PROJECT',
            label: 'dev-after',
            projectRefHash: hashCanonicalValue('project:dev-a'),
        },
        capturedAt: '2026-07-15T00:00:00.000Z',
        unions: [baseUnion('A'), baseUnion('B')],
    });
    assert.doesNotThrow(() => assertDisposableCloneArtifactPair(before, after));

    const disposableAfter = structuredClone(after);
    disposableAfter.source.kind = 'DISPOSABLE_CLONE';
    assert.throws(
        () => assertDisposableCloneArtifactPair(before, disposableAfter),
        /matching non-production database source kinds/
    );
});

test('minor-parcel RPC에서 unit 결과와 group summary를 stable row로 추출한다', () => {
    const rows = extractMinorParcelSnapshotRows('union-a', [{
        id: 'member-a',
        minor_parcel_review: { status: 'REVIEW_NEEDED' },
        property_units: [{
            id: 'canonical-property-a',
            official_property_unit_id: 'property-a',
            property_ownership_id: 'ownership-a',
            minor_parcel_phase1: { status: 'CANDIDATE' },
        }],
    }]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].snapshot_key, 'GROUP:member-a');
    assert.equal(rows[1].snapshot_key, 'UNIT:member-a:ownership-a:property-a');
    assert.deepEqual(rows[1].result, { status: 'CANDIDATE' });
});

test('clone reader는 필수 6개 dataset을 읽고 artifact에 원문 값을 남기지 않는다', async () => {
    const tableRows: Record<string, SnapshotRow[]> = {
        property_units: [
            { id: 'property-a', union_id: 'union-a', pnu: SHARED_PNU, is_deleted: false, building_unit_id: null, dong: null, ho: null },
            { id: 'property-b', union_id: 'union-b', pnu: SHARED_PNU, is_deleted: false, building_unit_id: null, dong: null, ho: null },
        ],
        property_ownerships: [
            { id: 'ownership-a', union_id: 'union-a', property_unit_id: 'property-a', is_active: true },
            { id: 'ownership-b', union_id: 'union-b', property_unit_id: 'property-b', is_active: true },
        ],
        v_member_property_units_canonical: [
            { id: 'ownership-a', property_ownership_id: 'ownership-a', official_property_unit_id: 'property-a', pnu: SHARED_PNU, is_active: true },
            { id: 'ownership-b', property_ownership_id: 'ownership-b', official_property_unit_id: 'property-b', pnu: SHARED_PNU, is_active: true },
        ],
        building_land_lots: [
            { id: 'mapping-1', pnu: SHARED_PNU, building_id: 'building-1' },
        ],
        buildings: [
            { id: 'building-1' },
            { id: 'building-orphan' },
        ],
    };

    const fakeClient = {
        from(table: string) {
            let rows = tableRows[table] ?? [];
            const builder: Record<string, unknown> & PromiseLike<{ data: SnapshotRow[]; error: null }> = {
                select: () => builder,
                eq: (column: string, value: JsonValue) => {
                    rows = rows.filter((row) => row[column] === value);
                    return builder;
                },
                in: (column: string, values: JsonValue[]) => {
                    rows = rows.filter((row) => values.includes(row[column]));
                    return builder;
                },
                order: () => builder,
                range: (from: number, to: number) => {
                    rows = rows.slice(from, to + 1);
                    return builder;
                },
                then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
            };
            return builder;
        },
        async rpc(_name: string, args: Record<string, JsonValue>) {
            const unionId = String(args.p_union_id);
            const suffix = unionId.endsWith('a') ? 'a' : 'b';
            return {
                data: {
                    total_count: 1,
                    rows: [{
                        id: `member-${suffix}`,
                        minor_parcel_review: { status: 'REVIEW_NEEDED' },
                        property_units: [{
                            id: `property-${suffix}`,
                            official_property_unit_id: `property-${suffix}`,
                            property_ownership_id: `ownership-${suffix}`,
                            minor_parcel_phase1: { status: 'REVIEW_NEEDED' },
                        }],
                    }],
                },
                error: null,
            };
        },
    } as unknown as SupabaseClient;

    const artifact = await capturePhase0CloneArtifact({
        client: fakeClient,
        projectRef: 'clone-ref',
        label: 'fixture-capture',
        capturedAt: '2026-07-15T00:00:00.000Z',
        unions: [
            { alias: 'A', unionId: 'union-a' },
            { alias: 'B', unionId: 'union-b' },
        ],
    });
    const unionA = artifact.unions.find((union) => union.alias === 'A')!;
    assert.deepEqual(Object.keys(unionA.datasets).sort(), [
        'buildingLandLots',
        'buildingOrphanSummary',
        'canonicalMemberProperties',
        'minorParcelResults',
        'propertyOwnerships',
        'propertyUnits',
    ]);
    assert.equal(unionA.datasets.buildingOrphanSummary.rowCount, 3);
    assert.equal(unionA.sharedPnuHashes.length, 1);

    const serialized = JSON.stringify(artifact);
    assert.equal(serialized.includes(SHARED_PNU), false);
    assert.equal(serialized.includes('union-a'), false);
    assert.equal(serialized.includes('building-orphan'), false);
});

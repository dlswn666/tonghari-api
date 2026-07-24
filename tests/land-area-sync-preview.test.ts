import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildScopeSnapshot,
    sanitizeIssue,
    capIssues,
    mapClsSeCodeToSourceState,
    normalizeFloorLabel,
    buildScopeEvidence,
} from '../src/services/land-area-sync/preview';
import type { BylotResolution } from '../src/services/land-area-sync/bylot';
import type { DbScopeResolution } from '../src/services/land-area-sync/scope';
import type { LandAreaSyncIssue } from '../src/types/land-area-sync-job.types';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const PNU = '1168010100107360024';

const bylot: BylotResolution = {
    expectedPks: ['PKB', 'PKA'],
    evidence: [
        { mgmBldrgstPk: 'PKB', source: 'TITLE', rawValue: '2', count: 2, crossCheckState: 'TITLE_ONLY' },
        { mgmBldrgstPk: 'PKA', source: 'TITLE', rawValue: '0', count: 0, crossCheckState: 'TITLE_ONLY' },
    ],
    status: 'RESOLVED',
    issues: [],
};

test('buildScopeSnapshot: 3층 hash·정렬 candidate·정렬 bylotEvidence 를 고정한다', () => {
    const snapshot = buildScopeSnapshot({
        strategy: 'LDAREG',
        frozenAt: '2026-07-23T00:00:00.000Z',
        scannedPnus: [PNU],
        resolverRootPks: ['PK-UP', 'PK-UP', 'PK-A'],
        bylot,
        dbScopeHash: 'db-hash',
        externalScopeDigest: 'ext-digest',
        propertyMembership: [{ propertyUnitId: UUID_A, pnu: PNU, buildingUnitId: null }],
        candidatePropertyUnitIds: [UUID_A, UUID_A],
        currentLandTuples: [{ propertyUnitId: UUID_A, landArea: '10', source: 'MANUAL' }],
        proposedLandAreas: [{ propertyUnitId: UUID_A, landArea: '21.3' }],
        ladfrlAreaEvidence: {
            parcels: [{ pnu: PNU, area: '100.5' }],
            totalArea: '100.5',
        },
        replicationEvidence: {
            canonicalSourcePnu: PNU,
            comparedPnus: [PNU],
            exactReplica: true,
            rowCount: 1,
            rowMultisetDigest: 'a'.repeat(64),
        },
        componentMatchDigest: [],
        projectionItems: [{ propertyUnitId: UUID_A }],
    });
    assert.match(snapshot.scopeHash, /^[0-9a-f]{64}$/);
    assert.match(snapshot.propertyMembershipHash, /^[0-9a-f]{64}$/);
    assert.match(snapshot.projectionInputDigest, /^[0-9a-f]{64}$/);
    assert.equal(snapshot.dbScopeHash, 'db-hash');
    assert.equal(snapshot.externalScopeDigest, 'ext-digest');
    assert.deepEqual(snapshot.candidatePropertyUnitIds, [UUID_A]); // distinct + sorted
    assert.deepEqual(snapshot.bylotEvidence.map((e) => e.mgmBldrgstPk), ['PKA', 'PKB']); // sorted
    // C1: resolverRootPks 는 정렬·dedup 되어 고정된다(웹 [5.3] 재검증 계약 입력).
    assert.deepEqual(snapshot.resolverRootPks, ['PK-A', 'PK-UP']);
    assert.equal(snapshot.canonicalVersion, 2);
    assert.deepEqual(snapshot.ladfrlAreaEvidence, {
        version: 'land-area-sync.ladfrl-scope.v1',
        parcels: [{ pnu: PNU, area: '100.5' }],
        totalArea: '100.5',
    });
    assert.deepEqual(snapshot.replicationEvidence, {
        version: 'land-area-sync.ldareg-replication.v2',
        canonicalSourcePnu: PNU,
        comparedPnus: [PNU],
        exactReplica: true,
        rowCount: 1,
        rowMultisetDigest: 'a'.repeat(64),
    });
});

test('sanitizeIssue: allowlist 밖 필드(소유자명 등)는 제거하고 code·PNU·UUID·동/호만 남긴다', () => {
    const dirty = {
        code: 'RATIO_PARSE_FAILED',
        propertyUnitId: UUID_A,
        targetPnu: PNU,
        dong: '가',
        ho: '301',
        ownerName: '홍길동',
        rawResponse: '{...}',
    } as unknown as LandAreaSyncIssue;
    const clean = sanitizeIssue(dirty);
    assert.deepEqual(clean, { code: 'RATIO_PARSE_FAILED', propertyUnitId: UUID_A, targetPnu: PNU, dong: '가', ho: '301' });
    assert.ok(!('ownerName' in clean));
    assert.ok(!('rawResponse' in clean));
});

test('sanitizeIssue: 형식이 틀린 UUID·PNU 는 통과시키지 않는다', () => {
    const clean = sanitizeIssue({ code: 'PROPERTY_UNIT_NOT_FOUND', propertyUnitId: 'not-a-uuid', targetPnu: '123' } as LandAreaSyncIssue);
    assert.deepEqual(clean, { code: 'PROPERTY_UNIT_NOT_FOUND' });
});

test('capIssues: 200 초과는 절단하고 total·truncated 를 보고한다', () => {
    const many: LandAreaSyncIssue[] = Array.from({ length: 250 }, () => ({ code: 'RATIO_PARSE_FAILED' }));
    const capped = capIssues(many);
    assert.equal(capped.issues.length, 200);
    assert.equal(capped.issuesTotal, 250);
    assert.equal(capped.issuesTruncated, true);
});

test('mapClsSeCodeToSourceState: 명확 말소만 CLOSED, 공란/유효는 CURRENT, 불명확은 CURRENT+ambiguous', () => {
    assert.deepEqual(mapClsSeCodeToSourceState('', ''), { state: 'CURRENT', ambiguous: false });
    assert.deepEqual(mapClsSeCodeToSourceState('0', '유효'), { state: 'CURRENT', ambiguous: false });
    assert.deepEqual(mapClsSeCodeToSourceState('2', ''), { state: 'CLOSED', ambiguous: false });
    assert.deepEqual(mapClsSeCodeToSourceState('', '말소'), { state: 'CLOSED', ambiguous: false });
    assert.deepEqual(mapClsSeCodeToSourceState('X7', 'ZZZ'), { state: 'CURRENT', ambiguous: true });
});

test('normalizeFloorLabel: integer 층 ↔ "N층" 표기를 동일 key 로 맞춘다', () => {
    assert.equal(normalizeFloorLabel('3층'), '3');
    assert.equal(normalizeFloorLabel(3), '3');
    assert.equal(normalizeFloorLabel('03'), '3');
    assert.equal(normalizeFloorLabel(null), '');
});

test('buildScopeEvidence: DB resolver evidence key 수와 attached 파생값을 투영한다', () => {
    const dbScope = {
        linkedEvidenceKeys: ['a', 'b'],
        pendingEvidenceKeys: [],
        blockingEvidence: [{ sourceKind: 'x', sourceId: '1', state: 's' }],
        openUnresolvedEvidenceKeys: ['u'],
        componentPnus: [PNU],
    } as unknown as DbScopeResolution;
    const ev = buildScopeEvidence(dbScope, { attachedRows: 5, distinctAttachedPnuCount: 3 });
    assert.equal(ev.linkedRelationCount, 2);
    assert.equal(ev.blockingEvidenceCount, 1);
    assert.equal(ev.openUnresolvedCount, 1);
    assert.equal(ev.componentPnuCount, 1);
    assert.equal(ev.attachedRows, 5);
    assert.equal(ev.distinctAttachedPnuCount, 3);
});

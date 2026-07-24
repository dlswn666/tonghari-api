import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import {
    DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION,
    DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
    DEVELOPMENT_GIS_JWT_TTL_SECONDS,
    DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS,
    DEVELOPMENT_TARGET_MANIFEST_VERSION,
    LocalhostDevelopmentLandAreaSyncClient,
    computeDevelopmentTargetDigest,
    createDevelopmentGisSystemAdminJwt,
    parseDevelopmentDbApprovalManifest,
    parseDevelopmentEvidenceManifest,
    parseDevelopmentTargetManifest,
    runDevelopmentLandAreaSync,
    validateDevelopmentRunArtifact,
    validateDevelopmentRunnerEnvironment,
    validateDevelopmentRunnerManifests,
    type DevelopmentDbApprovalManifest,
    type DevelopmentEvidenceEntry,
    type DevelopmentEvidenceManifest,
    type DevelopmentReadOnlyPreflightReader,
    type DevelopmentTargetManifest,
    type LandAreaSyncApiClient,
    type LandAreaSyncApiJob,
} from '../src/operations/development-land-area-sync-runner';
import type { LandAreaSyncScopeSnapshot } from '../src/types/land-area-sync-job.types';

const UNION_ID = '00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9';
const ACTOR_AUTH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPERTY_UNIT_ID = '5a1a4cbb-c8ad-45a3-ae40-b90665dc949c';
const PNU = '1130510100107912166';
const SECOND_PNU = '1130510100107912167';
const DISCOVERY_JOB_ID = '11111111-1111-4111-8111-111111111111';
const APPLY_JOB_ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const REPRESENTATIVE_EVIDENCE_MANIFEST_URL = new URL(
    '../development-land-area-sync-manifests/mia-seven-representative-evidence-20260725.json',
    import.meta.url
);

function sha256Utf8(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function target(pnus = [PNU], expectedPropertyUnitCount = 1): DevelopmentTargetManifest {
    return {
        version: DEVELOPMENT_TARGET_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: UNION_ID,
        pnus,
        targetCount: pnus.length,
        manifestDigest: computeDevelopmentTargetDigest(UNION_ID, pnus),
        expectedPropertyUnitCount,
        expectedUnionActivePropertyUnitCount: expectedPropertyUnitCount,
        expectedUnionActivePnuCount: pnus.length,
    };
}

function approval(
    targetManifest: DevelopmentTargetManifest
): DevelopmentDbApprovalManifest {
    return {
        version: DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: targetManifest.unionId,
        pnus: targetManifest.pnus,
        targetCount: targetManifest.targetCount,
        manifestDigest: targetManifest.manifestDigest,
        enabled: true,
    };
}

function evidenceEntry(
    pnu = PNU,
    propertyUnitId = PROPERTY_UNIT_ID
): DevelopmentEvidenceEntry {
    return {
        anchorPnu: pnu,
        expectedStrategy: 'LADFRL',
        expectedScannedPnus: [pnu],
        expectedPropertyUnitIds: [propertyUnitId],
        expectedProposedLandAreas: [
            { propertyUnitId, landArea: '161' },
        ],
        expectedLadfrlAreaEvidence: {
            parcels: [{ pnu, area: '161' }],
            totalArea: '161',
        },
        allowedPrestates: [
            {
                propertyUnitId,
                landArea: null,
                landAreaSource: 'LEGACY_UNKNOWN',
            },
            {
                propertyUnitId,
                landArea: '161',
                landAreaSource: 'LADFRL',
            },
        ],
        parcelScopeEvidence: {
            kind: 'OTHER',
            ref: `sheet=s;cells=E29,F29;sha256=${HASH}`,
        },
        landOwnershipEvidence: {
            kind: 'OTHER',
            ref: `sheet=s;cells=E29,F29;sha256=${HASH}`,
        },
        allowManualOverwrite: false,
        sourceReferences: {
            workbookFileReferenceSha256: HASH,
            sheet: '미아791',
            cells: ['E29', 'F29'],
            selectedCellsReferenceSha256: HASH,
            phase0RunId: '30105293359',
            phase0ArtifactReferenceSha256: HASH,
            phase0ObservationReferenceSha256: HASH,
            developmentObservationReferenceSha256: HASH,
        },
    };
}

function preflightReader(
    entries: DevelopmentEvidenceEntry[],
    initiallyApplied = false,
    writerJobId = APPLY_JOB_ID
): DevelopmentReadOnlyPreflightReader {
    let reads = 0;
    return {
        async readActivePropertyUnits() {
            reads += 1;
            const applied = initiallyApplied || reads > 1;
            return entries.flatMap((entry) =>
                entry.expectedPropertyUnitIds.map((id) => ({
                    id,
                    pnu: entry.anchorPnu,
                    landArea: applied ? '161' : null,
                    landAreaSource: applied
                        ? (entry.expectedStrategy as 'LADFRL')
                        : ('LEGACY_UNKNOWN' as const),
                    landAreaSyncedAt: applied
                        ? '2026-07-25T00:01:00.000Z'
                        : null,
                    landAreaSyncJobId: applied ? writerJobId : null,
                }))
            );
        },
        async readPropertyUnitsBySyncJobIds() {
            return entries.flatMap((entry) =>
                entry.expectedPropertyUnitIds.map((id) => ({
                    id,
                    unionId: UNION_ID,
                    landAreaSyncJobId: writerJobId,
                }))
            );
        },
    };
}

function evidence(
    targetManifest: DevelopmentTargetManifest,
    entries = [evidenceEntry()]
): DevelopmentEvidenceManifest {
    return {
        version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: targetManifest.unionId,
        manifestDigest: targetManifest.manifestDigest,
        entries,
    };
}

function snapshot(
    pnu = PNU,
    propertyUnitId = PROPERTY_UNIT_ID
): LandAreaSyncScopeSnapshot {
    return {
        frozenAt: '2026-07-25T00:00:00.000Z',
        strategy: 'LADFRL',
        scannedPnus: [pnu],
        resolverRootPks: ['root'],
        bylotSourcePolicy: 'TITLE_WITH_BASIS_FALLBACK',
        bylotEvidence: [],
        dbScopeHash: '1'.repeat(64),
        externalScopeDigest: '2'.repeat(64),
        scopeHash: '3'.repeat(64),
        candidatePropertyUnitIds: [propertyUnitId],
        propertyMembershipHash: '4'.repeat(64),
        currentLandTuples: [],
        proposedLandAreas: [{ propertyUnitId, landArea: '161' }],
        ladfrlAreaEvidence: {
            version: 'land-area-sync.ladfrl-scope.v1',
            parcels: [{ pnu, area: '161' }],
            totalArea: '161',
        },
        replicationEvidence: null,
        projectionInputDigest: '5'.repeat(64),
        canonicalVersion: 1,
    };
}

function job(
    id: string,
    input: {
        status: LandAreaSyncApiJob['status'];
        scopeState: NonNullable<
            LandAreaSyncApiJob['landAreaSync']
        >['scopeState'];
        outcome: NonNullable<
            LandAreaSyncApiJob['landAreaSync']
        >['outcome'];
        sourceDiscoveryJobId?: string | null;
        scopeSnapshot?: LandAreaSyncScopeSnapshot | null;
        issueCodes?: string[];
    }
): LandAreaSyncApiJob {
    return {
        jobId: id,
        unionId: UNION_ID,
        status: input.status,
        progress: input.status === 'PROCESSING' ? 50 : 100,
        landAreaSync: {
            anchorPnu: PNU,
            sourceDiscoveryJobId:
                input.sourceDiscoveryJobId === undefined
                    ? null
                    : input.sourceDiscoveryJobId,
            scopeState: input.scopeState,
            scopeSnapshot:
                input.scopeSnapshot === undefined
                    ? snapshot()
                    : input.scopeSnapshot,
            branch: 'LADFRL',
            outcome: input.outcome,
            counts: {
                updatedPropertyUnits: input.outcome === 'APPLIED' ? 1 : 0,
                unchangedPropertyUnits: 0,
            },
            issues: (input.issueCodes ?? []).map((code) => ({ code })),
            issuesTotal: input.issueCodes?.length ?? 0,
        },
    };
}

test('대표 evidence reference digest는 문서화된 PII-free canonical preimage와 실제 Phase 0 artifact hash를 고정한다', () => {
    const manifest = parseDevelopmentEvidenceManifest(
        JSON.parse(
            readFileSync(REPRESENTATIVE_EVIDENCE_MANIFEST_URL, 'utf8')
        )
    );
    const sources = manifest.entries[0].sourceReferences;
    const selectedCellsPreimage =
        '{"cells":{"E29":"791-2166","F29":"161"},"sheet":"미아791"}';
    const phase0ObservationPreimage =
        '{"landArea":"161","pnu":"1130510100107912166","runId":"30105293359","strategy":"LADFRL"}';
    const developmentObservationPreimage =
        '{"landLotsArea":"161","pnu":"1130510100107912166","propertyUnitId":"5a1a4cbb-c8ad-45a3-ae40-b90665dc949c","unionId":"00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9"}';

    assert.equal(
        sources.selectedCellsReferenceSha256,
        sha256Utf8(selectedCellsPreimage)
    );
    assert.equal(
        sources.phase0ObservationReferenceSha256,
        sha256Utf8(phase0ObservationPreimage)
    );
    assert.equal(
        sources.developmentObservationReferenceSha256,
        sha256Utf8(developmentObservationPreimage)
    );
    assert.equal(
        sources.phase0ArtifactReferenceSha256,
        '63dc038ffb83ef923a1f760f812271d1d27168aa7c8f5105c2f24b00d7ff167b'
    );
});

test('개발 GIS JWT는 kid/dev claims와 정확한 10분 TTL을 고정하고 auth UUID를 sub/userId에 사용한다', () => {
    const secret = 'development-secret-value';
    const now = new Date('2026-07-25T01:02:03.000Z');
    const token = createDevelopmentGisSystemAdminJwt(
        secret,
        ACTOR_AUTH_ID,
        now
    );
    const decoded = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        issuer: 'tonghari-web-dev',
        audience: 'tonghari-api',
        complete: true,
    });
    assert.equal(decoded.header.kid, 'dev');
    assert.equal(decoded.header.alg, 'HS256');
    const payload = decoded.payload as jwt.JwtPayload;
    assert.equal(payload.sub, ACTOR_AUTH_ID);
    assert.equal(payload.userId, ACTOR_AUTH_ID);
    assert.equal(payload.unionId, 'system');
    assert.equal(payload.role, 'SYSTEM_ADMIN');
    assert.equal(payload.purpose, 'GIS_SYSTEM_ADMIN');
    assert.equal(payload.databaseTarget, 'development');
    assert.equal(payload.iss, 'tonghari-web-dev');
    assert.equal(payload.aud, 'tonghari-api');
    assert.equal(
        (payload.exp ?? 0) - (payload.iat ?? 0),
        DEVELOPMENT_GIS_JWT_TTL_SECONDS
    );
});

test('target/DB approval/evidence manifest는 exact union/PNU/count/digest와 1:1 evidence coverage를 요구한다', () => {
    const targetManifest = parseDevelopmentTargetManifest(target());
    const approvalManifest = parseDevelopmentDbApprovalManifest(
        approval(targetManifest)
    );
    const evidenceManifest = parseDevelopmentEvidenceManifest(
        evidence(targetManifest)
    );
    assert.doesNotThrow(() =>
        validateDevelopmentRunnerManifests(
            targetManifest,
            approvalManifest,
            evidenceManifest
        )
    );

    assert.throws(
        () =>
            parseDevelopmentTargetManifest({
                ...targetManifest,
                databaseTarget: 'production',
            }),
        /TARGET_MANIFEST_INVALID/
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerManifests(
                targetManifest,
                {
                    ...approvalManifest,
                    manifestDigest: '0'.repeat(64),
                },
                evidenceManifest
            ),
        /DB_APPROVAL_MANIFEST_MISMATCH/
    );
    assert.throws(
        () =>
            parseDevelopmentEvidenceManifest({
                ...evidenceManifest,
                entries: [
                    {
                        ...evidenceManifest.entries[0],
                        landOwnershipEvidence: null,
                    },
                ],
        }),
        /LAND_OWNERSHIP_EVIDENCE_INVALID/
    );
    assert.throws(
        () =>
            parseDevelopmentEvidenceManifest({
                ...evidenceManifest,
                entries: [
                    {
                        ...evidenceManifest.entries[0],
                        ownerName: '금지된 원문',
                    },
                ],
            }),
        /EVIDENCE_ENTRY_INVALID/
    );
});

test('runtime은 dev service env 격리, exact allowlist, write feature flag를 모두 확인한다', () => {
    const targetManifest = target();
    const allowedTarget = `development:${UNION_ID}:${PNU}`;
    assert.doesNotThrow(() =>
        validateDevelopmentRunnerEnvironment(
            {
                DEV_API_JWT_SECRET: 'dev-jwt',
                DEV_SUPABASE_URL: 'https://dev.example.supabase.co',
                DEV_SUPABASE_SERVICE_ROLE_KEY: 'dev-service',
                JWT_SECRET: 'prod-jwt',
                SUPABASE_URL: 'https://prod.example.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'prod-service',
                LAND_AREA_SYNC_ENABLED: 'true',
                LAND_AREA_SYNC_ALLOWED_TARGETS: allowedTarget,
            },
            targetManifest
        )
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerEnvironment(
                {
                    DEV_API_JWT_SECRET: 'same',
                    DEV_SUPABASE_URL: 'https://dev.example.supabase.co',
                    DEV_SUPABASE_SERVICE_ROLE_KEY: 'dev-service',
                    JWT_SECRET: 'same',
                    SUPABASE_URL: 'https://prod.example.supabase.co',
                    SUPABASE_SERVICE_ROLE_KEY: 'prod-service',
                    LAND_AREA_SYNC_ENABLED: 'true',
                    LAND_AREA_SYNC_ALLOWED_TARGETS: allowedTarget,
                },
                targetManifest
            ),
        /DEVELOPMENT_ENVIRONMENT_NOT_ISOLATED/
    );
    assert.throws(
        () =>
            validateDevelopmentRunnerEnvironment(
                {
                    DEV_API_JWT_SECRET: 'dev-jwt',
                    DEV_SUPABASE_URL: 'https://dev.example.supabase.co',
                    DEV_SUPABASE_SERVICE_ROLE_KEY: 'dev-service',
                    JWT_SECRET: 'prod-jwt',
                    SUPABASE_URL: 'https://prod.example.supabase.co',
                    SUPABASE_SERVICE_ROLE_KEY: 'prod-service',
                    LAND_AREA_SYNC_ENABLED: 'true',
                    LAND_AREA_SYNC_ALLOWED_TARGETS: `${allowedTarget},development:${UNION_ID}:${SECOND_PNU}`,
                },
                targetManifest
            ),
        /RUNTIME_ALLOWLIST_MANIFEST_MISMATCH/
    );
});

test('직렬 runner는 discovery terminal을 증거와 exact 대조한 뒤 1회 confirm하고 apply terminal PASS를 만든다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    const calls: string[] = [];
    let discoveryReads = 0;
    let applyReads = 0;
    let confirmBody: Parameters<
        LandAreaSyncApiClient['confirmDiscovery']
    >[1] | null = null;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            calls.push('latest');
            return null;
        },
        async admitDiscovery() {
            calls.push('admit-discovery');
            return DISCOVERY_JOB_ID;
        },
        async getJob(_unionId, jobId) {
            calls.push(`get:${jobId}`);
            if (jobId === DISCOVERY_JOB_ID) {
                discoveryReads += 1;
                return discoveryReads === 1
                    ? job(DISCOVERY_JOB_ID, {
                          status: 'PROCESSING',
                          scopeState: undefined,
                          outcome: null,
                          scopeSnapshot: null,
                      })
                    : job(DISCOVERY_JOB_ID, {
                          status: 'COMPLETED',
                          scopeState:
                              'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                          outcome: 'REVIEW_REQUIRED',
                      });
            }
            applyReads += 1;
            return applyReads === 1
                ? job(APPLY_JOB_ID, {
                      status: 'PROCESSING',
                      scopeState: 'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                      outcome: null,
                      sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                  })
                : job(APPLY_JOB_ID, {
                      status: 'COMPLETED',
                      scopeState: 'SINGLE_PNU_CONFIRMED',
                      outcome: 'APPLIED',
                      sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                  });
        },
        async confirmDiscovery(_discoveryJobId, body) {
            calls.push('confirm');
            confirmBody = body;
            return APPLY_JOB_ID;
        },
    };
    let clock = Date.parse('2026-07-25T00:00:00.000Z');
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(evidenceManifest.entries),
        pollIntervalMs: 100,
        jobTimeoutMs: DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS,
        sleep: async (milliseconds) => {
            clock += milliseconds;
        },
        now: () => new Date(clock),
    });

    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(artifact.observedPropertyUnitCount, 1);
    assert.equal(
        artifact.preflight?.nonTargetTupleDigest,
        artifact.postflight?.nonTargetTupleDigest
    );
    assert.equal(artifact.writeAttribution?.writerJobCount, 1);
    assert.equal(
        artifact.writeAttribution?.attributedPropertyUnitCount,
        1
    );
    assert.deepEqual(calls, [
        'latest',
        'admit-discovery',
        `get:${DISCOVERY_JOB_ID}`,
        `get:${DISCOVERY_JOB_ID}`,
        'confirm',
        `get:${APPLY_JOB_ID}`,
        `get:${APPLY_JOB_ID}`,
    ]);
    assert.deepEqual(confirmBody, {
        unionId: UNION_ID,
        expectedScopeHash: '3'.repeat(64),
        propertyUnitIds: [PROPERTY_UNIT_ID],
        parcelScopeConfirmed: true,
        landOwnershipConfirmed: true,
        overwriteManualConfirmed: false,
        parcelScopeEvidenceKind: 'OTHER',
        parcelScopeEvidenceRef: `sheet=s;cells=E29,F29;sha256=${HASH}`,
        landOwnershipEvidenceKind: 'OTHER',
        landOwnershipEvidenceRef: `sheet=s;cells=E29,F29;sha256=${HASH}`,
    });
    assert.doesNotThrow(() =>
        validateDevelopmentRunArtifact(artifact, targetManifest)
    );
    assert.throws(
        () =>
            validateDevelopmentRunArtifact(
                { ...artifact, authorization: 'forbidden' },
                targetManifest
            ),
        /RUN_ARTIFACT_INVALID/
    );
    assert.throws(
        () =>
            validateDevelopmentRunArtifact(
                {
                    ...artifact,
                    postflight: {
                        ...artifact.postflight!,
                        nonTargetTupleDigest: '0'.repeat(64),
                    },
                },
                targetManifest
            ),
        /RUN_ARTIFACT_NON_TARGET_TUPLE_CHANGED/
    );
});

test('latest APPLIED job은 신규 discovery/confirm 없이 resume 처리한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    let admissions = 0;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            return job(APPLY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'SINGLE_PNU_CONFIRMED',
                outcome: 'APPLIED',
                sourceDiscoveryJobId: DISCOVERY_JOB_ID,
            });
        },
        async getJob() {
            throw new Error('호출되면 안 됨');
        },
        async admitDiscovery() {
            admissions += 1;
            return DISCOVERY_JOB_ID;
        },
        async confirmDiscovery() {
            admissions += 1;
            return APPLY_JOB_ID;
        },
    };
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(
            evidenceManifest.entries,
            true
        ),
    });
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(artifact.results[0].admission, 'ALREADY_APPLIED');
    assert.equal(admissions, 0);
});

test('read-only preflight membership/prestate가 다르면 API admission 전에 FAIL한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    let apiCalls = 0;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            apiCalls += 1;
            return null;
        },
        async getJob() {
            apiCalls += 1;
            throw new Error('호출되면 안 됨');
        },
        async admitDiscovery() {
            apiCalls += 1;
            return DISCOVERY_JOB_ID;
        },
        async confirmDiscovery() {
            apiCalls += 1;
            return APPLY_JOB_ID;
        },
    };
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: {
            async readActivePropertyUnits() {
                return [
                    {
                        id: PROPERTY_UNIT_ID,
                        pnu: PNU,
                        landArea: '999',
                        landAreaSource: 'MANUAL',
                        landAreaSyncedAt: null,
                        landAreaSyncJobId: null,
                    },
                ];
            },
            async readPropertyUnitsBySyncJobIds() {
                throw new Error('호출되면 안 됨');
            },
        },
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'PREFLIGHT_TARGET_PRESTATE_MISMATCH'
    );
    assert.equal(apiCalls, 0);
    assert.equal(artifact.results.length, 0);
});

test('10분 queue 상한과 전파 여유를 지난 job도 durable terminal까지 drain한 뒤 FAIL한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    let clock = Date.parse('2026-07-25T00:00:00.000Z');
    let getJobCalls = 0;
    let terminalObserved = false;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            return null;
        },
        async admitDiscovery() {
            return DISCOVERY_JOB_ID;
        },
        async getJob() {
            getJobCalls += 1;
            if (getJobCalls < 23) {
                if (getJobCalls % 2 === 0) {
                    throw new Error('일시적 API 조회 실패');
                }
                return job(DISCOVERY_JOB_ID, {
                    status: 'PROCESSING',
                    scopeState: undefined,
                    outcome: null,
                    scopeSnapshot: null,
                });
            }
            terminalObserved = true;
            return job(DISCOVERY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'LINKED_SCOPE_RESOLVED',
                outcome: 'APPLIED',
            });
        },
        async confirmDiscovery() {
            throw new Error('호출되면 안 됨');
        },
    };
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(
            evidenceManifest.entries,
            false,
            DISCOVERY_JOB_ID
        ),
        pollIntervalMs: 30_000,
        jobTimeoutMs: DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS,
        sleep: async (milliseconds) => {
            clock += milliseconds;
        },
        now: () => new Date(clock),
    });

    assert.equal(terminalObserved, true);
    assert.equal(getJobCalls, 23);
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL'
    );
    await assert.rejects(
        runDevelopmentLandAreaSync({
            target: targetManifest,
            dbApproval: approval(targetManifest),
            evidence: evidenceManifest,
            client,
            preflightReader: preflightReader(evidenceManifest.entries),
            jobTimeoutMs: 10 * 60_000,
        }),
        /POLL_CONFIGURATION_INVALID/
    );
});

test('confirmation POST 응답 유실은 latest lineage를 복구해 apply terminal까지 drain한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    const networkFailureClient =
        new LocalhostDevelopmentLandAreaSyncClient(
            'development-secret-value',
            ACTOR_AUTH_ID,
            () => new Date('2026-07-25T00:00:00.000Z'),
            async () => {
                throw new Error('응답 유실');
            }
        );
    let latestReads = 0;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            latestReads += 1;
            if (latestReads === 1) {
                return job(DISCOVERY_JOB_ID, {
                    status: 'COMPLETED',
                    scopeState:
                        'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                    outcome: 'REVIEW_REQUIRED',
                });
            }
            return job(APPLY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'SINGLE_PNU_CONFIRMED',
                outcome: 'APPLIED',
                sourceDiscoveryJobId: DISCOVERY_JOB_ID,
            });
        },
        async getJob() {
            throw new Error('호출되면 안 됨');
        },
        async admitDiscovery() {
            throw new Error('호출되면 안 됨');
        },
        async confirmDiscovery(discoveryJobId, body) {
            return networkFailureClient.confirmDiscovery(
                discoveryJobId,
                body
            );
        },
    };

    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(evidenceManifest.entries),
        pollIntervalMs: 100,
        sleep: async () => undefined,
    });

    assert.equal(latestReads, 2);
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(artifact.results[0].applyJobId, APPLY_JOB_ID);
    assert.equal(artifact.results[0].writerJobId, APPLY_JOB_ID);
});

test('discovery POST 응답 유실도 latest durable job을 복구해 terminal 전 반환하지 않는다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    const networkFailureClient =
        new LocalhostDevelopmentLandAreaSyncClient(
            'development-secret-value',
            ACTOR_AUTH_ID,
            () => new Date('2026-07-25T00:00:00.000Z'),
            async () => {
                throw new Error('응답 유실');
            }
        );
    let latestReads = 0;
    const client: LandAreaSyncApiClient = {
        async getLatest() {
            latestReads += 1;
            if (latestReads === 1) {
                return null;
            }
            return job(DISCOVERY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'LINKED_SCOPE_RESOLVED',
                outcome: 'APPLIED',
            });
        },
        async getJob() {
            throw new Error('호출되면 안 됨');
        },
        async admitDiscovery(unionId, pnu) {
            return networkFailureClient.admitDiscovery(unionId, pnu);
        },
        async confirmDiscovery() {
            throw new Error('호출되면 안 됨');
        },
    };

    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(
            evidenceManifest.entries,
            false,
            DISCOVERY_JOB_ID
        ),
        pollIntervalMs: 100,
        sleep: async () => undefined,
    });

    assert.equal(latestReads, 2);
    assert.equal(artifact.gate.status, 'PASS');
    assert.equal(
        artifact.results[0].discoveryJobId,
        DISCOVERY_JOB_ID
    );
    assert.equal(
        artifact.results[0].writerJobId,
        DISCOVERY_JOB_ID
    );
});

test('postflight는 승인 대상 밖의 land area/source/synced/job tuple 변경을 exact 거부한다', async () => {
    const targetManifest = {
        ...target(),
        expectedUnionActivePropertyUnitCount: 2,
        expectedUnionActivePnuCount: 2,
    };
    const evidenceManifest = evidence(targetManifest);
    const nonTargetId = '6a1a4cbb-c8ad-45a3-ae40-b90665dc949c';
    let reads = 0;
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client: {
            async getLatest() {
                return job(APPLY_JOB_ID, {
                    status: 'COMPLETED',
                    scopeState: 'SINGLE_PNU_CONFIRMED',
                    outcome: 'APPLIED',
                    sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                });
            },
            async getJob() {
                throw new Error('호출되면 안 됨');
            },
            async admitDiscovery() {
                throw new Error('호출되면 안 됨');
            },
            async confirmDiscovery() {
                throw new Error('호출되면 안 됨');
            },
        },
        preflightReader: {
            async readActivePropertyUnits() {
                reads += 1;
                return [
                    {
                        id: PROPERTY_UNIT_ID,
                        pnu: PNU,
                        landArea: '161',
                        landAreaSource: 'LADFRL',
                        landAreaSyncedAt:
                            '2026-07-25T00:01:00.000Z',
                        landAreaSyncJobId: APPLY_JOB_ID,
                    },
                    {
                        id: nonTargetId,
                        pnu: SECOND_PNU,
                        landArea: reads === 1 ? null : '99',
                        landAreaSource: 'LEGACY_UNKNOWN',
                        landAreaSyncedAt: null,
                        landAreaSyncJobId: null,
                    },
                ];
            },
            async readPropertyUnitsBySyncJobIds() {
                throw new Error('호출되면 안 됨');
            },
        },
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_NON_TARGET_TUPLE_CHANGED'
    );
});

test('writer job attribution bounded read는 타 조합 또는 승인 scope 밖 write를 FAIL한다', async () => {
    const targetManifest = target();
    const evidenceManifest = evidence(targetManifest);
    const reader = preflightReader(evidenceManifest.entries, true);
    reader.readPropertyUnitsBySyncJobIds = async () => [
        {
            id: PROPERTY_UNIT_ID,
            unionId: '10f48b95-e9bc-4c92-a0e5-6b9a57adcfb9',
            landAreaSyncJobId: APPLY_JOB_ID,
        },
    ];
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client: {
            async getLatest() {
                return job(APPLY_JOB_ID, {
                    status: 'COMPLETED',
                    scopeState: 'SINGLE_PNU_CONFIRMED',
                    outcome: 'APPLIED',
                    sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                });
            },
            async getJob() {
                throw new Error('호출되면 안 됨');
            },
            async admitDiscovery() {
                throw new Error('호출되면 안 됨');
            },
            async confirmDiscovery() {
                throw new Error('호출되면 안 됨');
            },
        },
        preflightReader: reader,
    });

    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(
        artifact.gate.failureCode,
        'POSTFLIGHT_CROSS_UNION_OR_SCOPE_WRITE_DETECTED'
    );
});

test('FAILED/review/cache conflict이면 다음 PNU admission을 즉시 중단한다', async () => {
    const targetManifest = target([PNU, SECOND_PNU], 2);
    const secondPropertyUnitId = '6a1a4cbb-c8ad-45a3-ae40-b90665dc949c';
    const latestPnus: string[] = [];
    const client: LandAreaSyncApiClient = {
        async getLatest(_unionId, pnu) {
            latestPnus.push(pnu);
            return job(APPLY_JOB_ID, {
                status: 'COMPLETED',
                scopeState: 'SINGLE_PNU_CONFIRMED',
                outcome: 'APPLIED',
                sourceDiscoveryJobId: DISCOVERY_JOB_ID,
                issueCodes: ['CACHE_CONFLICT'],
            });
        },
        async getJob() {
            throw new Error('호출되면 안 됨');
        },
        async admitDiscovery() {
            throw new Error('호출되면 안 됨');
        },
        async confirmDiscovery() {
            throw new Error('호출되면 안 됨');
        },
    };
    const evidenceManifest = evidence(targetManifest, [
        evidenceEntry(),
        evidenceEntry(SECOND_PNU, secondPropertyUnitId),
    ]);
    const artifact = await runDevelopmentLandAreaSync({
        target: targetManifest,
        dbApproval: approval(targetManifest),
        evidence: evidenceManifest,
        client,
        preflightReader: preflightReader(evidenceManifest.entries),
    });
    assert.equal(artifact.gate.status, 'FAIL');
    assert.equal(artifact.gate.failureCode, 'APPLY_TERMINAL_NOT_PASS');
    assert.equal(artifact.gate.stoppedBeforePnu, PNU);
    assert.deepEqual(latestPnus, [PNU]);
});

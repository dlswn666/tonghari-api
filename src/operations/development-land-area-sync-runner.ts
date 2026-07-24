import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
    createLandAreaSyncAllowedTargetsManifest,
} from '../security/land-area-sync-canary-policy';
import type {
    LandAreaSyncCounts,
    LandAreaSyncOutcome,
    LandAreaSyncScopeSnapshot,
    LandAreaSyncScopeState,
    LandAreaSyncStrategy,
} from '../types/land-area-sync-job.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^[0-9]{19}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;
const LOCAL_API_ORIGIN = 'http://127.0.0.1:3100';
const RESPONSE_SIZE_LIMIT = 256 * 1024;

export const DEVELOPMENT_TARGET_MANIFEST_VERSION =
    'land-area-development-target-manifest@1';
export const DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION =
    'land-area-development-db-approval-manifest@1';
export const DEVELOPMENT_EVIDENCE_MANIFEST_VERSION =
    'land-area-development-evidence-manifest@1';
export const DEVELOPMENT_RUN_ARTIFACT_VERSION =
    'land-area-development-run-artifact@1';
export const DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION =
    'land-area-development-public-run-artifact@1';
export const DEVELOPMENT_GIS_JWT_TTL_SECONDS = 10 * 60;
export const DEVELOPMENT_API_QUEUE_TIMEOUT_MS = 10 * 60_000;
export const DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS =
    DEVELOPMENT_API_QUEUE_TIMEOUT_MS + 60_000;

export interface DevelopmentTargetManifest {
    version: typeof DEVELOPMENT_TARGET_MANIFEST_VERSION;
    databaseTarget: 'development';
    unionId: string;
    pnus: string[];
    targetCount: number;
    manifestDigest: string;
    expectedPropertyUnitCount: number;
    expectedUnionActivePropertyUnitCount: number;
    expectedUnionActivePnuCount: number;
}

export interface DevelopmentDbApprovalManifest {
    version: typeof DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION;
    databaseTarget: 'development';
    unionId: string;
    pnus: string[];
    targetCount: number;
    manifestDigest: string;
    enabled: true;
}

type ParcelEvidenceKind =
    | 'BUILDING_REGISTER_COPY'
    | 'BUILDING_REGISTER_TITLE_SECTION'
    | 'API_RELATION_CROSS_CHECK'
    | 'OTHER';
type LandOwnershipEvidenceKind =
    | 'LAND_REGISTER_OR_REGISTRY'
    | 'LAND_LEDGER_COPY'
    | 'OTHER';

export interface ConfirmationEvidence {
    kind: ParcelEvidenceKind | LandOwnershipEvidenceKind;
    ref: string;
}

export interface DevelopmentEvidenceEntry {
    anchorPnu: string;
    expectedStrategy: LandAreaSyncStrategy;
    expectedScannedPnus: string[];
    expectedPropertyUnitIds: string[];
    expectedProposedLandAreas: Array<{
        propertyUnitId: string;
        landArea: string;
    }>;
    expectedLadfrlAreaEvidence: {
        parcels: Array<{ pnu: string; area: string }>;
        totalArea: string;
    };
    allowedPrestates: Array<{
        propertyUnitId: string;
        landArea: string | null;
        landAreaSource: 'LEGACY_UNKNOWN' | 'MANUAL' | 'LADFRL' | 'LDAREG';
    }>;
    parcelScopeEvidence: ConfirmationEvidence;
    landOwnershipEvidence: ConfirmationEvidence | null;
    allowManualOverwrite: boolean;
    sourceReferences: {
        workbookFileReferenceSha256: string;
        sheet: string;
        cells: string[];
        selectedCellsReferenceSha256: string;
        phase0RunId: string;
        phase0ArtifactReferenceSha256: string;
        phase0ObservationReferenceSha256: string;
        developmentObservationReferenceSha256: string;
    };
}

export interface DevelopmentEvidenceManifest {
    version: typeof DEVELOPMENT_EVIDENCE_MANIFEST_VERSION;
    databaseTarget: 'development';
    unionId: string;
    manifestDigest: string;
    entries: DevelopmentEvidenceEntry[];
}

export interface DevelopmentRunnerEnvironment {
    DEV_API_JWT_SECRET?: string;
    DEV_SUPABASE_URL?: string;
    DEV_SUPABASE_SERVICE_ROLE_KEY?: string;
    JWT_SECRET?: string;
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    LAND_AREA_SYNC_ENABLED?: string;
    LAND_AREA_SYNC_ALLOWED_TARGETS?: string;
}

export interface LandAreaSyncApiJob {
    jobId: string;
    unionId: string;
    status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
    progress: number;
    landAreaSync: {
        anchorPnu?: string;
        sourceDiscoveryJobId?: string | null;
        scopeState?: LandAreaSyncScopeState;
        scopeSnapshot?: LandAreaSyncScopeSnapshot | null;
        branch?: LandAreaSyncStrategy | null;
        outcome?: LandAreaSyncOutcome | null;
        counts?: Partial<LandAreaSyncCounts>;
        issues?: Array<{ code?: string }>;
        issuesTotal?: number;
    } | null;
    createdAt?: string;
    updatedAt?: string;
}

export interface LandAreaSyncApiClient {
    getLatest(unionId: string, pnu: string): Promise<LandAreaSyncApiJob | null>;
    getJob(unionId: string, jobId: string): Promise<LandAreaSyncApiJob>;
    admitDiscovery(unionId: string, pnu: string): Promise<string>;
    confirmDiscovery(
        discoveryJobId: string,
        body: {
            unionId: string;
            expectedScopeHash: string;
            propertyUnitIds: string[];
            parcelScopeConfirmed: true;
            landOwnershipConfirmed: true | null;
            overwriteManualConfirmed: boolean;
            parcelScopeEvidenceKind: string;
            parcelScopeEvidenceRef: string;
            landOwnershipEvidenceKind: string | null;
            landOwnershipEvidenceRef: string | null;
        }
    ): Promise<string>;
}

export interface DevelopmentActivePropertyUnit {
    id: string;
    pnu: string;
    landArea: string | null;
    landAreaSource: 'LEGACY_UNKNOWN' | 'MANUAL' | 'LADFRL' | 'LDAREG';
    landAreaSyncedAt: string | null;
    landAreaSyncJobId: string | null;
}

export interface DevelopmentAttributedPropertyUnit {
    id: string;
    unionId: string;
    landAreaSyncJobId: string;
}

export interface DevelopmentReadOnlyPreflightReader {
    readActivePropertyUnits(
        unionId: string
    ): Promise<DevelopmentActivePropertyUnit[]>;
    readPropertyUnitsBySyncJobIds(
        syncJobIds: string[]
    ): Promise<DevelopmentAttributedPropertyUnit[]>;
}

export interface DevelopmentReadOnlySnapshot {
    activePropertyUnitCount: number;
    activePnuCount: number;
    positiveLandAreaCount: number;
    identityDigest: string;
    tupleDigest: string;
    nonTargetTupleDigest: string;
}

export interface DevelopmentWriteAttribution {
    writerJobCount: number;
    attributedPropertyUnitCount: number;
    attributionDigest: string;
}

export interface DevelopmentRunTargetResult {
    pnu: string;
    admission: 'NEW_DISCOVERY' | 'RESUMED_LATEST' | 'ALREADY_APPLIED';
    discoveryJobId: string | null;
    applyJobId: string | null;
    writerJobId: string;
    status: 'COMPLETED' | 'FAILED';
    strategy: LandAreaSyncStrategy | null;
    scopeState: LandAreaSyncScopeState | null;
    outcome: LandAreaSyncOutcome | null;
    updatedPropertyUnits: number;
    unchangedPropertyUnits: number;
    issueCodes: string[];
}

export interface DevelopmentRunArtifact {
    version: typeof DEVELOPMENT_RUN_ARTIFACT_VERSION;
    databaseTarget: 'development';
    unionId: string;
    targetCount: number;
    manifestDigest: string;
    expectedPropertyUnitCount: number;
    observedPropertyUnitCount: number;
    startedAt: string;
    completedAt: string;
    preflight: DevelopmentReadOnlySnapshot | null;
    postflight: DevelopmentReadOnlySnapshot | null;
    writeAttribution: DevelopmentWriteAttribution | null;
    results: DevelopmentRunTargetResult[];
    gate: {
        status: 'PASS' | 'FAIL';
        failureCode: string | null;
        stoppedBeforePnu: string | null;
    };
}

export interface DevelopmentPublicRunArtifact {
    version: typeof DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION;
    databaseTarget: 'development';
    manifestLabel: string;
    aggregateCounts: {
        targetCount: number;
        expectedPropertyUnitCount: number;
        observedPropertyUnitCount: number;
        resultCount: number;
        preflightActivePropertyUnitCount: number | null;
        preflightActivePnuCount: number | null;
        preflightPositiveLandAreaCount: number | null;
        postflightActivePropertyUnitCount: number | null;
        postflightActivePnuCount: number | null;
        postflightPositiveLandAreaCount: number | null;
        writerJobCount: number | null;
        attributedPropertyUnitCount: number | null;
    };
    digests: {
        manifestDigest: string;
        preflightIdentityDigest: string | null;
        preflightTupleDigest: string | null;
        preflightNonTargetTupleDigest: string | null;
        postflightIdentityDigest: string | null;
        postflightTupleDigest: string | null;
        postflightNonTargetTupleDigest: string | null;
        writeAttributionDigest: string | null;
    };
    strategyCounts: {
        LADFRL: number;
        LDAREG: number;
        NONE: number;
    };
    outcomeCounts: {
        APPLIED: number;
        PARTIAL: number;
        NO_DATA: number;
        REVIEW_REQUIRED: number;
        FAILED: number;
        NONE: number;
    };
    gate: {
        status: 'PASS' | 'FAIL';
        failureCode: string | null;
    };
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[]
): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
}

class ControlledRunnerError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'ControlledRunnerError';
    }
}

class ControlledApiError extends ControlledRunnerError {
    constructor(
        code: string,
        readonly status: number
    ) {
        super(code);
        this.name = 'ControlledApiError';
    }
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ControlledRunnerError(code);
    }
    return value as Record<string, unknown>;
}

function isSortedUnique(values: readonly string[]): boolean {
    return (
        values.length === new Set(values).size &&
        values.every((value, index) => index === 0 || values[index - 1] < value)
    );
}

function canonicalTargetValue(
    databaseTarget: 'development',
    unionId: string,
    pnus: readonly string[]
): string {
    return pnus
        .map((pnu) => `${databaseTarget}:${unionId.toLowerCase()}:${pnu}`)
        .join(',');
}

export function computeDevelopmentTargetDigest(
    unionId: string,
    pnus: readonly string[]
): string {
    return createHash('sha256')
        .update(canonicalTargetValue('development', unionId, pnus), 'utf8')
        .digest('hex');
}

function assertCommonManifest(
    value: Record<string, unknown>,
    expectedVersion: string
): asserts value is Record<string, unknown> & {
    databaseTarget: 'development';
    unionId: string;
    pnus: string[];
    targetCount: number;
    manifestDigest: string;
} {
    if (
        value.version !== expectedVersion ||
        value.databaseTarget !== 'development' ||
        typeof value.unionId !== 'string' ||
        !UUID_RE.test(value.unionId) ||
        !Array.isArray(value.pnus) ||
        value.pnus.length === 0 ||
        !value.pnus.every((pnu) => typeof pnu === 'string' && PNU_RE.test(pnu)) ||
        !isSortedUnique(value.pnus as string[]) ||
        !Number.isSafeInteger(value.targetCount) ||
        value.targetCount !== value.pnus.length ||
        typeof value.manifestDigest !== 'string' ||
        !HEX64_RE.test(value.manifestDigest) ||
        value.manifestDigest !==
            computeDevelopmentTargetDigest(value.unionId, value.pnus as string[])
    ) {
        throw new ControlledRunnerError('TARGET_MANIFEST_INVALID');
    }
}

export function parseDevelopmentTargetManifest(
    input: unknown
): DevelopmentTargetManifest {
    const value = asRecord(input, 'TARGET_MANIFEST_INVALID');
    assertCommonManifest(value, DEVELOPMENT_TARGET_MANIFEST_VERSION);
    if (
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'unionId',
            'pnus',
            'targetCount',
            'manifestDigest',
            'expectedPropertyUnitCount',
            'expectedUnionActivePropertyUnitCount',
            'expectedUnionActivePnuCount',
        ]) ||
        !Number.isSafeInteger(value.expectedPropertyUnitCount) ||
        (value.expectedPropertyUnitCount as number) <= 0 ||
        !Number.isSafeInteger(value.expectedUnionActivePropertyUnitCount) ||
        (value.expectedUnionActivePropertyUnitCount as number) <= 0 ||
        !Number.isSafeInteger(value.expectedUnionActivePnuCount) ||
        (value.expectedUnionActivePnuCount as number) <= 0 ||
        (value.expectedUnionActivePnuCount as number) >
            (value.expectedUnionActivePropertyUnitCount as number)
    ) {
        throw new ControlledRunnerError('TARGET_MANIFEST_INVALID');
    }
    return value as unknown as DevelopmentTargetManifest;
}

export function parseDevelopmentDbApprovalManifest(
    input: unknown
): DevelopmentDbApprovalManifest {
    const value = asRecord(input, 'DB_APPROVAL_MANIFEST_INVALID');
    try {
        assertCommonManifest(value, DEVELOPMENT_DB_APPROVAL_MANIFEST_VERSION);
    } catch {
        throw new ControlledRunnerError('DB_APPROVAL_MANIFEST_INVALID');
    }
    if (
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'unionId',
            'pnus',
            'targetCount',
            'manifestDigest',
            'enabled',
        ]) ||
        value.enabled !== true
    ) {
        throw new ControlledRunnerError('DB_APPROVAL_MANIFEST_DISABLED');
    }
    return value as unknown as DevelopmentDbApprovalManifest;
}

function assertEvidenceRef(
    value: unknown,
    allowedKinds: readonly string[],
    code: string
): asserts value is ConfirmationEvidence {
    const ref = asRecord(value, code);
    if (
        !hasExactKeys(ref, ['kind', 'ref']) ||
        typeof ref.kind !== 'string' ||
        !allowedKinds.includes(ref.kind) ||
        typeof ref.ref !== 'string' ||
        ref.ref.trim() !== ref.ref ||
        ref.ref.length < 1 ||
        ref.ref.length > 200 ||
        /[\r\n]/.test(ref.ref)
    ) {
        throw new ControlledRunnerError(code);
    }
}

function assertPositiveDecimal(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) &&
        Number(value) > 0
    );
}

function parseEvidenceEntry(input: unknown): DevelopmentEvidenceEntry {
    const value = asRecord(input, 'EVIDENCE_ENTRY_INVALID');
    const proposed = value.expectedProposedLandAreas;
    const ladfrl = asRecord(
        value.expectedLadfrlAreaEvidence,
        'EVIDENCE_LADFRL_AREA_INVALID'
    );
    const parcels = ladfrl.parcels;
    const sources = asRecord(value.sourceReferences, 'EVIDENCE_SOURCE_INVALID');
    const allowedPrestates = value.allowedPrestates;
    if (
        !hasExactKeys(value, [
            'anchorPnu',
            'expectedStrategy',
            'expectedScannedPnus',
            'expectedPropertyUnitIds',
            'expectedProposedLandAreas',
            'expectedLadfrlAreaEvidence',
            'allowedPrestates',
            'parcelScopeEvidence',
            'landOwnershipEvidence',
            'allowManualOverwrite',
            'sourceReferences',
        ]) ||
        !hasExactKeys(ladfrl, ['parcels', 'totalArea']) ||
        !hasExactKeys(sources, [
            'workbookFileReferenceSha256',
            'sheet',
            'cells',
            'selectedCellsReferenceSha256',
            'phase0RunId',
            'phase0ArtifactReferenceSha256',
            'phase0ObservationReferenceSha256',
            'developmentObservationReferenceSha256',
        ]) ||
        typeof value.anchorPnu !== 'string' ||
        !PNU_RE.test(value.anchorPnu) ||
        (value.expectedStrategy !== 'LADFRL' &&
            value.expectedStrategy !== 'LDAREG') ||
        !Array.isArray(value.expectedScannedPnus) ||
        value.expectedScannedPnus.length === 0 ||
        !value.expectedScannedPnus.every(
            (pnu) => typeof pnu === 'string' && PNU_RE.test(pnu)
        ) ||
        !isSortedUnique(value.expectedScannedPnus as string[]) ||
        !Array.isArray(value.expectedPropertyUnitIds) ||
        value.expectedPropertyUnitIds.length === 0 ||
        !value.expectedPropertyUnitIds.every(
            (id) => typeof id === 'string' && UUID_RE.test(id)
        ) ||
        !isSortedUnique(value.expectedPropertyUnitIds as string[]) ||
        !Array.isArray(proposed) ||
        proposed.length !== value.expectedPropertyUnitIds.length ||
        !proposed.every((item) => {
            const row = asRecord(item, 'EVIDENCE_PROPOSED_AREA_INVALID');
            return (
                hasExactKeys(row, ['propertyUnitId', 'landArea']) &&
                typeof row.propertyUnitId === 'string' &&
                UUID_RE.test(row.propertyUnitId) &&
                assertPositiveDecimal(row.landArea)
            );
        }) ||
        !Array.isArray(parcels) ||
        parcels.length === 0 ||
        !parcels.every((item) => {
            const row = asRecord(item, 'EVIDENCE_LADFRL_AREA_INVALID');
            return (
                hasExactKeys(row, ['pnu', 'area']) &&
                typeof row.pnu === 'string' &&
                PNU_RE.test(row.pnu) &&
                assertPositiveDecimal(row.area)
            );
        }) ||
        !assertPositiveDecimal(ladfrl.totalArea) ||
        !Array.isArray(allowedPrestates) ||
        allowedPrestates.length === 0 ||
        !allowedPrestates.every((item) => {
            const row = asRecord(item, 'EVIDENCE_PRESTATE_INVALID');
            return (
                hasExactKeys(row, [
                    'propertyUnitId',
                    'landArea',
                    'landAreaSource',
                ]) &&
                typeof row.propertyUnitId === 'string' &&
                UUID_RE.test(row.propertyUnitId) &&
                (row.landArea === null ||
                    (typeof row.landArea === 'string' &&
                        /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(
                            row.landArea
                        ))) &&
                (row.landAreaSource === 'LEGACY_UNKNOWN' ||
                    row.landAreaSource === 'MANUAL' ||
                    row.landAreaSource === 'LADFRL' ||
                    row.landAreaSource === 'LDAREG')
            );
        }) ||
        typeof value.allowManualOverwrite !== 'boolean'
    ) {
        throw new ControlledRunnerError('EVIDENCE_ENTRY_INVALID');
    }

    assertEvidenceRef(
        value.parcelScopeEvidence,
        [
            'BUILDING_REGISTER_COPY',
            'BUILDING_REGISTER_TITLE_SECTION',
            'API_RELATION_CROSS_CHECK',
            'OTHER',
        ],
        'PARCEL_SCOPE_EVIDENCE_INVALID'
    );
    if (value.expectedStrategy === 'LADFRL') {
        assertEvidenceRef(
            value.landOwnershipEvidence,
            ['LAND_REGISTER_OR_REGISTRY', 'LAND_LEDGER_COPY', 'OTHER'],
            'LAND_OWNERSHIP_EVIDENCE_INVALID'
        );
    } else if (value.landOwnershipEvidence !== null) {
        throw new ControlledRunnerError(
            'LDAREG_LAND_OWNERSHIP_EVIDENCE_FORBIDDEN'
        );
    }

    if (
        typeof sources.workbookFileReferenceSha256 !== 'string' ||
        !HEX64_RE.test(sources.workbookFileReferenceSha256) ||
        typeof sources.sheet !== 'string' ||
        sources.sheet.length < 1 ||
        sources.sheet.length > 50 ||
        !Array.isArray(sources.cells) ||
        sources.cells.length === 0 ||
        !sources.cells.every(
            (cell) => typeof cell === 'string' && /^[A-Z]{1,3}[1-9][0-9]*$/.test(cell)
        ) ||
        typeof sources.selectedCellsReferenceSha256 !== 'string' ||
        !HEX64_RE.test(sources.selectedCellsReferenceSha256) ||
        typeof sources.phase0RunId !== 'string' ||
        !POSITIVE_INTEGER_RE.test(sources.phase0RunId) ||
        typeof sources.phase0ArtifactReferenceSha256 !== 'string' ||
        !HEX64_RE.test(sources.phase0ArtifactReferenceSha256) ||
        typeof sources.phase0ObservationReferenceSha256 !== 'string' ||
        !HEX64_RE.test(sources.phase0ObservationReferenceSha256) ||
        typeof sources.developmentObservationReferenceSha256 !== 'string' ||
        !HEX64_RE.test(sources.developmentObservationReferenceSha256)
    ) {
        throw new ControlledRunnerError('EVIDENCE_SOURCE_INVALID');
    }

    const proposedIds = (proposed as Array<Record<string, unknown>>)
        .map((item) => item.propertyUnitId as string)
        .sort();
    if (
        JSON.stringify(proposedIds) !==
        JSON.stringify(value.expectedPropertyUnitIds)
    ) {
        throw new ControlledRunnerError('EVIDENCE_PROPOSED_MEMBERSHIP_MISMATCH');
    }
    const prestateIds = [
        ...new Set(
            (allowedPrestates as Array<Record<string, unknown>>).map(
                (item) => item.propertyUnitId as string
            )
        ),
    ].sort();
    if (
        JSON.stringify(prestateIds) !==
        JSON.stringify(value.expectedPropertyUnitIds)
    ) {
        throw new ControlledRunnerError('EVIDENCE_PRESTATE_MEMBERSHIP_MISMATCH');
    }
    const parcelPnus = (parcels as Array<Record<string, unknown>>)
        .map((item) => item.pnu as string)
        .sort();
    if (
        JSON.stringify(parcelPnus) !==
        JSON.stringify(value.expectedScannedPnus)
    ) {
        throw new ControlledRunnerError('EVIDENCE_LADFRL_SCOPE_MISMATCH');
    }
    return value as unknown as DevelopmentEvidenceEntry;
}

export function parseDevelopmentEvidenceManifest(
    input: unknown
): DevelopmentEvidenceManifest {
    const value = asRecord(input, 'EVIDENCE_MANIFEST_INVALID');
    if (
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'unionId',
            'manifestDigest',
            'entries',
        ]) ||
        value.version !== DEVELOPMENT_EVIDENCE_MANIFEST_VERSION ||
        value.databaseTarget !== 'development' ||
        typeof value.unionId !== 'string' ||
        !UUID_RE.test(value.unionId) ||
        typeof value.manifestDigest !== 'string' ||
        !HEX64_RE.test(value.manifestDigest) ||
        !Array.isArray(value.entries) ||
        value.entries.length === 0
    ) {
        throw new ControlledRunnerError('EVIDENCE_MANIFEST_INVALID');
    }
    return {
        version: DEVELOPMENT_EVIDENCE_MANIFEST_VERSION,
        databaseTarget: 'development',
        unionId: value.unionId,
        manifestDigest: value.manifestDigest,
        entries: value.entries.map(parseEvidenceEntry),
    };
}

function normalizedUrl(value: string): string {
    return value.trim().replace(/\/+$/, '').toLowerCase();
}

export function validateDevelopmentRunnerEnvironment(
    input: DevelopmentRunnerEnvironment,
    target: DevelopmentTargetManifest
): void {
    const developmentValues = [
        input.DEV_API_JWT_SECRET,
        input.DEV_SUPABASE_URL,
        input.DEV_SUPABASE_SERVICE_ROLE_KEY,
    ];
    const productionValues = [
        input.JWT_SECRET,
        input.SUPABASE_URL,
        input.SUPABASE_SERVICE_ROLE_KEY,
    ];
    if (
        developmentValues.some((value) => !value) ||
        productionValues.some((value) => !value)
    ) {
        throw new ControlledRunnerError('DEVELOPMENT_SERVICE_ENV_MISSING');
    }
    if (
        input.DEV_API_JWT_SECRET === input.JWT_SECRET ||
        normalizedUrl(input.DEV_SUPABASE_URL!) ===
            normalizedUrl(input.SUPABASE_URL!) ||
        input.DEV_SUPABASE_SERVICE_ROLE_KEY ===
            input.SUPABASE_SERVICE_ROLE_KEY
    ) {
        throw new ControlledRunnerError('DEVELOPMENT_ENVIRONMENT_NOT_ISOLATED');
    }
    if (input.LAND_AREA_SYNC_ENABLED !== 'true') {
        throw new ControlledRunnerError('LAND_AREA_SYNC_DISABLED');
    }

    let runtimeManifest;
    try {
        runtimeManifest = createLandAreaSyncAllowedTargetsManifest(
            input.LAND_AREA_SYNC_ALLOWED_TARGETS
        );
    } catch {
        throw new ControlledRunnerError('RUNTIME_ALLOWLIST_INVALID');
    }
    const targetCanonical = canonicalTargetValue(
        'development',
        target.unionId,
        target.pnus
    );
    if (
        runtimeManifest.count !== target.targetCount ||
        runtimeManifest.digest !== target.manifestDigest ||
        runtimeManifest.canonicalValue !== targetCanonical
    ) {
        throw new ControlledRunnerError('RUNTIME_ALLOWLIST_MANIFEST_MISMATCH');
    }
}

export function validateDevelopmentRunnerManifests(
    target: DevelopmentTargetManifest,
    dbApproval: DevelopmentDbApprovalManifest,
    evidence: DevelopmentEvidenceManifest
): void {
    if (
        dbApproval.databaseTarget !== 'development' ||
        dbApproval.unionId.toLowerCase() !== target.unionId.toLowerCase() ||
        dbApproval.targetCount !== target.targetCount ||
        dbApproval.manifestDigest !== target.manifestDigest ||
        JSON.stringify(dbApproval.pnus) !== JSON.stringify(target.pnus)
    ) {
        throw new ControlledRunnerError('DB_APPROVAL_MANIFEST_MISMATCH');
    }
    if (
        evidence.databaseTarget !== 'development' ||
        evidence.unionId.toLowerCase() !== target.unionId.toLowerCase() ||
        evidence.manifestDigest !== target.manifestDigest
    ) {
        throw new ControlledRunnerError('EVIDENCE_MANIFEST_MISMATCH');
    }
    const entriesByPnu = new Map(
        evidence.entries.map((entry) => [entry.anchorPnu, entry])
    );
    if (
        entriesByPnu.size !== target.pnus.length ||
        target.pnus.some((pnu) => !entriesByPnu.has(pnu))
    ) {
        throw new ControlledRunnerError('EVIDENCE_PNU_COVERAGE_MISMATCH');
    }
    const approvedPnus = new Set(target.pnus);
    for (const entry of evidence.entries) {
        if (entry.expectedScannedPnus.some((pnu) => !approvedPnus.has(pnu))) {
            throw new ControlledRunnerError('EVIDENCE_SCOPE_OUTSIDE_MANIFEST');
        }
    }
    const expectedPropertyUnitIds = new Set(
        evidence.entries.flatMap((entry) => entry.expectedPropertyUnitIds)
    );
    if (expectedPropertyUnitIds.size !== target.expectedPropertyUnitCount) {
        throw new ControlledRunnerError(
            'EXPECTED_PROPERTY_UNIT_COUNT_MISMATCH'
        );
    }
}

export function createDevelopmentGisSystemAdminJwt(
    secret: string,
    actorAuthUserId: string,
    now: Date = new Date()
): string {
    if (!secret || !UUID_RE.test(actorAuthUserId)) {
        throw new ControlledRunnerError('JWT_INPUT_INVALID');
    }
    const issuedAt = Math.floor(now.getTime() / 1000);
    return jwt.sign(
        {
            sub: actorAuthUserId.toLowerCase(),
            userId: actorAuthUserId.toLowerCase(),
            unionId: 'system',
            role: 'SYSTEM_ADMIN',
            purpose: 'GIS_SYSTEM_ADMIN',
            databaseTarget: 'development',
            iss: 'tonghari-web-dev',
            aud: 'tonghari-api',
            iat: issuedAt,
            exp: issuedAt + DEVELOPMENT_GIS_JWT_TTL_SECONDS,
            jti: randomUUID(),
        },
        secret,
        {
            algorithm: 'HS256',
            keyid: 'dev',
        }
    );
}

function requireApiJob(value: unknown): LandAreaSyncApiJob {
    const row = asRecord(value, 'API_RESPONSE_INVALID');
    if (
        row.success !== true ||
        typeof row.jobId !== 'string' ||
        !UUID_RE.test(row.jobId) ||
        typeof row.unionId !== 'string' ||
        !UUID_RE.test(row.unionId) ||
        (row.status !== 'PROCESSING' &&
            row.status !== 'COMPLETED' &&
            row.status !== 'FAILED') ||
        typeof row.progress !== 'number' ||
        row.progress < 0 ||
        row.progress > 100
    ) {
        throw new ControlledRunnerError('API_RESPONSE_INVALID');
    }
    return {
        jobId: row.jobId,
        unionId: row.unionId,
        status: row.status,
        progress: row.progress,
        landAreaSync:
            row.landAreaSync && typeof row.landAreaSync === 'object'
                ? (row.landAreaSync as LandAreaSyncApiJob['landAreaSync'])
                : null,
        ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
        ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
    };
}

export class LocalhostDevelopmentLandAreaSyncClient
    implements LandAreaSyncApiClient
{
    constructor(
        private readonly secret: string,
        private readonly actorAuthUserId: string,
        private readonly now: () => Date = () => new Date(),
        private readonly fetchImpl: typeof fetch = fetch
    ) {}

    private async request(
        path: string,
        init: { method: 'GET' | 'POST'; body?: Record<string, unknown> }
    ): Promise<{ status: number; value: unknown }> {
        const token = createDevelopmentGisSystemAdminJwt(
            this.secret,
            this.actorAuthUserId,
            this.now()
        );
        let response: Response;
        try {
            response = await this.fetchImpl(`${LOCAL_API_ORIGIN}${path}`, {
                method: init.method,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(init.body ? { body: JSON.stringify(init.body) } : {}),
                redirect: 'error',
                signal: AbortSignal.timeout(15_000),
            });
        } catch {
            throw new ControlledApiError('API_NETWORK_ERROR', 0);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > RESPONSE_SIZE_LIMIT) {
            throw new ControlledApiError('API_RESPONSE_TOO_LARGE', response.status);
        }
        let value: unknown;
        try {
            value = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            throw new ControlledApiError('API_RESPONSE_NOT_JSON', response.status);
        }
        if (!response.ok) {
            const body = value && typeof value === 'object'
                ? (value as Record<string, unknown>)
                : {};
            const code =
                typeof body.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)
                    ? body.code
                    : `HTTP_${response.status}`;
            throw new ControlledApiError(code, response.status);
        }
        return { status: response.status, value };
    }

    async getLatest(
        unionId: string,
        pnu: string
    ): Promise<LandAreaSyncApiJob | null> {
        try {
            const response = await this.request(
                `/api/gis/land-area-sync/latest?unionId=${encodeURIComponent(
                    unionId
                )}&pnu=${encodeURIComponent(pnu)}`,
                { method: 'GET' }
            );
            return requireApiJob(response.value);
        } catch (error) {
            if (
                error instanceof ControlledApiError &&
                error.status === 404 &&
                error.code === 'JOB_NOT_FOUND'
            ) {
                return null;
            }
            throw error;
        }
    }

    async getJob(unionId: string, jobId: string): Promise<LandAreaSyncApiJob> {
        const response = await this.request(
            `/api/gis/land-area-sync/${encodeURIComponent(
                jobId
            )}?unionId=${encodeURIComponent(unionId)}`,
            { method: 'GET' }
        );
        const job = requireApiJob(response.value);
        if (
            job.jobId.toLowerCase() !== jobId.toLowerCase() ||
            job.unionId.toLowerCase() !== unionId.toLowerCase()
        ) {
            throw new ControlledRunnerError('API_JOB_SCOPE_MISMATCH');
        }
        return job;
    }

    async admitDiscovery(unionId: string, pnu: string): Promise<string> {
        const response = await this.request('/api/gis/land-area-sync', {
            method: 'POST',
            body: { unionId, anchorPnu: pnu },
        });
        const value = asRecord(response.value, 'API_RESPONSE_INVALID');
        if (
            response.status !== 202 ||
            value.success !== true ||
            typeof value.jobId !== 'string' ||
            !UUID_RE.test(value.jobId)
        ) {
            throw new ControlledRunnerError('API_RESPONSE_INVALID');
        }
        return value.jobId;
    }

    async confirmDiscovery(
        discoveryJobId: string,
        body: Parameters<LandAreaSyncApiClient['confirmDiscovery']>[1]
    ): Promise<string> {
        const response = await this.request(
            `/api/gis/land-area-sync/${encodeURIComponent(
                discoveryJobId
            )}/confirm`,
            { method: 'POST', body }
        );
        const value = asRecord(response.value, 'API_RESPONSE_INVALID');
        if (
            response.status !== 202 ||
            value.success !== true ||
            typeof value.jobId !== 'string' ||
            !UUID_RE.test(value.jobId) ||
            value.sourceDiscoveryJobId !== discoveryJobId
        ) {
            throw new ControlledRunnerError('API_RESPONSE_INVALID');
        }
        return value.jobId;
    }
}

function sortedProposedAreas(
    rows: Array<{ propertyUnitId: string; landArea: string }>
): Array<{ propertyUnitId: string; landArea: string }> {
    return [...rows].sort((a, b) =>
        a.propertyUnitId.localeCompare(b.propertyUnitId)
    );
}

function assertJobEvidenceMatches(
    job: LandAreaSyncApiJob,
    evidence: DevelopmentEvidenceEntry,
    requireDiscovery: boolean
): LandAreaSyncScopeSnapshot {
    const land = job.landAreaSync;
    const snapshot = land?.scopeSnapshot;
    if (
        !land ||
        land.anchorPnu !== evidence.anchorPnu ||
        (requireDiscovery && land.sourceDiscoveryJobId !== null) ||
        !snapshot ||
        snapshot.strategy !== evidence.expectedStrategy ||
        JSON.stringify(snapshot.scannedPnus) !==
            JSON.stringify(evidence.expectedScannedPnus) ||
        JSON.stringify(snapshot.candidatePropertyUnitIds) !==
            JSON.stringify(evidence.expectedPropertyUnitIds) ||
        JSON.stringify(sortedProposedAreas(snapshot.proposedLandAreas)) !==
            JSON.stringify(
                sortedProposedAreas(evidence.expectedProposedLandAreas)
            ) ||
        !snapshot.ladfrlAreaEvidence ||
        JSON.stringify(snapshot.ladfrlAreaEvidence.parcels) !==
            JSON.stringify(evidence.expectedLadfrlAreaEvidence.parcels) ||
        snapshot.ladfrlAreaEvidence.totalArea !==
            evidence.expectedLadfrlAreaEvidence.totalArea ||
        !HEX64_RE.test(snapshot.scopeHash)
    ) {
        throw new ControlledRunnerError('JOB_EVIDENCE_MISMATCH');
    }
    return snapshot;
}

function issueCodes(job: LandAreaSyncApiJob): string[] {
    const codes = (job.landAreaSync?.issues ?? [])
        .map((issue) => issue.code)
        .filter(
            (code): code is string =>
                typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code)
        );
    return [...new Set(codes)].sort();
}

function hasBlockingIssue(job: LandAreaSyncApiJob): boolean {
    const codes = issueCodes(job);
    const blockingPattern =
        /CACHE|CONFLICT|REVIEW|PENDING|UNRESOLVED|BLOCKING|MISMATCH|INCOMPLETE|ERROR|FAILED|AMBIGUOUS|NOT_FOUND|CHANGED|DENIED/;
    return codes.some((code) => blockingPattern.test(code));
}

function isAmbiguousApiNetworkError(error: unknown): boolean {
    return (
        error instanceof ControlledApiError &&
        error.status === 0 &&
        error.code === 'API_NETWORK_ERROR'
    );
}

async function reconcileAmbiguousAdmission(input: {
    client: LandAreaSyncApiClient;
    unionId: string;
    pnu: string;
    sourceDiscoveryJobId: string | null;
    pollIntervalMs: number;
    sleep: (milliseconds: number) => Promise<void>;
}): Promise<LandAreaSyncApiJob> {
    // POST 응답이 유실되면 서버가 durable job을 만들었는지 클라이언트가 알 수
    // 없다. cancel/idempotency endpoint가 없으므로 latest lineage가 나타날 때까지
    // operation lock을 보유한다. 영구 미확인은 영구 lock인 fail-closed 상태다.
    for (;;) {
        await input.sleep(input.pollIntervalMs);
        try {
            const latest = await input.client.getLatest(
                input.unionId,
                input.pnu
            );
            if (
                latest &&
                (input.sourceDiscoveryJobId === null
                    ? latest.landAreaSync?.sourceDiscoveryJobId == null
                    : latest.landAreaSync?.sourceDiscoveryJobId ===
                      input.sourceDiscoveryJobId)
            ) {
                return latest;
            }
        } catch {
            // 승인 여부가 불명확한 동안에는 반환하지 않는다.
        }
    }
}

async function pollTerminal(
    client: LandAreaSyncApiClient,
    unionId: string,
    jobId: string,
    initial: LandAreaSyncApiJob | null,
    input: {
        pollIntervalMs: number;
        jobTimeoutMs: number;
        sleep: (milliseconds: number) => Promise<void>;
        nowMs: () => number;
    }
): Promise<{
    job: LandAreaSyncApiJob;
    softDeadlineExceeded: boolean;
}> {
    let current = initial;
    const deadline = input.nowMs() + input.jobTimeoutMs;
    let softDeadlineExceeded = false;
    while (current === null || current.status === 'PROCESSING') {
        if (input.nowMs() >= deadline) {
            // p-queue의 10분 제한은 worker 실행 상한이며 queue 대기 시간은 별도다.
            // deadline 이후에도 durable terminal을 확인할 때까지 drain하여 runner/SSH
            // 종료가 진행 중인 DB write와 operation lock을 분리하지 못하게 한다.
            softDeadlineExceeded = true;
        }
        await input.sleep(input.pollIntervalMs);
        try {
            current = await client.getJob(unionId, jobId);
        } catch {
            // 이미 admission된 job의 terminal을 모르는 상태에서 반환하면 orphan write가
            // 가능하다. API/DB가 복구될 때까지 lock 보유 프로세스가 fail-closed한다.
            current = null;
        }
        if (input.nowMs() >= deadline) {
            softDeadlineExceeded = true;
        }
    }
    return { job: current, softDeadlineExceeded };
}

function resultFromJob(
    pnu: string,
    admission: DevelopmentRunTargetResult['admission'],
    discoveryJobId: string | null,
    applyJobId: string | null,
    job: LandAreaSyncApiJob
): DevelopmentRunTargetResult {
    return {
        pnu,
        admission,
        discoveryJobId,
        applyJobId,
        writerJobId: job.jobId,
        status: job.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
        strategy: job.landAreaSync?.branch ?? null,
        scopeState: job.landAreaSync?.scopeState ?? null,
        outcome: job.landAreaSync?.outcome ?? null,
        updatedPropertyUnits:
            job.landAreaSync?.counts?.updatedPropertyUnits ?? 0,
        unchangedPropertyUnits:
            job.landAreaSync?.counts?.unchangedPropertyUnits ?? 0,
        issueCodes: issueCodes(job),
    };
}

function assertAppliedTerminal(job: LandAreaSyncApiJob): void {
    if (
        job.status !== 'COMPLETED' ||
        job.landAreaSync?.outcome !== 'APPLIED' ||
        job.landAreaSync.scopeState === 'REVIEW_REQUIRED' ||
        job.landAreaSync.scopeState === 'FAILED' ||
        hasBlockingIssue(job)
    ) {
        throw new ControlledRunnerError('APPLY_TERMINAL_NOT_PASS');
    }
}

function canonicalPropertyRows(
    rows: DevelopmentActivePropertyUnit[]
): DevelopmentActivePropertyUnit[] {
    return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function digestJson(value: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(value), 'utf8')
        .digest('hex');
}

function isPositiveLandArea(value: string | null): boolean {
    return value !== null && assertPositiveDecimal(value);
}

function canonicalLandTuple(row: DevelopmentActivePropertyUnit) {
    return {
        id: row.id,
        pnu: row.pnu,
        landArea: row.landArea,
        landAreaSource: row.landAreaSource,
        landAreaSyncedAt: row.landAreaSyncedAt,
        landAreaSyncJobId: row.landAreaSyncJobId,
    };
}

async function readAndValidateDevelopmentSnapshot(input: {
    reader: DevelopmentReadOnlyPreflightReader;
    target: DevelopmentTargetManifest;
    evidence: DevelopmentEvidenceManifest;
    phase: 'PRE' | 'POST';
    expectedIdentityDigest?: string;
}): Promise<{
    summary: DevelopmentReadOnlySnapshot;
    rows: DevelopmentActivePropertyUnit[];
}> {
    const rows = canonicalPropertyRows(
        await input.reader.readActivePropertyUnits(input.target.unionId)
    );
    if (
        rows.length !== input.target.expectedUnionActivePropertyUnitCount ||
        rows.some(
            (row) =>
                !UUID_RE.test(row.id) ||
                !PNU_RE.test(row.pnu) ||
                (row.landArea !== null &&
                    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(row.landArea)) ||
                !['LEGACY_UNKNOWN', 'MANUAL', 'LADFRL', 'LDAREG'].includes(
                    row.landAreaSource
                ) ||
                (row.landAreaSyncedAt !== null &&
                    !Number.isFinite(Date.parse(row.landAreaSyncedAt))) ||
                (row.landAreaSyncJobId !== null &&
                    !UUID_RE.test(row.landAreaSyncJobId)) ||
                (['LEGACY_UNKNOWN', 'MANUAL'].includes(row.landAreaSource) &&
                    (row.landAreaSyncedAt !== null ||
                        row.landAreaSyncJobId !== null)) ||
                (['LADFRL', 'LDAREG'].includes(row.landAreaSource) &&
                    (!isPositiveLandArea(row.landArea) ||
                        row.landAreaSyncedAt === null ||
                        row.landAreaSyncJobId === null))
        ) ||
        new Set(rows.map((row) => row.id)).size !== rows.length
    ) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_ACTIVE_PROPERTY_SET_INVALID`
        );
    }
    const activePnuCount = new Set(rows.map((row) => row.pnu)).size;
    if (activePnuCount !== input.target.expectedUnionActivePnuCount) {
        throw new ControlledRunnerError(
            `${input.phase}FLIGHT_ACTIVE_PNU_COUNT_MISMATCH`
        );
    }

    const evidenceByPnu = new Map(
        input.evidence.entries.map((entry) => [entry.anchorPnu, entry])
    );
    for (const pnu of input.target.pnus) {
        const entry = evidenceByPnu.get(pnu)!;
        const scopedRows = rows.filter((row) => row.pnu === pnu);
        const scopedIds = scopedRows.map((row) => row.id).sort();
        if (
            JSON.stringify(scopedIds) !==
            JSON.stringify(entry.expectedPropertyUnitIds)
        ) {
            throw new ControlledRunnerError(
                `${input.phase}FLIGHT_TARGET_MEMBERSHIP_MISMATCH`
            );
        }
        if (input.phase === 'PRE') {
            for (const row of scopedRows) {
                const allowed = entry.allowedPrestates.some(
                    (prestate) =>
                        prestate.propertyUnitId === row.id &&
                        prestate.landArea === row.landArea &&
                        prestate.landAreaSource === row.landAreaSource
                );
                if (!allowed) {
                    throw new ControlledRunnerError(
                        'PREFLIGHT_TARGET_PRESTATE_MISMATCH'
                    );
                }
            }
        } else {
            const expectedAreaByPropertyId = new Map(
                entry.expectedProposedLandAreas.map((area) => [
                    area.propertyUnitId,
                    area.landArea,
                ])
            );
            for (const row of scopedRows) {
                if (
                    !isPositiveLandArea(row.landArea) ||
                    row.landArea !== expectedAreaByPropertyId.get(row.id) ||
                    row.landAreaSource !== entry.expectedStrategy
                ) {
                    throw new ControlledRunnerError(
                        'POSTFLIGHT_TARGET_LAND_AREA_NOT_APPLIED'
                    );
                }
            }
        }
    }

    const identityRows = rows.map((row) => ({ id: row.id, pnu: row.pnu }));
    const tupleRows = rows.map(canonicalLandTuple);
    const targetPropertyUnitIds = new Set(
        input.evidence.entries.flatMap(
            (entry) => entry.expectedPropertyUnitIds
        )
    );
    const nonTargetTupleRows = tupleRows.filter(
        (row) => !targetPropertyUnitIds.has(row.id)
    );
    const summary: DevelopmentReadOnlySnapshot = {
        activePropertyUnitCount: rows.length,
        activePnuCount,
        positiveLandAreaCount: rows.filter((row) =>
            isPositiveLandArea(row.landArea)
        ).length,
        identityDigest: digestJson(identityRows),
        tupleDigest: digestJson(tupleRows),
        nonTargetTupleDigest: digestJson(nonTargetTupleRows),
    };
    if (
        input.expectedIdentityDigest &&
        summary.identityDigest !== input.expectedIdentityDigest
    ) {
        throw new ControlledRunnerError(
            'POSTFLIGHT_PROPERTY_IDENTITY_CHANGED'
        );
    }
    return { summary, rows };
}

function assertExpectedPostflightTransition(input: {
    preRows: DevelopmentActivePropertyUnit[];
    postRows: DevelopmentActivePropertyUnit[];
    evidence: DevelopmentEvidenceManifest;
    results: DevelopmentRunTargetResult[];
}): void {
    const preById = new Map(input.preRows.map((row) => [row.id, row]));
    const evidenceByPropertyId = new Map<
        string,
        {
            entry: DevelopmentEvidenceEntry;
            expectedArea: string;
        }
    >();
    for (const entry of input.evidence.entries) {
        const expectedAreas = new Map(
            entry.expectedProposedLandAreas.map((area) => [
                area.propertyUnitId,
                area.landArea,
            ])
        );
        for (const propertyUnitId of entry.expectedPropertyUnitIds) {
            evidenceByPropertyId.set(propertyUnitId, {
                entry,
                expectedArea: expectedAreas.get(propertyUnitId)!,
            });
        }
    }
    const resultByPnu = new Map(
        input.results.map((result) => [result.pnu, result])
    );

    for (const post of input.postRows) {
        const pre = preById.get(post.id);
        if (!pre) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_PROPERTY_IDENTITY_CHANGED'
            );
        }
        const expected = evidenceByPropertyId.get(post.id);
        if (!expected) {
            if (
                JSON.stringify(canonicalLandTuple(pre)) !==
                JSON.stringify(canonicalLandTuple(post))
            ) {
                throw new ControlledRunnerError(
                    'POSTFLIGHT_NON_TARGET_TUPLE_CHANGED'
                );
            }
            continue;
        }

        const result = resultByPnu.get(expected.entry.anchorPnu);
        if (!result) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_TARGET_RESULT_MISSING'
            );
        }
        if (result.admission === 'ALREADY_APPLIED') {
            if (
                JSON.stringify(canonicalLandTuple(pre)) !==
                    JSON.stringify(canonicalLandTuple(post)) ||
                post.landArea !== expected.expectedArea ||
                post.landAreaSource !== expected.entry.expectedStrategy ||
                post.landAreaSyncJobId !== result.writerJobId
            ) {
                throw new ControlledRunnerError(
                    'POSTFLIGHT_ALREADY_APPLIED_TUPLE_CHANGED'
                );
            }
            continue;
        }
        if (
            post.landArea !== expected.expectedArea ||
            post.landAreaSource !== expected.entry.expectedStrategy ||
            post.landAreaSyncJobId !== result.writerJobId ||
            post.landAreaSyncedAt === null ||
            !Number.isFinite(Date.parse(post.landAreaSyncedAt))
        ) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_TARGET_TUPLE_MISMATCH'
            );
        }
    }
}

async function readAndValidateWriteAttribution(input: {
    reader: DevelopmentReadOnlyPreflightReader;
    target: DevelopmentTargetManifest;
    evidence: DevelopmentEvidenceManifest;
    results: DevelopmentRunTargetResult[];
}): Promise<DevelopmentWriteAttribution> {
    const writerJobIds = [
        ...new Set(input.results.map((result) => result.writerJobId)),
    ].sort();
    if (
        writerJobIds.length === 0 ||
        writerJobIds.some((jobId) => !UUID_RE.test(jobId))
    ) {
        throw new ControlledRunnerError(
            'POSTFLIGHT_WRITE_ATTRIBUTION_INVALID'
        );
    }
    const attributedRows = [
        ...(await input.reader.readPropertyUnitsBySyncJobIds(writerJobIds)),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const expectedWriterByPropertyId = new Map<string, string>();
    const resultByPnu = new Map(
        input.results.map((result) => [result.pnu, result])
    );
    for (const entry of input.evidence.entries) {
        const result = resultByPnu.get(entry.anchorPnu);
        if (!result) {
            throw new ControlledRunnerError(
                'POSTFLIGHT_WRITE_ATTRIBUTION_INVALID'
            );
        }
        for (const propertyUnitId of entry.expectedPropertyUnitIds) {
            expectedWriterByPropertyId.set(
                propertyUnitId,
                result.writerJobId
            );
        }
    }
    if (
        attributedRows.length !== expectedWriterByPropertyId.size ||
        new Set(attributedRows.map((row) => row.id)).size !==
            attributedRows.length ||
        attributedRows.some(
            (row) =>
                !UUID_RE.test(row.id) ||
                !UUID_RE.test(row.unionId) ||
                !UUID_RE.test(row.landAreaSyncJobId) ||
                row.unionId !== input.target.unionId ||
                expectedWriterByPropertyId.get(row.id) !==
                    row.landAreaSyncJobId
        )
    ) {
        throw new ControlledRunnerError(
            'POSTFLIGHT_CROSS_UNION_OR_SCOPE_WRITE_DETECTED'
        );
    }
    return {
        writerJobCount: writerJobIds.length,
        attributedPropertyUnitCount: attributedRows.length,
        attributionDigest: digestJson(
            attributedRows.map((row) => ({
                id: row.id,
                unionId: row.unionId,
                writerJobId: row.landAreaSyncJobId,
            }))
        ),
    };
}

export async function runDevelopmentLandAreaSync(input: {
    target: DevelopmentTargetManifest;
    dbApproval: DevelopmentDbApprovalManifest;
    evidence: DevelopmentEvidenceManifest;
    client: LandAreaSyncApiClient;
    preflightReader: DevelopmentReadOnlyPreflightReader;
    pollIntervalMs?: number;
    jobTimeoutMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => Date;
}): Promise<DevelopmentRunArtifact> {
    validateDevelopmentRunnerManifests(
        input.target,
        input.dbApproval,
        input.evidence
    );
    const pollIntervalMs = input.pollIntervalMs ?? 3_000;
    const jobTimeoutMs =
        input.jobTimeoutMs ?? DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS;
    if (
        !Number.isSafeInteger(pollIntervalMs) ||
        pollIntervalMs < 100 ||
        pollIntervalMs > 30_000 ||
        !Number.isSafeInteger(jobTimeoutMs) ||
        jobTimeoutMs < DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS ||
        jobTimeoutMs > 30 * 60_000
    ) {
        throw new ControlledRunnerError('POLL_CONFIGURATION_INVALID');
    }
    const sleep =
        input.sleep ??
        ((milliseconds: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const now = input.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const results: DevelopmentRunTargetResult[] = [];
    const observedPropertyUnitIds = new Set<string>();
    const evidenceByPnu = new Map(
        input.evidence.entries.map((entry) => [entry.anchorPnu, entry])
    );
    let failureCode: string | null = null;
    let stoppedBeforePnu: string | null = null;
    let preflight: DevelopmentReadOnlySnapshot | null = null;
    let postflight: DevelopmentReadOnlySnapshot | null = null;
    let preflightRows: DevelopmentActivePropertyUnit[] = [];
    let writeAttribution: DevelopmentWriteAttribution | null = null;
    try {
        const observedPreflight =
            await readAndValidateDevelopmentSnapshot({
                reader: input.preflightReader,
                target: input.target,
                evidence: input.evidence,
                phase: 'PRE',
            });
        preflight = observedPreflight.summary;
        preflightRows = observedPreflight.rows;
    } catch (error) {
        failureCode =
            error instanceof ControlledRunnerError
                ? error.code
                : 'PREFLIGHT_READ_FAILED';
        stoppedBeforePnu = input.target.pnus[0] ?? null;
    }

    for (const pnu of failureCode === null ? input.target.pnus : []) {
        const evidence = evidenceByPnu.get(pnu)!;
        try {
            let admission: DevelopmentRunTargetResult['admission'] =
                'RESUMED_LATEST';
            let latest = await input.client.getLatest(
                input.target.unionId,
                pnu
            );
            let discoveryJobId: string | null = null;
            let applyJobId: string | null = null;
            if (!latest) {
                admission = 'NEW_DISCOVERY';
                try {
                    discoveryJobId =
                        await input.client.admitDiscovery(
                            input.target.unionId,
                            pnu
                        );
                } catch (error) {
                    if (!isAmbiguousApiNetworkError(error)) {
                        throw error;
                    }
                    latest = await reconcileAmbiguousAdmission({
                        client: input.client,
                        unionId: input.target.unionId,
                        pnu,
                        sourceDiscoveryJobId: null,
                        pollIntervalMs,
                        sleep,
                    });
                    discoveryJobId = latest.jobId;
                }
            } else if (
                latest.status === 'COMPLETED' &&
                latest.landAreaSync?.outcome === 'APPLIED'
            ) {
                admission = 'ALREADY_APPLIED';
            } else if (
                typeof latest.landAreaSync?.sourceDiscoveryJobId === 'string'
            ) {
                discoveryJobId =
                    latest.landAreaSync.sourceDiscoveryJobId;
                applyJobId = latest.jobId;
            } else {
                discoveryJobId = latest.jobId;
            }

            let polled = await pollTerminal(
                input.client,
                input.target.unionId,
                latest?.jobId ?? discoveryJobId!,
                latest,
                {
                    pollIntervalMs,
                    jobTimeoutMs,
                    sleep,
                    nowMs: () => now().getTime(),
                }
            );
            let terminal = polled.job;
            if (polled.softDeadlineExceeded) {
                throw new ControlledRunnerError(
                    'JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL'
                );
            }

            if (
                terminal.status === 'FAILED' ||
                terminal.landAreaSync?.scopeState === 'FAILED'
            ) {
                throw new ControlledRunnerError(
                    'DISCOVERY_OR_APPLY_JOB_FAILED'
                );
            }
            if (
                terminal.landAreaSync?.scopeState ===
                    'SINGLE_SCOPE_CONFIRMATION_REQUIRED' ||
                terminal.landAreaSync?.scopeState ===
                    'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED'
            ) {
                if (hasBlockingIssue(terminal)) {
                    throw new ControlledRunnerError(
                        'DISCOVERY_BLOCKING_ISSUE'
                    );
                }
                const snapshot = assertJobEvidenceMatches(
                    terminal,
                    evidence,
                    true
                );
                discoveryJobId = terminal.jobId;
                const isManual =
                    terminal.landAreaSync.scopeState ===
                    'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED';
                if (isManual !== evidence.allowManualOverwrite) {
                    throw new ControlledRunnerError(
                        'MANUAL_OVERWRITE_EVIDENCE_MISMATCH'
                    );
                }
                const ownership =
                    evidence.expectedStrategy === 'LADFRL'
                        ? evidence.landOwnershipEvidence!
                        : null;
                let reconciledApply: LandAreaSyncApiJob | null = null;
                try {
                    applyJobId =
                        await input.client.confirmDiscovery(
                            discoveryJobId,
                            {
                                unionId: input.target.unionId,
                                expectedScopeHash: snapshot.scopeHash,
                                propertyUnitIds:
                                    snapshot.candidatePropertyUnitIds,
                                parcelScopeConfirmed: true,
                                landOwnershipConfirmed:
                                    evidence.expectedStrategy === 'LADFRL'
                                        ? true
                                        : null,
                                overwriteManualConfirmed: isManual,
                                parcelScopeEvidenceKind:
                                    evidence.parcelScopeEvidence.kind,
                                parcelScopeEvidenceRef:
                                    evidence.parcelScopeEvidence.ref,
                                landOwnershipEvidenceKind:
                                    ownership?.kind ?? null,
                                landOwnershipEvidenceRef:
                                    ownership?.ref ?? null,
                            }
                        );
                } catch (error) {
                    if (!isAmbiguousApiNetworkError(error)) {
                        throw error;
                    }
                    reconciledApply =
                        await reconcileAmbiguousAdmission({
                            client: input.client,
                            unionId: input.target.unionId,
                            pnu,
                            sourceDiscoveryJobId: discoveryJobId,
                            pollIntervalMs,
                            sleep,
                        });
                    applyJobId = reconciledApply.jobId;
                }
                polled = await pollTerminal(
                    input.client,
                    input.target.unionId,
                    applyJobId,
                    reconciledApply,
                    {
                        pollIntervalMs,
                        jobTimeoutMs,
                        sleep,
                        nowMs: () => now().getTime(),
                    }
                );
                terminal = polled.job;
                if (polled.softDeadlineExceeded) {
                    throw new ControlledRunnerError(
                        'JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL'
                    );
                }
            }

            assertAppliedTerminal(terminal);
            assertJobEvidenceMatches(terminal, evidence, false);
            for (const propertyUnitId of evidence.expectedPropertyUnitIds) {
                observedPropertyUnitIds.add(propertyUnitId);
            }
            results.push(
                resultFromJob(
                    pnu,
                    admission,
                    discoveryJobId,
                    applyJobId,
                    terminal
                )
            );
        } catch (error) {
            failureCode =
                error instanceof ControlledRunnerError
                    ? error.code
                    : 'UNEXPECTED_RUNNER_ERROR';
            stoppedBeforePnu = pnu;
            break;
        }
    }

    if (
        failureCode === null &&
        observedPropertyUnitIds.size !== input.target.expectedPropertyUnitCount
    ) {
        failureCode = 'OBSERVED_PROPERTY_UNIT_COUNT_MISMATCH';
    }
    if (
        failureCode === null &&
        results.length !== input.target.targetCount
    ) {
        failureCode = 'TARGET_RESULT_COUNT_MISMATCH';
    }
    if (preflight) {
        try {
            const observedPostflight =
                await readAndValidateDevelopmentSnapshot({
                    reader: input.preflightReader,
                    target: input.target,
                    evidence: input.evidence,
                    phase: 'POST',
                    expectedIdentityDigest: preflight.identityDigest,
                });
            postflight = observedPostflight.summary;
            if (failureCode === null) {
                assertExpectedPostflightTransition({
                    preRows: preflightRows,
                    postRows: observedPostflight.rows,
                    evidence: input.evidence,
                    results,
                });
                if (
                    preflight.nonTargetTupleDigest !==
                    postflight.nonTargetTupleDigest
                ) {
                    throw new ControlledRunnerError(
                        'POSTFLIGHT_NON_TARGET_TUPLE_CHANGED'
                    );
                }
                writeAttribution =
                    await readAndValidateWriteAttribution({
                        reader: input.preflightReader,
                        target: input.target,
                        evidence: input.evidence,
                        results,
                    });
            }
        } catch (error) {
            if (failureCode === null) {
                failureCode =
                    error instanceof ControlledRunnerError
                        ? error.code
                        : 'POSTFLIGHT_READ_FAILED';
            }
        }
    }

    return {
        version: DEVELOPMENT_RUN_ARTIFACT_VERSION,
        databaseTarget: 'development',
        unionId: input.target.unionId,
        targetCount: input.target.targetCount,
        manifestDigest: input.target.manifestDigest,
        expectedPropertyUnitCount: input.target.expectedPropertyUnitCount,
        observedPropertyUnitCount: observedPropertyUnitIds.size,
        startedAt,
        completedAt: now().toISOString(),
        preflight,
        postflight,
        writeAttribution,
        results,
        gate: {
            status: failureCode === null ? 'PASS' : 'FAIL',
            failureCode,
            stoppedBeforePnu,
        },
    };
}

export function controlledFailureCode(error: unknown): string {
    return error instanceof ControlledRunnerError
        ? error.code
        : 'UNEXPECTED_RUNNER_ERROR';
}

export function validateDevelopmentRunArtifact(
    input: unknown,
    target: DevelopmentTargetManifest
): DevelopmentRunArtifact {
    const value = asRecord(input, 'RUN_ARTIFACT_INVALID');
    const gate = asRecord(value.gate, 'RUN_ARTIFACT_INVALID');
    if (
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'unionId',
            'targetCount',
            'manifestDigest',
            'expectedPropertyUnitCount',
            'observedPropertyUnitCount',
            'startedAt',
            'completedAt',
            'preflight',
            'postflight',
            'writeAttribution',
            'results',
            'gate',
        ]) ||
        value.version !== DEVELOPMENT_RUN_ARTIFACT_VERSION ||
        value.databaseTarget !== 'development' ||
        value.unionId !== target.unionId ||
        value.targetCount !== target.targetCount ||
        value.manifestDigest !== target.manifestDigest ||
        value.expectedPropertyUnitCount !== target.expectedPropertyUnitCount ||
        !Number.isSafeInteger(value.observedPropertyUnitCount) ||
        (value.observedPropertyUnitCount as number) < 0 ||
        typeof value.startedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.startedAt)) ||
        typeof value.completedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.completedAt)) ||
        Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
        !Array.isArray(value.results) ||
        !hasExactKeys(gate, [
            'status',
            'failureCode',
            'stoppedBeforePnu',
        ]) ||
        (gate.status !== 'PASS' && gate.status !== 'FAIL') ||
        (gate.failureCode !== null &&
            (typeof gate.failureCode !== 'string' ||
                !/^[A-Z0-9_]{1,100}$/.test(gate.failureCode))) ||
        (gate.stoppedBeforePnu !== null &&
            (typeof gate.stoppedBeforePnu !== 'string' ||
                !PNU_RE.test(gate.stoppedBeforePnu)))
    ) {
        throw new ControlledRunnerError('RUN_ARTIFACT_INVALID');
    }

    const parseSnapshot = (
        snapshotInput: unknown,
        required: boolean
    ): DevelopmentReadOnlySnapshot | null => {
        if (snapshotInput === null) {
            if (required) {
                throw new ControlledRunnerError('RUN_ARTIFACT_SNAPSHOT_INVALID');
            }
            return null;
        }
        const snapshot = asRecord(
            snapshotInput,
            'RUN_ARTIFACT_SNAPSHOT_INVALID'
        );
        if (
            !hasExactKeys(snapshot, [
                'activePropertyUnitCount',
                'activePnuCount',
                'positiveLandAreaCount',
                'identityDigest',
                'tupleDigest',
                'nonTargetTupleDigest',
            ]) ||
            snapshot.activePropertyUnitCount !==
                target.expectedUnionActivePropertyUnitCount ||
            snapshot.activePnuCount !== target.expectedUnionActivePnuCount ||
            !Number.isSafeInteger(snapshot.positiveLandAreaCount) ||
            (snapshot.positiveLandAreaCount as number) < 0 ||
            (snapshot.positiveLandAreaCount as number) >
                target.expectedUnionActivePropertyUnitCount ||
            typeof snapshot.identityDigest !== 'string' ||
            !HEX64_RE.test(snapshot.identityDigest) ||
            typeof snapshot.tupleDigest !== 'string' ||
            !HEX64_RE.test(snapshot.tupleDigest) ||
            typeof snapshot.nonTargetTupleDigest !== 'string' ||
            !HEX64_RE.test(snapshot.nonTargetTupleDigest)
        ) {
            throw new ControlledRunnerError('RUN_ARTIFACT_SNAPSHOT_INVALID');
        }
        return snapshot as unknown as DevelopmentReadOnlySnapshot;
    };
    const preflight = parseSnapshot(value.preflight, gate.status === 'PASS');
    const postflight = parseSnapshot(value.postflight, gate.status === 'PASS');
    if (
        preflight &&
        postflight &&
        preflight.identityDigest !== postflight.identityDigest
    ) {
        throw new ControlledRunnerError('RUN_ARTIFACT_IDENTITY_CHANGED');
    }
    if (
        preflight &&
        postflight &&
        preflight.nonTargetTupleDigest !== postflight.nonTargetTupleDigest
    ) {
        throw new ControlledRunnerError(
            'RUN_ARTIFACT_NON_TARGET_TUPLE_CHANGED'
        );
    }

    let writeAttribution: DevelopmentWriteAttribution | null = null;
    if (value.writeAttribution !== null) {
        const attribution = asRecord(
            value.writeAttribution,
            'RUN_ARTIFACT_WRITE_ATTRIBUTION_INVALID'
        );
        if (
            !hasExactKeys(attribution, [
                'writerJobCount',
                'attributedPropertyUnitCount',
                'attributionDigest',
            ]) ||
            !Number.isSafeInteger(attribution.writerJobCount) ||
            (attribution.writerJobCount as number) < 1 ||
            (attribution.writerJobCount as number) > target.targetCount ||
            attribution.attributedPropertyUnitCount !==
                target.expectedPropertyUnitCount ||
            typeof attribution.attributionDigest !== 'string' ||
            !HEX64_RE.test(attribution.attributionDigest)
        ) {
            throw new ControlledRunnerError(
                'RUN_ARTIFACT_WRITE_ATTRIBUTION_INVALID'
            );
        }
        writeAttribution =
            attribution as unknown as DevelopmentWriteAttribution;
    }

    const results = value.results.map((item) => {
        const result = asRecord(item, 'RUN_ARTIFACT_INVALID');
        if (
            !hasExactKeys(result, [
                'pnu',
                'admission',
                'discoveryJobId',
                'applyJobId',
                'writerJobId',
                'status',
                'strategy',
                'scopeState',
                'outcome',
                'updatedPropertyUnits',
                'unchangedPropertyUnits',
                'issueCodes',
            ]) ||
            typeof result.pnu !== 'string' ||
            !PNU_RE.test(result.pnu) ||
            !target.pnus.includes(result.pnu) ||
            !['NEW_DISCOVERY', 'RESUMED_LATEST', 'ALREADY_APPLIED'].includes(
                result.admission as string
            ) ||
            (result.discoveryJobId !== null &&
                (typeof result.discoveryJobId !== 'string' ||
                    !UUID_RE.test(result.discoveryJobId))) ||
            (result.applyJobId !== null &&
                (typeof result.applyJobId !== 'string' ||
                    !UUID_RE.test(result.applyJobId))) ||
            typeof result.writerJobId !== 'string' ||
            !UUID_RE.test(result.writerJobId) ||
            (result.status !== 'COMPLETED' && result.status !== 'FAILED') ||
            (result.strategy !== null &&
                result.strategy !== 'LADFRL' &&
                result.strategy !== 'LDAREG') ||
            (result.scopeState !== null &&
                ![
                    'SINGLE_SCOPE_CONFIRMATION_REQUIRED',
                    'SINGLE_PNU_CONFIRMED',
                    'LINKED_SCOPE_RESOLVED',
                    'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED',
                    'REVIEW_REQUIRED',
                    'FAILED',
                ].includes(result.scopeState as string)) ||
            (result.outcome !== null &&
                ![
                    'APPLIED',
                    'PARTIAL',
                    'NO_DATA',
                    'REVIEW_REQUIRED',
                    'FAILED',
                ].includes(result.outcome as string)) ||
            !Number.isSafeInteger(result.updatedPropertyUnits) ||
            (result.updatedPropertyUnits as number) < 0 ||
            !Number.isSafeInteger(result.unchangedPropertyUnits) ||
            (result.unchangedPropertyUnits as number) < 0 ||
            !Array.isArray(result.issueCodes) ||
            !result.issueCodes.every(
                (code) =>
                    typeof code === 'string' &&
                    /^[A-Z0-9_]{1,100}$/.test(code)
            ) ||
            !isSortedUnique(result.issueCodes as string[])
        ) {
            throw new ControlledRunnerError('RUN_ARTIFACT_INVALID');
        }
        return result as unknown as DevelopmentRunTargetResult;
    });

    if (
        new Set(results.map((result) => result.pnu)).size !== results.length ||
        JSON.stringify(results.map((result) => result.pnu)) !==
            JSON.stringify(target.pnus.slice(0, results.length))
    ) {
        throw new ControlledRunnerError('RUN_ARTIFACT_TARGET_ORDER_INVALID');
    }

    if (gate.status === 'PASS') {
        if (
            gate.failureCode !== null ||
            gate.stoppedBeforePnu !== null ||
            value.observedPropertyUnitCount !==
                target.expectedPropertyUnitCount ||
            results.length !== target.targetCount ||
            results.some(
                (result) =>
                    result.status !== 'COMPLETED' ||
                    result.outcome !== 'APPLIED'
            ) ||
            !preflight ||
            !postflight ||
            !writeAttribution
        ) {
            throw new ControlledRunnerError('RUN_ARTIFACT_PASS_INVALID');
        }
    } else if (gate.failureCode === null) {
        throw new ControlledRunnerError('RUN_ARTIFACT_FAIL_INVALID');
    }

    return {
        version: DEVELOPMENT_RUN_ARTIFACT_VERSION,
        databaseTarget: 'development',
        unionId: target.unionId,
        targetCount: target.targetCount,
        manifestDigest: target.manifestDigest,
        expectedPropertyUnitCount: target.expectedPropertyUnitCount,
        observedPropertyUnitCount: value.observedPropertyUnitCount as number,
        startedAt: value.startedAt,
        completedAt: value.completedAt,
        preflight,
        postflight,
        writeAttribution,
        results,
        gate: {
            status: gate.status as 'PASS' | 'FAIL',
            failureCode: gate.failureCode as string | null,
            stoppedBeforePnu: gate.stoppedBeforePnu as string | null,
        },
    };
}

const PUBLIC_MANIFEST_LABEL_RE =
    /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

function countPublicAggregateValues<T extends string>(
    values: Array<T | null>,
    keys: readonly T[]
): Record<T | 'NONE', number> {
    const counts = Object.fromEntries([
        ...keys.map((key) => [key, 0]),
        ['NONE', 0],
    ]) as Record<T | 'NONE', number>;
    for (const value of values) {
        counts[value ?? 'NONE'] += 1;
    }
    return counts;
}

export function createDevelopmentPublicRunArtifact(
    artifact: DevelopmentRunArtifact,
    manifestLabel: string
): DevelopmentPublicRunArtifact {
    const strategyCounts = countPublicAggregateValues(
        artifact.results.map((result) => result.strategy),
        ['LADFRL', 'LDAREG'] as const
    );
    const outcomeCounts = countPublicAggregateValues(
        artifact.results.map((result) => result.outcome),
        [
            'APPLIED',
            'PARTIAL',
            'NO_DATA',
            'REVIEW_REQUIRED',
            'FAILED',
        ] as const
    );
    return validateDevelopmentPublicRunArtifact(
        {
            version: DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION,
            databaseTarget: 'development',
            manifestLabel,
            aggregateCounts: {
                targetCount: artifact.targetCount,
                expectedPropertyUnitCount:
                    artifact.expectedPropertyUnitCount,
                observedPropertyUnitCount:
                    artifact.observedPropertyUnitCount,
                resultCount: artifact.results.length,
                preflightActivePropertyUnitCount:
                    artifact.preflight?.activePropertyUnitCount ?? null,
                preflightActivePnuCount:
                    artifact.preflight?.activePnuCount ?? null,
                preflightPositiveLandAreaCount:
                    artifact.preflight?.positiveLandAreaCount ?? null,
                postflightActivePropertyUnitCount:
                    artifact.postflight?.activePropertyUnitCount ?? null,
                postflightActivePnuCount:
                    artifact.postflight?.activePnuCount ?? null,
                postflightPositiveLandAreaCount:
                    artifact.postflight?.positiveLandAreaCount ?? null,
                writerJobCount:
                    artifact.writeAttribution?.writerJobCount ?? null,
                attributedPropertyUnitCount:
                    artifact.writeAttribution
                        ?.attributedPropertyUnitCount ?? null,
            },
            digests: {
                manifestDigest: artifact.manifestDigest,
                preflightIdentityDigest:
                    artifact.preflight?.identityDigest ?? null,
                preflightTupleDigest:
                    artifact.preflight?.tupleDigest ?? null,
                preflightNonTargetTupleDigest:
                    artifact.preflight?.nonTargetTupleDigest ?? null,
                postflightIdentityDigest:
                    artifact.postflight?.identityDigest ?? null,
                postflightTupleDigest:
                    artifact.postflight?.tupleDigest ?? null,
                postflightNonTargetTupleDigest:
                    artifact.postflight?.nonTargetTupleDigest ?? null,
                writeAttributionDigest:
                    artifact.writeAttribution?.attributionDigest ?? null,
            },
            strategyCounts,
            outcomeCounts,
            gate: {
                status: artifact.gate.status,
                failureCode: artifact.gate.failureCode,
            },
        },
        manifestLabel
    );
}

export function validateDevelopmentPublicRunArtifact(
    input: unknown,
    manifestLabel: string
): DevelopmentPublicRunArtifact {
    const value = asRecord(input, 'PUBLIC_RUN_ARTIFACT_INVALID');
    const aggregateCounts = asRecord(
        value.aggregateCounts,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const digests = asRecord(
        value.digests,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const strategyCounts = asRecord(
        value.strategyCounts,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const outcomeCounts = asRecord(
        value.outcomeCounts,
        'PUBLIC_RUN_ARTIFACT_INVALID'
    );
    const gate = asRecord(value.gate, 'PUBLIC_RUN_ARTIFACT_INVALID');
    const aggregateKeys = [
        'targetCount',
        'expectedPropertyUnitCount',
        'observedPropertyUnitCount',
        'resultCount',
        'preflightActivePropertyUnitCount',
        'preflightActivePnuCount',
        'preflightPositiveLandAreaCount',
        'postflightActivePropertyUnitCount',
        'postflightActivePnuCount',
        'postflightPositiveLandAreaCount',
        'writerJobCount',
        'attributedPropertyUnitCount',
    ] as const;
    const nullableCountKeys = aggregateKeys.slice(4);
    const digestKeys = [
        'manifestDigest',
        'preflightIdentityDigest',
        'preflightTupleDigest',
        'preflightNonTargetTupleDigest',
        'postflightIdentityDigest',
        'postflightTupleDigest',
        'postflightNonTargetTupleDigest',
        'writeAttributionDigest',
    ] as const;
    const strategyKeys = ['LADFRL', 'LDAREG', 'NONE'] as const;
    const outcomeKeys = [
        'APPLIED',
        'PARTIAL',
        'NO_DATA',
        'REVIEW_REQUIRED',
        'FAILED',
        'NONE',
    ] as const;
    const validNullableCount = (candidate: unknown): boolean =>
        candidate === null ||
        (Number.isSafeInteger(candidate) && (candidate as number) >= 0);
    const validNullableDigest = (candidate: unknown): boolean =>
        candidate === null ||
        (typeof candidate === 'string' && HEX64_RE.test(candidate));

    if (
        !PUBLIC_MANIFEST_LABEL_RE.test(manifestLabel) ||
        !hasExactKeys(value, [
            'version',
            'databaseTarget',
            'manifestLabel',
            'aggregateCounts',
            'digests',
            'strategyCounts',
            'outcomeCounts',
            'gate',
        ]) ||
        value.version !== DEVELOPMENT_PUBLIC_RUN_ARTIFACT_VERSION ||
        value.databaseTarget !== 'development' ||
        value.manifestLabel !== manifestLabel ||
        !hasExactKeys(aggregateCounts, aggregateKeys) ||
        !aggregateKeys.slice(0, 4).every(
            (key) =>
                Number.isSafeInteger(aggregateCounts[key]) &&
                (aggregateCounts[key] as number) >= 0
        ) ||
        !nullableCountKeys.every((key) =>
            validNullableCount(aggregateCounts[key])
        ) ||
        !hasExactKeys(digests, digestKeys) ||
        typeof digests.manifestDigest !== 'string' ||
        !HEX64_RE.test(digests.manifestDigest) ||
        !digestKeys
            .slice(1)
            .every((key) => validNullableDigest(digests[key])) ||
        !hasExactKeys(strategyCounts, strategyKeys) ||
        !strategyKeys.every(
            (key) =>
                Number.isSafeInteger(strategyCounts[key]) &&
                (strategyCounts[key] as number) >= 0
        ) ||
        !hasExactKeys(outcomeCounts, outcomeKeys) ||
        !outcomeKeys.every(
            (key) =>
                Number.isSafeInteger(outcomeCounts[key]) &&
                (outcomeCounts[key] as number) >= 0
        ) ||
        strategyKeys.reduce(
            (sum, key) => sum + (strategyCounts[key] as number),
            0
        ) !== aggregateCounts.resultCount ||
        outcomeKeys.reduce(
            (sum, key) => sum + (outcomeCounts[key] as number),
            0
        ) !== aggregateCounts.resultCount ||
        !hasExactKeys(gate, ['status', 'failureCode']) ||
        (gate.status !== 'PASS' && gate.status !== 'FAIL') ||
        (gate.failureCode !== null &&
            (typeof gate.failureCode !== 'string' ||
                !/^[A-Z0-9_]{1,100}$/.test(gate.failureCode)))
    ) {
        throw new ControlledRunnerError('PUBLIC_RUN_ARTIFACT_INVALID');
    }
    const preflightFields = [
        aggregateCounts.preflightActivePropertyUnitCount,
        aggregateCounts.preflightActivePnuCount,
        aggregateCounts.preflightPositiveLandAreaCount,
        digests.preflightIdentityDigest,
        digests.preflightTupleDigest,
        digests.preflightNonTargetTupleDigest,
    ];
    const postflightFields = [
        aggregateCounts.postflightActivePropertyUnitCount,
        aggregateCounts.postflightActivePnuCount,
        aggregateCounts.postflightPositiveLandAreaCount,
        digests.postflightIdentityDigest,
        digests.postflightTupleDigest,
        digests.postflightNonTargetTupleDigest,
    ];
    const attributionFields = [
        aggregateCounts.writerJobCount,
        aggregateCounts.attributedPropertyUnitCount,
        digests.writeAttributionDigest,
    ];
    const allNullOrAllPresent = (fields: unknown[]): boolean =>
        fields.every((field) => field === null) ||
        fields.every((field) => field !== null);
    if (
        !allNullOrAllPresent(preflightFields) ||
        !allNullOrAllPresent(postflightFields) ||
        !allNullOrAllPresent(attributionFields) ||
        (aggregateCounts.resultCount as number) >
            (aggregateCounts.targetCount as number) ||
        (gate.status === 'PASS' &&
            (gate.failureCode !== null ||
                aggregateCounts.observedPropertyUnitCount !==
                    aggregateCounts.expectedPropertyUnitCount ||
                aggregateCounts.resultCount !==
                    aggregateCounts.targetCount ||
                outcomeCounts.APPLIED !== aggregateCounts.resultCount ||
                outcomeKeys
                    .filter((key) => key !== 'APPLIED')
                    .some((key) => outcomeCounts[key] !== 0) ||
                preflightFields.some((field) => field === null) ||
                postflightFields.some((field) => field === null) ||
                attributionFields.some((field) => field === null))) ||
        (gate.status === 'FAIL' && gate.failureCode === null)
    ) {
        throw new ControlledRunnerError('PUBLIC_RUN_ARTIFACT_INVALID');
    }
    return value as unknown as DevelopmentPublicRunArtifact;
}

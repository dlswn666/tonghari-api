import { createHash } from 'node:crypto';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SnapshotRow = Record<string, JsonValue>;

export const PHASE0_S_ARTIFACT_VERSION = 'phase0-s-artifact/v3' as const;
export const PHASE0_S_MEMBER_APPROVAL_VERSION = 'phase0-s-member-approval/v2' as const;

export const PHASE0_S_DATASETS = [
    'propertyUnits',
    'propertyOwnerships',
    'canonicalMemberProperties',
    'minorParcelResults',
    'buildingLandLots',
    'buildingOrphanSummary',
] as const;

export type Phase0DatasetName = (typeof PHASE0_S_DATASETS)[number];

export interface Phase0RawUnionSnapshot {
    alias: string;
    unionId: string;
    propertyUnits: SnapshotRow[];
    propertyOwnerships: SnapshotRow[];
    canonicalMemberProperties: SnapshotRow[];
    minorParcelResults: SnapshotRow[];
    buildingLandLots: SnapshotRow[];
    buildingOrphanSummary: SnapshotRow[];
}

export interface Phase0HashedRow {
    keyHash: string;
    rowHash: string;
    columnHashes: Record<string, string>;
}

export interface Phase0DatasetArtifact {
    rowCount: number;
    digest: string;
    rows: Phase0HashedRow[];
}

export interface Phase0UnionArtifact {
    alias: string;
    unionIdHash: string;
    sharedPnuHashes: string[];
    sharedPnuCoverageCommitment: string;
    datasets: Record<Phase0DatasetName, Phase0DatasetArtifact>;
}

export interface Phase0SnapshotArtifact {
    schemaVersion: typeof PHASE0_S_ARTIFACT_VERSION;
    source: {
        kind: 'FIXTURE' | 'DISPOSABLE_CLONE' | 'DEVELOPMENT_PROJECT';
        label: string;
        projectRefHash: string | null;
    };
    capturedAt: string;
    unions: Phase0UnionArtifact[];
}

export interface Phase0RowChange {
    dataset: Phase0DatasetName;
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    keyHash: string;
    changedColumns: string[];
    before: Phase0HashedRow | null;
    after: Phase0HashedRow | null;
}

export interface Phase0Violation {
    code: string;
    message: string;
    unionAlias?: string;
    dataset?: Phase0DatasetName;
    rowKeyHash?: string;
    changedColumns?: string[];
}

export interface Phase0GateResult {
    passed: boolean;
    gate: 'INVARIANCE' | 'MEMBER_IMPORT';
    operation: string;
    sharedPnuHashCount: number;
    violations: Phase0Violation[];
    digests: Record<string, Record<Phase0DatasetName, { before: string; after: string }>>;
}

export interface ApprovedMemberImportChange {
    dataset: 'propertyUnits' | 'propertyOwnerships';
    operation: 'INSERT' | 'UPDATE';
    rowKeyHash?: string;
    changedColumns: string[];
    matchAfterColumnHashes: Record<string, string>;
    source: 'PROPERTY_OWNED_INPUT';
}

export interface Phase0MemberImportApproval {
    schemaVersion: typeof PHASE0_S_MEMBER_APPROVAL_VERSION;
    targetAlias: string;
    peerAliases: string[];
    expectedTargetCanonicalMemberPropertiesDigest: string;
    expectedTargetMinorParcelDigest: string;
    changes: ApprovedMemberImportChange[];
}

function sha256(value: string): string {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function isSha256(value: unknown): value is string {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path} must be a plain JSON object`);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} must not contain non-JSON objects`);
    }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
    const unknownKeys = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${path} contains unsupported fields: ${unknownKeys.sort().join(', ')}`);
    }
}

/** JSON 객체 key를 정렬해 DB 반환 순서와 무관한 canonical 문자열을 만든다. */
export function canonicalJson(value: unknown, path = '$'): string {
    if (value === null) return 'null';

    if (typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`${path} contains a non-finite number`);
        }
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(',')}]`;
    }

    assertPlainObject(value, path);
    const entries = Object.keys(value)
        .sort()
        .map((key) => {
            const item = value[key];
            if (item === undefined) {
                throw new Error(`${path}.${key} is undefined; snapshots must be valid JSON`);
            }
            return `${JSON.stringify(key)}:${canonicalJson(item, `${path}.${key}`)}`;
        });
    return `{${entries.join(',')}}`;
}

/** 원문 값을 노출하지 않는 비교용 hash. null도 고정 hash로 판별할 수 있다. */
export function hashCanonicalValue(value: unknown): string {
    return sha256(canonicalJson(value));
}

const COVERAGE_RESULT_STATUS_PRESENT_COLUMN = '$coverage.resultStatusPresent';
const COVERAGE_ORPHAN_ID_SET_COMMITMENT_COLUMN = '$coverage.orphanBuildingIdSetCommitment';
const HASH_TRUE = hashCanonicalValue(true);
const HASH_FALSE = hashCanonicalValue(false);
const HASH_NULL = hashCanonicalValue(null);
const HASH_EMPTY_STRING = hashCanonicalValue('');
const HASH_GLOBAL_SNAPSHOT_KEY = hashCanonicalValue('GLOBAL');

const BUILDING_ORPHAN_GLOBAL_COLUMNS = [
    'snapshot_key',
    'building_count',
    'mapped_building_count',
    'orphan_count',
    'orphan_building_ids',
    COVERAGE_ORPHAN_ID_SET_COMMITMENT_COLUMN,
] as const;

const BUILDING_ORPHAN_STATUS_COLUMNS = [
    'snapshot_key',
    'building_id',
    'is_orphan',
] as const;

function commitHashSet(label: string, hashes: string[]): string {
    return sha256(`${label}:${canonicalJson(Array.from(new Set(hashes)).sort())}`);
}

/** v3 row commitment: 원문 없이도 모든 column/coverage hash의 결합을 parser가 재검증할 수 있다. */
function commitColumnHashes(columnHashes: Record<string, string>): string {
    return sha256(`phase0-s-row/v3:${canonicalJson(columnHashes)}`);
}

function getRawRowKey(dataset: Phase0DatasetName, row: SnapshotRow): string {
    const keyColumn = {
        propertyUnits: 'id',
        propertyOwnerships: 'id',
        canonicalMemberProperties: 'property_ownership_id',
        minorParcelResults: 'snapshot_key',
        buildingLandLots: 'id',
        buildingOrphanSummary: 'snapshot_key',
    } satisfies Record<Phase0DatasetName, string>;
    const key = row[keyColumn[dataset]];
    if (typeof key !== 'string' || key.length === 0) {
        throw new Error(`${dataset} row is missing a non-empty ${keyColumn[dataset]}`);
    }
    return key;
}

function validateUnionScopedRows(union: Phase0RawUnionSnapshot): void {
    if (!union.alias.trim()) throw new Error('union alias is required');
    if (!union.unionId.trim()) throw new Error(`union ${union.alias} id is required`);

    const unionScopedDatasets = [
        'propertyUnits',
        'propertyOwnerships',
        'canonicalMemberProperties',
        'minorParcelResults',
    ] as const;
    for (const dataset of PHASE0_S_DATASETS) {
        for (const [index, row] of union[dataset].entries()) {
            assertPlainObject(row, `${union.alias}.${dataset}[${index}]`);
            if (unionScopedDatasets.includes(dataset as (typeof unionScopedDatasets)[number]) && row.union_id !== union.unionId) {
                throw new Error(
                    `${union.alias}.${dataset}[${index}] union_id does not match the requested union`
                );
            }
            canonicalJson(row, `${union.alias}.${dataset}[${index}]`);
        }
    }
}

function createDatasetArtifact(
    dataset: Phase0DatasetName,
    rows: SnapshotRow[]
): Phase0DatasetArtifact {
    const seenKeys = new Set<string>();
    const hashedRows = rows.map((row) => {
        const rawKey = getRawRowKey(dataset, row);
        if (seenKeys.has(rawKey)) {
            throw new Error(`${dataset} contains duplicate row key ${rawKey}`);
        }
        seenKeys.add(rawKey);

        if (
            Object.hasOwn(row, COVERAGE_RESULT_STATUS_PRESENT_COLUMN) ||
            Object.hasOwn(row, COVERAGE_ORPHAN_ID_SET_COMMITMENT_COLUMN)
        ) {
            throw new Error(`${dataset} row contains reserved coverage metadata`);
        }
        const columnHashes = Object.fromEntries(
            Object.keys(row)
                .sort()
                .map((column) => [column, hashCanonicalValue(row[column])])
        );
        if (dataset === 'minorParcelResults') {
            const result = row.result;
            const hasResultStatus = result !== null &&
                typeof result === 'object' &&
                !Array.isArray(result) &&
                typeof result.status === 'string' &&
                result.status.length > 0;
            columnHashes[COVERAGE_RESULT_STATUS_PRESENT_COLUMN] = hashCanonicalValue(hasResultStatus);
        }
        if (dataset === 'buildingOrphanSummary' && row.snapshot_key === 'GLOBAL') {
            const orphanBuildingIds = row.orphan_building_ids;
            if (
                !Array.isArray(orphanBuildingIds) ||
                !orphanBuildingIds.every((buildingId) =>
                    typeof buildingId === 'string' && buildingId.length > 0
                )
            ) {
                throw new Error('buildingOrphanSummary GLOBAL row has invalid orphan_building_ids');
            }
            columnHashes[COVERAGE_ORPHAN_ID_SET_COMMITMENT_COLUMN] = commitHashSet(
                'phase0-s-orphan-building-ids/v3',
                orphanBuildingIds.map((buildingId) => hashCanonicalValue(buildingId))
            );
        }
        return {
            keyHash: sha256(`${dataset}:${rawKey}`),
            rowHash: commitColumnHashes(columnHashes),
            columnHashes,
        };
    });

    hashedRows.sort((a, b) => a.keyHash.localeCompare(b.keyHash));
    return {
        rowCount: hashedRows.length,
        digest: sha256(hashedRows.map((row) => `${row.keyHash}:${row.rowHash}`).join('\n')),
        rows: hashedRows,
    };
}

function columnHash(row: Phase0HashedRow, column: string): string | undefined {
    return row.columnHashes[column];
}

/**
 * 원문 PNU 없이 hashed row의 관계만으로 완전 coverage PNU를 다시 계산한다.
 * 따라서 sharedPnuHashes는 별도 주장 값이 아니라 6개 dataset commitment의 파생값이다.
 */
function recomputeFullyCoveredPnuHashes(
    datasets: Record<Phase0DatasetName, Phase0DatasetArtifact>
): string[] {
    const minorRows = datasets.minorParcelResults.rows;
    const groupMemberIdHashes = new Set(
        minorRows
            .filter((row) =>
                columnHash(row, 'scope') === hashCanonicalValue('MEMBER_GROUP') &&
                columnHash(row, COVERAGE_RESULT_STATUS_PRESENT_COLUMN) === HASH_TRUE
            )
            .map((row) => columnHash(row, 'member_group_id'))
            .filter((hash): hash is string => Boolean(hash) && hash !== HASH_NULL && hash !== HASH_EMPTY_STRING)
    );
    const nonOrphanBuildingIdHashes = new Set(
        datasets.buildingOrphanSummary.rows
            .filter((row) =>
                columnHash(row, 'snapshot_key') !== HASH_GLOBAL_SNAPSHOT_KEY &&
                columnHash(row, 'is_orphan') === HASH_FALSE
            )
            .map((row) => columnHash(row, 'building_id'))
            .filter((hash): hash is string => Boolean(hash) && hash !== HASH_NULL && hash !== HASH_EMPTY_STRING)
    );
    const candidatePnuHashes = new Set(
        datasets.propertyUnits.rows
            .filter((row) => columnHash(row, 'is_deleted') === HASH_FALSE)
            .map((row) => columnHash(row, 'pnu'))
            .filter((hash): hash is string => Boolean(hash) && hash !== HASH_NULL && hash !== HASH_EMPTY_STRING)
    );

    return Array.from(candidatePnuHashes).filter((pnuHash) => {
        const mappings = datasets.buildingLandLots.rows.filter(
            (row) => columnHash(row, 'pnu') === pnuHash
        );
        if (
            mappings.length === 0 ||
            mappings.some((row) => {
                const buildingIdHash = columnHash(row, 'building_id');
                return !buildingIdHash || !nonOrphanBuildingIdHashes.has(buildingIdHash);
            })
        ) {
            return false;
        }

        return datasets.propertyUnits.rows
            .filter((property) =>
                columnHash(property, 'is_deleted') === HASH_FALSE &&
                columnHash(property, 'pnu') === pnuHash
            )
            .some((property) => {
                const propertyIdHash = columnHash(property, 'id');
                if (!propertyIdHash) return false;
                return datasets.propertyOwnerships.rows
                    .filter((ownership) =>
                        columnHash(ownership, 'is_active') === HASH_TRUE &&
                        columnHash(ownership, 'property_unit_id') === propertyIdHash
                    )
                    .some((ownership) => {
                        const ownershipIdHash = columnHash(ownership, 'id');
                        if (!ownershipIdHash) return false;
                        const hasCanonical = datasets.canonicalMemberProperties.rows.some((canonical) =>
                            columnHash(canonical, 'is_active') === HASH_TRUE &&
                            columnHash(canonical, 'property_ownership_id') === ownershipIdHash &&
                            columnHash(canonical, 'official_property_unit_id') === propertyIdHash &&
                            columnHash(canonical, 'pnu') === pnuHash
                        );
                        if (!hasCanonical) return false;

                        return minorRows.some((minor) => {
                            const memberGroupIdHash = columnHash(minor, 'member_group_id');
                            return columnHash(minor, 'scope') === hashCanonicalValue('PROPERTY_UNIT') &&
                                columnHash(minor, COVERAGE_RESULT_STATUS_PRESENT_COLUMN) === HASH_TRUE &&
                                columnHash(minor, 'property_unit_id') === propertyIdHash &&
                                columnHash(minor, 'property_ownership_id') === ownershipIdHash &&
                                Boolean(memberGroupIdHash) &&
                                groupMemberIdHashes.has(memberGroupIdHash!);
                        });
                    });
            });
    }).sort();
}

function commitSharedPnuCoverage(
    sharedPnuHashes: string[],
    datasets: Record<Phase0DatasetName, Phase0DatasetArtifact>
): string {
    return sha256(`phase0-s-shared-pnu-coverage/v3:${canonicalJson({
        sharedPnuHashes: [...sharedPnuHashes].sort(),
        datasetDigests: Object.fromEntries(
            PHASE0_S_DATASETS.map((dataset) => [dataset, datasets[dataset].digest])
        ),
    })}`);
}

function assertBuildingOrphanSummaryCoverage(
    dataset: Phase0DatasetArtifact,
    path: string
): void {
    const globalRows = dataset.rows.filter(
        (row) => columnHash(row, 'snapshot_key') === HASH_GLOBAL_SNAPSHOT_KEY
    );
    if (globalRows.length !== 1) {
        throw new Error(`${path} must contain exactly one GLOBAL row`);
    }
    const globalRow = globalRows[0];
    if (
        columnHash(globalRow, 'building_id') !== undefined ||
        columnHash(globalRow, 'is_orphan') !== undefined
    ) {
        throw new Error(`${path} GLOBAL row cannot contain building status fields`);
    }
    if (!sameStringSet(Object.keys(globalRow.columnHashes), [...BUILDING_ORPHAN_GLOBAL_COLUMNS])) {
        throw new Error(`${path} GLOBAL row has invalid schema`);
    }
    const buildingRows = dataset.rows.filter((row) => row !== globalRow);
    const buildingIdHashes = buildingRows.map((row, index) => {
        if (!sameStringSet(Object.keys(row.columnHashes), [...BUILDING_ORPHAN_STATUS_COLUMNS])) {
            throw new Error(`${path} building status row ${index} has invalid schema`);
        }
        const snapshotKeyHash = columnHash(row, 'snapshot_key');
        const buildingIdHash = columnHash(row, 'building_id');
        const orphanHash = columnHash(row, 'is_orphan');
        if (
            !snapshotKeyHash ||
            snapshotKeyHash === HASH_NULL ||
            snapshotKeyHash === HASH_EMPTY_STRING ||
            !buildingIdHash ||
            buildingIdHash === HASH_NULL ||
            buildingIdHash === HASH_EMPTY_STRING ||
            ![HASH_TRUE, HASH_FALSE].includes(orphanHash ?? '')
        ) {
            throw new Error(`${path} building status row ${index} is invalid`);
        }
        return buildingIdHash;
    });
    if (new Set(buildingIdHashes).size !== buildingIdHashes.length) {
        throw new Error(`${path} contains duplicate building identity hashes`);
    }
    const orphanBuildingIdHashes = buildingRows
        .filter((row) => columnHash(row, 'is_orphan') === HASH_TRUE)
        .map((row) => columnHash(row, 'building_id')!);
    const nonOrphanCount = buildingRows.length - orphanBuildingIdHashes.length;
    if (
        columnHash(globalRow, 'building_count') !== hashCanonicalValue(buildingRows.length) ||
        columnHash(globalRow, 'mapped_building_count') !== hashCanonicalValue(nonOrphanCount) ||
        columnHash(globalRow, 'orphan_count') !== hashCanonicalValue(orphanBuildingIdHashes.length)
    ) {
        throw new Error(`${path} GLOBAL counts do not match building status rows`);
    }
    const expectedOrphanSetCommitment = commitHashSet(
        'phase0-s-orphan-building-ids/v3',
        orphanBuildingIdHashes
    );
    if (
        columnHash(globalRow, COVERAGE_ORPHAN_ID_SET_COMMITMENT_COLUMN) !==
        expectedOrphanSetCommitment
    ) {
        throw new Error(`${path} GLOBAL orphan set commitment does not match building status rows`);
    }
}

export function createPhase0SnapshotArtifact(input: {
    source: Phase0SnapshotArtifact['source'];
    capturedAt?: string;
    unions: Phase0RawUnionSnapshot[];
}): Phase0SnapshotArtifact {
    const seenAliases = new Set<string>();
    const seenUnionIdHashes = new Set<string>();
    const unions = input.unions.map((union) => {
        validateUnionScopedRows(union);
        if (seenAliases.has(union.alias)) {
            throw new Error(`duplicate union alias ${union.alias}`);
        }
        seenAliases.add(union.alias);
        const unionIdHash = sha256(`union:${union.unionId}`);
        if (seenUnionIdHashes.has(unionIdHash)) {
            throw new Error('captured union identities must be pairwise distinct');
        }
        seenUnionIdHashes.add(unionIdHash);

        const datasets = {
            propertyUnits: createDatasetArtifact('propertyUnits', union.propertyUnits),
            propertyOwnerships: createDatasetArtifact(
                'propertyOwnerships',
                union.propertyOwnerships
            ),
            canonicalMemberProperties: createDatasetArtifact(
                'canonicalMemberProperties',
                union.canonicalMemberProperties
            ),
            minorParcelResults: createDatasetArtifact(
                'minorParcelResults',
                union.minorParcelResults
            ),
            buildingLandLots: createDatasetArtifact(
                'buildingLandLots',
                union.buildingLandLots
            ),
            buildingOrphanSummary: createDatasetArtifact(
                'buildingOrphanSummary',
                union.buildingOrphanSummary
            ),
        } satisfies Record<Phase0DatasetName, Phase0DatasetArtifact>;
        assertBuildingOrphanSummaryCoverage(
            datasets.buildingOrphanSummary,
            `${union.alias}.buildingOrphanSummary`
        );
        const sharedPnuHashes = recomputeFullyCoveredPnuHashes(datasets);

        return {
            alias: union.alias,
            unionIdHash,
            sharedPnuHashes,
            sharedPnuCoverageCommitment: commitSharedPnuCoverage(sharedPnuHashes, datasets),
            datasets,
        };
    });

    unions.sort((a, b) => a.alias.localeCompare(b.alias));
    return {
        schemaVersion: PHASE0_S_ARTIFACT_VERSION,
        source: input.source,
        capturedAt: input.capturedAt ?? new Date().toISOString(),
        unions,
    };
}

function assertHashedRow(value: unknown, path: string): asserts value is Phase0HashedRow {
    assertPlainObject(value, path);
    assertAllowedKeys(value, ['keyHash', 'rowHash', 'columnHashes'], path);
    if (!isSha256(value.keyHash) || !isSha256(value.rowHash)) {
        throw new Error(`${path} has invalid hashes`);
    }
    assertPlainObject(value.columnHashes, `${path}.columnHashes`);
    for (const [column, hash] of Object.entries(value.columnHashes)) {
        if (!column || !isSha256(hash)) {
            throw new Error(`${path}.columnHashes is invalid`);
        }
    }
    const expectedRowHash = commitColumnHashes(value.columnHashes as Record<string, string>);
    if (value.rowHash !== expectedRowHash) {
        throw new Error(`${path}.rowHash does not commit to columnHashes`);
    }
}

/** CLI에서 읽은 artifact가 원문 row를 포함하지 않고 hash 구조만 갖는지 검증한다. */
export function parsePhase0SnapshotArtifact(value: unknown): Phase0SnapshotArtifact {
    assertPlainObject(value, 'artifact');
    assertAllowedKeys(value, ['schemaVersion', 'source', 'capturedAt', 'unions'], 'artifact');
    if (value.schemaVersion !== PHASE0_S_ARTIFACT_VERSION) {
        throw new Error(`unsupported artifact schemaVersion: ${String(value.schemaVersion)}`);
    }
    if (!Array.isArray(value.unions)) throw new Error('artifact.unions must be an array');
    assertPlainObject(value.source, 'artifact.source');
    assertAllowedKeys(value.source, ['kind', 'label', 'projectRefHash'], 'artifact.source');
    if (!['FIXTURE', 'DISPOSABLE_CLONE', 'DEVELOPMENT_PROJECT'].includes(String(value.source.kind))) {
        throw new Error('artifact.source.kind is invalid');
    }
    if (typeof value.source.label !== 'string') throw new Error('artifact.source.label is invalid');
    if (value.source.projectRefHash !== null && !isSha256(value.source.projectRefHash)) {
        throw new Error('artifact.source.projectRefHash is invalid');
    }
    if (value.source.kind !== 'FIXTURE' && value.source.projectRefHash === null) {
        throw new Error('non-production artifact.source.projectRefHash is required');
    }
    if (typeof value.capturedAt !== 'string') throw new Error('artifact.capturedAt is invalid');

    const seenAliases = new Set<string>();
    const seenUnionIdHashes = new Set<string>();
    for (const [unionIndex, unionValue] of value.unions.entries()) {
        const unionPath = `artifact.unions[${unionIndex}]`;
        assertPlainObject(unionValue, unionPath);
        assertAllowedKeys(unionValue, [
            'alias',
            'unionIdHash',
            'sharedPnuHashes',
            'sharedPnuCoverageCommitment',
            'datasets',
        ], unionPath);
        if (typeof unionValue.alias !== 'string' || !unionValue.alias) {
            throw new Error(`${unionPath}.alias is required`);
        }
        if (seenAliases.has(unionValue.alias)) throw new Error(`duplicate union alias ${unionValue.alias}`);
        seenAliases.add(unionValue.alias);
        if (!isSha256(unionValue.unionIdHash)) throw new Error(`${unionPath}.unionIdHash is invalid`);
        if (seenUnionIdHashes.has(unionValue.unionIdHash)) {
            throw new Error('artifact union identities must be pairwise distinct');
        }
        seenUnionIdHashes.add(unionValue.unionIdHash);
        if (!Array.isArray(unionValue.sharedPnuHashes)) {
            throw new Error(`${unionPath}.sharedPnuHashes must be an array`);
        }
        if (!unionValue.sharedPnuHashes.every((hash) => isSha256(hash))) {
            throw new Error(`${unionPath}.sharedPnuHashes is invalid`);
        }
        const canonicalSharedPnuHashes = Array.from(new Set(unionValue.sharedPnuHashes)).sort();
        if (canonicalJson(unionValue.sharedPnuHashes) !== canonicalJson(canonicalSharedPnuHashes)) {
            throw new Error(`${unionPath}.sharedPnuHashes must be sorted and unique`);
        }
        if (!isSha256(unionValue.sharedPnuCoverageCommitment)) {
            throw new Error(`${unionPath}.sharedPnuCoverageCommitment is invalid`);
        }
        assertPlainObject(unionValue.datasets, `${unionPath}.datasets`);
        assertAllowedKeys(unionValue.datasets, [...PHASE0_S_DATASETS], `${unionPath}.datasets`);
        for (const dataset of PHASE0_S_DATASETS) {
            const datasetValue = unionValue.datasets[dataset];
            const datasetPath = `${unionPath}.datasets.${dataset}`;
            assertPlainObject(datasetValue, datasetPath);
            assertAllowedKeys(datasetValue, ['rowCount', 'digest', 'rows'], datasetPath);
            if (!Number.isInteger(datasetValue.rowCount) || !isSha256(datasetValue.digest)) {
                throw new Error(`${datasetPath} metadata is invalid`);
            }
            if (!Array.isArray(datasetValue.rows)) throw new Error(`${datasetPath}.rows must be an array`);
            if (datasetValue.rows.length !== datasetValue.rowCount) {
                throw new Error(`${datasetPath} row count does not match rows`);
            }
            datasetValue.rows.forEach((row, index) => {
                assertHashedRow(row, `${datasetPath}.rows[${index}]`);
                const statusPresentHash = row.columnHashes[COVERAGE_RESULT_STATUS_PRESENT_COLUMN];
                const orphanSetCommitmentHash =
                    row.columnHashes[COVERAGE_ORPHAN_ID_SET_COMMITMENT_COLUMN];
                if (dataset === 'minorParcelResults') {
                    if (![HASH_TRUE, HASH_FALSE].includes(statusPresentHash)) {
                        throw new Error(`${datasetPath}.rows[${index}] is missing result status coverage metadata`);
                    }
                } else if (statusPresentHash !== undefined) {
                    throw new Error(`${datasetPath}.rows[${index}] contains reserved coverage metadata`);
                }
                if (
                    dataset !== 'buildingOrphanSummary' &&
                    orphanSetCommitmentHash !== undefined
                ) {
                    throw new Error(`${datasetPath}.rows[${index}] contains reserved coverage metadata`);
                }
            });
            const keyHashes = datasetValue.rows.map((row) => row.keyHash);
            if (new Set(keyHashes).size !== keyHashes.length) {
                throw new Error(`${datasetPath} contains duplicate keyHash values`);
            }
            const expectedDigest = sha256(
                [...datasetValue.rows]
                    .sort((a, b) => a.keyHash.localeCompare(b.keyHash))
                    .map((row) => `${row.keyHash}:${row.rowHash}`)
                    .join('\n')
            );
            if (datasetValue.digest !== expectedDigest) {
                throw new Error(`${datasetPath}.digest does not match rows`);
            }
        }

        const datasets = unionValue.datasets as unknown as Record<Phase0DatasetName, Phase0DatasetArtifact>;
        assertBuildingOrphanSummaryCoverage(
            datasets.buildingOrphanSummary,
            `${unionPath}.datasets.buildingOrphanSummary`
        );
        const recomputedSharedPnuHashes = recomputeFullyCoveredPnuHashes(datasets);
        if (canonicalJson(unionValue.sharedPnuHashes) !== canonicalJson(recomputedSharedPnuHashes)) {
            throw new Error(`${unionPath}.sharedPnuHashes do not match 6-dataset coverage`);
        }
        const expectedCoverageCommitment = commitSharedPnuCoverage(
            recomputedSharedPnuHashes,
            datasets
        );
        if (unionValue.sharedPnuCoverageCommitment !== expectedCoverageCommitment) {
            throw new Error(`${unionPath}.sharedPnuCoverageCommitment does not match datasets`);
        }
    }

    return value as unknown as Phase0SnapshotArtifact;
}

/** 실제 gate CLI는 테스트 fixture가 아니라 동일한 비운영 DB의 전후 snapshot만 허용한다. */
export function assertDisposableCloneArtifactPair(
    before: Phase0SnapshotArtifact,
    after: Phase0SnapshotArtifact
): void {
    const allowedKinds = new Set(['DISPOSABLE_CLONE', 'DEVELOPMENT_PROJECT']);
    if (!allowedKinds.has(before.source.kind) || !allowedKinds.has(after.source.kind)) {
        throw new Error('gate CLI requires non-production database before/after artifacts');
    }
    if (before.source.kind !== after.source.kind) {
        throw new Error('gate CLI requires matching non-production database source kinds');
    }
    if (
        before.source.projectRefHash === null ||
        after.source.projectRefHash === null ||
        before.source.projectRefHash !== after.source.projectRefHash
    ) {
        throw new Error('gate CLI requires matching non-null non-production projectRefHash values');
    }
}

function getUnion(artifact: Phase0SnapshotArtifact, alias: string): Phase0UnionArtifact {
    const union = artifact.unions.find((candidate) => candidate.alias === alias);
    if (!union) throw new Error(`artifact is missing union alias ${alias}`);
    return union;
}

function assertSelectedUnionIdentitiesDistinct(
    artifact: Phase0SnapshotArtifact,
    aliases: string[],
    context: string
): void {
    const unionIdHashes = aliases.map((alias) => getUnion(artifact, alias).unionIdHash);
    if (new Set(unionIdHashes).size !== unionIdHashes.length) {
        throw new Error(`${context} selected union identities must be pairwise distinct`);
    }
}

function getSharedPnuHashes(artifact: Phase0SnapshotArtifact, aliases: string[]): string[] {
    if (aliases.length < 2) throw new Error('at least two union aliases are required');
    const sets = aliases.map((alias) => new Set(getUnion(artifact, alias).sharedPnuHashes));
    return Array.from(sets[0]).filter((hash) => sets.slice(1).every((set) => set.has(hash))).sort();
}

function getStableSharedPnuHashes(
    before: Phase0SnapshotArtifact,
    after: Phase0SnapshotArtifact,
    aliases: string[]
): string[] {
    const beforeShared = getSharedPnuHashes(before, aliases);
    const afterShared = new Set(getSharedPnuHashes(after, aliases));
    return beforeShared.filter((hash) => afterShared.has(hash));
}

function diffDataset(
    dataset: Phase0DatasetName,
    before: Phase0DatasetArtifact,
    after: Phase0DatasetArtifact
): Phase0RowChange[] {
    const beforeRows = new Map(before.rows.map((row) => [row.keyHash, row]));
    const afterRows = new Map(after.rows.map((row) => [row.keyHash, row]));
    const keys = Array.from(new Set([...beforeRows.keys(), ...afterRows.keys()])).sort();

    return keys.flatMap((keyHash): Phase0RowChange[] => {
        const beforeRow = beforeRows.get(keyHash) ?? null;
        const afterRow = afterRows.get(keyHash) ?? null;
        if (beforeRow?.rowHash === afterRow?.rowHash) return [];
        if (!beforeRow) {
            return [{
                dataset,
                operation: 'INSERT',
                keyHash,
                changedColumns: Object.keys(afterRow!.columnHashes).sort(),
                before: null,
                after: afterRow,
            }];
        }
        if (!afterRow) {
            return [{
                dataset,
                operation: 'DELETE',
                keyHash,
                changedColumns: Object.keys(beforeRow.columnHashes).sort(),
                before: beforeRow,
                after: null,
            }];
        }

        const columns = Array.from(
            new Set([...Object.keys(beforeRow.columnHashes), ...Object.keys(afterRow.columnHashes)])
        ).sort();
        return [{
            dataset,
            operation: 'UPDATE',
            keyHash,
            changedColumns: columns.filter(
                (column) => beforeRow.columnHashes[column] !== afterRow.columnHashes[column]
            ),
            before: beforeRow,
            after: afterRow,
        }];
    });
}

function collectDigests(
    before: Phase0SnapshotArtifact,
    after: Phase0SnapshotArtifact,
    aliases: string[]
): Phase0GateResult['digests'] {
    return Object.fromEntries(
        aliases.map((alias) => {
            const beforeUnion = getUnion(before, alias);
            const afterUnion = getUnion(after, alias);
            return [
                alias,
                Object.fromEntries(
                    PHASE0_S_DATASETS.map((dataset) => [
                        dataset,
                        {
                            before: beforeUnion.datasets[dataset].digest,
                            after: afterUnion.datasets[dataset].digest,
                        },
                    ])
                ),
            ];
        })
    ) as Phase0GateResult['digests'];
}

function compareUnionIdentity(
    before: Phase0SnapshotArtifact,
    after: Phase0SnapshotArtifact,
    aliases: string[]
): Phase0Violation[] {
    return aliases.flatMap((alias) => {
        const beforeUnion = getUnion(before, alias);
        const afterUnion = getUnion(after, alias);
        return beforeUnion.unionIdHash === afterUnion.unionIdHash
            ? []
            : [{
                code: 'UNION_IDENTITY_CHANGED',
                message: `${alias}가 전후 서로 다른 조합을 가리킵니다.`,
                unionAlias: alias,
            }];
    });
}

function compareArtifactSource(
    before: Phase0SnapshotArtifact,
    after: Phase0SnapshotArtifact
): Phase0Violation[] {
    if (
        before.source.kind === after.source.kind &&
        before.source.projectRefHash === after.source.projectRefHash
    ) {
        return [];
    }
    return [{
        code: 'SNAPSHOT_SOURCE_CHANGED',
        message: '전후 snapshot이 서로 다른 source 또는 clone project를 가리킵니다.',
    }];
}

export function verifyPhase0InvariantOperation(input: {
    before: Phase0SnapshotArtifact;
    after: Phase0SnapshotArtifact;
    operation: string;
    unionAliases: string[];
}): Phase0GateResult {
    // CLI를 우회해 typed object로 직접 호출해도 commitment 검증을 생략할 수 없다.
    parsePhase0SnapshotArtifact(input.before);
    parsePhase0SnapshotArtifact(input.after);
    if (new Set(input.unionAliases).size !== input.unionAliases.length) {
        throw new Error('shared-PNU gate union aliases must be pairwise distinct');
    }
    const aliases = [...input.unionAliases];
    if (aliases.length < 2) throw new Error('shared-PNU gate requires at least two distinct unions');
    assertSelectedUnionIdentitiesDistinct(input.before, aliases, 'before artifact');
    assertSelectedUnionIdentitiesDistinct(input.after, aliases, 'after artifact');
    const sharedPnus = getStableSharedPnuHashes(input.before, input.after, aliases);
    const violations = [
        ...compareArtifactSource(input.before, input.after),
        ...compareUnionIdentity(input.before, input.after, aliases),
    ];

    if (sharedPnus.length === 0) {
        violations.push({
            code: 'SHARED_PNU_FIXTURE_MISSING',
            message: '전후 선택 조합 사이에 완전 coverage 공유 PNU가 없어 cross-union 회귀를 증명할 수 없습니다.',
        });
    }

    for (const alias of aliases) {
        const beforeUnion = getUnion(input.before, alias);
        const afterUnion = getUnion(input.after, alias);
        for (const dataset of PHASE0_S_DATASETS) {
            if (beforeUnion.datasets[dataset].digest === afterUnion.datasets[dataset].digest) continue;
            for (const change of diffDataset(
                dataset,
                beforeUnion.datasets[dataset],
                afterUnion.datasets[dataset]
            )) {
                violations.push({
                    code: 'INVARIANT_DATASET_CHANGED',
                    message: `${input.operation} 실행으로 ${alias}.${dataset}가 변경됐습니다.`,
                    unionAlias: alias,
                    dataset,
                    rowKeyHash: change.keyHash,
                    changedColumns: change.changedColumns,
                });
            }
        }
    }

    return {
        passed: violations.length === 0,
        gate: 'INVARIANCE',
        operation: input.operation,
        sharedPnuHashCount: sharedPnus.length,
        violations,
        digests: collectDigests(input.before, input.after, aliases),
    };
}

function sameStringSet(left: string[], right: string[]): boolean {
    const leftSorted = Array.from(new Set(left)).sort();
    const rightSorted = Array.from(new Set(right)).sort();
    return canonicalJson(leftSorted) === canonicalJson(rightSorted);
}

function approvalMatchesChange(
    approval: ApprovedMemberImportChange,
    change: Phase0RowChange
): boolean {
    if (approval.dataset !== change.dataset || approval.operation !== change.operation) return false;
    if (approval.rowKeyHash && approval.rowKeyHash !== change.keyHash) return false;
    if (!sameStringSet(approval.changedColumns, change.changedColumns)) return false;
    if (!change.after) return false;
    if (!sameStringSet(Object.keys(approval.matchAfterColumnHashes), change.changedColumns)) {
        return false;
    }

    return change.changedColumns.every(
        (column) => change.after!.columnHashes[column] === approval.matchAfterColumnHashes[column]
    );
}

/** 승인된 member diff를 after snapshot의 실제 property PNU commitment로 해소한다. */
function resolveMemberImportChangePnuHash(
    change: Phase0RowChange,
    targetAfter: Phase0UnionArtifact
): string | null {
    if (!change.after) return null;
    if (change.dataset === 'propertyUnits') {
        const pnuHash = columnHash(change.after, 'pnu');
        return pnuHash && pnuHash !== HASH_NULL && pnuHash !== HASH_EMPTY_STRING
            ? pnuHash
            : null;
    }
    if (change.dataset !== 'propertyOwnerships') return null;

    const propertyUnitIdHash = columnHash(change.after, 'property_unit_id');
    if (
        !propertyUnitIdHash ||
        propertyUnitIdHash === HASH_NULL ||
        propertyUnitIdHash === HASH_EMPTY_STRING
    ) {
        return null;
    }
    const matchingProperties = targetAfter.datasets.propertyUnits.rows.filter(
        (property) => columnHash(property, 'id') === propertyUnitIdHash
    );
    if (matchingProperties.length !== 1) return null;
    const pnuHash = columnHash(matchingProperties[0], 'pnu');
    return pnuHash && pnuHash !== HASH_NULL && pnuHash !== HASH_EMPTY_STRING
        ? pnuHash
        : null;
}

export function parsePhase0MemberImportApproval(value: unknown): Phase0MemberImportApproval {
    assertPlainObject(value, 'approval');
    assertAllowedKeys(value, [
        'schemaVersion',
        'targetAlias',
        'peerAliases',
        'expectedTargetCanonicalMemberPropertiesDigest',
        'expectedTargetMinorParcelDigest',
        'changes',
    ], 'approval');
    if (value.schemaVersion !== PHASE0_S_MEMBER_APPROVAL_VERSION) {
        throw new Error(`unsupported approval schemaVersion: ${String(value.schemaVersion)}`);
    }
    if (typeof value.targetAlias !== 'string' || !value.targetAlias) {
        throw new Error('approval.targetAlias is required');
    }
    if (!Array.isArray(value.peerAliases) || !value.peerAliases.every((alias) => typeof alias === 'string')) {
        throw new Error('approval.peerAliases must be a string array');
    }
    if (
        new Set(value.peerAliases).size !== value.peerAliases.length ||
        value.peerAliases.includes(value.targetAlias)
    ) {
        throw new Error('approval aliases must be distinct');
    }
    if (!isSha256(value.expectedTargetMinorParcelDigest)) {
        throw new Error('approval.expectedTargetMinorParcelDigest is required');
    }
    if (!isSha256(value.expectedTargetCanonicalMemberPropertiesDigest)) {
        throw new Error('approval.expectedTargetCanonicalMemberPropertiesDigest is required');
    }
    if (!Array.isArray(value.changes)) throw new Error('approval.changes must be an array');
    for (const [index, change] of value.changes.entries()) {
        assertPlainObject(change, `approval.changes[${index}]`);
        assertAllowedKeys(change, [
            'dataset',
            'operation',
            'rowKeyHash',
            'changedColumns',
            'matchAfterColumnHashes',
            'source',
        ], `approval.changes[${index}]`);
        if (!['propertyUnits', 'propertyOwnerships'].includes(String(change.dataset))) {
            throw new Error(`approval.changes[${index}].dataset is invalid`);
        }
        if (!['INSERT', 'UPDATE'].includes(String(change.operation))) {
            throw new Error(`approval.changes[${index}].operation is invalid`);
        }
        if (change.source !== 'PROPERTY_OWNED_INPUT') {
            throw new Error(`approval.changes[${index}].source must be PROPERTY_OWNED_INPUT`);
        }
        if (
            !Array.isArray(change.changedColumns) ||
            change.changedColumns.length === 0 ||
            !change.changedColumns.every((column) => typeof column === 'string' && column.length > 0) ||
            new Set(change.changedColumns).size !== change.changedColumns.length
        ) {
            throw new Error(`approval.changes[${index}].changedColumns is invalid`);
        }
        if (change.rowKeyHash !== undefined && !isSha256(change.rowKeyHash)) {
            throw new Error(`approval.changes[${index}].rowKeyHash is invalid`);
        }
        assertPlainObject(change.matchAfterColumnHashes, `approval.changes[${index}].matchAfterColumnHashes`);
        if (!Object.values(change.matchAfterColumnHashes).every((hash) => isSha256(hash))) {
            throw new Error(`approval.changes[${index}].matchAfterColumnHashes is invalid`);
        }
        if (!sameStringSet(Object.keys(change.matchAfterColumnHashes), change.changedColumns)) {
            throw new Error(
                `approval.changes[${index}].matchAfterColumnHashes must cover every changed column exactly`
            );
        }
    }
    return value as unknown as Phase0MemberImportApproval;
}

export function verifyPhase0MemberImport(input: {
    before: Phase0SnapshotArtifact;
    after: Phase0SnapshotArtifact;
    approval: Phase0MemberImportApproval;
}): Phase0GateResult {
    parsePhase0SnapshotArtifact(input.before);
    parsePhase0SnapshotArtifact(input.after);
    parsePhase0MemberImportApproval(input.approval);
    const aliases = [input.approval.targetAlias, ...input.approval.peerAliases];
    assertSelectedUnionIdentitiesDistinct(input.before, aliases, 'before member-import artifact');
    assertSelectedUnionIdentitiesDistinct(input.after, aliases, 'after member-import artifact');
    const sharedPnus = getStableSharedPnuHashes(input.before, input.after, aliases);
    const violations = [
        ...compareArtifactSource(input.before, input.after),
        ...compareUnionIdentity(input.before, input.after, aliases),
    ];
    if (sharedPnus.length === 0) {
        violations.push({
            code: 'SHARED_PNU_FIXTURE_MISSING',
            message: '전후 선택 조합 사이에 완전 coverage 공유 PNU가 없어 cross-union 회귀를 증명할 수 없습니다.',
        });
    }

    for (const alias of input.approval.peerAliases) {
        const beforeUnion = getUnion(input.before, alias);
        const afterUnion = getUnion(input.after, alias);
        for (const dataset of PHASE0_S_DATASETS) {
            if (beforeUnion.datasets[dataset].digest === afterUnion.datasets[dataset].digest) continue;
            violations.push({
                code: 'PEER_UNION_CHANGED',
                message: `member import가 비대상 조합 ${alias}.${dataset}를 변경했습니다.`,
                unionAlias: alias,
                dataset,
            });
        }
    }

    const targetBefore = getUnion(input.before, input.approval.targetAlias);
    const targetAfter = getUnion(input.after, input.approval.targetAlias);
    for (const dataset of ['buildingLandLots', 'buildingOrphanSummary'] as const) {
        if (targetBefore.datasets[dataset].digest !== targetAfter.datasets[dataset].digest) {
            violations.push({
                code: 'BUILDING_GLOBAL_STATE_CHANGED',
                message: `member import가 전역 ${dataset}를 변경했습니다.`,
                unionAlias: input.approval.targetAlias,
                dataset,
            });
        }
    }
    const actualChanges = (['propertyUnits', 'propertyOwnerships'] as const).flatMap((dataset) =>
        diffDataset(dataset, targetBefore.datasets[dataset], targetAfter.datasets[dataset])
    );
    const usedApprovals = new Set<number>();
    const sharedPnuSet = new Set(sharedPnus);

    for (const change of actualChanges) {
        if (change.operation === 'DELETE') {
            violations.push({
                code: 'MEMBER_IMPORT_DELETE_FORBIDDEN',
                message: `member import에서 ${change.dataset} 삭제는 허용되지 않습니다.`,
                unionAlias: input.approval.targetAlias,
                dataset: change.dataset,
                rowKeyHash: change.keyHash,
            });
            continue;
        }

        const matches = input.approval.changes
            .map((approval, index) => ({ approval, index }))
            .filter(({ index }) => !usedApprovals.has(index))
            .filter(({ approval }) => approvalMatchesChange(approval, change));
        if (matches.length !== 1) {
            violations.push({
                code: matches.length === 0 ? 'UNAPPROVED_MEMBER_DIFF' : 'AMBIGUOUS_MEMBER_APPROVAL',
                message: `${change.dataset} 변경이 승인 입력 계약과 정확히 일치하지 않습니다.`,
                unionAlias: input.approval.targetAlias,
                dataset: change.dataset,
                rowKeyHash: change.keyHash,
                changedColumns: change.changedColumns,
            });
            continue;
        }
        usedApprovals.add(matches[0].index);

        const changedPropertyPnuHash = resolveMemberImportChangePnuHash(change, targetAfter);
        if (!changedPropertyPnuHash) {
            violations.push({
                code: 'MEMBER_IMPORT_PROPERTY_CHAIN_UNRESOLVED',
                message: `${change.dataset} 변경을 after snapshot의 property PNU로 해소할 수 없습니다.`,
                unionAlias: input.approval.targetAlias,
                dataset: change.dataset,
                rowKeyHash: change.keyHash,
            });
        } else if (!sharedPnuSet.has(changedPropertyPnuHash)) {
            violations.push({
                code: 'MEMBER_IMPORT_CHANGE_OUTSIDE_SHARED_PNU',
                message: `${change.dataset} 변경이 stable shared-PNU fixture에 속하지 않습니다.`,
                unionAlias: input.approval.targetAlias,
                dataset: change.dataset,
                rowKeyHash: change.keyHash,
            });
        }

        if (change.dataset === 'propertyUnits') {
            const buildingUnitHash = change.after?.columnHashes.building_unit_id;
            const dongHash = change.after?.columnHashes.dong;
            const hoHash = change.after?.columnHashes.ho;
            const changedRestrictedColumns = change.operation === 'UPDATE'
                ? ['building_unit_id', 'dong', 'ho'].filter((column) =>
                    change.changedColumns.includes(column)
                )
                : [];
            if (
                changedRestrictedColumns.length > 0 ||
                (change.operation === 'INSERT' && [buildingUnitHash, dongHash, hoHash].some(
                    (hash) => hash !== hashCanonicalValue(null)
                ))
            ) {
                violations.push({
                    code: 'BUILDING_DERIVED_PROPERTY_FIELDS_FORBIDDEN',
                    message: 'member import gate에서는 property_units.building_unit_id/dong/ho 변경을 허용하지 않습니다.',
                    unionAlias: input.approval.targetAlias,
                    dataset: change.dataset,
                    rowKeyHash: change.keyHash,
                    changedColumns: changedRestrictedColumns,
                });
            }
        }
    }

    input.approval.changes.forEach((approval, index) => {
        if (!usedApprovals.has(index)) {
            violations.push({
                code: 'APPROVED_DIFF_NOT_OBSERVED',
                message: `승인된 ${approval.dataset} ${approval.operation} 변경이 실제 결과에 없습니다.`,
                unionAlias: input.approval.targetAlias,
                dataset: approval.dataset,
                rowKeyHash: approval.rowKeyHash,
            });
        }
    });

    if (targetAfter.datasets.minorParcelResults.digest !== input.approval.expectedTargetMinorParcelDigest) {
        violations.push({
            code: 'MINOR_PARCEL_EXPECTATION_MISMATCH',
            message: '대상 조합의 과소필지 결과가 승인된 예상 digest와 일치하지 않습니다.',
            unionAlias: input.approval.targetAlias,
            dataset: 'minorParcelResults',
        });
    }
    if (
        targetAfter.datasets.canonicalMemberProperties.digest !==
        input.approval.expectedTargetCanonicalMemberPropertiesDigest
    ) {
        violations.push({
            code: 'CANONICAL_MEMBER_EXPECTATION_MISMATCH',
            message: '대상 조합 canonical member property 결과가 승인된 예상 digest와 일치하지 않습니다.',
            unionAlias: input.approval.targetAlias,
            dataset: 'canonicalMemberProperties',
        });
    }

    return {
        passed: violations.length === 0,
        gate: 'MEMBER_IMPORT',
        operation: 'MEMBER_IMPORT',
        sharedPnuHashCount: sharedPnus.length,
        violations,
        digests: collectDigests(input.before, input.after, aliases),
    };
}

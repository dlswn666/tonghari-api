/**
 * 대지권면적 Phase 0 실호출 캡처.
 *
 * 외부 API strict adapter의 응답을 읽기만 하고, 원문 대신 비식별 inventory와
 * 응답 schema hash만 만든다. 파일 I/O와 실행 환경 처리는 CLI 경계에 둔다.
 */

import { createHash } from 'node:crypto';
import { dirname as pathDirname, resolve as pathResolve } from 'node:path';
import type {
    BuildingHubAuth,
    VworldAuth,
} from '../services/land-area-sync/adapter';
import { parseBylotCnt } from '../services/land-area-sync/bylot';
import { classifyHousingType } from '../services/land-area-sync/classifier';
import {
    housingOtherPurposeSignals,
    type HousingOtherPurposeSignal,
} from '../services/land-area-sync/housing-purpose-signals';
import {
    isOptionalRegistryManagementPkValid,
    normalizeRegistryManagementPk,
} from '../services/land-area-sync/registry-pk';
import { resolveScopeLadfrlAreas } from '../services/land-area-sync/ladfrl-scope';
import { validateLdaregReplication } from '../services/land-area-sync/ldareg-branch';
import {
    isDenominatorWithinTolerance,
    parseLdaQotaRate,
} from '../services/land-area-sync/ratio';
import {
    normalizeUnitSegment,
    normalizeUnitTuple,
} from '../services/land-area-sync/normalizer';
import {
    assembleAttachedPnus,
    buildBuildingHubPnu,
    type AtchJibunRowInput,
} from '../services/gis-shared/pnu';
import type { GisSharedEndpointName } from '../services/gis-shared/endpoints';
import type {
    BrAtchJibunRow,
    BrBasisOulnRow,
    BrExposRow,
    BrTitleRow,
    LadfrlRow,
    LdaregRow,
    ProviderIssue,
    StrictScan,
} from '../types/land-area-sync.types';

export const LAND_AREA_PHASE0_MANIFEST_VERSION =
    'land-area-phase0-capture-input@1' as const;
export const LAND_AREA_PHASE0_PLAN_VERSION =
    'land-area-phase0-capture-plan@1' as const;
export const LAND_AREA_PHASE0_ARTIFACT_VERSION =
    'land-area-phase0-capture-artifact@3' as const;
export const LAND_AREA_PHASE0_ARTIFACT_SCHEMA_HASH =
    '42defd540c3c3d81331aea1f6f74346e790e0c4093da50a23f300932fadbde7d' as const;
export const LAND_AREA_PHASE0_MAX_ARTIFACT_BYTES = 3 * 1024 * 1024;
export const LAND_AREA_PHASE0_OUTPUT_DIRECTORY = '.phase0-land-area';

const MAX_SAMPLES = 20;
const MAX_INVENTORY_RECORDS = 200;
const MAX_BYLOT_COUNT = 10_000;
const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PNU_PATTERN = /^\d{10}[12]\d{8}$/;
const OUTPUT_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.json$/;
const REGISTRY_TYPE_CODE_PATTERN = /^\d{1,2}$/;
const MAIN_PURPOSE_CODE_PATTERN = /^\d{5}$/;
const MAIN_ATTACHED_TYPE_CODE_PATTERN = /^\d{1,2}$/;
const FLOOR_TYPE_CODE_PATTERN = /^\d{1,2}$/;
const LAND_CATEGORY_CODE_PATTERN = /^\d{1,4}$/;
const CLASSIFICATION_CODE_PATTERN = /^\d{1,3}$/;
const SAFE_AREA_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;
const SAFE_LABEL_PATTERN =
    /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}·ㆍ()（）,\-/.]{0,79}$/u;
export const LAND_AREA_PHASE0_ENDPOINTS = [
    'getBrTitleInfo',
    'getBrBasisOulnInfo',
    'getBrAtchJibunInfo',
    'getBrExposInfo',
    'ladfrlList',
    'ldaregList',
] as const satisfies readonly GisSharedEndpointName[];

export type LandAreaPhase0ExpectedBylot = 'ZERO' | 'POSITIVE';

export interface LandAreaPhase0CaptureSample {
    alias: string;
    expectedBylot: LandAreaPhase0ExpectedBylot;
    pnu: string;
}

export interface LandAreaPhase0CaptureManifest {
    version: typeof LAND_AREA_PHASE0_MANIFEST_VERSION;
    samples: LandAreaPhase0CaptureSample[];
}

export interface LandAreaPhase0CaptureAdapter {
    scanTitle(
        pnu: string,
        auth: BuildingHubAuth
    ): Promise<StrictScan<BrTitleRow>>;
    scanBasis(
        pnu: string,
        auth: BuildingHubAuth
    ): Promise<StrictScan<BrBasisOulnRow>>;
    scanAttached(
        pnu: string,
        auth: BuildingHubAuth
    ): Promise<StrictScan<BrAtchJibunRow>>;
    scanExpos(
        pnu: string,
        auth: BuildingHubAuth
    ): Promise<StrictScan<BrExposRow>>;
    scanLadfrl(
        pnu: string,
        auth: VworldAuth
    ): Promise<StrictScan<LadfrlRow>>;
    scanLdareg(
        pnu: string,
        auth: VworldAuth
    ): Promise<StrictScan<LdaregRow>>;
}

export interface LandAreaPhase0CapturePlan {
    version: typeof LAND_AREA_PHASE0_PLAN_VERSION;
    sampleCount: number;
    requestCount: number;
    endpoints: readonly GisSharedEndpointName[];
    samples: Array<{
        aliasHash: string;
        expectedBylot: LandAreaPhase0ExpectedBylot;
        pnuHash: string;
    }>;
}

type SanitizedIssue = Pick<
    ProviderIssue,
    | 'kind'
    | 'schemaErrorCode'
    | 'httpStatus'
    | 'pagesFetched'
    | 'expectedTotalCount'
    | 'receivedRows'
    | 'attempts'
>;

type JsonValueType =
    | 'undefined'
    | 'null'
    | 'string'
    | 'number'
    | 'boolean'
    | 'object'
    | 'array';

interface BylotFieldInventory {
    presence: 'ABSENT' | 'NULL' | 'PRESENT';
    jsonType: JsonValueType;
    parseState: 'VALID' | 'INVALID';
    rawValue?: string | number;
    count?: number;
}

interface BoundedInventory {
    totalRecords: number;
    truncated: boolean;
    sanitizedDigest: string;
}

export interface LandAreaPhase0EndpointArtifact {
    endpoint: GisSharedEndpointName;
    state: StrictScan<unknown>['state'];
    schemaHash: string;
    totalCount?: number;
    pagesFetched?: number;
    issue?: SanitizedIssue;
    inventory:
        | TitleInventory
        | BasisInventory
        | AttachedInventory
        | ExposInventory
        | LadfrlInventory
        | LdaregInventory;
}

interface TitleInventory extends BoundedInventory {
    kind: 'TITLE';
    records: Array<{
        managementPkHash?: string;
        upManagementPkHash?: string;
        bylot: BylotFieldInventory;
        registryTypeCode?: string;
        registryTypeLabel?: string;
        mainPurposeCode?: string;
        mainPurposeLabel?: string;
        otherPurposePresent: boolean;
        otherPurposeHash?: string;
        otherPurposeSignals: HousingOtherPurposeSignal[];
    }>;
}

interface BasisInventory extends BoundedInventory {
    kind: 'BASIS';
    records: Array<{
        managementPkHash?: string;
        upManagementPkHash?: string;
        bylot: BylotFieldInventory;
    }>;
}

interface AttachedInventory {
    kind: 'ATTACHED';
    pairs: Array<{
        managementPkHash?: string;
        basePnuHash: string;
        attachedPnuHash: string;
    }>;
    rejected: Array<{
        side: 'BASE' | 'ATTACHED' | 'PAIR';
        reason: string;
        count: number;
    }>;
    totalPairs: number;
    pairsTruncated: boolean;
    pairsDigest: string;
    totalRejected: number;
    rejectedDigest: string;
}

interface ExposInventory extends BoundedInventory {
    kind: 'EXPOS';
    records: Array<{
        managementPkHash?: string;
        upManagementPkHash?: string;
        unitIdentityShape: 'DONG_FLOOR_HO' | 'INCOMPLETE';
        unitIdentityHash?: string;
        mainAttachedTypeCode?: string;
        floorTypeCode?: string;
        floorShape?: string;
        area?: string;
    }>;
}

interface LadfrlInventory extends BoundedInventory {
    kind: 'LADFRL';
    records: Array<{
        pnuHash?: string;
        landArea?: string;
        landCategoryCode?: string;
    }>;
}

interface LdaregInventory extends BoundedInventory {
    kind: 'LDAREG';
    records: Array<{
        pnuHash?: string;
        aggregateBuildingSerialHash?: string;
        unitIdentityShape: 'DONG_FLOOR_HO' | 'INCOMPLETE';
        unitIdentityHash?: string;
        quotaRatioState: 'VALID' | 'MISSING' | 'INVALID';
        quotaRatioInput: {
            presence: 'ABSENT' | 'NULL' | 'PRESENT';
            jsonType: JsonValueType;
            parseState: 'VALID' | 'MISSING' | 'INVALID';
            stringShape:
                | 'NOT_APPLICABLE'
                | 'EMPTY'
                | 'NON_EMPTY'
                | 'NOT_STRING';
        };
        quotaRatio?: string;
        classificationCode?: string;
        classificationLabel?: string;
        floorShape?: string;
    }>;
}

export interface LandAreaPhase0SampleArtifact {
    aliasHash: string;
    expectedBylot: LandAreaPhase0ExpectedBylot;
    pnuHash: string;
    endpoints: LandAreaPhase0EndpointArtifact[];
    evidence: {
        bylotByManagementPk: {
            records: Array<{
                managementPkHash: string;
                titleState: 'RESOLVED' | 'NO_VALID' | 'CONFLICT' | 'MISSING';
                basisState: 'RESOLVED' | 'NO_VALID' | 'CONFLICT' | 'MISSING';
                titleCount: number | null;
                basisCount: number | null;
                effectiveCount: number | null;
                attachedPairCount: number;
                titleBasisRelation:
                    | 'MATCH'
                    | 'FALLBACK_AVAILABLE'
                    | 'MISMATCH'
                    | 'MISSING';
            }>;
            totalRecords: number;
            truncated: boolean;
            sanitizedDigest: string;
        };
        scopeLadfrl: {
            status: 'PASS' | 'FAIL';
            records: Array<{ pnuHash: string; area: string }>;
            totalArea: string | null;
        };
        ldaregReplication: {
            status: 'PASS' | 'FAIL';
            canonicalSourcePnuHash: string;
            comparedPnuHashes: string[];
            rowCount: number | null;
            rowMultisetDigest: string | null;
        };
    };
    policyCandidate:
        | 'TITLE_ONLY'
        | 'TITLE_WITH_BASIS_FALLBACK'
        | null;
    checks: {
        titleBasis: {
            status: 'PASS' | 'FAIL';
        };
        bylotAttached: {
            status: 'PASS' | 'FAIL';
            matchedManagementPkHashes: {
                records: string[];
                totalRecords: number;
                truncated: boolean;
                sanitizedDigest: string;
            };
        };
    };
    failureCodes: string[];
    reviewCodes: string[];
}

export interface LandAreaPhase0CaptureArtifact {
    version: typeof LAND_AREA_PHASE0_ARTIFACT_VERSION;
    schemaHash: string;
    gate: {
        status: 'PASS' | 'FAIL';
        failureCodes: string[];
        reviewCodes: string[];
    };
    samples: LandAreaPhase0SampleArtifact[];
}

interface SampleRawCapture {
    sample: LandAreaPhase0CaptureSample;
    title: StrictScan<BrTitleRow>;
    basis: StrictScan<BrBasisOulnRow>;
    attached: StrictScan<BrAtchJibunRow>;
    expos: StrictScan<BrExposRow>;
    ladfrl: StrictScan<LadfrlRow>;
    ldareg: StrictScan<LdaregRow>;
    /** sample PNU + same-run attached scope PNU별 LADFRL strict scan. */
    scopeLadfrl: Array<{ pnu: string; scan: StrictScan<LadfrlRow> }>;
    /** sample PNU + same-run attached scope PNU별 LDAREG strict scan. */
    scopeLdareg: Array<{ pnu: string; scan: StrictScan<LdaregRow> }>;
    /** sample PNU + same-run attached scope PNU별 expos strict scan. */
    scopeExpos: Array<{ pnu: string; scan: StrictScan<BrExposRow> }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[]
): void {
    const allowedSet = new Set(allowed);
    if (Object.keys(value).some((key) => !allowedSet.has(key))) {
        throw new Error('허용되지 않은 키가 있습니다.');
    }
}

/**
 * 비밀값은 포함하지 않는 입력 manifest를 strict 검증한다.
 */
export function parseLandAreaPhase0Manifest(
    input: unknown
): LandAreaPhase0CaptureManifest {
    if (!isRecord(input)) {
        throw new Error('manifest는 JSON 객체여야 합니다.');
    }
    assertOnlyKeys(input, ['version', 'samples']);
    if (input.version !== LAND_AREA_PHASE0_MANIFEST_VERSION) {
        throw new Error('manifest version이 올바르지 않습니다.');
    }
    if (
        !Array.isArray(input.samples) ||
        input.samples.length < 1 ||
        input.samples.length > MAX_SAMPLES
    ) {
        throw new Error(`samples는 1~${MAX_SAMPLES}건이어야 합니다.`);
    }

    const aliases = new Set<string>();
    const pnus = new Set<string>();
    let hasZero = false;
    let hasPositive = false;
    const samples: LandAreaPhase0CaptureSample[] = input.samples.map(
        (candidate) => {
            if (!isRecord(candidate)) {
                throw new Error('sample은 JSON 객체여야 합니다.');
            }
            assertOnlyKeys(candidate, ['alias', 'expectedBylot', 'pnu']);
            if (
                typeof candidate.alias !== 'string' ||
                !ALIAS_PATTERN.test(candidate.alias)
            ) {
                throw new Error('sample alias 형식이 올바르지 않습니다.');
            }
            const aliasKey = candidate.alias.toLowerCase();
            if (aliases.has(aliasKey)) {
                throw new Error('sample alias가 중복되었습니다.');
            }
            aliases.add(aliasKey);

            if (
                candidate.expectedBylot !== 'ZERO' &&
                candidate.expectedBylot !== 'POSITIVE'
            ) {
                throw new Error('expectedBylot 값이 올바르지 않습니다.');
            }
            hasZero ||= candidate.expectedBylot === 'ZERO';
            hasPositive ||= candidate.expectedBylot === 'POSITIVE';

            if (
                typeof candidate.pnu !== 'string' ||
                !PNU_PATTERN.test(candidate.pnu)
            ) {
                throw new Error('sample PNU 형식이 올바르지 않습니다.');
            }
            if (pnus.has(candidate.pnu)) {
                throw new Error('sample PNU가 중복되었습니다.');
            }
            pnus.add(candidate.pnu);

            return {
                alias: candidate.alias,
                expectedBylot: candidate.expectedBylot,
                pnu: candidate.pnu,
            };
        }
    );

    if (!hasZero || !hasPositive) {
        throw new Error('ZERO와 POSITIVE sample이 각각 최소 1개 필요합니다.');
    }
    return { version: LAND_AREA_PHASE0_MANIFEST_VERSION, samples };
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function identityHash(kind: string, value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (!normalized) return undefined;
    return sha256(`${kind}\u0000${normalized}`);
}

function managementPkHash(kind: 'MGM_BLDRGST_PK' | 'MGM_UP_BLDRGST_PK', value: unknown): string | undefined {
    const normalized = normalizeRegistryManagementPk(value);
    const identityKind =
        kind === 'MGM_UP_BLDRGST_PK' ? 'MGM_BLDRGST_PK' : kind;
    return normalized === null
        ? undefined
        : sha256(`${identityKind}\u0000${normalized}`);
}

function pnuHash(value: string): string {
    return sha256(`PNU\u0000${value}`);
}

function aliasHash(value: string): string {
    return sha256(`ALIAS\u0000${value}`);
}

function compareCanonical(a: unknown, b: unknown): number {
    return stableStringify(a).localeCompare(stableStringify(b));
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (isRecord(value)) {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            const nested = value[key];
            if (nested !== undefined) result[key] = canonicalize(nested);
        }
        return result;
    }
    return value;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function boundRecords<T>(records: T[]): {
    records: T[];
    totalRecords: number;
    truncated: boolean;
    sanitizedDigest: string;
} {
    const sorted = [...records].sort(compareCanonical);
    return {
        records: sorted.slice(0, MAX_INVENTORY_RECORDS),
        totalRecords: sorted.length,
        truncated: sorted.length > MAX_INVENTORY_RECORDS,
        sanitizedDigest: sha256(stableStringify(sorted)),
    };
}

function schemaHash(rows: unknown[]): string {
    const tokens = new Set<string>();
    const visit = (value: unknown, path: string, depth: number): void => {
        if (depth > 12) {
            tokens.add(`${path}:DEPTH_LIMIT`);
            return;
        }
        if (value === null) {
            tokens.add(`${path}:null`);
            return;
        }
        if (Array.isArray(value)) {
            tokens.add(`${path}:array`);
            for (const item of value) visit(item, `${path}[]`, depth + 1);
            return;
        }
        if (typeof value === 'object') {
            tokens.add(`${path}:object`);
            for (const key of Object.keys(value as Record<string, unknown>).sort()) {
                visit(
                    (value as Record<string, unknown>)[key],
                    `${path}.${key}`,
                    depth + 1
                );
            }
            return;
        }
        tokens.add(`${path}:${typeof value}`);
    };
    for (const row of rows) visit(row, '$', 0);
    return sha256([...tokens].sort().join('\n'));
}

type SensitiveValueGuard = (value: string) => boolean;

function buildSensitiveValueGuard(
    buildingHubAuth: BuildingHubAuth,
    vworldAuth: VworldAuth
): SensitiveValueGuard {
    const tokens = [
        buildingHubAuth.serviceKey,
        vworldAuth.key,
        vworldAuth.domain,
    ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    return (value: string): boolean => {
        const normalized = value.trim().toLowerCase();
        return tokens.some((token) => normalized.includes(token));
    };
}

function rowsOf<T>(scan: StrictScan<T>): T[] {
    return scan.state === 'COMPLETE' || scan.state === 'COMPLETE_ZERO'
        ? scan.rows
        : [];
}

function safePublicCode(
    value: unknown,
    pattern: RegExp,
    isSensitive: SensitiveValueGuard
): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return pattern.test(normalized) && !isSensitive(normalized)
        ? normalized
        : undefined;
}

function safeDecimal(
    value: unknown,
    isSensitive: SensitiveValueGuard
): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const normalized = String(value).trim();
    if (!SAFE_AREA_PATTERN.test(normalized) || isSensitive(normalized)) {
        return undefined;
    }
    const number = Number(normalized);
    return Number.isFinite(number) ? normalized : undefined;
}

function positiveDecimal(
    value: unknown,
    isSensitive: SensitiveValueGuard
): string | undefined {
    const normalized = safeDecimal(value, isSensitive);
    return normalized !== undefined && Number(normalized) > 0
        ? normalized
        : undefined;
}

function safeRatio(
    value: unknown,
    isSensitive: SensitiveValueGuard
): string | undefined {
    return safeParsedRatio(value, isSensitive)?.normalized;
}

function safeParsedRatio(
    value: unknown,
    isSensitive: SensitiveValueGuard
): {
    normalized: string;
    numerator: number;
    denominator: number;
} | null {
    if (typeof value !== 'string') return null;
    if (isSensitive(value)) return null;
    const parsed = parseLdaQotaRate(value);
    if (!parsed.ok) return null;
    if (
        !SAFE_AREA_PATTERN.test(parsed.numeratorText) ||
        !SAFE_AREA_PATTERN.test(parsed.denominatorText)
    ) {
        return null;
    }
    const normalized = `${parsed.numeratorText}/${parsed.denominatorText}`;
    return isSensitive(normalized)
        ? null
        : {
              normalized,
              numerator: parsed.numerator,
              denominator: parsed.denominator,
          };
}

function safeUnicodeLabel(
    value: unknown,
    isSensitive: SensitiveValueGuard
): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().normalize('NFC');
    if (
        !normalized ||
        !SAFE_LABEL_PATTERN.test(normalized) ||
        !/\p{L}/u.test(normalized) ||
        /(?:https?:\/\/|www\.|@)/iu.test(normalized) ||
        /\d{2,4}[-\s]\d{3,4}[-\s]\d{4}/u.test(normalized) ||
        isSensitive(normalized)
    ) {
        return undefined;
    }
    return normalized;
}

function sanitizedOtherPurpose(
    value: unknown,
    isSensitive: SensitiveValueGuard
): {
    otherPurposePresent: boolean;
    otherPurposeHash?: string;
    otherPurposeSignals: HousingOtherPurposeSignal[];
} {
    if (typeof value !== 'string' || !value.trim()) {
        return {
            otherPurposePresent: false,
            otherPurposeSignals: [],
        };
    }
    const normalized = value.trim().normalize('NFC');
    if (isSensitive(normalized)) {
        return {
            otherPurposePresent: true,
            otherPurposeSignals: [],
        };
    }
    return {
        otherPurposePresent: true,
        otherPurposeHash: sha256(`ETC_PURPS\u0000${normalized}`),
        otherPurposeSignals: housingOtherPurposeSignals(normalized),
    };
}

function floorShape(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().normalize('NFKC').replace(/\s+/g, '');
    if (/^\d+층$/u.test(normalized)) return '#층';
    if (/^지하\d+층$/u.test(normalized)) return '지하#층';
    if (/^지상\d+층$/u.test(normalized)) return '지상#층';
    if (/^[Bb]\d+층?$/u.test(normalized)) {
        return normalized.endsWith('층') ? 'B#층' : 'B#';
    }
    if (/^-\d+층?$/u.test(normalized)) {
        return normalized.endsWith('층') ? '-#층' : '-#';
    }
    if (/^\d+$/u.test(normalized)) return '#';
    return undefined;
}

function jsonValueType(value: unknown): JsonValueType {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value as Exclude<JsonValueType, 'undefined' | 'null' | 'array'>;
}

function bylotFieldInventory(
    row: Record<string, unknown>
): BylotFieldInventory {
    const present = Object.prototype.hasOwnProperty.call(row, 'bylotCnt');
    const value = row.bylotCnt;
    const presence = !present
        ? 'ABSENT'
        : value === null
          ? 'NULL'
          : 'PRESENT';
    const parsed = parseBylotCnt(value);
    const withinBound = parsed.valid && parsed.count <= MAX_BYLOT_COUNT;
    const rawValue =
        withinBound &&
        ((typeof value === 'string' &&
            value.length <= 32 &&
            /^\s*\d+\s*$/.test(value)) ||
            (typeof value === 'number' && Number.isSafeInteger(value)))
            ? value
            : undefined;
    return {
        presence,
        jsonType: jsonValueType(value),
        parseState: withinBound ? 'VALID' : 'INVALID',
        ...(rawValue !== undefined ? { rawValue } : {}),
        ...(withinBound ? { count: parsed.count } : {}),
    };
}

function unitIdentity(
    kind: 'EXPOS_UNIT' | 'LDAREG_UNIT',
    row: Record<string, unknown>
): {
    shape: 'DONG_FLOOR_HO' | 'INCOMPLETE';
    hash?: string;
} {
    const exactStringAlias = (aliases: readonly string[]): string | null => {
        const present = aliases
            .filter((alias) =>
                Object.prototype.hasOwnProperty.call(row, alias)
            )
            .map((alias) => row[alias]);
        if (
            present.length === 0 ||
            present.some((value) => typeof value !== 'string')
        ) {
            return null;
        }
        const normalized = [
            ...new Set(
                (present as string[])
                    .map((value) => normalizeUnitSegment(value))
                    .filter(Boolean)
            ),
        ];
        return normalized.length === 1 ? normalized[0] : null;
    };
    const tuple = normalizeUnitTuple({
        dong: exactStringAlias(
            kind === 'EXPOS_UNIT'
                ? ['dongNm', 'buldDongNm']
                : ['buldDongNm', 'buldNm', 'dongNm']
        ),
        floor: exactStringAlias(
            kind === 'EXPOS_UNIT'
                ? ['flrNoNm', 'buldFloorNm']
                : ['buldFloorNm', 'flrNoNm']
        ),
        ho: exactStringAlias(
            kind === 'EXPOS_UNIT'
                ? ['hoNm', 'buldHoNm']
                : ['buldHoNm', 'hoNm']
        ),
    });
    if (!tuple.dong || !tuple.floor || !tuple.ho) {
        return { shape: 'INCOMPLETE' };
    }
    return {
        shape: 'DONG_FLOOR_HO',
        hash: sha256(
            `UNIT_TUPLE_JSON\u0000${stableStringify([
                tuple.dong,
                tuple.floor,
                tuple.ho,
            ])}`
        ),
    };
}

function sanitizedIssue(issue: ProviderIssue): SanitizedIssue {
    const result: SanitizedIssue = { kind: issue.kind };
    if (issue.schemaErrorCode !== undefined)
        result.schemaErrorCode = issue.schemaErrorCode;
    if (issue.httpStatus !== undefined) result.httpStatus = issue.httpStatus;
    if (issue.pagesFetched !== undefined)
        result.pagesFetched = issue.pagesFetched;
    if (issue.expectedTotalCount !== undefined)
        result.expectedTotalCount = issue.expectedTotalCount;
    if (issue.receivedRows !== undefined)
        result.receivedRows = issue.receivedRows;
    if (issue.attempts !== undefined) result.attempts = issue.attempts;
    return result;
}

function endpointArtifact<T>(
    endpoint: GisSharedEndpointName,
    scan: StrictScan<T>,
    inventory: LandAreaPhase0EndpointArtifact['inventory']
): LandAreaPhase0EndpointArtifact {
    const rows = rowsOf(scan);
    if (scan.state === 'COMPLETE' || scan.state === 'COMPLETE_ZERO') {
        return {
            endpoint,
            state: scan.state,
            schemaHash: schemaHash(rows),
            totalCount: scan.totalCount,
            pagesFetched: scan.pagesFetched,
            inventory,
        };
    }
    return {
        endpoint,
        state: scan.state,
        schemaHash: schemaHash([]),
        issue: sanitizedIssue(scan.issue),
        inventory,
    };
}

function titleInventory(
    rows: BrTitleRow[],
    isSensitive: SensitiveValueGuard
): TitleInventory {
    const records = rows.map((row) => {
        const raw = row as Record<string, unknown>;
        const otherPurpose = sanitizedOtherPurpose(
            raw.etcPurps,
            isSensitive
        );
        return {
            ...(managementPkHash('MGM_BLDRGST_PK', row.mgmBldrgstPk)
                ? {
                      managementPkHash: managementPkHash(
                          'MGM_BLDRGST_PK',
                          row.mgmBldrgstPk
                      ),
                  }
                : {}),
            ...(managementPkHash('MGM_UP_BLDRGST_PK', row.mgmUpBldrgstPk)
                ? {
                      upManagementPkHash: managementPkHash(
                          'MGM_UP_BLDRGST_PK',
                          row.mgmUpBldrgstPk
                      ),
                  }
                : {}),
            bylot: bylotFieldInventory(raw),
            ...(safePublicCode(
                row.regstrGbCd,
                REGISTRY_TYPE_CODE_PATTERN,
                isSensitive
            )
                ? {
                      registryTypeCode: safePublicCode(
                          row.regstrGbCd,
                          REGISTRY_TYPE_CODE_PATTERN,
                          isSensitive
                      ),
                  }
                : {}),
            ...(safeUnicodeLabel(raw.regstrGbCdNm, isSensitive)
                ? {
                      registryTypeLabel: safeUnicodeLabel(
                          raw.regstrGbCdNm,
                          isSensitive
                      ),
                  }
                : {}),
            ...(safePublicCode(
                row.mainPurpsCd,
                MAIN_PURPOSE_CODE_PATTERN,
                isSensitive
            )
                ? {
                      mainPurposeCode: safePublicCode(
                          row.mainPurpsCd,
                          MAIN_PURPOSE_CODE_PATTERN,
                          isSensitive
                      ),
                  }
                : {}),
            ...(safeUnicodeLabel(raw.mainPurpsCdNm, isSensitive)
                ? {
                      mainPurposeLabel: safeUnicodeLabel(
                          raw.mainPurpsCdNm,
                          isSensitive
                      ),
                  }
                : {}),
            ...otherPurpose,
        };
    });
    return { kind: 'TITLE', ...boundRecords(records) };
}

function basisInventory(rows: BrBasisOulnRow[]): BasisInventory {
    const records = rows.map((row) => {
        const managementPkHashValue = managementPkHash(
            'MGM_BLDRGST_PK',
            row.mgmBldrgstPk
        );
        const upManagementPkHashValue = managementPkHash(
            'MGM_UP_BLDRGST_PK',
            row.mgmUpBldrgstPk
        );
        return {
            ...(managementPkHashValue ? { managementPkHash: managementPkHashValue } : {}),
            ...(upManagementPkHashValue
                ? { upManagementPkHash: upManagementPkHashValue }
                : {}),
            bylot: bylotFieldInventory(row as Record<string, unknown>),
        };
    });
    return { kind: 'BASIS', ...boundRecords(records) };
}

function toAttachedInput(row: BrAtchJibunRow): AtchJibunRowInput {
    const string = (value: unknown): string =>
        typeof value === 'string' ? value : '';
    return {
        mgmBldrgstPk: normalizeRegistryManagementPk(row.mgmBldrgstPk) ?? '',
        sigunguCd: string(row.sigunguCd),
        bjdongCd: string(row.bjdongCd),
        platGbCd: string(row.platGbCd),
        bun: string(row.bun),
        ji: string(row.ji),
        atchSigunguCd: string(row.atchSigunguCd),
        atchBjdongCd: string(row.atchBjdongCd),
        atchPlatGbCd: string(row.atchPlatGbCd),
        atchBun: string(row.atchBun),
        atchJi: string(row.atchJi),
    };
}

function assembledAttached(rows: BrAtchJibunRow[]) {
    return assembleAttachedPnus(rows.map(toAttachedInput));
}

function attachedInventory(rows: BrAtchJibunRow[]): AttachedInventory {
    const assembled = assembledAttached(rows);
    const pairs = assembled.pairs.map((pair) => {
        const managementPkHashValue = managementPkHash(
            'MGM_BLDRGST_PK',
            pair.mgmBldrgstPk
        );
        return {
            ...(managementPkHashValue ? { managementPkHash: managementPkHashValue } : {}),
            basePnuHash: pnuHash(pair.basePnu),
            attachedPnuHash: pnuHash(pair.attachedPnu),
        };
    });
    const boundedPairs = boundRecords(pairs);

    const rejectedCounts = new Map<string, number>();
    for (const rejected of assembled.rejected) {
        const key = `${rejected.reason.side}|${rejected.reason.reason}`;
        rejectedCounts.set(key, (rejectedCounts.get(key) ?? 0) + 1);
    }
    const rejected = [...rejectedCounts.entries()]
        .map(([key, count]) => {
            const [side, reason] = key.split('|');
            return {
                side: side as 'BASE' | 'ATTACHED' | 'PAIR',
                reason,
                count,
            };
        })
        .sort(compareCanonical);
    return {
        kind: 'ATTACHED',
        pairs: boundedPairs.records,
        rejected,
        totalPairs: boundedPairs.totalRecords,
        pairsTruncated: boundedPairs.truncated,
        pairsDigest: boundedPairs.sanitizedDigest,
        totalRejected: assembled.rejected.length,
        rejectedDigest: sha256(stableStringify(rejected)),
    };
}

function exposInventory(
    rows: BrExposRow[],
    isSensitive: SensitiveValueGuard
): ExposInventory {
    const records = rows.map((typedRow) => {
        const row = typedRow as Record<string, unknown>;
        const managementPkHashValue = managementPkHash(
            'MGM_BLDRGST_PK',
            row.mgmBldrgstPk
        );
        const upManagementPkHashValue = managementPkHash(
            'MGM_UP_BLDRGST_PK',
            row.mgmUpBldrgstPk
        );
        const unit = unitIdentity('EXPOS_UNIT', row);
        const mainAttachedTypeCode = safePublicCode(
            row.mainAtchGbCd,
            MAIN_ATTACHED_TYPE_CODE_PATTERN,
            isSensitive
        );
        const floorTypeCode = safePublicCode(
            row.flrGbCd,
            FLOOR_TYPE_CODE_PATTERN,
            isSensitive
        );
        const area = safeDecimal(row.area ?? row.exposArea, isSensitive);
        const sanitizedFloorShape = floorShape(
            row.flrNoNm ?? row.buldFloorNm
        );
        return {
            ...(managementPkHashValue ? { managementPkHash: managementPkHashValue } : {}),
            ...(upManagementPkHashValue ? { upManagementPkHash: upManagementPkHashValue } : {}),
            unitIdentityShape: unit.shape,
            ...(unit.hash ? { unitIdentityHash: unit.hash } : {}),
            ...(mainAttachedTypeCode ? { mainAttachedTypeCode } : {}),
            ...(floorTypeCode ? { floorTypeCode } : {}),
            ...(sanitizedFloorShape
                ? { floorShape: sanitizedFloorShape }
                : {}),
            ...(area ? { area } : {}),
        };
    });
    return { kind: 'EXPOS', ...boundRecords(records) };
}

function ladfrlInventory(
    rows: LadfrlRow[],
    isSensitive: SensitiveValueGuard
): LadfrlInventory {
    const records = rows.map((typedRow) => {
        const row = typedRow as Record<string, unknown>;
        const hashedPnu = identityHash('PNU', row.pnu);
        const landArea = safeDecimal(row.lndpclAr, isSensitive);
        const landCategoryCode = safePublicCode(
            row.lndcgrCode,
            LAND_CATEGORY_CODE_PATTERN,
            isSensitive
        );
        return {
            ...(hashedPnu ? { pnuHash: hashedPnu } : {}),
            ...(landArea ? { landArea } : {}),
            ...(landCategoryCode ? { landCategoryCode } : {}),
        };
    });
    return { kind: 'LADFRL', ...boundRecords(records) };
}

function ldaregInventory(
    rows: LdaregRow[],
    isSensitive: SensitiveValueGuard
): LdaregInventory {
    const records = rows.map((typedRow) => {
        const row = typedRow as Record<string, unknown>;
        const hashedPnu = identityHash('PNU', row.pnu);
        const aggregateBuildingSerialHash = identityHash(
            'AGBLDG_SN',
            row.agbldgSn
        );
        const unit = unitIdentity('LDAREG_UNIT', row);
        const quotaRatio = safeRatio(row.ldaQotaRate, isSensitive);
        const quotaRatioState: LdaregInventory['records'][number]['quotaRatioState'] =
            row.ldaQotaRate === undefined ||
            row.ldaQotaRate === null ||
            (typeof row.ldaQotaRate === 'string' &&
                row.ldaQotaRate.trim() === '')
                ? 'MISSING'
                : quotaRatio
                  ? 'VALID'
                  : 'INVALID';
        const quotaRatioInput: LdaregInventory['records'][number]['quotaRatioInput'] =
            {
                presence:
                    row.ldaQotaRate === undefined
                        ? 'ABSENT'
                        : row.ldaQotaRate === null
                          ? 'NULL'
                          : 'PRESENT',
                jsonType: jsonValueType(row.ldaQotaRate),
                parseState: quotaRatioState,
                stringShape:
                    row.ldaQotaRate === undefined ||
                    row.ldaQotaRate === null
                        ? 'NOT_APPLICABLE'
                        : typeof row.ldaQotaRate !== 'string'
                          ? 'NOT_STRING'
                          : row.ldaQotaRate.trim() === ''
                            ? 'EMPTY'
                            : 'NON_EMPTY',
            };
        const classificationCode = safePublicCode(
            row.clsSeCode,
            CLASSIFICATION_CODE_PATTERN,
            isSensitive
        );
        const classificationLabel = safeUnicodeLabel(
            row.clsSeCodeNm,
            isSensitive
        );
        const sanitizedFloorShape = floorShape(
            row.buldFloorNm ?? row.flrNoNm
        );
        return {
            ...(hashedPnu ? { pnuHash: hashedPnu } : {}),
            ...(aggregateBuildingSerialHash
                ? { aggregateBuildingSerialHash }
                : {}),
            unitIdentityShape: unit.shape,
            ...(unit.hash ? { unitIdentityHash: unit.hash } : {}),
            quotaRatioState,
            quotaRatioInput,
            ...(quotaRatio ? { quotaRatio } : {}),
            ...(classificationCode ? { classificationCode } : {}),
            ...(classificationLabel ? { classificationLabel } : {}),
            ...(sanitizedFloorShape
                ? { floorShape: sanitizedFloorShape }
                : {}),
        };
    });
    return { kind: 'LDAREG', ...boundRecords(records) };
}

function buildingHubRowPnu(
    typedRow: Record<string, unknown>
): string | null {
    const string = (value: unknown): string =>
        typeof value === 'string' ? value.trim() : '';
    const directRaw = string(typedRow.pnu);
    const direct = PNU_PATTERN.test(directRaw) ? directRaw : null;
    if (directRaw && !direct) return null;

    const parcelParts = [
        typedRow.sigunguCd,
        typedRow.bjdongCd,
        typedRow.platGbCd,
        typedRow.bun,
        typedRow.ji,
    ];
    const hasParcelParts = parcelParts.some(
        (value) => value !== undefined && value !== null && value !== ''
    );
    let reconstructed: string | null = null;
    if (hasParcelParts) {
        const built = buildBuildingHubPnu({
            sigunguCd: string(typedRow.sigunguCd),
            bjdongCd: string(typedRow.bjdongCd),
            platGbCd: string(typedRow.platGbCd),
            bun: string(typedRow.bun),
            ji: string(typedRow.ji),
        });
        if (!built.ok) return null;
        reconstructed = built.pnu;
    }
    if (direct && reconstructed && direct !== reconstructed) return null;
    return direct ?? reconstructed;
}

function buildingHubRowsMatchPnu(
    rows: Array<Record<string, unknown>>,
    expectedPnu: string
): boolean {
    return rows.every((row) => buildingHubRowPnu(row) === expectedPnu);
}

interface ResolvedCount {
    state: 'RESOLVED' | 'NO_VALID' | 'CONFLICT';
    count: number | null;
    fallbackEligible: boolean;
}

function countsByPk(
    rows: Array<{ mgmBldrgstPk?: unknown; bylotCnt?: unknown }>
): {
    counts: Map<string, ResolvedCount>;
    hasInvalidPk: boolean;
} {
    const raw = new Map<
        string,
        Array<{ mgmBldrgstPk?: unknown; bylotCnt?: unknown }>
    >();
    let hasInvalidPk = false;
    for (const row of rows) {
        const pk = normalizeRegistryManagementPk(row.mgmBldrgstPk);
        if (!pk) {
            hasInvalidPk = true;
            continue;
        }
        const values = raw.get(pk) ?? [];
        values.push(row);
        raw.set(pk, values);
    }
    const counts = new Map<string, ResolvedCount>();
    for (const [pk, values] of raw) {
        const observed = values.map((row) =>
            bylotFieldInventory(row as Record<string, unknown>)
        );
        const valid = observed.filter(
            (
                value
            ): value is BylotFieldInventory & {
                parseState: 'VALID';
                count: number;
            } => value.parseState === 'VALID' && value.count !== undefined
        );
        const distinct = new Set(valid.map((value) => value.count));
        const hasInvalid = observed.some(
            (value) => value.parseState === 'INVALID'
        );
        if (distinct.size === 0) {
            counts.set(pk, {
                state: 'NO_VALID',
                count: null,
                fallbackEligible: observed.every(
                    (value) =>
                        value.presence === 'ABSENT' ||
                        value.presence === 'NULL'
                ),
            });
        } else if (distinct.size === 1 && !hasInvalid) {
            counts.set(pk, {
                state: 'RESOLVED',
                count: valid[0].count,
                fallbackEligible: false,
            });
        } else {
            counts.set(pk, {
                state: 'CONFLICT',
                count: null,
                fallbackEligible: false,
            });
        }
    }
    return { counts, hasInvalidPk };
}

function scanFailureCodes(scans: StrictScan<unknown>[]): string[] {
    const codes = new Set<string>();
    for (const scan of scans) {
        if (scan.state === 'FAILED') codes.add('SCAN_FAILED');
        if (scan.state === 'INCOMPLETE') codes.add('SCAN_INCOMPLETE');
    }
    return [...codes].sort();
}

function resolveCaptureScopeLadfrl(raw: SampleRawCapture) {
    if (
        raw.scopeLadfrl.some(
            ({ scan }) => scan.state !== 'COMPLETE'
        )
    ) {
        return null;
    }
    return resolveScopeLadfrlAreas(
        raw.scopeLadfrl.map(({ pnu, scan }) => ({
            pnu,
            rows: scan.state === 'COMPLETE' ? scan.rows : [],
        }))
    );
}

function resolveCaptureLdaregReplication(raw: SampleRawCapture) {
    const scopeLdareg =
        raw.scopeLdareg ?? [{ pnu: raw.sample.pnu, scan: raw.ldareg }];
    const scopeExpos =
        raw.scopeExpos ?? [{ pnu: raw.sample.pnu, scan: raw.expos }];
    if (
        scopeLdareg.some(({ scan }) => !successfulScan(scan)) ||
        scopeExpos.some(({ scan }) => !successfulScan(scan))
    ) {
        return null;
    }
    const exposByPnu = new Map(
        scopeExpos.map(({ pnu, scan }) => [pnu, rowsOf(scan)])
    );
    return validateLdaregReplication(
        scopeLdareg.map(({ pnu }) => pnu),
        scopeLdareg.map(({ pnu, scan }) => ({
            pnu,
            ldaregRows: rowsOf(scan),
            exposRows: exposByPnu.get(pnu) ?? [],
        })),
        raw.sample.pnu
    );
}

function buildSampleArtifact(
    raw: SampleRawCapture,
    isSensitive: SensitiveValueGuard
): LandAreaPhase0SampleArtifact {
    const titleRows = rowsOf(raw.title);
    const basisRows = rowsOf(raw.basis);
    const attachedRows = rowsOf(raw.attached);
    const exposRows = rowsOf(raw.expos);
    const ladfrlRows = rowsOf(raw.ladfrl);
    const ldaregRows = rowsOf(raw.ldareg);
    const scopeLdareg =
        raw.scopeLdareg ?? [{ pnu: raw.sample.pnu, scan: raw.ldareg }];
    const scopeExpos =
        raw.scopeExpos ?? [{ pnu: raw.sample.pnu, scan: raw.expos }];
    const scopeLadfrl = resolveCaptureScopeLadfrl(raw);
    const ldaregReplication = resolveCaptureLdaregReplication(raw);
    const assembled = assembledAttached(attachedRows);
    const titlePnuExact = buildingHubRowsMatchPnu(
        titleRows as Array<Record<string, unknown>>,
        raw.sample.pnu
    );
    const basisPnuExact = buildingHubRowsMatchPnu(
        basisRows as Array<Record<string, unknown>>,
        raw.sample.pnu
    );
    const exposPnuExact = buildingHubRowsMatchPnu(
        exposRows as Array<Record<string, unknown>>,
        raw.sample.pnu
    );

    const titleCounts = countsByPk(titleRows);
    const basisCounts = countsByPk(basisRows);
    const attachedCounts = new Map<string, number>();
    const titlePkInvalid = titleRows.some(
        (row) =>
            normalizeRegistryManagementPk(row.mgmBldrgstPk) === null ||
            !isOptionalRegistryManagementPkValid(row.mgmUpBldrgstPk)
    );
    const basisPkInvalid = basisRows.some(
        (row) =>
            normalizeRegistryManagementPk(row.mgmBldrgstPk) === null ||
            !isOptionalRegistryManagementPkValid(row.mgmUpBldrgstPk)
    );
    const exposPkInvalid = exposRows.some((row) => {
        const record = row as Record<string, unknown>;
        return (
            normalizeRegistryManagementPk(record.mgmBldrgstPk) === null ||
            !isOptionalRegistryManagementPkValid(record.mgmUpBldrgstPk)
        );
    });
    let attachedPkInvalid = attachedRows.some(
        (row) => normalizeRegistryManagementPk(row.mgmBldrgstPk) === null
    );
    let attachedBaseMismatch = false;
    for (const pair of assembled.pairs) {
        const pk = normalizeRegistryManagementPk(pair.mgmBldrgstPk);
        if (!pk) {
            attachedPkInvalid = true;
            continue;
        }
        if (pair.basePnu !== raw.sample.pnu) {
            attachedBaseMismatch = true;
            continue;
        }
        attachedCounts.set(pk, (attachedCounts.get(pk) ?? 0) + 1);
    }

    const titlePks = [...titleCounts.counts.keys()].sort();
    const basisPks = [...basisCounts.counts.keys()].sort();
    const titlePkSet = new Set(titlePks);
    const basisParentByPk = new Map<string, string>();
    let basisClosureValid = true;
    for (const row of basisRows) {
        const pk = normalizeRegistryManagementPk(row.mgmBldrgstPk);
        const upPk = normalizeRegistryManagementPk(row.mgmUpBldrgstPk);
        if (!pk) {
            basisClosureValid = false;
            continue;
        }
        if (titlePkSet.has(pk)) {
            if (upPk && upPk !== pk) {
                basisClosureValid = false;
            }
            continue;
        }
        if (!upPk || !titlePkSet.has(upPk)) {
            basisClosureValid = false;
            continue;
        }
        const existing = basisParentByPk.get(pk);
        if (existing && existing !== upPk) {
            basisClosureValid = false;
            continue;
        }
        basisParentByPk.set(pk, upPk);
    }
    const exposPks = new Set<string>();
    let exposClosureValid = true;
    for (const typedRow of exposRows) {
        const row = typedRow as Record<string, unknown>;
        const pk = normalizeRegistryManagementPk(row.mgmBldrgstPk);
        const upPk = normalizeRegistryManagementPk(row.mgmUpBldrgstPk);
        if (!pk) {
            exposClosureValid = false;
            continue;
        }
        exposPks.add(pk);
        const expectedRoot = titlePkSet.has(pk)
            ? pk
            : basisParentByPk.get(pk);
        if (!expectedRoot || (upPk && upPk !== expectedRoot)) {
            exposClosureValid = false;
        }
    }
    const basisChildPks = basisPks.filter((pk) => !titlePkSet.has(pk));
    const basisExposClosureValid =
        exposClosureValid &&
        basisChildPks.every((pk) => exposPks.has(pk)) &&
        [...exposPks].every(
            (pk) => titlePkSet.has(pk) || basisParentByPk.has(pk)
        );
    let policyCandidate: LandAreaPhase0SampleArtifact['policyCandidate'] =
        null;
    if (
        successfulScan(raw.title) &&
        successfulScan(raw.basis) &&
        !titleCounts.hasInvalidPk &&
        !basisCounts.hasInvalidPk &&
        titlePnuExact &&
        basisPnuExact &&
        titlePks.length > 0 &&
        basisClosureValid &&
        basisExposClosureValid
    ) {
        let hasFallback = false;
        let compatible = true;
        for (const pk of titlePks) {
            const title = titleCounts.counts.get(pk)!;
            const basis = basisCounts.counts.get(pk)!;
            if (title.state === 'RESOLVED') {
                if (
                    basis.state !== 'RESOLVED' ||
                    title.count !== basis.count
                ) {
                    compatible = false;
                }
            } else if (
                title.state === 'NO_VALID' &&
                title.fallbackEligible &&
                basis.state === 'RESOLVED'
            ) {
                hasFallback = true;
            } else {
                compatible = false;
            }
        }
        if (compatible) {
            policyCandidate = hasFallback
                ? 'TITLE_WITH_BASIS_FALLBACK'
                : 'TITLE_ONLY';
        }
    }

    const candidateCount = (pk: string): number | null => {
        if (!policyCandidate) return null;
        const title = titleCounts.counts.get(pk);
        const basis = basisCounts.counts.get(pk);
        if (title?.state === 'RESOLVED') return title.count;
        if (
            policyCandidate === 'TITLE_WITH_BASIS_FALLBACK' &&
            title?.state === 'NO_VALID' &&
            title.fallbackEligible &&
            basis?.state === 'RESOLVED'
        ) {
            return basis.count;
        }
        return null;
    };
    if (policyCandidate) {
        for (const basisPk of basisPks) {
            const rootPk = titlePkSet.has(basisPk)
                ? basisPk
                : basisParentByPk.get(basisPk);
            const basis = basisCounts.counts.get(basisPk);
            if (
                !rootPk ||
                basis?.state !== 'RESOLVED' ||
                candidateCount(rootPk) !== basis.count
            ) {
                policyCandidate = null;
                break;
            }
        }
    }

    const effectiveCount = (pk: string): number | null => {
        return candidateCount(pk);
    };
    const relationFor = (
        pk: string
    ):
        | 'MATCH'
        | 'FALLBACK_AVAILABLE'
        | 'MISMATCH'
        | 'MISSING' => {
        const title = titleCounts.counts.get(pk);
        const basis = basisCounts.counts.get(pk);
        if (!title || !basis) return 'MISSING';
        if (
            title.state === 'RESOLVED' &&
            basis.state === 'RESOLVED' &&
            title.count === basis.count
        ) {
            return 'MATCH';
        }
        if (
            title.state === 'NO_VALID' &&
            title.fallbackEligible &&
            basis.state === 'RESOLVED'
        ) {
            return 'FALLBACK_AVAILABLE';
        }
        return 'MISMATCH';
    };

    const allPks = new Set<string>([
        ...titlePks,
        ...attachedCounts.keys(),
    ]);
    const bylotEvidenceRecords = [...allPks].map((pk) => {
        const title = titleCounts.counts.get(pk);
        const basis = basisCounts.counts.get(pk);
        return {
            managementPkHash: managementPkHash('MGM_BLDRGST_PK', pk)!,
            titleState: title?.state ?? ('MISSING' as const),
            basisState: basis?.state ?? ('MISSING' as const),
            titleCount: title?.count ?? null,
            basisCount: basis?.count ?? null,
            effectiveCount: effectiveCount(pk),
            attachedPairCount: attachedCounts.get(pk) ?? 0,
            titleBasisRelation: relationFor(pk),
        };
    });
    const bylotByManagementPk = boundRecords(bylotEvidenceRecords);

    const expectedCount = (count: number | null): boolean =>
        raw.sample.expectedBylot === 'ZERO'
            ? count === 0
            : count !== null && count > 0;
    const matchedPks = titlePks
        .filter((pk) => {
            const count = effectiveCount(pk);
            return (
                expectedCount(count) &&
                count === (attachedCounts.get(pk) ?? 0)
            );
        })
        .map((pk) => managementPkHash('MGM_BLDRGST_PK', pk)!)
        .sort();
    const hasAttachedPkOutsideTitle = [...attachedCounts.keys()].some(
        (pk) => !titleCounts.counts.has(pk)
    );
    const allExpectedAndExact =
        policyCandidate !== null &&
        titlePks.length > 0 &&
        titlePks.every((pk) => {
            const count = effectiveCount(pk);
            return (
                expectedCount(count) &&
                count === (attachedCounts.get(pk) ?? 0)
            );
        });
    const bylotAttachedPassed =
        allExpectedAndExact && !hasAttachedPkOutsideTitle;
    const titleBasisPassed = policyCandidate !== null;
    const boundedMatchedPks = boundRecords(matchedPks);

    const failureCodes = new Set<string>(
        scanFailureCodes([
            raw.title,
            raw.basis,
            raw.attached,
            raw.expos,
            raw.ladfrl,
            raw.ldareg,
        ])
    );
    for (const { scan } of raw.scopeLadfrl) {
        for (const code of scanFailureCodes([scan])) failureCodes.add(code);
    }
    for (const { scan } of scopeLdareg) {
        for (const code of scanFailureCodes([scan])) failureCodes.add(code);
    }
    for (const { scan } of scopeExpos) {
        for (const code of scanFailureCodes([scan])) failureCodes.add(code);
        if (
            rowsOf(scan).some((row) => {
                const record = row as Record<string, unknown>;
                return (
                    normalizeRegistryManagementPk(record.mgmBldrgstPk) === null ||
                    !isOptionalRegistryManagementPkValid(record.mgmUpBldrgstPk)
                );
            })
        ) {
            failureCodes.add('EXPOS_PK_INVALID');
        }
    }
    const reviewCodes = new Set<string>();
    const classification = classifyHousingType({
        titleRows: titleRows.map((row) => ({
            regstrGbCd: row.regstrGbCd,
            mainPurpsCd: row.mainPurpsCd,
            mainPurpsCdNm: row.mainPurpsCdNm,
            etcPurps:
                typeof row.etcPurps === 'string'
                    ? row.etcPurps
                    : undefined,
        })),
        rootIdentities: titlePks,
    });
    const expectedFamily =
        raw.sample.expectedBylot === 'POSITIVE' ? 'LDAREG' : 'LADFRL';
    if (
        classification.kind !== 'CLASSIFIED' ||
        classification.family !== expectedFamily
    ) {
        failureCodes.add('HOUSING_CLASSIFICATION_ALLOWLIST_MISMATCH');
    }
    if (titleCounts.hasInvalidPk || titlePkInvalid)
        failureCodes.add('TITLE_PK_INVALID');
    if (!titlePnuExact) failureCodes.add('TITLE_PNU_EXACT_MISMATCH');
    if (
        [...titleCounts.counts.values()].some(
            (value) =>
                value.state === 'CONFLICT' ||
                (value.state === 'NO_VALID' && !value.fallbackEligible)
        )
    ) {
        failureCodes.add('TITLE_BYLOT_INVALID_OR_CONFLICT');
    }
    if (basisCounts.hasInvalidPk || basisPkInvalid)
        failureCodes.add('BASIS_PK_INVALID');
    if (!basisPnuExact) failureCodes.add('BASIS_PNU_EXACT_MISMATCH');
    if (
        [...basisCounts.counts.values()].some(
            (value) => value.state !== 'RESOLVED'
        )
    ) {
        failureCodes.add('BASIS_BYLOT_INVALID_OR_CONFLICT');
    }
    if (!titleBasisPassed) {
        failureCodes.add('TITLE_BASIS_PK_CLOSURE_MISMATCH');
        failureCodes.add('BYLOT_POLICY_UNRESOLVED');
    }
    if (policyCandidate === 'TITLE_WITH_BASIS_FALLBACK') {
        reviewCodes.add('TITLE_WITH_BASIS_FALLBACK_CANDIDATE');
    }
    if (attachedPkInvalid) failureCodes.add('ATTACHED_PK_INVALID');
    if (exposPkInvalid) failureCodes.add('EXPOS_PK_INVALID');
    if (!exposPnuExact) failureCodes.add('EXPOS_PNU_EXACT_MISMATCH');
    if (attachedBaseMismatch)
        failureCodes.add('ATTACHED_BASE_PNU_MISMATCH');
    if (assembled.rejected.length > 0)
        failureCodes.add('ATTACHED_ROWS_REJECTED');
    if (!bylotAttachedPassed)
        failureCodes.add('BYLOT_ATTACHED_EXPECTATION_MISMATCH');

    const titleResult = titleInventory(titleRows, isSensitive);
    const basisResult = basisInventory(basisRows);
    const attachedResult = attachedInventory(attachedRows);
    const exposResult = exposInventory(exposRows, isSensitive);
    const ladfrlResult = ladfrlInventory(ladfrlRows, isSensitive);
    const ldaregResult = ldaregInventory(ldaregRows, isSensitive);
    const endpoints: LandAreaPhase0EndpointArtifact[] = [
        endpointArtifact(
            'getBrTitleInfo',
            raw.title,
            titleResult
        ),
        endpointArtifact(
            'getBrBasisOulnInfo',
            raw.basis,
            basisResult
        ),
        endpointArtifact(
            'getBrAtchJibunInfo',
            raw.attached,
            attachedResult
        ),
        endpointArtifact(
            'getBrExposInfo',
            raw.expos,
            exposResult
        ),
        endpointArtifact(
            'ladfrlList',
            raw.ladfrl,
            ladfrlResult
        ),
        endpointArtifact(
            'ldaregList',
            raw.ldareg,
            ldaregResult
        ),
    ];

    if (
        titleResult.truncated ||
        basisResult.truncated ||
        attachedResult.pairsTruncated ||
        exposResult.truncated ||
        ladfrlResult.truncated ||
        ldaregResult.truncated ||
        bylotByManagementPk.truncated ||
        boundedMatchedPks.truncated
    ) {
        failureCodes.add('CAPTURE_INVENTORY_TRUNCATED');
    }
    const hasTitleCodebookEvidence = titleRows.some((row) => {
        const record = row as Record<string, unknown>;
        return (
            safePublicCode(
                record.regstrGbCd,
                REGISTRY_TYPE_CODE_PATTERN,
                isSensitive
            ) !== undefined &&
            safeUnicodeLabel(record.regstrGbCdNm, isSensitive) !== undefined &&
            safePublicCode(
                record.mainPurpsCd,
                MAIN_PURPOSE_CODE_PATTERN,
                isSensitive
            ) !== undefined &&
            safeUnicodeLabel(record.mainPurpsCdNm, isSensitive) !== undefined
        );
    });
    if (!hasTitleCodebookEvidence) {
        failureCodes.add('TITLE_CODEBOOK_EVIDENCE_MISSING');
    }
    if (
        ldaregRows.length > 0 &&
        !ldaregRows.some((row) => {
            const record = row as Record<string, unknown>;
            return (
                safePublicCode(
                    record.clsSeCode,
                    CLASSIFICATION_CODE_PATTERN,
                    isSensitive
                ) !== undefined &&
                safeUnicodeLabel(record.clsSeCodeNm, isSensitive) !== undefined
            );
        })
    ) {
        failureCodes.add('LDAREG_CODEBOOK_EVIDENCE_MISSING');
    }
    if (
        successfulScan(raw.ladfrl) &&
        raw.ladfrl.rows.some((row) => row.pnu !== raw.sample.pnu)
    ) {
        failureCodes.add('LADFRL_PNU_EXACT_MISMATCH');
    }
    if (
        successfulScan(raw.ldareg) &&
        raw.ldareg.rows.some((row) => row.pnu !== raw.sample.pnu)
    ) {
        failureCodes.add('LDAREG_PNU_EXACT_MISMATCH');
    }
    const exactLadfrlAreas = ladfrlRows
        .filter((row) => row.pnu === raw.sample.pnu)
        .map((row) => positiveDecimal(row.lndpclAr, isSensitive))
        .filter((value): value is string => value !== undefined)
        .map(Number);
    const distinctExactLadfrlAreas = [...new Set(exactLadfrlAreas)];
    if (
        ladfrlRows.length > 0 &&
        exactLadfrlAreas.length !== ladfrlRows.length
    ) {
        failureCodes.add('LADFRL_AREA_INVALID');
    }
    if (distinctExactLadfrlAreas.length > 1) {
        failureCodes.add('LADFRL_AREA_CONFLICT');
    }
    if (!scopeLadfrl || !scopeLadfrl.ok) {
        failureCodes.add('LADFRL_SCOPE_AREA_INVALID');
    }
    if (!ldaregReplication?.ok) {
        failureCodes.add('LDAREG_SCOPE_REPLICA_INVALID');
    }
    const scopeLdaregRows = scopeLdareg.flatMap(({ scan }) => rowsOf(scan));
    const validScopeLdaregRatios = scopeLdaregRows
        .map((row) => ({
            row,
            ratio: safeParsedRatio(row.ldaQotaRate, isSensitive),
        }))
        .filter(
            (
                entry
            ): entry is {
                row: LdaregRow;
                ratio: {
                    normalized: string;
                    numerator: number;
                    denominator: number;
                };
            } => entry.ratio !== null
        );
    const invalidScopeLdaregRatios = scopeLdaregRows.filter(
        (row) =>
            row.ldaQotaRate !== undefined &&
            row.ldaQotaRate !== null &&
            !(
                typeof row.ldaQotaRate === 'string' &&
                row.ldaQotaRate.trim() === ''
            ) &&
            safeParsedRatio(row.ldaQotaRate, isSensitive) === null
    );
    const missingScopeLdaregRatios = scopeLdaregRows.filter(
        (row) =>
            row.ldaQotaRate === undefined ||
            row.ldaQotaRate === null ||
            (typeof row.ldaQotaRate === 'string' &&
                row.ldaQotaRate.trim() === '')
    );
    if (invalidScopeLdaregRatios.length > 0) {
        failureCodes.add('LDAREG_RATIO_INVALID');
    }
    if (missingScopeLdaregRatios.length > 0) {
        reviewCodes.add('LDAREG_RATIO_MISSING_OBSERVED');
    }
    if (validScopeLdaregRatios.length > 0) {
        const validDenominatorsMatch = validScopeLdaregRatios.every(
            ({ ratio }) =>
                scopeLadfrl?.ok === true &&
                isDenominatorWithinTolerance(
                    ratio.denominator,
                    scopeLadfrl.totalAreaNumber
                )
        );
        if (!validDenominatorsMatch) {
            failureCodes.add('LDAREG_DENOMINATOR_MISMATCH');
        }
    }

    if (raw.sample.expectedBylot === 'POSITIVE') {
        const validLdaregRecords = ldaregResult.records.filter(
            (record) => record.quotaRatioState === 'VALID'
        );
        const missingLdaregRecords = ldaregResult.records.filter(
            (record) => record.quotaRatioState === 'MISSING'
        );
        const exposUnitHashes = exposResult.records
            .map((record) => record.unitIdentityHash)
            .filter((hash): hash is string => hash !== undefined);
        const validLdaregUnitHashes = validLdaregRecords
            .map((record) => record.unitIdentityHash)
            .filter((hash): hash is string => hash !== undefined);
        const missingLdaregUnitHashes = new Set(
            missingLdaregRecords
                .map((record) => record.unitIdentityHash)
                .filter((hash): hash is string => hash !== undefined)
        );
        const exposSet = new Set(exposUnitHashes);
        const validLdaregSet = new Set(validLdaregUnitHashes);
        const exactUnitCorrelation =
            exposUnitHashes.length === exposResult.records.length &&
            validLdaregUnitHashes.length === validLdaregRecords.length &&
            missingLdaregUnitHashes.size === missingLdaregRecords.length &&
            exposResult.records.every(
                (record) => record.unitIdentityShape === 'DONG_FLOOR_HO'
            ) &&
            [...validLdaregRecords, ...missingLdaregRecords].every(
                (record) => record.unitIdentityShape === 'DONG_FLOOR_HO'
            ) &&
            exposUnitHashes.length === exposSet.size &&
            validLdaregUnitHashes.length === validLdaregSet.size &&
            exposSet.size > 0 &&
            exposSet.size === validLdaregSet.size &&
            [...exposSet].every((hash) => validLdaregSet.has(hash)) &&
            [...missingLdaregUnitHashes].every(
                (hash) => !exposSet.has(hash)
            );
        if (!exactUnitCorrelation) {
            failureCodes.add('LDAREG_EXPOS_UNIT_CORRELATION_MISMATCH');
        }
    }

    return {
        aliasHash: aliasHash(raw.sample.alias),
        expectedBylot: raw.sample.expectedBylot,
        pnuHash: pnuHash(raw.sample.pnu),
        endpoints,
        evidence: {
            bylotByManagementPk,
            scopeLadfrl: {
                status: scopeLadfrl?.ok === true ? 'PASS' : 'FAIL',
                records:
                    scopeLadfrl?.ok === true
                        ? scopeLadfrl.areas.map((entry) => ({
                              pnuHash: pnuHash(entry.pnu),
                              area: entry.area,
                          }))
                        : [],
                totalArea: scopeLadfrl?.ok === true ? scopeLadfrl.totalArea : null,
            },
            ldaregReplication: {
                status: ldaregReplication?.ok === true ? 'PASS' : 'FAIL',
                canonicalSourcePnuHash: pnuHash(raw.sample.pnu),
                comparedPnuHashes: scopeLdareg
                    .map(({ pnu }) => pnuHash(pnu))
                    .sort(),
                rowCount:
                    ldaregReplication?.ok === true
                        ? ldaregReplication.evidence.rowCount
                        : null,
                rowMultisetDigest:
                    ldaregReplication?.ok === true
                        ? ldaregReplication.evidence.rowMultisetDigest
                        : null,
            },
        },
        policyCandidate,
        checks: {
            titleBasis: {
                status: titleBasisPassed ? 'PASS' : 'FAIL',
            },
            bylotAttached: {
                status: bylotAttachedPassed ? 'PASS' : 'FAIL',
                matchedManagementPkHashes: boundedMatchedPks,
            },
        },
        failureCodes: [...failureCodes].sort(),
        reviewCodes: [...reviewCodes].sort(),
    };
}

function successfulScan<T>(
    scan: StrictScan<T>
): scan is Extract<StrictScan<T>, { state: 'COMPLETE' | 'COMPLETE_ZERO' }> {
    return scan.state === 'COMPLETE' || scan.state === 'COMPLETE_ZERO';
}

function hasPositiveLadfrlEvidence(
    raw: SampleRawCapture,
    isSensitive: SensitiveValueGuard
): boolean {
    if (!successfulScan(raw.ladfrl) || raw.ladfrl.rows.length === 0) {
        return false;
    }
    const areas = raw.ladfrl.rows
        .filter((row) => row.pnu === raw.sample.pnu)
        .map((row) => positiveDecimal(row.lndpclAr, isSensitive))
        .filter((value): value is string => value !== undefined)
        .map(Number);
    return (
        areas.length === raw.ladfrl.rows.length &&
        new Set(areas).size === 1
    );
}

function hasPositiveLdaregEvidence(
    raw: SampleRawCapture,
    isSensitive: SensitiveValueGuard
): boolean {
    if (!successfulScan(raw.ladfrl) || !successfulScan(raw.ldareg)) {
        return false;
    }
    const scopeLadfrl = resolveCaptureScopeLadfrl(raw);
    if (!scopeLadfrl?.ok) return false;
    const replication = resolveCaptureLdaregReplication(raw);
    if (!replication?.ok || replication.evidence.rowCount === 0) return false;
    return (
        raw.ldareg.rows.some(
            (row) => {
                if (row.pnu !== raw.sample.pnu) return false;
                const ratio = safeParsedRatio(
                    row.ldaQotaRate,
                    isSensitive
                );
                return (
                    ratio !== null &&
                    isDenominatorWithinTolerance(
                        ratio.denominator,
                        scopeLadfrl.totalAreaNumber
                    )
                );
            }
        )
    );
}

async function safeScan<T>(
    endpoint: GisSharedEndpointName,
    scan: () => Promise<StrictScan<T>>
): Promise<StrictScan<T>> {
    try {
        return await scan();
    } catch {
        return {
            state: 'FAILED',
            issue: {
                kind: 'TRANSPORT_ERROR',
                endpoint,
                message: '예상하지 못한 조회 오류로 실패했습니다.',
            },
        };
    }
}

export function buildLandAreaPhase0CapturePlan(
    input: LandAreaPhase0CaptureManifest | unknown
): LandAreaPhase0CapturePlan {
    const manifest = parseLandAreaPhase0Manifest(input);
    const samples = [...manifest.samples]
        .map((sample) => ({
            aliasHash: aliasHash(sample.alias),
            expectedBylot: sample.expectedBylot,
            pnuHash: pnuHash(sample.pnu),
        }))
        .sort((a, b) => a.aliasHash.localeCompare(b.aliasHash));
    return {
        version: LAND_AREA_PHASE0_PLAN_VERSION,
        sampleCount: samples.length,
        requestCount: samples.length * LAND_AREA_PHASE0_ENDPOINTS.length,
        endpoints: LAND_AREA_PHASE0_ENDPOINTS,
        samples,
    };
}

/**
 * sample마다 title → basis → attached → expos → LADFRL → LDAREG 순서로
 * 모두 호출한다. 중간 실패가 있어도 나머지 상태를 수집한 뒤 최종 gate에서 실패한다.
 */
export async function captureLandAreaPhase0(input: {
    manifest: LandAreaPhase0CaptureManifest | unknown;
    adapter: LandAreaPhase0CaptureAdapter;
    buildingHubAuth: BuildingHubAuth;
    vworldAuth: VworldAuth;
}): Promise<LandAreaPhase0CaptureArtifact> {
    const manifest = parseLandAreaPhase0Manifest(input.manifest);
    const samples = [...manifest.samples].sort((a, b) =>
        aliasHash(a.alias).localeCompare(aliasHash(b.alias))
    );
    const rawCaptures: SampleRawCapture[] = [];

    for (const sample of samples) {
        const title = await safeScan('getBrTitleInfo', () =>
            input.adapter.scanTitle(sample.pnu, input.buildingHubAuth)
        );
        const basis = await safeScan('getBrBasisOulnInfo', () =>
            input.adapter.scanBasis(sample.pnu, input.buildingHubAuth)
        );
        const attached = await safeScan('getBrAtchJibunInfo', () =>
            input.adapter.scanAttached(sample.pnu, input.buildingHubAuth)
        );
        const expos = await safeScan('getBrExposInfo', () =>
            input.adapter.scanExpos(sample.pnu, input.buildingHubAuth)
        );
        const ladfrl = await safeScan('ladfrlList', () =>
            input.adapter.scanLadfrl(sample.pnu, input.vworldAuth)
        );
        const ldareg = await safeScan('ldaregList', () =>
            input.adapter.scanLdareg(sample.pnu, input.vworldAuth)
        );
        const linkedPnus =
            successfulScan(attached)
                ? [
                      ...new Set(
                          assembledAttached(rowsOf(attached))
                              .pairs.filter((pair) => pair.basePnu === sample.pnu)
                              .map((pair) => pair.attachedPnu)
                      ),
                  ].sort()
                : [];
        const scopeLadfrl: Array<{
            pnu: string;
            scan: StrictScan<LadfrlRow>;
        }> = [{ pnu: sample.pnu, scan: ladfrl }];
        const scopeLdareg: Array<{
            pnu: string;
            scan: StrictScan<LdaregRow>;
        }> = [{ pnu: sample.pnu, scan: ldareg }];
        const scopeExpos: Array<{
            pnu: string;
            scan: StrictScan<BrExposRow>;
        }> = [{ pnu: sample.pnu, scan: expos }];
        for (const pnu of linkedPnus) {
            if (pnu === sample.pnu) continue;
            scopeLadfrl.push({
                pnu,
                scan: await safeScan('ladfrlList', () =>
                    input.adapter.scanLadfrl(pnu, input.vworldAuth)
                ),
            });
            scopeLdareg.push({
                pnu,
                scan: await safeScan('ldaregList', () =>
                    input.adapter.scanLdareg(pnu, input.vworldAuth)
                ),
            });
            scopeExpos.push({
                pnu,
                scan: await safeScan('getBrExposInfo', () =>
                    input.adapter.scanExpos(pnu, input.buildingHubAuth)
                ),
            });
        }
        rawCaptures.push({
            sample,
            title,
            basis,
            attached,
            expos,
            ladfrl,
            ldareg,
            scopeLadfrl,
            scopeLdareg,
            scopeExpos,
        });
    }

    const isSensitive = buildSensitiveValueGuard(
        input.buildingHubAuth,
        input.vworldAuth
    );
    const artifacts = rawCaptures.map((raw) =>
        buildSampleArtifact(raw, isSensitive)
    );
    if (
        !rawCaptures.some((raw) =>
            hasPositiveLadfrlEvidence(raw, isSensitive)
        )
    ) {
        for (const sample of artifacts) {
            if (sample.expectedBylot === 'POSITIVE') {
                sample.failureCodes = [
                    ...new Set([
                        ...sample.failureCodes,
                        'LADFRL_POSITIVE_EVIDENCE_MISSING',
                    ]),
                ].sort();
            }
        }
    }
    if (
        !rawCaptures.some((raw) =>
            hasPositiveLdaregEvidence(raw, isSensitive)
        )
    ) {
        for (const sample of artifacts) {
            if (sample.expectedBylot === 'POSITIVE') {
                sample.failureCodes = [
                    ...new Set([
                        ...sample.failureCodes,
                        'LDAREG_POSITIVE_EVIDENCE_MISSING',
                    ]),
                ].sort();
            }
        }
    }
    const failureCodes = new Set(
        artifacts.flatMap((sample) => sample.failureCodes)
    );
    const reviewCodes = new Set(
        artifacts.flatMap((sample) => sample.reviewCodes)
    );

    return {
        version: LAND_AREA_PHASE0_ARTIFACT_VERSION,
        schemaHash: LAND_AREA_PHASE0_ARTIFACT_SCHEMA_HASH,
        gate: {
            status: failureCodes.size === 0 ? 'PASS' : 'FAIL',
            failureCodes: [...failureCodes].sort(),
            reviewCodes: [...reviewCodes].sort(),
        },
        samples: artifacts,
    };
}

/**
 * 요청 경로를 cwd의 `.phase0-land-area` 바로 아래 파일로만 해소한다.
 */
export function resolveLandAreaPhase0OutputPath(
    cwd: string,
    requested: string
): string {
    const root = pathResolve(cwd, LAND_AREA_PHASE0_OUTPUT_DIRECTORY);
    const normalizedRequested = requested.replaceAll('\\', '/');
    let filename: string;
    if (!normalizedRequested.includes('/')) {
        filename = normalizedRequested;
    } else if (
        normalizedRequested.startsWith(
            `${LAND_AREA_PHASE0_OUTPUT_DIRECTORY}/`
        ) &&
        normalizedRequested.split('/').length === 2
    ) {
        filename = normalizedRequested.slice(
            LAND_AREA_PHASE0_OUTPUT_DIRECTORY.length + 1
        );
    } else {
        throw new Error('출력 경로는 전용 디렉터리 바로 아래여야 합니다.');
    }
    if (!OUTPUT_FILE_PATTERN.test(filename)) {
        throw new Error('출력 경로의 파일명 형식이 올바르지 않습니다.');
    }
    const resolved = pathResolve(root, filename);
    if (pathDirname(resolved) !== root) {
        throw new Error('출력 경로가 전용 디렉터리를 벗어났습니다.');
    }
    return resolved;
}

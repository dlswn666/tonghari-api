import type { DatabaseTarget } from '../types/database.types';
import { createHash } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNU_RE = /^[0-9]{19}$/;

export const LAND_AREA_SYNC_CANARY_NOT_CONFIGURED_CODE =
    'LAND_AREA_SYNC_CANARY_NOT_CONFIGURED';
export const LAND_AREA_SYNC_CANARY_NOT_CONFIGURED_MESSAGE =
    '대지권면적 동기화 허용 대상이 설정되지 않았습니다.';
export const LAND_AREA_SYNC_CANARY_DENIED_CODE = 'LAND_AREA_SYNC_CANARY_DENIED';
export const LAND_AREA_SYNC_CANARY_DENIED_MESSAGE =
    '대지권면적 동기화가 허용되지 않은 대상입니다.';
export const LAND_AREA_SYNC_CANARY_INVALID_REQUEST_CODE =
    'LAND_AREA_SYNC_CANARY_INVALID_REQUEST';
export const LAND_AREA_SYNC_CANARY_INVALID_REQUEST_MESSAGE =
    '대지권면적 동기화 대상 정보가 올바르지 않습니다.';

export type LandAreaSyncAllowedTargets = ReadonlySet<string>;
export interface LandAreaSyncAllowedTargetsManifest {
    allowedTargets: LandAreaSyncAllowedTargets;
    canonicalValue: string;
    count: number;
    digest: string;
}

export class LandAreaSyncCanaryError extends Error {
    constructor(
        readonly code: string,
        readonly status: 400 | 403 | 503,
        message: string
    ) {
        super(message);
        this.name = 'LandAreaSyncCanaryError';
    }
}

function isDatabaseTarget(value: string): value is DatabaseTarget {
    return value === 'development' || value === 'production';
}

function targetKey(
    databaseTarget: DatabaseTarget,
    unionId: string,
    anchorPnu: string
): string {
    return `${databaseTarget}:${unionId.toLowerCase()}:${anchorPnu}`;
}

/**
 * `databaseTarget:unionUuid:anchorPnu` 항목을 쉼표로 구분한다.
 * wildcard·부분 일치·중복은 허용하지 않으며, 잘못된 설정은 프로세스 시작을 거부한다.
 */
export function createLandAreaSyncAllowedTargetsManifest(
    value: string | undefined
): LandAreaSyncAllowedTargetsManifest {
    if (!value?.trim()) {
        return {
            allowedTargets: new Set(),
            canonicalValue: '',
            count: 0,
            digest: '',
        };
    }

    const allowed = new Set<string>();
    for (const rawEntry of value.split(',')) {
        const entry = rawEntry.trim();
        const parts = entry.split(':');
        if (
            parts.length !== 3 ||
            !isDatabaseTarget(parts[0]) ||
            !UUID_RE.test(parts[1]) ||
            !PNU_RE.test(parts[2])
        ) {
            throw new Error(
                'LAND_AREA_SYNC_ALLOWED_TARGETS는 databaseTarget:unionUuid:19자리Pnu 형식이어야 합니다.'
            );
        }

        const key = targetKey(parts[0], parts[1], parts[2]);
        if (allowed.has(key)) {
            throw new Error('LAND_AREA_SYNC_ALLOWED_TARGETS에 중복 대상이 있습니다.');
        }
        allowed.add(key);
    }

    const canonicalEntries = [...allowed].sort();
    const canonicalValue = canonicalEntries.join(',');
    return {
        allowedTargets: new Set(canonicalEntries),
        canonicalValue,
        count: canonicalEntries.length,
        digest: createHash('sha256').update(canonicalValue, 'utf8').digest('hex'),
    };
}

export function parseLandAreaSyncAllowedTargets(
    value: string | undefined
): LandAreaSyncAllowedTargets {
    return createLandAreaSyncAllowedTargetsManifest(value).allowedTargets;
}

export function assertLandAreaSyncCanaryAllowed(
    allowedTargets: LandAreaSyncAllowedTargets,
    databaseTarget: unknown,
    unionId: unknown,
    anchorPnu: unknown
): asserts databaseTarget is DatabaseTarget {
    if (
        typeof databaseTarget !== 'string' ||
        !isDatabaseTarget(databaseTarget) ||
        typeof unionId !== 'string' ||
        !UUID_RE.test(unionId) ||
        typeof anchorPnu !== 'string' ||
        !PNU_RE.test(anchorPnu)
    ) {
        throw new LandAreaSyncCanaryError(
            LAND_AREA_SYNC_CANARY_INVALID_REQUEST_CODE,
            400,
            LAND_AREA_SYNC_CANARY_INVALID_REQUEST_MESSAGE
        );
    }

    if (allowedTargets.size === 0) {
        throw new LandAreaSyncCanaryError(
            LAND_AREA_SYNC_CANARY_NOT_CONFIGURED_CODE,
            503,
            LAND_AREA_SYNC_CANARY_NOT_CONFIGURED_MESSAGE
        );
    }

    if (!allowedTargets.has(targetKey(databaseTarget, unionId, anchorPnu))) {
        throw new LandAreaSyncCanaryError(
            LAND_AREA_SYNC_CANARY_DENIED_CODE,
            403,
            LAND_AREA_SYNC_CANARY_DENIED_MESSAGE
        );
    }
}

/** resolved scope는 일부 PNU만 허용되어도 적용하지 않는다. */
export function assertLandAreaSyncScopeAllowed(
    allowedTargets: LandAreaSyncAllowedTargets,
    databaseTarget: DatabaseTarget,
    unionId: string,
    scannedPnus: readonly string[]
): void {
    if (scannedPnus.length === 0) {
        throw new LandAreaSyncCanaryError(
            LAND_AREA_SYNC_CANARY_INVALID_REQUEST_CODE,
            400,
            LAND_AREA_SYNC_CANARY_INVALID_REQUEST_MESSAGE
        );
    }
    for (const pnu of new Set(scannedPnus)) {
        assertLandAreaSyncCanaryAllowed(
            allowedTargets,
            databaseTarget,
            unionId,
            pnu
        );
    }
}

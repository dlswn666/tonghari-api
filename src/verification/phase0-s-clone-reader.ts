import type { SupabaseClient } from '@supabase/supabase-js';
import {
    canonicalJson,
    createPhase0SnapshotArtifact,
    hashCanonicalValue,
    type JsonValue,
    type Phase0SnapshotArtifact,
    type SnapshotRow,
} from './phase0-s-artifact';

export const PHASE0_S_CLONE_CONFIRMATION = 'DISPOSABLE_CLONE_READ_ONLY';

export interface DisposableCloneTargetInput {
    url: string;
    confirmation: string | undefined;
    cloneProjectRef: string | undefined;
    productionProjectRef: string | undefined;
    configuredProductionUrl?: string;
}

export function assertDistinctPhase0UnionSelection(
    unions: Array<{ alias: string; unionId: string }>
): void {
    if (unions.length < 2) throw new Error('A/B 공유-PNU 검증에는 두 조합 이상이 필요합니다.');
    const aliases = unions.map((union) => union.alias.trim());
    const unionIds = unions.map((union) => union.unionId.trim());
    if (aliases.some((alias) => !alias) || unionIds.some((unionId) => !unionId)) {
        throw new Error('조합 alias와 union id는 비어 있을 수 없습니다.');
    }
    if (new Set(aliases).size !== aliases.length) {
        throw new Error('capture union aliases must be pairwise distinct');
    }
    if (new Set(unionIds).size !== unionIds.length) {
        throw new Error('capture union identities must be pairwise distinct');
    }
}

function projectRefFromHostedUrl(url: URL): string | null {
    const match = url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
    return match?.[1] ?? null;
}

/**
 * 실수로 운영 service-role을 사용하지 않도록 clone 전용 환경변수와 운영 ref 대조를 강제한다.
 * localhost 외의 임의 self-hosted 주소도 허용하지 않는다.
 */
export function assertDisposableCloneTarget(input: DisposableCloneTargetInput): {
    normalizedUrl: string;
    projectRef: string;
} {
    if (input.confirmation !== PHASE0_S_CLONE_CONFIRMATION) {
        throw new Error(
            `PHASE0_S_CLONE_CONFIRMED=${PHASE0_S_CLONE_CONFIRMATION} 확인값이 필요합니다.`
        );
    }

    const url = new URL(input.url);
    if (url.username || url.password) throw new Error('clone URL에 credential을 포함할 수 없습니다.');
    const normalizedUrl = url.origin;
    if (input.configuredProductionUrl) {
        const productionOrigin = new URL(input.configuredProductionUrl).origin;
        if (productionOrigin === normalizedUrl) {
            throw new Error('운영 SUPABASE_URL과 같은 대상에서는 Phase 0-S snapshot을 실행할 수 없습니다.');
        }
    }

    const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (isLocal) {
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('local clone URL protocol이 잘못됐습니다.');
        return { normalizedUrl, projectRef: `local:${url.host}` };
    }

    if (url.protocol !== 'https:') throw new Error('hosted clone은 HTTPS만 허용합니다.');
    const hostedRef = projectRefFromHostedUrl(url);
    if (!hostedRef) {
        throw new Error('localhost 또는 명시적으로 검증된 *.supabase.co disposable clone만 허용합니다.');
    }
    if (!input.cloneProjectRef || input.cloneProjectRef !== hostedRef) {
        throw new Error('PHASE0_S_CLONE_PROJECT_REF가 clone URL의 project ref와 일치해야 합니다.');
    }
    if (!input.productionProjectRef) {
        throw new Error('운영 대상 차단을 위해 PHASE0_S_PRODUCTION_PROJECT_REF가 필요합니다.');
    }
    if (input.productionProjectRef === hostedRef) {
        throw new Error('운영 project ref에서는 Phase 0-S clone snapshot을 실행할 수 없습니다.');
    }
    return { normalizedUrl, projectRef: hostedRef };
}

function asSnapshotRow(value: unknown, context: string): SnapshotRow {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${context}가 JSON object가 아닙니다.`);
    }
    canonicalJson(value, context);
    return value as SnapshotRow;
}

function sanitizedDbError(context: string, error: unknown): Error {
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const code = typeof record.code === 'string' ? record.code : 'UNKNOWN';
    return new Error(`${context} 조회 실패 (code=${code})`);
}

async function readAllUnionRows(
    client: SupabaseClient,
    table: 'property_units' | 'property_ownerships',
    unionId: string
): Promise<SnapshotRow[]> {
    const rows: SnapshotRow[] = [];
    const pageSize = 1_000;
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await client
            .from(table)
            .select('*')
            .eq('union_id', unionId)
            .order('id', { ascending: true })
            .range(offset, offset + pageSize - 1);
        if (error) throw sanitizedDbError(table, error);
        if (!Array.isArray(data)) throw new Error(`${table} 조회 결과가 배열이 아닙니다.`);
        rows.push(...data.map((row, index) => asSnapshotRow(row, `${table}[${offset + index}]`)));
        if (data.length < pageSize) break;
    }
    return rows;
}

async function readAllGlobalRows(
    client: SupabaseClient,
    table: 'building_land_lots' | 'buildings'
): Promise<SnapshotRow[]> {
    const rows: SnapshotRow[] = [];
    const pageSize = 1_000;
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await client
            .from(table)
            .select('*')
            .order('id', { ascending: true })
            .range(offset, offset + pageSize - 1);
        if (error) throw sanitizedDbError(table, error);
        if (!Array.isArray(data)) throw new Error(`${table} 조회 결과가 배열이 아닙니다.`);
        rows.push(...data.map((row, index) => asSnapshotRow(row, `${table}[${offset + index}]`)));
        if (data.length < pageSize) break;
    }
    return rows;
}

async function readCanonicalMemberProperties(
    client: SupabaseClient,
    unionId: string,
    ownerships: SnapshotRow[]
): Promise<SnapshotRow[]> {
    const ownershipIds = ownerships
        .filter((row) => row.is_active === true)
        .map((row, index) => requiredString(row.id, `active property_ownerships[${index}].id`));
    const rows: SnapshotRow[] = [];
    const chunkSize = 200;
    for (let offset = 0; offset < ownershipIds.length; offset += chunkSize) {
        const chunk = ownershipIds.slice(offset, offset + chunkSize);
        const { data, error } = await client
            .from('v_member_property_units_canonical')
            .select('*')
            .in('property_ownership_id', chunk)
            .order('property_ownership_id', { ascending: true });
        if (error) throw sanitizedDbError('v_member_property_units_canonical', error);
        if (!Array.isArray(data)) {
            throw new Error('v_member_property_units_canonical 조회 결과가 배열이 아닙니다.');
        }
        rows.push(...data.map((row, index) => ({
            ...asSnapshotRow(row, `v_member_property_units_canonical[${offset + index}]`),
            // view에 union_id가 없으므로 scope 검증용 synthetic 필드만 hash artifact에 포함한다.
            union_id: unionId,
        })));
    }
    if (rows.length !== ownershipIds.length) {
        throw new Error('canonical member property row 수가 활성/비활성 ownership 원장과 일치하지 않습니다.');
    }
    return rows;
}

function buildBuildingOrphanSummary(
    buildings: SnapshotRow[],
    buildingLandLots: SnapshotRow[]
): SnapshotRow[] {
    const buildingIds = buildings.map((row, index) => requiredString(row.id, `buildings[${index}].id`));
    const mappedBuildingIds = new Set(
        buildingLandLots.map((row, index) =>
            requiredString(row.building_id, `building_land_lots[${index}].building_id`)
        )
    );
    const orphanIds = buildingIds.filter((id) => !mappedBuildingIds.has(id)).sort();
    const globalSummary: SnapshotRow = {
        snapshot_key: 'GLOBAL',
        building_count: buildingIds.length,
        mapped_building_count: new Set(buildingIds.filter((id) => mappedBuildingIds.has(id))).size,
        orphan_count: orphanIds.length,
        orphan_building_ids: orphanIds,
    };
    const buildingStatuses = buildingIds
        .sort()
        .map((buildingId): SnapshotRow => ({
            snapshot_key: `BUILDING:${buildingId}`,
            building_id: buildingId,
            is_orphan: !mappedBuildingIds.has(buildingId),
        }));
    return [globalSummary, ...buildingStatuses];
}

function requiredString(value: unknown, context: string): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${context} 식별자가 없습니다.`);
    return value;
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/** RPC 원문에서 과소필지 unit 결과와 group summary만 뽑는다. */
export function extractMinorParcelSnapshotRows(
    unionId: string,
    memberRows: unknown[]
): SnapshotRow[] {
    const result: SnapshotRow[] = [];
    for (const [memberIndex, memberValue] of memberRows.entries()) {
        const member = asSnapshotRow(memberValue, `memberRows[${memberIndex}]`);
        const memberId = requiredString(member.id, `memberRows[${memberIndex}].id`);
        const summary = (member.minor_parcel_review ?? null) as JsonValue;
        canonicalJson(summary, `memberRows[${memberIndex}].minor_parcel_review`);
        result.push({
            snapshot_key: `GROUP:${memberId}`,
            union_id: unionId,
            scope: 'MEMBER_GROUP',
            member_group_id: memberId,
            property_unit_id: null,
            property_ownership_id: null,
            result: summary,
        });

        const units = member.property_units;
        if (!Array.isArray(units)) {
            throw new Error(`memberRows[${memberIndex}].property_units가 배열이 아닙니다.`);
        }
        for (const [unitIndex, unitValue] of units.entries()) {
            const unit = asSnapshotRow(unitValue, `memberRows[${memberIndex}].property_units[${unitIndex}]`);
            const propertyUnitId = optionalString(unit.official_property_unit_id) ?? optionalString(unit.id);
            const ownershipId = optionalString(unit.property_ownership_id);
            if (!propertyUnitId) {
                throw new Error(`memberRows[${memberIndex}].property_units[${unitIndex}] unit id가 없습니다.`);
            }
            const unitResult = (unit.minor_parcel_phase1 ?? null) as JsonValue;
            canonicalJson(unitResult, `memberRows[${memberIndex}].property_units[${unitIndex}].minor_parcel_phase1`);
            result.push({
                snapshot_key: `UNIT:${memberId}:${ownershipId ?? '-'}:${propertyUnitId}`,
                union_id: unionId,
                scope: 'PROPERTY_UNIT',
                member_group_id: memberId,
                property_unit_id: propertyUnitId,
                property_ownership_id: ownershipId,
                result: unitResult,
            });
        }
    }
    return result;
}

async function readMinorParcelResults(client: SupabaseClient, unionId: string): Promise<SnapshotRow[]> {
    const memberRows: unknown[] = [];
    const pageSize = 2_000;
    let totalCount: number | null = null;
    for (let page = 1; page <= 1_000; page++) {
        const { data, error } = await client.rpc('get_admin_member_list_rows_lite', {
            p_union_id: unionId,
            p_search_query: '',
            p_blocked_filter: 'all',
            p_member_type_filter: 'all',
            p_page: page,
            p_page_size: pageSize,
            p_minor_parcel_review_filter: 'all',
        });
        if (error) throw sanitizedDbError('get_admin_member_list_rows_lite', error);
        const response = asSnapshotRow(data, 'get_admin_member_list_rows_lite');
        if (!Array.isArray(response.rows) || !Number.isInteger(response.total_count)) {
            throw new Error('get_admin_member_list_rows_lite 응답 계약이 잘못됐습니다.');
        }
        totalCount = response.total_count as number;
        memberRows.push(...response.rows);
        if (memberRows.length >= totalCount || response.rows.length === 0) break;
    }
    if (totalCount === null || memberRows.length !== totalCount) {
        throw new Error('과소필지 RPC 전체 페이지를 수집하지 못했습니다.');
    }
    return extractMinorParcelSnapshotRows(unionId, memberRows);
}

export async function capturePhase0CloneArtifact(input: {
    client: SupabaseClient;
    projectRef: string;
    label: string;
    unions: Array<{ alias: string; unionId: string }>;
    capturedAt?: string;
}): Promise<Phase0SnapshotArtifact> {
    assertDistinctPhase0UnionSelection(input.unions);
    const [buildingLandLots, buildings] = await Promise.all([
        readAllGlobalRows(input.client, 'building_land_lots'),
        readAllGlobalRows(input.client, 'buildings'),
    ]);
    const buildingOrphanSummary = buildBuildingOrphanSummary(buildings, buildingLandLots);
    const rawUnions = await Promise.all(
        input.unions.map(async (union) => {
            const [propertyUnits, propertyOwnerships, minorParcelResults] = await Promise.all([
                readAllUnionRows(input.client, 'property_units', union.unionId),
                readAllUnionRows(input.client, 'property_ownerships', union.unionId),
                readMinorParcelResults(input.client, union.unionId),
            ]);
            const canonicalMemberProperties = await readCanonicalMemberProperties(
                input.client,
                union.unionId,
                propertyOwnerships
            );
            return {
                alias: union.alias,
                unionId: union.unionId,
                propertyUnits,
                propertyOwnerships,
                canonicalMemberProperties,
                minorParcelResults,
                buildingLandLots,
                buildingOrphanSummary,
            };
        })
    );

    return createPhase0SnapshotArtifact({
        source: {
            kind: 'DISPOSABLE_CLONE',
            label: input.label,
            projectRefHash: hashCanonicalValue(`project:${input.projectRef}`),
        },
        capturedAt: input.capturedAt,
        unions: rawUnions,
    });
}

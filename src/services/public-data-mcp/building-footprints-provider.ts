import {
    BUILDING_FOOTPRINTS_ATTRIBUTION, BUILDING_FOOTPRINTS_LAYER, BUILDING_FOOTPRINTS_SOURCE,
    BuildingFootprintsDataSchema, LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME, LookupBuildingFootprintsInputV1Schema,
    type BuildingFootprintsClient, type LookupBuildingFootprintsInputV1,
} from './building-footprints-contract';
import { BuildingFootprintsError, createBuildingFootprintsClient } from './building-footprints-client';
import { PUBLIC_DATA_MCP_MAX_OUTPUT_BYTES, type PublicDataMcpResultV1 } from './policy';

export function createBuildingFootprintsProvider(deps: { client?: BuildingFootprintsClient; now?: () => number } = {}) {
    const client = deps.client ?? createBuildingFootprintsClient();
    const now = deps.now ?? Date.now;
    return {
        async execute(input: LookupBuildingFootprintsInputV1, context: { signal: AbortSignal }): Promise<PublicDataMcpResultV1> {
            const base = {
                contractVersion: 'TonghariPublicGisResultV1' as const, tool: LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME,
                provider: 'VWorld', source: BUILDING_FOOTPRINTS_SOURCE, asOf: new Date(now()).toISOString(),
                attribution: BUILDING_FOOTPRINTS_ATTRIBUTION,
                query: { bbox: input.bbox, page: input.page, limit: input.limit },
            };
            try {
                const safeInput = LookupBuildingFootprintsInputV1Schema.parse(input);
                const page = await client.lookup(safeInput, context.signal);
                const data = BuildingFootprintsDataSchema.parse({ layer: BUILDING_FOOTPRINTS_LAYER,
                    crs: 'EPSG:4326', type: 'FeatureCollection', features: page.features });
                const offset = (safeInput.page - 1) * safeInput.limit;
                if (!Number.isSafeInteger(page.total) || page.total < 0
                    || data.features.length !== Math.min(safeInput.limit, Math.max(0, page.total - offset))) {
                    throw new BuildingFootprintsError('PAGINATION_MISMATCH');
                }
                const hasMore = offset + data.features.length < page.total;
                const result: PublicDataMcpResultV1 = {
                    ...base, status: page.total === 0 ? 'NO_DATA' : 'SUCCESS',
                    ...(page.total === 0 ? { code: 'NO_DATA' as const } : {}), data,
                    pagination: { offset, limit: safeInput.limit, returned: data.features.length, total: page.total, hasMore },
                    warnings: ['DATA_REFERENCE_DATE_MUST_BE_CONFIRMED', 'FOOTPRINT_ID_IS_NOT_BUILDING_REGISTER_ID',
                        ...(hasMore ? ['MORE_RECORDS_AVAILABLE'] : [])],
                };
                if (Buffer.byteLength(JSON.stringify(result), 'utf8') > PUBLIC_DATA_MCP_MAX_OUTPUT_BYTES) {
                    throw new BuildingFootprintsError('OUTPUT_TOO_LARGE');
                }
                return result;
            } catch (error) {
                const safe = context.signal.aborted ? new BuildingFootprintsError('REQUEST_ABORTED')
                    : error instanceof BuildingFootprintsError ? error : new BuildingFootprintsError('PROVIDER_RESPONSE_INVALID');
                return { ...base, status: safe.status, code: safe.code, data: {}, warnings: [safe.code] };
            }
        },
    };
}

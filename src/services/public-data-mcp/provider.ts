import type {
    ApartmentHouseOfficialPrice,
    BuildingDongInfo,
    GisService,
    IndividualHousingOfficialPrice,
    OfficialLandPriceInfo,
} from '../gis.service';
import { GIS_SHARED_ENDPOINTS } from '../gis-shared/endpoints';
import {
    LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME,
    FULL_GIS_SOURCE_META,
    FULL_GIS_SOURCE_IDS,
    type LookupFullGisPublicDataInputV1,
} from './full-lookup-contract';
import { createFullGisLookupProvider } from './full-lookup-provider';
import { createBuildingFootprintsProvider } from './building-footprints-provider';
import { createBuildingFootprintsClient } from './building-footprints-client';
import {
    BUILDING_FOOTPRINTS_ATTRIBUTION, BUILDING_FOOTPRINTS_SOURCE, LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME,
    type BuildingFootprintsClient, type LookupBuildingFootprintsInputV1,
} from './building-footprints-contract';
import {
    LandRightLookupBudget,
    type NedFetchResult,
    type VworldAuth,
    landRightNedClient,
} from '../land-right-lookup/ned';
import {
    projectLadfrlRecord,
    projectLdaregRecord,
} from '../land-right-lookup/transient';
import {
    LOOKUP_BUILDING_REGISTER_TOOL_NAME,
    LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME,
    LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME,
    LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME,
    PUBLIC_DATA_MCP_SAFE_CODES,
    RESOLVE_ADDRESS_TO_PNU_TOOL_NAME,
    type LookupBuildingRegisterInputV1,
    type LookupHousingOfficialPriceInputV1,
    type LookupLandRightRegistrationInputV1,
    type LookupParcelPublicDataInputV1,
    type PublicDataMcpResultV1,
    type PublicDataMcpSafeCode,
    type PublicDataMcpStatus,
    type PublicDataMcpToolInput,
    type PublicDataMcpToolName,
    type ResolveAddressToPnuInputV1,
} from './policy';

const VWORLD_ADDRESS_SOURCE = 'https://api.vworld.kr/req/address';
const VWORLD_PARCEL_BOUNDARY_SOURCE = 'https://api.vworld.kr/req/data';
const VWORLD_PARCEL_WFS_SOURCE =
    'https://api.vworld.kr/ned/wfs/getCtnlgsSpceWFS';
const VWORLD_LAND_PRICE_SOURCE =
    'https://api.vworld.kr/ned/data/getIndvdLandPriceAttr';
const VWORLD_APARTMENT_PRICE_SOURCE =
    'https://api.vworld.kr/ned/data/getApartHousingPriceAttr';
const VWORLD_INDIVIDUAL_PRICE_SOURCE =
    'https://api.vworld.kr/ned/data/getIndvdHousingPriceAttr';

const VWORLD_ATTRIBUTION =
    '국토교통부 VWorld 공공데이터를 이용했습니다.';
const DATA_PORTAL_ATTRIBUTION =
    '국토교통부 건축HUB 공공데이터포털 자료를 이용했습니다.';

const SAFE_CODE_SET = new Set<string>(PUBLIC_DATA_MCP_SAFE_CODES);

export const PUBLIC_DATA_MCP_TOOL_PROVENANCE: Record<
    PublicDataMcpToolName,
    { provider: string; source: string; attribution: string }
> = {
    [LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME]: {
        provider: 'VWorld', source: BUILDING_FOOTPRINTS_SOURCE, attribution: BUILDING_FOOTPRINTS_ATTRIBUTION,
    },
    [LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME]: {
        provider: 'VWorld / 공공데이터포털 건축HUB',
        source: [...new Set(FULL_GIS_SOURCE_IDS.map((id) => FULL_GIS_SOURCE_META[id].source))].join(', '),
        attribution: `${VWORLD_ATTRIBUTION} ${DATA_PORTAL_ATTRIBUTION}`,
    },
    [RESOLVE_ADDRESS_TO_PNU_TOOL_NAME]: {
        provider: 'VWorld',
        source: VWORLD_ADDRESS_SOURCE,
        attribution: VWORLD_ATTRIBUTION,
    },
    [LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME]: {
        provider: 'VWorld',
        source: [
            VWORLD_PARCEL_BOUNDARY_SOURCE,
            VWORLD_PARCEL_WFS_SOURCE,
            GIS_SHARED_ENDPOINTS.ladfrlList,
            VWORLD_LAND_PRICE_SOURCE,
        ].join(', '),
        attribution: VWORLD_ATTRIBUTION,
    },
    [LOOKUP_BUILDING_REGISTER_TOOL_NAME]: {
        provider: '공공데이터포털 건축HUB',
        source: [
            GIS_SHARED_ENDPOINTS.getBrTitleInfo,
            GIS_SHARED_ENDPOINTS.getBrExposInfo,
        ].join(', '),
        attribution: DATA_PORTAL_ATTRIBUTION,
    },
    [LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME]: {
        provider: 'VWorld',
        source: [
            VWORLD_APARTMENT_PRICE_SOURCE,
            VWORLD_INDIVIDUAL_PRICE_SOURCE,
        ].join(', '),
        attribution: VWORLD_ATTRIBUTION,
    },
    [LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME]: {
        provider: 'VWorld',
        source: [
            GIS_SHARED_ENDPOINTS.ldaregList,
            GIS_SHARED_ENDPOINTS.ladfrlList,
        ].join(', '),
        attribution: VWORLD_ATTRIBUTION,
    },
};

export interface PublicDataMcpProviderContext {
    signal: AbortSignal;
}

export interface PublicDataMcpProviderV1 {
    execute(
        tool: PublicDataMcpToolName,
        input: PublicDataMcpToolInput,
        context: PublicDataMcpProviderContext
    ): Promise<PublicDataMcpResultV1>;
}

type GisProviderMethods = Pick<
    GisService,
    | 'getPNUFromAddress'
    | 'getParcelBoundary'
    | 'getLandRegistryInfo'
    | 'getOfficialLandPriceRecord'
    | 'getBuildingDongs'
    | 'getApartmentHousePrices'
    | 'getIndividualHousingPrice'
>;

type LandRightProviderMethods = Pick<
    typeof landRightNedClient,
    'fetchLdareg' | 'fetchLadfrl'
>;

export interface PublicDataMcpProviderDependenciesV1 {
    buildingFootprints?: BuildingFootprintsClient;
    gis?: GisProviderMethods;
    landRight?: LandRightProviderMethods;
    vworldAuth?: VworldAuth;
    now?: () => number;
}

type SourceStatus = Exclude<PublicDataMcpStatus, 'PARTIAL'>;

interface SourceOutcome<T> {
    status: SourceStatus;
    code?: PublicDataMcpSafeCode;
    value?: T;
}

function safeIsoTime(now: () => number): string {
    const value = now();
    return Number.isFinite(value)
        ? new Date(value).toISOString()
        : new Date(0).toISOString();
}

function queryFor(
    tool: PublicDataMcpToolName,
    input: PublicDataMcpToolInput
): Record<string, unknown> {
    switch (tool) {
        case LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME: {
            const footprints = input as LookupBuildingFootprintsInputV1;
            return { bbox: footprints.bbox, page: footprints.page, limit: footprints.limit };
        }
        case LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME:
            return { ...(input as LookupFullGisPublicDataInputV1) };
        case RESOLVE_ADDRESS_TO_PNU_TOOL_NAME:
            return { address: (input as ResolveAddressToPnuInputV1).address };
        case LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME: {
            const parcel = input as LookupParcelPublicDataInputV1;
            return { pnu: parcel.pnu, year: parcel.year ?? null };
        }
        case LOOKUP_BUILDING_REGISTER_TOOL_NAME:
        case LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME: {
            const paged = input as
                | LookupBuildingRegisterInputV1
                | LookupLandRightRegistrationInputV1;
            return {
                pnu: paged.pnu,
                offset: paged.offset,
                limit: paged.limit,
            };
        }
        case LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME: {
            const housing = input as LookupHousingOfficialPriceInputV1;
            return {
                pnu: housing.pnu,
                year: housing.year ?? null,
                offset: housing.offset,
                limit: housing.limit,
            };
        }
    }
}

function baseResult(
    tool: PublicDataMcpToolName,
    input: PublicDataMcpToolInput,
    now: () => number
): Pick<
    PublicDataMcpResultV1,
    | 'contractVersion'
    | 'tool'
    | 'provider'
    | 'source'
    | 'asOf'
    | 'attribution'
    | 'query'
> {
    const provenance = PUBLIC_DATA_MCP_TOOL_PROVENANCE[tool];
    return {
        contractVersion: 'TonghariPublicGisResultV1',
        tool,
        provider: provenance.provider,
        source: provenance.source,
        asOf: safeIsoTime(now),
        attribution: provenance.attribution,
        query: queryFor(tool, input),
    };
}

export function createPublicDataMcpFailureResultV1(
    tool: PublicDataMcpToolName,
    input: PublicDataMcpToolInput,
    code: PublicDataMcpSafeCode,
    status: Extract<PublicDataMcpStatus, 'FAILED' | 'INCOMPLETE'> = 'FAILED',
    now: () => number = Date.now
): PublicDataMcpResultV1 {
    return {
        ...baseResult(tool, input, now),
        status,
        code,
        data: {},
        warnings: [code],
    };
}

function nullableText(value: unknown, maximum = 500): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text.length > 0 ? text.slice(0, maximum) : null;
}

function nullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function safeCode(value: string | undefined): PublicDataMcpSafeCode | undefined {
    return value && SAFE_CODE_SET.has(value)
        ? value as PublicDataMcpSafeCode
        : value
            ? 'PROVIDER_RESPONSE_INVALID'
            : undefined;
}

async function safeCall<T>(operation: () => Promise<T>): Promise<
    { ok: true; value: T } | { ok: false }
> {
    try {
        return { ok: true, value: await operation() };
    } catch {
        return { ok: false };
    }
}

function aggregateStatuses(statuses: SourceStatus[]): PublicDataMcpStatus {
    const successful = statuses.filter((status) => status === 'SUCCESS').length;
    if (statuses.every((status) => status === 'NO_DATA')) return 'NO_DATA';
    if (
        successful > 0
        && statuses.every(
            (status) => status === 'SUCCESS' || status === 'NO_DATA'
        )
    ) {
        return 'SUCCESS';
    }
    if (successful > 0) return 'PARTIAL';
    if (statuses.some((status) => status === 'INCOMPLETE')) return 'INCOMPLETE';
    if (statuses.some((status) => status === 'FAILED')) return 'FAILED';
    return 'INCOMPLETE';
}

function pagination(
    offset: number,
    limit: number,
    total: number,
    returned: number
): NonNullable<PublicDataMcpResultV1['pagination']> {
    return {
        offset,
        limit,
        returned,
        total,
        hasMore: offset + returned < total,
    };
}

function statusCode(
    status: PublicDataMcpStatus,
    partial: PublicDataMcpSafeCode,
    incomplete: PublicDataMcpSafeCode
): PublicDataMcpSafeCode | undefined {
    switch (status) {
        case 'PARTIAL':
            return partial;
        case 'INCOMPLETE':
            return incomplete;
        case 'FAILED':
            return 'PROVIDER_REQUEST_FAILED';
        case 'NO_DATA':
            return 'NO_DATA';
        case 'SUCCESS':
            return undefined;
    }
}

function projectBuildingRecords(dongs: BuildingDongInfo[]): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    for (const dong of dongs) {
        const building = {
            dongName: nullableText(dong.dongName),
            dongNameNormalized: nullableText(dong.dongNameNormalized),
            buildingType: dong.buildingType,
            housingType: dong.housingType,
            buildingName: nullableText(dong.buildingName),
            mainPurpose: nullableText(dong.mainPurpose),
            floorCount: Number.isSafeInteger(dong.floorCount)
                ? dong.floorCount
                : 0,
            isWelfareFacility: dong.isWelfareFacility === true,
        };

        if (dong.units.length === 0) {
            records.push({ ...building, unit: null });
            continue;
        }
        for (const unit of dong.units) {
            records.push({
                ...building,
                unit: {
                    dong: nullableText(unit.dong),
                    ho: nullableText(unit.ho),
                    floor: nullableNumber(unit.floor),
                    area: nullableNumber(unit.area),
                },
            });
        }
    }
    return records;
}

function projectApartmentPrice(
    row: ApartmentHouseOfficialPrice
): Record<string, unknown> | null {
    const officialPrice = nullableNumber(row.officialPrice);
    const sourcePnu = /^\d{19}$/.test(row.sourcePnu) ? row.sourcePnu : null;
    const stdrYear = /^\d{4}$/.test(row.stdrYear) ? row.stdrYear : null;
    if (!officialPrice || officialPrice <= 0 || !sourcePnu || !stdrYear) {
        return null;
    }
    return {
        housingKind: 'APARTMENT',
        dong: nullableText(row.dong),
        ho: nullableText(row.ho),
        area: nullableNumber(row.area),
        officialPrice,
        currency: 'KRW',
        sourcePnu,
        stdrYear,
    };
}

function projectIndividualPrice(
    row: IndividualHousingOfficialPrice
): Record<string, unknown> | null {
    const officialPrice = nullableNumber(row.officialPrice);
    const sourcePnu = /^\d{19}$/.test(row.sourcePnu) ? row.sourcePnu : null;
    const stdrYear = /^\d{4}$/.test(row.stdrYear) ? row.stdrYear : null;
    if (!officialPrice || officialPrice <= 0 || !sourcePnu || !stdrYear) {
        return null;
    }
    return {
        housingKind: 'INDIVIDUAL',
        dong: null,
        ho: null,
        area: null,
        officialPrice,
        currency: 'KRW',
        sourcePnu,
        stdrYear,
    };
}

function nedOutcome(result: NedFetchResult): SourceOutcome<Record<string, unknown>[]> {
    const code = safeCode(result.code);
    if (result.status === 'SUCCESS' && result.records.length === 0) {
        return {
            status: 'INCOMPLETE',
            code: 'PROVIDER_RESPONSE_INVALID',
        };
    }
    return {
        status: result.status,
        ...(code ? { code } : {}),
        ...(result.status === 'SUCCESS' ? { value: result.records } : {}),
    };
}

/**
 * 기존 GIS 정규화 서비스와 transient NED client만 연결하는 공개 projection adapter다.
 * 인스펙터 원문과 내부 DB 작업은 이 경계에 들어오지 않는다.
 * 전체 조회의 별도 이용허락 범위는 2026-09-06 acceptance에 기록한다.
 */
export function createPublicDataMcpProviderV1(
    dependencies: PublicDataMcpProviderDependenciesV1 = {}
): PublicDataMcpProviderV1 {
    const gis = dependencies.gis ?? (
        require('../gis.service') as { gisService: GisProviderMethods }
    ).gisService;
    const landRight = dependencies.landRight ?? landRightNedClient;
    const configuredEnv = dependencies.vworldAuth
        ? null
        : (require('../../config/env') as {
            env: { VWORLD_API_KEY: string; VWORLD_API_DOMAIN: string };
        }).env;
    const vworldAuth = dependencies.vworldAuth ?? {
        key: configuredEnv!.VWORLD_API_KEY,
        domain: configuredEnv!.VWORLD_API_DOMAIN,
    };
    const now = dependencies.now ?? Date.now;
    let fullLookup: ReturnType<typeof createFullGisLookupProvider> | undefined;
    let footprints: ReturnType<typeof createBuildingFootprintsProvider> | undefined;

    async function resolveAddress(
        input: ResolveAddressToPnuInputV1,
        context: PublicDataMcpProviderContext
    ): Promise<PublicDataMcpResultV1> {
        const lookup = await safeCall(() => gis.getPNUFromAddress(
            input.address,
            { signal: context.signal }
        ));
        if (!lookup.ok) {
            return createPublicDataMcpFailureResultV1(
                RESOLVE_ADDRESS_TO_PNU_TOOL_NAME,
                input,
                'PROVIDER_REQUEST_FAILED',
                'FAILED',
                now
            );
        }
        if (!lookup.value) {
            return createPublicDataMcpFailureResultV1(
                RESOLVE_ADDRESS_TO_PNU_TOOL_NAME,
                input,
                'ADDRESS_RESOLUTION_INCOMPLETE',
                'INCOMPLETE',
                now
            );
        }

        const longitude = Number(lookup.value.x);
        const latitude = Number(lookup.value.y);
        const coordinatesValid = Number.isFinite(longitude)
            && longitude >= -180
            && longitude <= 180
            && Number.isFinite(latitude)
            && latitude >= -90
            && latitude <= 90;
        const pnuValid = /^\d{19}$/.test(lookup.value.pnu);
        const status: PublicDataMcpStatus = pnuValid
            ? 'SUCCESS'
            : coordinatesValid
                ? 'PARTIAL'
                : 'INCOMPLETE';

        return {
            ...baseResult(RESOLVE_ADDRESS_TO_PNU_TOOL_NAME, input, now),
            status,
            ...(pnuValid
                ? {}
                : { code: 'PNU_RESOLUTION_INCOMPLETE' as const }),
            data: {
                pnu: pnuValid ? lookup.value.pnu : null,
                coordinates: coordinatesValid
                    ? { longitude, latitude, crs: 'EPSG:4326' }
                    : null,
            },
            warnings: [
                ...(pnuValid ? [] : ['PNU_RESOLUTION_INCOMPLETE']),
            ],
        };
    }

    async function lookupParcel(
        input: LookupParcelPublicDataInputV1,
        context: PublicDataMcpProviderContext
    ): Promise<PublicDataMcpResultV1> {
        const [boundaryCall, registryCall, priceCall] = await Promise.all([
            safeCall(() => gis.getParcelBoundary(
                input.pnu,
                { signal: context.signal }
            )),
            safeCall(() => gis.getLandRegistryInfo(
                input.pnu,
                {
                    signal: context.signal,
                    requireExactMetadata: true,
                }
            )),
            safeCall(() => gis.getOfficialLandPriceRecord(
                input.pnu,
                input.year,
                { signal: context.signal }
            )),
        ]);
        const boundary: SourceOutcome<GeoJSON.Geometry> = !boundaryCall.ok
            ? { status: 'FAILED', code: 'PROVIDER_REQUEST_FAILED' }
            : boundaryCall.value
                ? { status: 'SUCCESS', value: boundaryCall.value }
                : { status: 'INCOMPLETE', code: 'PROVIDER_RESPONSE_INVALID' };
        const registry: SourceOutcome<{
            sourcePnu: string;
            area: number;
            ownerCount: number;
            landCategory: string | null;
        }> = !registryCall.ok
            ? { status: 'FAILED', code: 'PROVIDER_REQUEST_FAILED' }
            : registryCall.value
                && registryCall.value.sourcePnu === input.pnu
                && Number.isFinite(registryCall.value.area)
                && registryCall.value.area > 0
                && Number.isSafeInteger(registryCall.value.ownerCount)
                && registryCall.value.ownerCount >= 0
                ? { status: 'SUCCESS', value: registryCall.value }
                : { status: 'INCOMPLETE', code: 'PROVIDER_RESPONSE_INVALID' };
        const officialPrice: SourceOutcome<OfficialLandPriceInfo> = !priceCall.ok
            ? { status: 'FAILED', code: 'PROVIDER_REQUEST_FAILED' }
            : priceCall.value !== null
                ? { status: 'SUCCESS', value: priceCall.value }
                : { status: 'INCOMPLETE', code: 'PROVIDER_RESPONSE_INVALID' };
        const outcomes = [boundary, registry, officialPrice];
        const status = aggregateStatuses(outcomes.map((item) => item.status));
        const code = statusCode(
            status,
            'PARCEL_PUBLIC_DATA_PARTIAL',
            'PARCEL_PUBLIC_DATA_INCOMPLETE'
        );

        return {
            ...baseResult(LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME, input, now),
            status,
            ...(code ? { code } : {}),
            data: {
                pnu: input.pnu,
                boundary: boundary.value ?? null,
                landRegistry: registry.value
                    ? {
                        area: nullableNumber(registry.value.area),
                        ownerCount: Number.isSafeInteger(registry.value.ownerCount)
                            ? registry.value.ownerCount
                            : null,
                        landCategory: nullableText(
                            registry.value.landCategory,
                            80
                        ),
                    }
                    : null,
                officialLandPrice: officialPrice.value !== undefined
                    ? {
                        value: officialPrice.value.officialPrice,
                        unit: 'KRW_PER_SQUARE_METER',
                        requestedYear: input.year ?? null,
                        sourcePnu: officialPrice.value.sourcePnu,
                        stdrYear: officialPrice.value.stdrYear,
                        lastUpdtDt: officialPrice.value.lastUpdtDt,
                    }
                    : null,
                sourceStatuses: {
                    boundary: {
                        status: boundary.status,
                        ...(boundary.code ? { code: boundary.code } : {}),
                    },
                    landRegistry: {
                        status: registry.status,
                        ...(registry.code ? { code: registry.code } : {}),
                    },
                    officialLandPrice: {
                        status: officialPrice.status,
                        ...(officialPrice.code
                            ? { code: officialPrice.code }
                            : {}),
                    },
                },
            },
            warnings: [
                'DATA_REFERENCE_DATE_MUST_BE_CONFIRMED',
                'OFFICIAL_PRICE_IS_NOT_APPRAISAL',
            ],
        };
    }

    async function lookupBuilding(
        input: LookupBuildingRegisterInputV1,
        context: PublicDataMcpProviderContext
    ): Promise<PublicDataMcpResultV1> {
        const lookup = await safeCall(() => gis.getBuildingDongs(
            input.pnu,
            { signal: context.signal }
        ));
        if (!lookup.ok) {
            return createPublicDataMcpFailureResultV1(
                LOOKUP_BUILDING_REGISTER_TOOL_NAME,
                input,
                'PROVIDER_REQUEST_FAILED',
                'FAILED',
                now
            );
        }
        if (lookup.value.length === 0) {
            return createPublicDataMcpFailureResultV1(
                LOOKUP_BUILDING_REGISTER_TOOL_NAME,
                input,
                'BUILDING_REGISTER_INCOMPLETE',
                'INCOMPLETE',
                now
            );
        }

        const records = projectBuildingRecords(lookup.value);
        if (records.length === 0) {
            return createPublicDataMcpFailureResultV1(
                LOOKUP_BUILDING_REGISTER_TOOL_NAME,
                input,
                'BUILDING_REGISTER_INCOMPLETE',
                'INCOMPLETE',
                now
            );
        }
        const page = records.slice(input.offset, input.offset + input.limit);

        return {
            ...baseResult(LOOKUP_BUILDING_REGISTER_TOOL_NAME, input, now),
            status: 'SUCCESS',
            data: { pnu: input.pnu, records: page },
            pagination: pagination(
                input.offset,
                input.limit,
                records.length,
                page.length
            ),
            warnings: [
                'DATA_REFERENCE_DATE_MUST_BE_CONFIRMED',
                'PUBLIC_RECORD_DOES_NOT_CONFIRM_REGISTERED_RIGHTS',
            ],
        };
    }

    async function lookupHousingPrice(
        input: LookupHousingOfficialPriceInputV1,
        context: PublicDataMcpProviderContext
    ): Promise<PublicDataMcpResultV1> {
        const [apartmentCall, individualCall] = await Promise.all([
            safeCall(() => gis.getApartmentHousePrices(
                input.pnu,
                input.year,
                { signal: context.signal }
            )),
            safeCall(() => gis.getIndividualHousingPrice(
                input.pnu,
                input.year,
                { signal: context.signal }
            )),
        ]);
        let apartment: SourceOutcome<Record<string, unknown>[]>;
        if (!apartmentCall.ok) {
            apartment = { status: 'FAILED', code: 'PROVIDER_REQUEST_FAILED' };
        } else if (apartmentCall.value === null) {
            apartment = {
                status: 'INCOMPLETE',
                code: 'PROVIDER_RESPONSE_INVALID',
            };
        } else if (apartmentCall.value.length === 0) {
            apartment = { status: 'NO_DATA', value: [] };
        } else {
            const projected = apartmentCall.value
                .map(projectApartmentPrice)
                .filter((row): row is Record<string, unknown> => row !== null);
            apartment = projected.length > 0
                ? { status: 'SUCCESS', value: projected }
                : {
                    status: 'INCOMPLETE',
                    code: 'PROVIDER_RESPONSE_INVALID',
                };
        }

        let individual: SourceOutcome<Record<string, unknown>[]>;
        if (!individualCall.ok) {
            individual = { status: 'FAILED', code: 'PROVIDER_REQUEST_FAILED' };
        } else if (individualCall.value === null) {
            // 기존 정규화 함수의 null은 무자료와 provider 실패를 구분하지 않는다.
            individual = {
                status: 'INCOMPLETE',
                code: 'PROVIDER_RESPONSE_INVALID',
            };
        } else {
            const projected = projectIndividualPrice(individualCall.value);
            individual = projected
                ? { status: 'SUCCESS', value: [projected] }
                : {
                    status: 'INCOMPLETE',
                    code: 'PROVIDER_RESPONSE_INVALID',
                };
        }

        const status = aggregateStatuses([apartment.status, individual.status]);
        const code = statusCode(
            status,
            'HOUSING_PRICE_PARTIAL',
            'HOUSING_PRICE_INCOMPLETE'
        );
        const records = [
            ...(apartment.value ?? []),
            ...(individual.value ?? []),
        ];
        const page = records.slice(input.offset, input.offset + input.limit);

        return {
            ...baseResult(LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME, input, now),
            status,
            ...(code ? { code } : {}),
            data: {
                pnu: input.pnu,
                records: page,
                sourceStatuses: {
                    apartment: {
                        status: apartment.status,
                        ...(apartment.code ? { code: apartment.code } : {}),
                    },
                    individual: {
                        status: individual.status,
                        ...(individual.code ? { code: individual.code } : {}),
                    },
                },
            },
            pagination: pagination(
                input.offset,
                input.limit,
                records.length,
                page.length
            ),
            warnings: [
                'DATA_REFERENCE_DATE_MUST_BE_CONFIRMED',
                'OFFICIAL_PRICE_IS_NOT_APPRAISAL',
            ],
        };
    }

    async function lookupLandRight(
        input: LookupLandRightRegistrationInputV1,
        context: PublicDataMcpProviderContext
    ): Promise<PublicDataMcpResultV1> {
        const budget = new LandRightLookupBudget();
        const [ldaregCall, ladfrlCall] = await Promise.all([
            safeCall(() => landRight.fetchLdareg(input.pnu, vworldAuth, {
                signal: context.signal,
                budget,
            })),
            safeCall(() => landRight.fetchLadfrl(input.pnu, vworldAuth, {
                signal: context.signal,
                budget,
            })),
        ]);
        const ldareg = ldaregCall.ok
            ? nedOutcome(ldaregCall.value)
            : {
                status: 'FAILED' as const,
                code: 'PROVIDER_REQUEST_FAILED' as const,
            };
        const ladfrl = ladfrlCall.ok
            ? nedOutcome(ladfrlCall.value)
            : {
                status: 'FAILED' as const,
                code: 'PROVIDER_REQUEST_FAILED' as const,
            };
        const status = aggregateStatuses([ldareg.status, ladfrl.status]);
        const code = statusCode(
            status,
            'LAND_RIGHT_PARTIAL',
            'LAND_RIGHT_INCOMPLETE'
        );
        const records: Record<string, unknown>[] = [
            ...(ldareg.value ?? []).map((row) => ({
                recordType: 'LAND_RIGHT_REGISTER',
                ...projectLdaregRecord(row),
            })),
            ...(ladfrl.value ?? []).map((row) => ({
                recordType: 'LAND_LEDGER',
                ...projectLadfrlRecord(row),
            })),
        ];
        const page = records.slice(input.offset, input.offset + input.limit);

        return {
            ...baseResult(
                LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME,
                input,
                now
            ),
            status,
            ...(code ? { code } : {}),
            data: {
                pnu: input.pnu,
                records: page,
                sourceStatuses: {
                    ldareg: {
                        status: ldareg.status,
                        ...(ldareg.code ? { code: ldareg.code } : {}),
                    },
                    ladfrl: {
                        status: ladfrl.status,
                        ...(ladfrl.code ? { code: ladfrl.code } : {}),
                    },
                },
            },
            pagination: pagination(
                input.offset,
                input.limit,
                records.length,
                page.length
            ),
            warnings: [
                'DATA_REFERENCE_DATE_MUST_BE_CONFIRMED',
                'PUBLIC_RECORD_DOES_NOT_CONFIRM_REGISTERED_RIGHTS',
            ],
        };
    }

    return {
        async execute(tool, input, context) {
            context.signal.throwIfAborted();
            switch (tool) {
                case LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME:
                    footprints ??= createBuildingFootprintsProvider({ now, client: dependencies.buildingFootprints
                        ?? createBuildingFootprintsClient({ vworldKey: vworldAuth.key, vworldDomain: vworldAuth.domain }) });
                    return footprints.execute(input as LookupBuildingFootprintsInputV1, context);
                case LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME:
                    fullLookup ??= createFullGisLookupProvider({ now });
                    return fullLookup.execute(input as LookupFullGisPublicDataInputV1, context);
                case RESOLVE_ADDRESS_TO_PNU_TOOL_NAME:
                    return resolveAddress(
                        input as ResolveAddressToPnuInputV1,
                        context
                    );
                case LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME:
                    return lookupParcel(
                        input as LookupParcelPublicDataInputV1,
                        context
                    );
                case LOOKUP_BUILDING_REGISTER_TOOL_NAME:
                    return lookupBuilding(
                        input as LookupBuildingRegisterInputV1,
                        context
                    );
                case LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME:
                    return lookupHousingPrice(
                        input as LookupHousingOfficialPriceInputV1,
                        context
                    );
                case LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME:
                    return lookupLandRight(
                        input as LookupLandRightRegistrationInputV1,
                        context
                    );
            }
        },
    };
}

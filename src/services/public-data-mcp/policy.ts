import * as z from 'zod/v4';
import {
    BuildingFootprintsDataSchema, LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME,
    LookupBuildingFootprintsInputV1Schema, type LookupBuildingFootprintsInputV1,
} from './building-footprints-contract';
export { LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME, LookupBuildingFootprintsInputV1Schema } from './building-footprints-contract';
import {
    LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME,
    FullGisDataSchema,
    type LookupFullGisPublicDataInputV1,
} from './full-lookup-contract';
export { LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME, LookupFullGisPublicDataInputV1Schema } from './full-lookup-contract';

export const PUBLIC_DATA_MCP_SERVER_NAME = 'tonghari-public-gis';
export const PUBLIC_DATA_MCP_SERVER_VERSION = '1.2.0';
export const GIS_MCP_REQUIRED_SCOPE = 'gis:read' as const;
export const GIS_MCP_CLIENT_ID = 'tonghari-gis-mcp' as const;

export const RESOLVE_ADDRESS_TO_PNU_TOOL_NAME =
    'resolve_address_to_pnu_v1' as const;
export const LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME =
    'lookup_parcel_public_data_v1' as const;
export const LOOKUP_BUILDING_REGISTER_TOOL_NAME =
    'lookup_building_register_v1' as const;
export const LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME =
    'lookup_housing_official_price_v1' as const;
export const LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME =
    'lookup_land_right_registration_v1' as const;

export const PUBLIC_DATA_MCP_TOOL_NAMES = [
    RESOLVE_ADDRESS_TO_PNU_TOOL_NAME,
    LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME,
    LOOKUP_BUILDING_REGISTER_TOOL_NAME,
    LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME,
    LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME,
    LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME,
    LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME,
] as const;

export const PUBLIC_DATA_MCP_REVIEW_PROMPT_NAME =
    'review_public_gis_data_v1' as const;
export const PUBLIC_DATA_MCP_POLICY_RESOURCE_NAME =
    'public-gis-data-policy-v1' as const;
export const PUBLIC_DATA_MCP_POLICY_RESOURCE_URI =
    'tonghari-gis://policy/public-data/v1' as const;

export const PUBLIC_DATA_MCP_MAX_OUTPUT_BYTES = 128 * 1024;
export const PUBLIC_DATA_MCP_MIN_YEAR = 2000;
export const PUBLIC_DATA_MCP_MAX_YEAR = new Date().getFullYear() + 1;

export const PublicDataMcpAddressSchema = z
    .string()
    .trim()
    .min(1)
    .max(300);
export const PublicDataMcpPnuSchema = z
    .string()
    .regex(/^\d{19}$/);
export const PublicDataMcpYearSchema = z
    .number()
    .int()
    .min(PUBLIC_DATA_MCP_MIN_YEAR)
    .max(PUBLIC_DATA_MCP_MAX_YEAR);
export const PublicDataMcpOffsetSchema = z
    .number()
    .int()
    .min(0)
    .default(0);
export const PublicDataMcpLimitSchema = z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20);

export const ResolveAddressToPnuInputV1Schema = z.object({
    address: PublicDataMcpAddressSchema,
}).strict();

export const LookupParcelPublicDataInputV1Schema = z.object({
    pnu: PublicDataMcpPnuSchema,
    year: PublicDataMcpYearSchema.optional(),
}).strict();

export const LookupBuildingRegisterInputV1Schema = z.object({
    pnu: PublicDataMcpPnuSchema,
    offset: PublicDataMcpOffsetSchema,
    limit: PublicDataMcpLimitSchema,
}).strict();

export const LookupHousingOfficialPriceInputV1Schema = z.object({
    pnu: PublicDataMcpPnuSchema,
    year: PublicDataMcpYearSchema.optional(),
    offset: PublicDataMcpOffsetSchema,
    limit: PublicDataMcpLimitSchema,
}).strict();

export const LookupLandRightRegistrationInputV1Schema = z.object({
    pnu: PublicDataMcpPnuSchema,
    offset: PublicDataMcpOffsetSchema,
    limit: PublicDataMcpLimitSchema,
}).strict();

export type ResolveAddressToPnuInputV1 = z.infer<
    typeof ResolveAddressToPnuInputV1Schema
>;
export type LookupParcelPublicDataInputV1 = z.infer<
    typeof LookupParcelPublicDataInputV1Schema
>;
export type LookupBuildingRegisterInputV1 = z.infer<
    typeof LookupBuildingRegisterInputV1Schema
>;
export type LookupHousingOfficialPriceInputV1 = z.infer<
    typeof LookupHousingOfficialPriceInputV1Schema
>;
export type LookupLandRightRegistrationInputV1 = z.infer<
    typeof LookupLandRightRegistrationInputV1Schema
>;

export type PublicDataMcpToolName =
    (typeof PUBLIC_DATA_MCP_TOOL_NAMES)[number];

export type PublicDataMcpToolInputByName = {
    [LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME]: LookupBuildingFootprintsInputV1;
    [LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME]: LookupFullGisPublicDataInputV1;
    [RESOLVE_ADDRESS_TO_PNU_TOOL_NAME]: ResolveAddressToPnuInputV1;
    [LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME]: LookupParcelPublicDataInputV1;
    [LOOKUP_BUILDING_REGISTER_TOOL_NAME]: LookupBuildingRegisterInputV1;
    [LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME]: LookupHousingOfficialPriceInputV1;
    [LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME]: LookupLandRightRegistrationInputV1;
};

export type PublicDataMcpToolInput =
    PublicDataMcpToolInputByName[PublicDataMcpToolName];

export const PUBLIC_DATA_MCP_STATUSES = [
    'SUCCESS',
    'PARTIAL',
    'NO_DATA',
    'FAILED',
    'INCOMPLETE',
] as const;

export const PUBLIC_DATA_MCP_SAFE_CODES = [
    'INSUFFICIENT_SCOPE',
    'RATE_LIMITED',
    'REQUEST_ABORTED',
    'REQUEST_DEADLINE_EXCEEDED',
    'PROVIDER_REQUEST_FAILED',
    'PROVIDER_RESPONSE_INVALID',
    'OUTPUT_TOO_LARGE',
    'ADDRESS_RESOLUTION_INCOMPLETE',
    'PNU_RESOLUTION_INCOMPLETE',
    'PARCEL_PUBLIC_DATA_PARTIAL',
    'PARCEL_PUBLIC_DATA_INCOMPLETE',
    'BUILDING_REGISTER_INCOMPLETE',
    'HOUSING_PRICE_PARTIAL',
    'HOUSING_PRICE_INCOMPLETE',
    'LAND_RIGHT_PARTIAL',
    'LAND_RIGHT_INCOMPLETE',
    'NO_DATA',
    'LOOKUP_DEADLINE_EXCEEDED',
    'LOOKUP_ABORTED',
    'PROVIDER_TIMEOUT',
    'SCAN_ROW_LIMIT_EXCEEDED',
    'LOOKUP_ROW_LIMIT_EXCEEDED',
    'LOOKUP_RESPONSE_SIZE_LIMIT_EXCEEDED',
    'PAGE_LIMIT_EXCEEDED',
    'PAGINATION_MISMATCH',
    'ROW_PNU_MISMATCH',
    'PAGE_REPEATED',
    'PAGE_RECORD_OVERLAP',
    'ENDPOINT_CONTAINER_INVALID',
    'ENDPOINT_RESPONSE_NON_OBJECT',
    'HTTP_ERROR',
    'INPUT_PNU_INVALID',
    'PROVIDER_ERROR',
    'PROVIDER_NOT_CONFIGURED',
    'ROWS_INVALID',
    'TOTAL_COUNT_INVALID',
    'TRANSPORT_ERROR',
    'FULL_GIS_PARTIAL',
    'FULL_GIS_INCOMPLETE',
    'PNU_MISMATCH',
] as const;

export type PublicDataMcpStatus =
    (typeof PUBLIC_DATA_MCP_STATUSES)[number];
export type PublicDataMcpSafeCode =
    (typeof PUBLIC_DATA_MCP_SAFE_CODES)[number];

export const PublicDataMcpResultV1Schema = z.object({
    contractVersion: z.literal('TonghariPublicGisResultV1'),
    tool: z.enum(PUBLIC_DATA_MCP_TOOL_NAMES),
    status: z.enum(PUBLIC_DATA_MCP_STATUSES),
    code: z.enum(PUBLIC_DATA_MCP_SAFE_CODES).optional(),
    provider: z.string().min(1).max(120),
    source: z.string().min(1).max(2_000),
    asOf: z.string().min(1).max(80),
    attribution: z.string().min(1).max(500),
    query: z.record(z.string(), z.unknown()),
    data: z.record(z.string(), z.unknown()),
    pagination: z.object({
        offset: z.number().int().min(0),
        limit: z.number().int().min(1).max(100),
        returned: z.number().int().min(0).max(100),
        total: z.number().int().min(0),
        hasMore: z.boolean(),
    }).strict().optional(),
    warnings: z.array(z.string().min(1).max(160)).max(30),
}).strict().superRefine((value, context) => {
    if (value.tool === LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME) {
        if (Object.keys(value.data).length === 0 && ['FAILED', 'INCOMPLETE'].includes(value.status)) return;
        const data = BuildingFootprintsDataSchema.safeParse(value.data);
        const query = LookupBuildingFootprintsInputV1Schema.safeParse(value.query);
        const pagination = value.pagination;
        if (!data.success || !query.success || !pagination
            || !['SUCCESS', 'NO_DATA'].includes(value.status)
            || pagination.offset !== (query.data.page - 1) * query.data.limit
            || pagination.limit !== query.data.limit || pagination.returned !== data.data.features.length
            || pagination.returned !== Math.min(pagination.limit, Math.max(0, pagination.total - pagination.offset))
            || pagination.hasMore !== (pagination.offset + pagination.returned < pagination.total)
            || (value.status === 'NO_DATA') !== (pagination.total === 0)) {
            context.addIssue({ code: 'custom', message: '건물 윤곽 자료와 페이지 계약이 일치하지 않습니다.', path: ['data'] });
        }
        return;
    }
    if (value.tool !== LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME) return;
    // 전송/인증 단계의 안전 오류는 data={}이며, 실제 전체 조회 결과는 14항목 계약을 따른다.
    if (Object.keys(value.data).length === 0 && ['FAILED', 'INCOMPLETE'].includes(value.status)) return;
    const result = FullGisDataSchema.safeParse(value.data);
    if (!result.success) {
        context.addIssue({ code: 'custom', message: '전체 GIS 조회 결과가 14개 자료 계약과 다릅니다.', path: ['data'] });
    }
});

export type PublicDataMcpResultV1 = z.infer<
    typeof PublicDataMcpResultV1Schema
>;

export const PublicDataMcpReviewPromptArgsSchema = z.object({
    question: z.string().trim().min(1).max(2_000),
    address: PublicDataMcpAddressSchema.optional(),
    pnu: PublicDataMcpPnuSchema.optional(),
    year: PublicDataMcpYearSchema.optional(),
}).strict();

export type PublicDataMcpReviewPromptArgs = z.infer<
    typeof PublicDataMcpReviewPromptArgsSchema
>;

export const PUBLIC_DATA_MCP_SERVER_INSTRUCTIONS = [
    '이 서버는 VWorld와 공공데이터포털의 공개 GIS 자료를 읽기 전용으로 조회한다.',
    '도구 결과의 provider, source, asOf, attribution을 유지하고 답변에서 출처를 표시한다.',
    '이 서버는 조회만 수행하며, 결과를 이용한 후속 DB 작업은 별도 작업 경로에서 수행한다.',
    '공시가격은 과세·행정 기준 자료이며 감정평가액이나 현재 시가로 단정하지 않는다.',
    '대지권등록부와 건축물대장은 참고용 공공자료이며 등기부상 권리의 존부·귀속·순위를 확정하지 않는다.',
    '기준연도와 lastUpdtDt가 있으면 함께 제시하고, asOf는 조회 시각이지 원자료의 최신 보증일이 아님을 알린다.',
    'FAILED, INCOMPLETE, PARTIAL 상태를 NO_DATA로 바꾸거나 누락 자료를 추정하지 않는다.',
    '명부 작성·공부 대조를 위한 전체 조회에는 lookup_full_gis_public_data_v1을 사용한다. 14개 자료의 개별 상태와 pagination을 확인한다.',
    'hasMore=true인 자료는 offsets에 해당 자료의 nextOffset을 넣어 이어 조회한다. allSourcesQueried와 allRecordsReturned를 구분한다.',
    '동별 건물 윤곽은 lookup_building_footprints_v1의 제한된 EPSG:4326 bbox로 별도 조회한다. hasMore=true이면 같은 bbox·limit으로 page를 1 증가시킨다. feature ID를 건축물대장 PK나 PNU로 해석하지 않는다.',
    '표제부·전유부·층별개요 면적과 대지권 분수는 원래 의미를 유지하고, 사람별 소유지분이나 명부 적용 면적으로 자동 변환하지 않는다.',
].join('\n');

export const PUBLIC_DATA_MCP_POLICY_V1 = `# 통하리 공개 GIS 데이터 이용 정책 v1

## 조회 범위와 후속 작업

- 공개 도구는 주소/PNU 또는 2km² 이하의 제한된 BBOX로 특정한 자료를 조회하는 읽기 전용 도구다. 동기화, 내부 DB 조회·수정, 임의 endpoint 호출은 제공하지 않는다.
- 이 서버는 조회만 수행하며, 결과를 이용한 후속 DB 작업은 별도 작업 경로에서 수행한다.
- 전체 조회는 기존 인스펙터의 14개 자료를 source별로 반환하며, 건물호수조회는 운영자가 별도 이용허락을 확보한 범위에서 제공한다.
- 건물 윤곽은 별도 도구가 LT_C_BLDGINFO의 실제 Polygon/MultiPolygon과 허용된 건물 속성을 반환한다. 동명 누락을 추정하지 않으며, 원천 feature ID는 PNU 또는 건축물대장 PK가 아니다. 페이지 전체 수집과 특정 동 매칭은 후속 검증이다.
- API key, bearer token, provider 원문 오류 body, stack, 소유자 식별정보는 결과에 포함하지 않는다.

## 출처와 기준일

- 답변에는 도구 결과의 provider, source, asOf, attribution을 유지해 출처를 표시한다.
- asOf는 통하리 서버의 조회 시각이다. 원자료의 기준연도나 lastUpdtDt가 있으면 별도로 표시한다.
- 공급기관 자료는 갱신 지연이나 정정이 있을 수 있으므로, 데이터 기준일을 확인하지 않은 채 최신 상태라고 단정하지 않는다.

## 해석 한계

- 개별공시지가와 공동·개별주택 공시가격은 행정 목적의 공시가격이다. 감정평가액, 거래가격 또는 현재 시가와 같다고 해석하지 않는다.
- 대지권등록부와 건축물대장은 등기부가 아니다. 권리의 존부, 소유자, 지분, 말소 여부 또는 순위를 확정하려면 등기사항증명서와 전문가 검토가 필요하다.
- PARTIAL, FAILED, INCOMPLETE는 공급자 실패나 응답 불완전을 포함한다. 이를 확정적인 NO_DATA로 바꾸지 않는다.
`;

export function buildPublicDataMcpReviewPromptMessage(
    args: PublicDataMcpReviewPromptArgs
): string {
    const input = JSON.stringify({
        question: args.question,
        address: args.address ?? null,
        pnu: args.pnu ?? null,
        year: args.year ?? null,
    }, null, 2);

    return `다음 공개 GIS 자료 질의를 검토하세요.

1. 주소만 있으면 먼저 ${RESOLVE_ADDRESS_TO_PNU_TOOL_NAME}으로 exact PNU를 확인하세요.
2. 질문에 필요한 도구만 호출하고, PARTIAL·FAILED·INCOMPLETE를 NO_DATA로 바꾸지 마세요.
3. 결과의 provider, source, asOf, attribution과 데이터 기준연도·lastUpdtDt를 답변에 표시하세요.
4. 공시가격은 감정평가가 아니며 대지권등록부·건축물대장은 등기 권리를 확정하지 않는다고 명시하세요.

사용자 입력(JSON):
${input}`;
}

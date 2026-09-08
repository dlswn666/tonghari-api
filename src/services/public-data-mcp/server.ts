import {
    McpServer,
    type AuthInfo,
    type CallToolResult,
    type ServerContext,
} from '@modelcontextprotocol/server';
import {
    GIS_MCP_REQUIRED_SCOPE,
    LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME,
    LookupBuildingFootprintsInputV1Schema,
    LOOKUP_BUILDING_REGISTER_TOOL_NAME,
    LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME,
    LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME,
    LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME,
    LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME,
    LookupFullGisPublicDataInputV1Schema,
    LookupBuildingRegisterInputV1Schema,
    LookupHousingOfficialPriceInputV1Schema,
    LookupLandRightRegistrationInputV1Schema,
    LookupParcelPublicDataInputV1Schema,
    PUBLIC_DATA_MCP_MAX_OUTPUT_BYTES,
    PUBLIC_DATA_MCP_POLICY_RESOURCE_NAME,
    PUBLIC_DATA_MCP_POLICY_RESOURCE_URI,
    PUBLIC_DATA_MCP_POLICY_V1,
    PUBLIC_DATA_MCP_REVIEW_PROMPT_NAME,
    PUBLIC_DATA_MCP_SERVER_INSTRUCTIONS,
    PUBLIC_DATA_MCP_SERVER_NAME,
    PUBLIC_DATA_MCP_SERVER_VERSION,
    PublicDataMcpResultV1Schema,
    PublicDataMcpReviewPromptArgsSchema,
    RESOLVE_ADDRESS_TO_PNU_TOOL_NAME,
    ResolveAddressToPnuInputV1Schema,
    buildPublicDataMcpReviewPromptMessage,
    type PublicDataMcpResultV1,
    type PublicDataMcpSafeCode,
    type PublicDataMcpToolInput,
    type PublicDataMcpToolName,
} from './policy';
import { TONGHARI_MCP_SUPPORTED_PROTOCOL_VERSIONS } from '../mcp-protocol';
import {
    createPublicDataMcpFailureResultV1,
} from './provider';
import {
    isPublicDataMcpRuntimeError,
} from './runtime';

export { PUBLIC_DATA_MCP_TOOL_NAMES } from './policy';

type MaybePromise<T> = T | Promise<T>;

export interface PublicDataMcpPrincipal {
    clientId: string;
    scopes: readonly string[];
    tokenId: string;
}

export interface PublicDataMcpCallContext {
    principal: PublicDataMcpPrincipal;
    signal: AbortSignal;
}

export interface PublicDataMcpServerDependencies {
    now?: () => number;
    execute(
        tool: PublicDataMcpToolName,
        input: PublicDataMcpToolInput,
        context: PublicDataMcpCallContext
    ): MaybePromise<unknown>;
}

class PublicDataMcpOutputTooLargeError extends Error {
    constructor() {
        super('GIS MCP output exceeds the transport budget.');
        this.name = 'PublicDataMcpOutputTooLargeError';
    }
}

class PublicDataMcpOutputInvalidError extends Error {
    constructor() {
        super('GIS MCP output violates the public projection.');
        this.name = 'PublicDataMcpOutputInvalidError';
    }
}

const FORBIDDEN_OUTPUT_KEYS = new Set([
    'apikey',
    'servicekey',
    'authorization',
    'bearertoken',
    'accesstoken',
    'refreshtoken',
    'tokenid',
    'jwt',
    'password',
    'secret',
    'raw',
    'rawjson',
    'rawbody',
    'rawproviderbody',
    'error',
    'errormessage',
    'errorbody',
    'message',
    'details',
    'body',
    'config',
    'headers',
    'request',
    'response',
    'stack',
    'stacktrace',
    'metadata',
    'ownername',
    'ownertelno',
    'ownerphone',
    'owneridentity',
    'residentregistrationnumber',
    'propertyunitid',
    'unionid',
    'userid',
    'internaldb',
    'servicerole',
]);

function normalizedKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertPublicProjection(value: unknown): void {
    const pending: unknown[] = [value];
    while (pending.length > 0) {
        const current = pending.pop();
        if (Array.isArray(current)) {
            pending.push(...current);
            continue;
        }
        if (!current || typeof current !== 'object') continue;
        for (const [key, nested] of Object.entries(current)) {
            if (FORBIDDEN_OUTPUT_KEYS.has(normalizedKey(key))) {
                throw new PublicDataMcpOutputInvalidError();
            }
            pending.push(nested);
        }
    }
}

function boundedPublicResult(value: unknown): {
    result: PublicDataMcpResultV1;
    text: string;
} {
    let text: string;
    try {
        text = JSON.stringify(value);
    } catch {
        throw new PublicDataMcpOutputInvalidError();
    }
    if (text === undefined) throw new PublicDataMcpOutputInvalidError();
    if (Buffer.byteLength(text, 'utf8') > PUBLIC_DATA_MCP_MAX_OUTPUT_BYTES) {
        throw new PublicDataMcpOutputTooLargeError();
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new PublicDataMcpOutputInvalidError();
    }
    assertPublicProjection(parsed);
    const validated = PublicDataMcpResultV1Schema.safeParse(parsed);
    if (!validated.success) throw new PublicDataMcpOutputInvalidError();
    return { result: validated.data, text };
}

function getCallContext(context: ServerContext): PublicDataMcpCallContext | null {
    const authInfo = context.http?.authInfo;
    const tokenId = authInfo?.extra?.tokenId;
    if (
        !authInfo
        || !authInfo.scopes.includes(GIS_MCP_REQUIRED_SCOPE)
        || typeof tokenId !== 'string'
        || !/^[0-9a-f]{64}$/i.test(tokenId)
    ) {
        return null;
    }

    return {
        principal: {
            clientId: authInfo.clientId,
            scopes: [...authInfo.scopes],
            tokenId,
        },
        signal: context.mcpReq.signal,
    };
}

function principalFromAuthInfo(authInfo: AuthInfo): PublicDataMcpPrincipal {
    const tokenId = authInfo.extra?.tokenId;
    if (typeof tokenId !== 'string' || !/^[0-9a-f]{64}$/i.test(tokenId)) {
        throw new Error('GIS MCP AuthInfo tokenId가 없습니다.');
    }
    return {
        clientId: authInfo.clientId,
        scopes: [...authInfo.scopes],
        tokenId,
    };
}

function callResult(
    output: PublicDataMcpResultV1,
    isError = false
): CallToolResult {
    const bounded = boundedPublicResult(output);
    return {
        content: [{ type: 'text', text: bounded.text }],
        structuredContent: bounded.result,
        ...(isError ? { isError: true } : {}),
    };
}

function runtimeFailureStatus(
    code: PublicDataMcpSafeCode
): 'FAILED' | 'INCOMPLETE' {
    return code === 'REQUEST_ABORTED' || code === 'REQUEST_DEADLINE_EXCEEDED'
        ? 'INCOMPLETE'
        : 'FAILED';
}

async function executeTool(
    dependencies: PublicDataMcpServerDependencies,
    tool: PublicDataMcpToolName,
    input: PublicDataMcpToolInput,
    context: ServerContext
): Promise<CallToolResult> {
    const now = dependencies.now ?? Date.now;
    const callContext = getCallContext(context);
    if (!callContext) {
        return callResult(createPublicDataMcpFailureResultV1(
            tool,
            input,
            'INSUFFICIENT_SCOPE',
            'FAILED',
            now
        ), true);
    }

    try {
        const candidate = await dependencies.execute(tool, input, callContext);
        const bounded = boundedPublicResult(candidate);
        return {
            content: [{ type: 'text', text: bounded.text }],
            structuredContent: bounded.result,
            ...(bounded.result.status === 'FAILED' ? { isError: true } : {}),
        };
    } catch (error) {
        let code: PublicDataMcpSafeCode = 'PROVIDER_REQUEST_FAILED';
        if (error instanceof PublicDataMcpOutputTooLargeError) {
            code = 'OUTPUT_TOO_LARGE';
        } else if (error instanceof PublicDataMcpOutputInvalidError) {
            code = 'PROVIDER_RESPONSE_INVALID';
        } else if (isPublicDataMcpRuntimeError(error)) {
            code = error.code;
        }
        return callResult(createPublicDataMcpFailureResultV1(
            tool,
            input,
            code,
            runtimeFailureStatus(code),
            now
        ), true);
    }
}

/** 기존 5개, 전체 조회, 건물 윤곽의 read-only surface를 등록하는 순수 factory다. */
export function createPublicDataMcpServer(
    dependencies: PublicDataMcpServerDependencies
): McpServer {
    const server = new McpServer(
        {
            name: PUBLIC_DATA_MCP_SERVER_NAME,
            version: PUBLIC_DATA_MCP_SERVER_VERSION,
        },
        {
            instructions: PUBLIC_DATA_MCP_SERVER_INSTRUCTIONS,
            supportedProtocolVersions: [
                ...TONGHARI_MCP_SUPPORTED_PROTOCOL_VERSIONS,
            ],
        }
    );
    const readOnlyAnnotations = {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    } as const;

    server.registerTool(
        RESOLVE_ADDRESS_TO_PNU_TOOL_NAME,
        {
            title: '주소를 PNU로 확인',
            description:
                '1~300자 주소를 VWorld에서 조회해 exact 19자리 PNU와 좌표를 반환하는 읽기 전용 도구다.',
            inputSchema: ResolveAddressToPnuInputV1Schema,
            outputSchema: PublicDataMcpResultV1Schema,
            annotations: readOnlyAnnotations,
        },
        (input, context) => executeTool(
            dependencies,
            RESOLVE_ADDRESS_TO_PNU_TOOL_NAME,
            input,
            context
        )
    );

    server.registerTool(
        LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME,
        {
            title: '필지 공개자료 조회',
            description:
                'exact PNU의 경계, 토지대장 공개 항목과 개별공시지가를 안전 projection으로 조회한다.',
            inputSchema: LookupParcelPublicDataInputV1Schema,
            outputSchema: PublicDataMcpResultV1Schema,
            annotations: readOnlyAnnotations,
        },
        (input, context) => executeTool(
            dependencies,
            LOOKUP_PARCEL_PUBLIC_DATA_TOOL_NAME,
            input,
            context
        )
    );

    server.registerTool(
        LOOKUP_BUILDING_REGISTER_TOOL_NAME,
        {
            title: '건축물대장 공개자료 조회',
            description:
                'exact PNU의 표제부·전유부 정규화 projection을 offset/limit 범위로 조회한다.',
            inputSchema: LookupBuildingRegisterInputV1Schema,
            outputSchema: PublicDataMcpResultV1Schema,
            annotations: readOnlyAnnotations,
        },
        (input, context) => executeTool(
            dependencies,
            LOOKUP_BUILDING_REGISTER_TOOL_NAME,
            input,
            context
        )
    );

    server.registerTool(
        LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME,
        {
            title: '주택 공시가격 조회',
            description:
                'exact PNU의 공동·개별주택 공시가격을 기준연도와 offset/limit 범위로 조회한다. 감정평가액이 아니다.',
            inputSchema: LookupHousingOfficialPriceInputV1Schema,
            outputSchema: PublicDataMcpResultV1Schema,
            annotations: readOnlyAnnotations,
        },
        (input, context) => executeTool(
            dependencies,
            LOOKUP_HOUSING_OFFICIAL_PRICE_TOOL_NAME,
            input,
            context
        )
    );

    server.registerTool(
        LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME,
        {
            title: '대지권등록부 공개자료 조회',
            description:
                'exact PNU의 VWorld 대지권등록부·토지대장 allowlist projection을 offset/limit 범위로 조회한다. 등기 권리를 확정하지 않는다.',
            inputSchema: LookupLandRightRegistrationInputV1Schema,
            outputSchema: PublicDataMcpResultV1Schema,
            annotations: readOnlyAnnotations,
        },
        (input, context) => executeTool(
            dependencies,
            LOOKUP_LAND_RIGHT_REGISTRATION_TOOL_NAME,
            input,
            context
        )
    );

    server.registerTool(
        LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME,
        {
            title: '명부 대조용 전체 GIS 공부 조회',
            description: '주소 또는 exact PNU의 14개 GIS 자료를 항목별 출처·상태와 함께 조회한다. 표제부·전유부·층별개요·가격·대지권·건물호수조회를 포함한다. 주소 입력 시 지오코딩·역지오코딩도 조회한다. 각 자료의 hasMore와 nextOffset을 확인하고 offsets로 이어 조회한다. 면적·지분의 원래 의미를 보존하는 읽기 전용 조회 도구이며, 후속 DB 작업은 별도 경로에서 수행한다.',
            inputSchema: LookupFullGisPublicDataInputV1Schema,
            outputSchema: PublicDataMcpResultV1Schema,
            annotations: readOnlyAnnotations,
        },
        (input, context) => executeTool(dependencies, LOOKUP_FULL_GIS_PUBLIC_DATA_TOOL_NAME, input, context)
    );

    server.registerTool(
        LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME,
        {
            title: '동별 건물 윤곽 조회',
            description: 'EPSG:4326 bbox [서쪽경도, 남쪽위도, 동쪽경도, 북쪽위도]의 VWorld 건축물정보 윤곽과 동명·건물명·층수를 조회한다. BBOX는 2km² 이하, 각 축 0.05도 이하이고 page는 1부터, limit은 기본 20·최대 100이다. hasMore이면 같은 bbox·limit으로 다음 page를 조회한다. feature ID는 건축물대장 PK/PNU가 아니며 전체 단지나 동별 매칭 완성을 보증하지 않는다. 읽기 전용이며 후속 저장은 별도 경로에서 수행한다.',
            inputSchema: LookupBuildingFootprintsInputV1Schema,
            outputSchema: PublicDataMcpResultV1Schema,
            annotations: readOnlyAnnotations,
        },
        (input, context) => executeTool(dependencies, LOOKUP_BUILDING_FOOTPRINTS_TOOL_NAME, input, context)
    );

    server.registerPrompt(
        PUBLIC_DATA_MCP_REVIEW_PROMPT_NAME,
        {
            title: '공개 GIS 자료 검토',
            description:
                '필요한 읽기 도구를 선택하고 출처·기준일·공시가격·등기 해석 한계를 유지한다.',
            argsSchema: PublicDataMcpReviewPromptArgsSchema,
        },
        (args) => ({
            messages: [{
                role: 'user' as const,
                content: {
                    type: 'text' as const,
                    text: buildPublicDataMcpReviewPromptMessage(args),
                },
            }],
        })
    );

    server.registerResource(
        PUBLIC_DATA_MCP_POLICY_RESOURCE_NAME,
        PUBLIC_DATA_MCP_POLICY_RESOURCE_URI,
        {
            title: '통하리 공개 GIS 데이터 이용 정책 v1',
            description: '조회 범위, 출처, 기준일과 법적·가격 해석 한계',
            mimeType: 'text/markdown',
            annotations: {
                audience: ['assistant'],
                priority: 1,
                lastModified: '2026-09-08T00:00:00+09:00',
            },
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'text/markdown',
                text: PUBLIC_DATA_MCP_POLICY_V1,
            }],
        })
    );

    return server;
}

/** host adapter와 테스트가 raw AuthInfo에서 같은 principal을 만들 때 사용한다. */
export const publicDataMcpPrincipalFromAuthInfo = principalFromAuthInfo;

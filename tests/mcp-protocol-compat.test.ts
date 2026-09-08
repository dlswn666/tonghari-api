import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import {
    createGisMcpRoute,
    type GisMcpRouteHandle,
} from '../src/routes/gis-mcp';
import {
    createLegalMcpRoute,
    type LegalMcpRouteHandle,
} from '../src/routes/legal-mcp';
import {
    LEGAL_MCP_REQUIRED_SCOPE,
    LEGAL_RENDER_TOOL_NAME,
    LEGAL_RESEARCH_TOOL_NAME,
} from '../src/services/legal-research/mcp-policy';
import type { LegalMcpCallContext } from '../src/services/legal-research/mcp-server';
import { TONGHARI_MCP_SUPPORTED_PROTOCOL_VERSIONS } from '../src/services/mcp-protocol';
import {
    PUBLIC_DATA_MCP_POLICY_RESOURCE_URI,
    PUBLIC_DATA_MCP_REVIEW_PROMPT_NAME,
    PUBLIC_DATA_MCP_TOOL_NAMES,
} from '../src/services/public-data-mcp/policy';
import type { PublicDataMcpCallContext } from '../src/services/public-data-mcp/server';

const CODEX_PROTOCOL_VERSION = '2025-06-18';
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const GIS_TOKEN = 'gis-mcp-protocol-compat-token';
const GIS_PROXY_TOKEN = 'gis-mcp-protocol-compat-proxy-token';
const LEGAL_TOKEN = 'legal-mcp-protocol-compat-token';
const LEGAL_PROXY_TOKEN = 'legal-mcp-protocol-compat-proxy-token';
const NOW = Date.parse('2026-09-05T00:00:00.000Z');

const sha256 = (value: string) => createHash('sha256')
    .update(value, 'utf8')
    .digest('hex');

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

async function jsonRpcBody(response: Response): Promise<Record<string, any>> {
    const text = await response.text();
    if (!text) return {};
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        return JSON.parse(text) as Record<string, any>;
    }

    const payloads = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .filter(Boolean)
        .map((value) => JSON.parse(value) as Record<string, any>);
    assert.ok(payloads.length > 0, 'SSE 응답에는 JSON-RPC data event가 필요합니다.');
    return payloads[payloads.length - 1];
}

interface LegacyRequestOptions {
    endpoint: string;
    token: string;
    proxyHeader: string;
    proxyToken: string;
    protocolVersion?: string;
}

async function legacyRequest(
    method: string,
    params: Record<string, unknown>,
    options: LegacyRequestOptions,
    id?: number
): Promise<{ response: Response; body: Record<string, any> }> {
    const headers: Record<string, string> = {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        [options.proxyHeader]: options.proxyToken,
    };
    if (options.protocolVersion) {
        headers['mcp-protocol-version'] = options.protocolVersion;
    }
    const request = {
        jsonrpc: '2.0',
        ...(id === undefined ? {} : { id }),
        method,
        params,
    };
    const response = await fetch(options.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
    });
    return {
        response,
        body: await jsonRpcBody(response),
    };
}

describe('Codex MCP 2025-06-18 stateless 호환 계약', () => {
    let server: Server;
    let gisRoute: GisMcpRouteHandle;
    let legalRoute: LegalMcpRouteHandle;
    let gisEndpoint: string;
    let legalEndpoint: string;
    let gisContext: PublicDataMcpCallContext | undefined;
    let legalContext: LegalMcpCallContext | undefined;

    before(async () => {
        const app = express();
        gisRoute = createGisMcpRoute({
            dependencies: {
                now: () => NOW,
                execute(tool, input, context) {
                    gisContext = context;
                    return {
                        contractVersion: 'TonghariPublicGisResultV1',
                        tool,
                        status: 'SUCCESS',
                        provider: 'protocol-compat-test',
                        source: 'https://example.test/public-data',
                        asOf: new Date(NOW).toISOString(),
                        attribution: '공개 자료 출처',
                        query: input as Record<string, unknown>,
                        data: { pnu: '1130510100100010000' },
                        warnings: [],
                    };
                },
            },
            allowedHosts: ['127.0.0.1'],
            allowedOrigins: [],
            tokenSha256: sha256(GIS_TOKEN),
            proxyTokenSha256: sha256(GIS_PROXY_TOKEN),
            requestsPerMinute: 10,
            globalRequestsPerMinute: 10,
        });
        legalRoute = createLegalMcpRoute({
            dependencies: {
                now: () => NOW,
                research(_input, context) {
                    legalContext = context;
                    return {
                        contractVersion: 'LegalResearchPacketV1',
                        packetId: 'packet-protocol-compat',
                        status: 'complete',
                        scope: { asOfDate: '2026-09-05' },
                        provenance: {
                            generatedAt: new Date(NOW).toISOString(),
                        },
                    };
                },
                buildAnswer() {
                    throw new Error('render 도구는 이 계약 테스트에서 호출하지 않습니다.');
                },
                validatePacket(candidate) {
                    return {
                        ok: true,
                        valid: true,
                        value: candidate,
                        errors: [],
                        issues: [],
                    };
                },
                validateAnswer() {
                    throw new Error('render 도구는 이 계약 테스트에서 호출하지 않습니다.');
                },
                render() {
                    throw new Error('render 도구는 이 계약 테스트에서 호출하지 않습니다.');
                },
            },
            allowedHosts: ['127.0.0.1'],
            allowedOrigins: [],
            tokenSha256: sha256(LEGAL_TOKEN),
            proxyTokenSha256: sha256(LEGAL_PROXY_TOKEN),
            packetSigningKey: 'ab'.repeat(32),
            researchRequestsPerMinute: 10,
            globalResearchRequestsPerMinute: 10,
        });
        app.use('/gis-mcp', gisRoute.router);
        app.use('/mcp', legalRoute.router);
        server = createServer(app);
        await listen(server);
        const address = server.address() as AddressInfo;
        gisEndpoint = `http://127.0.0.1:${address.port}/gis-mcp`;
        legalEndpoint = `http://127.0.0.1:${address.port}/mcp`;
    });

    after(async () => {
        await Promise.all([gisRoute.close(), legalRoute.close()]);
        await closeServer(server);
    });

    it('GIS는 Codex 버전 lifecycle과 기존 5개와 전체 조회 도구 및 인증 principal을 유지한다', async () => {
        const options: LegacyRequestOptions = {
            endpoint: gisEndpoint,
            token: GIS_TOKEN,
            proxyHeader: 'x-tonghari-gis-mcp-proxy-token',
            proxyToken: GIS_PROXY_TOKEN,
        };
        const initialized = await legacyRequest('initialize', {
            protocolVersion: CODEX_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'codex-compat-test', version: '1.0.0' },
        }, options, 1);
        assert.equal(initialized.response.status, 200);
        assert.equal(
            initialized.body.result.protocolVersion,
            CODEX_PROTOCOL_VERSION
        );
        assert.ok(initialized.body.result.capabilities.tools);

        const ready = await legacyRequest('notifications/initialized', {}, {
            ...options,
            protocolVersion: CODEX_PROTOCOL_VERSION,
        });
        assert.equal(ready.response.status, 202);

        const listed = await legacyRequest('tools/list', {}, {
            ...options,
            protocolVersion: CODEX_PROTOCOL_VERSION,
        }, 2);
        assert.equal(listed.response.status, 200);
        assert.deepEqual(
            listed.body.result.tools.map((tool: { name: string }) => tool.name),
            [...PUBLIC_DATA_MCP_TOOL_NAMES]
        );

        const called = await legacyRequest('tools/call', {
            name: 'resolve_address_to_pnu_v1',
            arguments: { address: '서울특별시 강북구 미아동 1' },
        }, {
            ...options,
            protocolVersion: CODEX_PROTOCOL_VERSION,
        }, 3);
        assert.equal(called.response.status, 200);
        assert.equal(called.body.result.structuredContent.status, 'SUCCESS');
        assert.equal(gisContext?.principal.clientId, 'tonghari-gis-mcp');
        assert.deepEqual(gisContext?.principal.scopes, ['gis:read']);
    });

    for (const surface of ['initialize', 'tools/list', 'resources/list', 'resources/read', 'prompts/get'] as const) {
        it(`GIS ${surface} 실제 응답에는 소비자 대상 저장 금지 지시가 없다`, async () => {
            const params = surface === 'initialize' ? {
                protocolVersion: CODEX_PROTOCOL_VERSION, capabilities: {},
                clientInfo: { name: 'storage-contract-test', version: '1.0.0' },
            } : surface === 'resources/read' ? { uri: PUBLIC_DATA_MCP_POLICY_RESOURCE_URI }
                : surface === 'prompts/get' ? {
                    name: PUBLIC_DATA_MCP_REVIEW_PROMPT_NAME,
                    arguments: { question: '공개 GIS 자료를 검토해 주세요.' },
                } : {};
            const response = await legacyRequest(surface, params, {
                endpoint: gisEndpoint, token: GIS_TOKEN,
                proxyHeader: 'x-tonghari-gis-mcp-proxy-token', proxyToken: GIS_PROXY_TOKEN,
                protocolVersion: CODEX_PROTOCOL_VERSION,
            }, 40);
            assert.equal(response.response.status, 200);
            assert.ok(response.body.result);
            const result = response.body.result;
            if (surface === 'tools/list') {
                assert.deepEqual(result.tools.map((tool: { name: string }) => tool.name), [...PUBLIC_DATA_MCP_TOOL_NAMES]);
                for (const tool of result.tools) {
                    assert.equal(tool.annotations.readOnlyHint, true);
                    assert.equal(tool.annotations.destructiveHint, false);
                }
            } else if (surface === 'resources/list') {
                assert.equal(result.resources.length, 1);
                assert.equal(result.resources[0].uri, PUBLIC_DATA_MCP_POLICY_RESOURCE_URI);
                assert.match(result.resources[0].description, /출처/);
                assert.match(result.resources[0].description, /기준일/);
            } else {
                const text = surface === 'initialize' ? result.instructions
                    : surface === 'resources/read' ? result.contents[0].text
                        : result.messages[0].content.text;
                assert.match(text, /provider/);
                assert.match(text, /source/);
                assert.match(text, /asOf/);
                assert.match(text, /attribution/);
                assert.match(text, /기준연도/);
                assert.match(text, /lastUpdtDt/);
                assert.match(text, /PARTIAL/);
                assert.match(text, /감정평가/);
                assert.match(text, /등기/);
                if (surface === 'resources/read') assert.match(text, /별도 이용허락/);
            }
            assert.doesNotMatch(JSON.stringify(result),
                /VWORLD_RESULT_MUST_NOT_BE_STORED|VWorld[^\n]*저장하지|결과를 저장하지|면적·지분[^\n]*DB에 저장하지|출처, 비저장/);
        });
    }

    it('법률 MCP는 Codex 버전에서 정확한 2개 도구와 인증 principal을 유지한다', async () => {
        const options: LegacyRequestOptions = {
            endpoint: legalEndpoint,
            token: LEGAL_TOKEN,
            proxyHeader: 'x-tonghari-mcp-proxy-token',
            proxyToken: LEGAL_PROXY_TOKEN,
        };
        const initialized = await legacyRequest('initialize', {
            protocolVersion: CODEX_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'codex-compat-test', version: '1.0.0' },
        }, options, 10);
        assert.equal(initialized.response.status, 200);
        assert.equal(
            initialized.body.result.protocolVersion,
            CODEX_PROTOCOL_VERSION
        );
        assert.ok(initialized.body.result.capabilities.tools);

        assert.equal((await legacyRequest('notifications/initialized', {}, {
            ...options,
            protocolVersion: CODEX_PROTOCOL_VERSION,
        })).response.status, 202);

        const listed = await legacyRequest('tools/list', {}, {
            ...options,
            protocolVersion: CODEX_PROTOCOL_VERSION,
        }, 11);
        assert.equal(listed.response.status, 200);
        assert.deepEqual(
            listed.body.result.tools
                .map((tool: { name: string }) => tool.name)
                .sort(),
            [LEGAL_RENDER_TOOL_NAME, LEGAL_RESEARCH_TOOL_NAME].sort()
        );

        const called = await legacyRequest('tools/call', {
            name: LEGAL_RESEARCH_TOOL_NAME,
            arguments: {
                question: '재건축 조합설립 동의 요건은 무엇인가요?',
                jurisdiction: {
                    countryCode: 'KR',
                    organizationCode: '6110000',
                    organizationName: '서울특별시',
                },
                projectType: 'reconstruction',
                projectStage: 'association_establishment',
                facts: [{
                    factId: 'FACT-1',
                    text: '조합설립 동의서를 징구 중이다.',
                    provenance: 'USER_STATED',
                }],
                researchPlan: {
                    issues: [{
                        issueId: 'ISSUE-1',
                        issue: '조합설립 동의율 요건',
                        requestedOutcome: 'vote_threshold',
                    }],
                    lawAnchors: [{
                        issueIds: ['ISSUE-1'],
                        exactName: '도시 및 주거환경정비법',
                        lawType: '법률',
                        articleLabels: ['제35조'],
                        issueTerms: ['조합설립', '동의율'],
                    }],
                    ordinanceRequirement: 'not_required',
                    ordinanceAnchors: [],
                    caseQueries: [{
                        issueIds: ['ISSUE-1'],
                        lawNames: ['도시 및 주거환경정비법'],
                        articleLabels: ['제35조'],
                        issueTerms: ['조합설립', '동의율'],
                    }],
                },
            },
        }, {
            ...options,
            protocolVersion: CODEX_PROTOCOL_VERSION,
        }, 12);
        assert.equal(called.response.status, 200);
        assert.equal(called.body.result.isError, undefined);
        assert.equal(
            called.body.result.structuredContent.packet.packetId,
            'packet-protocol-compat'
        );
        assert.equal(
            typeof called.body.result.structuredContent.packetProof,
            'string'
        );
        assert.equal(legalContext?.principal.clientId, 'tonghari-legal-mcp');
        assert.deepEqual(legalContext?.principal.scopes, [
            LEGAL_MCP_REQUIRED_SCOPE,
        ]);
    });

    it('두 endpoint 모두 미지원 legacy revision을 협상에서 제외하고 후속 요청을 거부한다', async () => {
        const endpoints: Array<LegacyRequestOptions & { name: string }> = [
            {
                name: 'GIS',
                endpoint: gisEndpoint,
                token: GIS_TOKEN,
                proxyHeader: 'x-tonghari-gis-mcp-proxy-token',
                proxyToken: GIS_PROXY_TOKEN,
            },
            {
                name: '법률',
                endpoint: legalEndpoint,
                token: LEGAL_TOKEN,
                proxyHeader: 'x-tonghari-mcp-proxy-token',
                proxyToken: LEGAL_PROXY_TOKEN,
            },
        ];

        for (const [index, options] of endpoints.entries()) {
            const negotiated = await legacyRequest('initialize', {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: {
                    name: `unsupported-version-${options.name}`,
                    version: '1.0.0',
                },
            }, options, 20 + (index * 2));
            assert.equal(negotiated.response.status, 200);
            assert.equal(
                negotiated.body.result.protocolVersion,
                CODEX_PROTOCOL_VERSION
            );

            const rejected = await legacyRequest('tools/list', {}, {
                ...options,
                protocolVersion: '2025-03-26',
            }, 21 + (index * 2));
            assert.equal(rejected.response.status, 400);
            assert.match(
                rejected.body.error.message,
                /Unsupported protocol version/
            );
            assert.doesNotMatch(
                JSON.stringify(rejected.body),
                new RegExp(`${options.token}|${options.proxyToken}`)
            );
        }
    });

    it('허용 버전은 modern 정본과 Codex 호환 버전 두 개로 고정된다', () => {
        assert.deepEqual(TONGHARI_MCP_SUPPORTED_PROTOCOL_VERSIONS, [
            MODERN_PROTOCOL_VERSION,
            CODEX_PROTOCOL_VERSION,
        ]);
    });
});

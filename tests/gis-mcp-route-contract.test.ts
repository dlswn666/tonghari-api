import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import {
    createGisMcpRoute,
    type GisMcpAccessAuditEventV1,
    type GisMcpRouteHandle,
} from '../src/routes/gis-mcp';
import { PUBLIC_DATA_MCP_TOOL_NAMES } from '../src/services/public-data-mcp/policy';
import type { PublicDataMcpCallContext } from '../src/services/public-data-mcp/server';
import { createGisMcpTokenRegistryFileProviderV1 } from '../src/middleware/gis-mcp-token-registry-file';

const RAW_TOKEN = 'gis-mcp-route-contract-client-token';
const RAW_PROXY_TOKEN = 'gis-mcp-route-contract-proxy-token-32-bytes';
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

describe('GIS MCP Streamable HTTP 공개 계약', () => {
    let route: GisMcpRouteHandle;
    let server: Server;
    let endpoint: string;
    let calls = 0;
    let lastContext: PublicDataMcpCallContext | undefined;
    const auditEvents: GisMcpAccessAuditEventV1[] = [];

    before(async () => {
        const app = express();
        route = createGisMcpRoute({
            dependencies: {
                now: () => Date.parse('2026-09-03T00:00:00.000Z'),
                async execute(tool, input, context) {
                    calls += 1;
                    lastContext = context;
                    return {
                        contractVersion: 'TonghariPublicGisResultV1',
                        tool,
                        status: 'SUCCESS',
                        provider: 'contract-test',
                        source: 'https://example.test/public-data',
                        asOf: '2026-09-03T00:00:00.000Z',
                        attribution: '공개 자료 출처',
                        query: input as Record<string, unknown>,
                        data: { pnu: '1130510100100010000' },
                        warnings: [],
                    };
                },
            },
            allowedHosts: ['127.0.0.1'],
            allowedOrigins: [],
            tokenSha256: sha256(RAW_TOKEN),
            proxyTokenSha256: sha256(RAW_PROXY_TOKEN),
            requestsPerMinute: 1,
            onAccessAudit: (event) => auditEvents.push(event),
        });
        app.use('/gis-mcp', route.router);
        server = createServer(app);
        await listen(server);
        const address = server.address() as AddressInfo;
        endpoint = `http://127.0.0.1:${address.port}/gis-mcp`;
    });

    after(async () => {
        await route.close();
        await closeServer(server);
    });

    async function request(
        method: string,
        params: Record<string, unknown> = {},
        options: { endpoint?: string; token?: string } = {}
    ) {
        const headers: Record<string, string> = {
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${options.token ?? RAW_TOKEN}`,
            'content-type': 'application/json',
            'mcp-method': method,
            'mcp-protocol-version': '2026-07-28',
            'x-forwarded-proto': 'https',
            'x-tonghari-gis-mcp-proxy-token': RAW_PROXY_TOKEN,
        };
        if (typeof params.name === 'string') {
            headers['mcp-name'] = params.name;
        }
        const response = await fetch(options.endpoint ?? endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method,
                params: {
                    ...params,
                    _meta: {
                        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                        'io.modelcontextprotocol/clientInfo': {
                            name: 'tonghari-gis-contract-test',
                            version: '1.0.0',
                        },
                        'io.modelcontextprotocol/clientCapabilities': {},
                    },
                },
            }),
        });
        return {
            response,
            body: await response.json() as Record<string, any>,
        };
    }

    it('tools/list와 tools/call이 7개 read-only surface와 gis:read principal을 유지한다', async () => {
        const listed = await request('tools/list');
        assert.equal(listed.response.status, 200);
        assert.equal(listed.response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(
            listed.body.result.tools.map((tool: { name: string }) => tool.name),
            [...PUBLIC_DATA_MCP_TOOL_NAMES]
        );

        const called = await request('tools/call', {
            name: 'resolve_address_to_pnu_v1',
            arguments: { address: '서울특별시 강북구 미아동 1' },
        });
        assert.equal(called.response.status, 200);
        assert.equal(called.body.result.structuredContent.status, 'SUCCESS');
        assert.equal(calls, 1);
        assert.equal(lastContext?.principal.clientId, 'tonghari-gis-mcp');
        assert.deepEqual(lastContext?.principal.scopes, ['gis:read']);

        const rejected = await request('tools/call', {
            name: 'lookup_parcel_public_data_v1',
            arguments: { pnu: '1130510100100010000' },
        });
        assert.equal(rejected.response.status, 429);
        assert.deepEqual(
            auditEvents.map(({ clientId, method, tool, statusCode, outcome }) => ({
                clientId,
                method,
                tool,
                statusCode,
                outcome,
            })),
            [
                {
                    clientId: 'tonghari-gis-mcp',
                    method: 'tools/list',
                    tool: undefined,
                    statusCode: 200,
                    outcome: 'completed',
                },
                {
                    clientId: 'tonghari-gis-mcp',
                    method: 'tools/call',
                    tool: 'resolve_address_to_pnu_v1',
                    statusCode: 200,
                    outcome: 'completed',
                },
                {
                    clientId: 'tonghari-gis-mcp',
                    method: 'tools/call',
                    tool: 'lookup_parcel_public_data_v1',
                    statusCode: 429,
                    outcome: 'completed',
                },
            ]
        );

        await request(RAW_TOKEN);
        const unknownMethodAudit = auditEvents.at(-1);
        assert.equal(unknownMethodAudit?.method, 'unknown');
        assert.equal(unknownMethodAudit?.tool, undefined);

        await request('tools/call', {
            name: RAW_TOKEN,
            arguments: {},
        });
        const unknownToolAudit = auditEvents.at(-1);
        assert.equal(unknownToolAudit?.method, 'tools/call');
        assert.equal(unknownToolAudit?.tool, undefined);
        assert.equal(JSON.stringify(auditEvents).includes(RAW_TOKEN), false);
    });

    it('file provider route는 atomic 교체 직후 새 bearer를 허용하고 구 bearer를 폐기한다', async () => {
        const root = realpathSync(mkdtempSync(
            path.join(tmpdir(), 'gis-mcp-route-registry-')
        ));
        chmodSync(root, 0o700);
        const filePath = path.join(root, 'clients.json');
        const firstToken = 'gis-file-route-first-token';
        const secondToken = 'gis-file-route-second-token';
        const writeAtomic = (clientId: string, rawToken: string): void => {
            const temporaryPath = path.join(root, 'clients.next.json');
            writeFileSync(temporaryPath, JSON.stringify({
                version: 1,
                clients: [{ clientId, tokenSha256: sha256(rawToken) }],
            }), { encoding: 'utf8', mode: 0o600 });
            chmodSync(temporaryPath, 0o600);
            renameSync(temporaryPath, filePath);
        };

        let fileRoute: GisMcpRouteHandle | undefined;
        let fileServer: Server | undefined;
        try {
            writeAtomic('gis-file-route-first', firstToken);
            const app = express();
            fileRoute = createGisMcpRoute({
                dependencies: {
                    now: () => Date.parse('2026-09-03T00:00:00.000Z'),
                    async execute(tool, input) {
                        return {
                            contractVersion: 'TonghariPublicGisResultV1',
                            tool,
                            status: 'SUCCESS',
                            provider: 'contract-test',
                            source: 'https://example.test/public-data',
                            asOf: '2026-09-03T00:00:00.000Z',
                            attribution: '공개 자료 출처',
                            query: input as Record<string, unknown>,
                            data: {},
                            warnings: [],
                        };
                    },
                },
                allowedHosts: ['127.0.0.1'],
                allowedOrigins: [],
                tokenRegistryFileProvider:
                    createGisMcpTokenRegistryFileProviderV1(filePath),
                proxyTokenSha256: sha256(RAW_PROXY_TOKEN),
            });
            app.use('/gis-mcp', fileRoute.router);
            fileServer = createServer(app);
            await listen(fileServer);
            const address = fileServer.address() as AddressInfo;
            const fileEndpoint = `http://127.0.0.1:${address.port}/gis-mcp`;

            assert.equal((await request('tools/list', {}, {
                endpoint: fileEndpoint,
                token: firstToken,
            })).response.status, 200);

            writeAtomic('gis-file-route-second', secondToken);
            assert.equal((await request('tools/list', {}, {
                endpoint: fileEndpoint,
                token: secondToken,
            })).response.status, 200);
            assert.equal((await request('tools/list', {}, {
                endpoint: fileEndpoint,
                token: firstToken,
            })).response.status, 401);
        } finally {
            await fileRoute?.close();
            if (fileServer) await closeServer(fileServer);
            rmSync(root, { recursive: true, force: true });
        }
    });
});

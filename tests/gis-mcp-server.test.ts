import assert from 'node:assert/strict';
import test from 'node:test';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { PUBLIC_DATA_MCP_TOOL_NAMES } from '../src/services/public-data-mcp/policy';
import { createPublicDataMcpServer } from '../src/services/public-data-mcp/server';
import { FULL_GIS_SOURCE_IDS, emptyFullGisStep } from '../src/services/public-data-mcp/full-lookup-contract';

type RegisteredServer = {
    _registeredTools: Record<string, {
        annotations: Record<string, unknown>;
        handler(input: unknown, context: ServerContext): Promise<CallToolResult>;
    }>;
    _registeredPrompts: Record<string, unknown>;
    _registeredResources: Record<string, unknown>;
};

function context(): ServerContext {
    return {
        http: {
            authInfo: {
                token: 'not-returned', clientId: 'server-test', scopes: ['gis:read'],
                extra: { tokenId: 'a'.repeat(64) },
            },
        },
        mcpReq: { signal: new AbortController().signal },
    } as ServerContext;
}

test('서버는 기존 5개와 전체 조회·건물 윤곽 도구, prompt 1개, resource 1개를 등록한다', () => {
    const server = createPublicDataMcpServer({ async execute() { return {}; } });
    const registered = server as unknown as RegisteredServer;
    assert.deepEqual(Object.keys(registered._registeredTools), [...PUBLIC_DATA_MCP_TOOL_NAMES]);
    assert.equal(Object.keys(registered._registeredPrompts).length, 1);
    assert.equal(Object.keys(registered._registeredResources).length, 1);
    for (const tool of Object.values(registered._registeredTools)) {
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.equal(tool.annotations.destructiveHint, false);
    }
});

test('전체 조회 도구에도 14항목 계약과 비밀 비노출 검증이 적용된다', async () => {
    const data = {
        pnu: '1130510100107490004',
        steps: FULL_GIS_SOURCE_IDS.map((id) => emptyFullGisStep(id, { offset: 0, limit: 10 }, 'NO_DATA')),
        allSourcesQueried: true, allRecordsReturned: true, hasMore: false,
    };
    for (const [candidate, valid] of [
        [data, true],
        [{ ...data, steps: data.steps.slice(0, 13) }, false],
        [{ ...data, steps: [...data.steps].reverse() }, false],
        [{ ...data, hasMore: true }, false],
        [{ ...data, steps: data.steps.map((step, index) => index === 0
            ? { ...step, status: 'SKIPPED', code: 'ADDRESS_REQUIRED' } : step) }, false],
        [{ ...data, steps: data.steps.map((step, index) => index === 0
            ? { ...step, records: [{ ownerName: 'private-canary' }] } : step) }, false],
    ] as const) {
        const server = createPublicDataMcpServer({
            async execute(tool) {
                return {
                    contractVersion: 'TonghariPublicGisResultV1', tool,
                    status: 'NO_DATA', provider: 'VWorld', source: 'https://api.vworld.kr',
                    asOf: new Date().toISOString(), attribution: '출처', query: {}, data: candidate, warnings: [],
                };
            },
        }) as unknown as RegisteredServer;
        const result = await server._registeredTools.lookup_full_gis_public_data_v1.handler(
            { pnu: data.pnu, offset: 0, limit: 10 }, context()
        );
        assert.equal(result.isError === true, !valid);
        assert.equal(JSON.stringify(result).includes('private-canary'), false);
    }
});

test('128KB 초과와 금지 필드는 structured JSON 안전 오류로 fail-closed한다', async () => {
    for (const data of [
        { records: ['x'.repeat(140 * 1024)] },
        { apiKey: 'key-canary', ownerName: 'owner-canary', stack: 'stack-canary' },
    ]) {
        const server = createPublicDataMcpServer({
            async execute(tool) {
                return {
                    contractVersion: 'TonghariPublicGisResultV1', tool,
                    status: 'SUCCESS', provider: 'VWorld', source: 'https://api.vworld.kr',
                    asOf: '2026-09-03T00:00:00.000Z', attribution: '출처', query: {}, data,
                    warnings: [],
                };
            },
        }) as unknown as RegisteredServer;
        const result = await server._registeredTools.resolve_address_to_pnu_v1.handler(
            { address: '서울특별시 강북구 미아동 1' },
            context()
        );
        assert.equal(result.isError, true);
        assert.ok(result.structuredContent);
        const text = JSON.stringify(result);
        assert.equal(text.includes('canary'), false);
        assert.match(text, /OUTPUT_TOO_LARGE|PROVIDER_RESPONSE_INVALID/);
    }
});

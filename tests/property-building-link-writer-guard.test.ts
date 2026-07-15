import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
    scanSourceText,
    validateInventoryAgainstPolicy,
} from '../scripts/check-property-building-link-writers.mjs';

type ScannedInventory = ReturnType<typeof scanSourceText>;

function policyFor(inventory: ScannedInventory) {
    return {
        formatVersion: 1,
        propertyUnitWriters: inventory.propertyUnitMutations.map((writer) => ({
            ...writer,
            dongHoClassification: writer.dongHoFields.length > 0 ? 'PROPERTY_OWNED_INPUT' : 'NONE',
            owner: '테스트 소유자',
            rationale: '테스트 기준선',
        })),
        buildingWriters: inventory.buildingMutations.map((writer) => ({
            ...writer,
            owner: '테스트 소유자',
            rationale: '테스트 기준선',
        })),
        rpcCalls: inventory.rpcCalls.map((rpc) => ({
            ...rpc,
            owner: '테스트 소유자',
            rationale: '테스트 기준선',
        })),
    };
}

const BASELINE_WRITER = `
async function updateProperty(client: any) {
    const patch = { updated_at: '2026-07-15T00:00:00.000Z' };
    await client.from('property_units').update(patch).eq('id', 'property-1');
}
`;

test('Phase 0-S property-building 자동 writer allowlist는 0건이다', () => {
    const result = spawnSync(process.execPath, ['scripts/check-property-building-link-writers.mjs'], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /writer guard passed/);
});

test('property_units writer occurrence와 전체 source file hash를 함께 고정한다', () => {
    const baseline = scanSourceText(BASELINE_WRITER, 'src/test-writer.ts');
    assert.equal(baseline.propertyUnitMutations.length, 1);
    assert.doesNotThrow(() => validateInventoryAgainstPolicy(baseline, policyFor(baseline)));

    const changed = scanSourceText(
        BASELINE_WRITER.replace(
            "await client.from('property_units')",
            "const alias = patch;\n    alias.ho = '101';\n    await client.from('property_units')",
        ),
        'src/test-writer.ts',
    );
    assert.throws(
        () => validateInventoryAgainstPolicy(changed, policyFor(baseline)),
        /sourceFileSha256|fields가 inventory와 다릅니다/,
    );
});

test('payload alias의 computed key mutation은 정적 분석 escape로 차단한다', () => {
    const inventory = scanSourceText(`
async function updateProperty(client: any, field: string) {
    const patch = { updated_at: '2026-07-15T00:00:00.000Z' };
    const alias = patch as Record<string, unknown>;
    alias[field] = '101';
    await client.from('property_units').update(patch).eq('id', 'property-1');
}
`, 'src/computed-writer.ts');

    assert.throws(
        () => validateInventoryAgainstPolicy(inventory, policyFor(inventory)),
        /dynamic-assignment-key/,
    );
});

test('Reflect.set으로 building_unit_id를 쓰는 우회를 차단한다', () => {
    const inventory = scanSourceText(`
async function updateProperty(client: any) {
    const patch: Record<string, unknown> = { updated_at: '2026-07-15T00:00:00.000Z' };
    Reflect.set(patch, 'building_unit_id', 'building-unit-1');
    await client.from('property_units').update(patch).eq('id', 'property-1');
}
`, 'src/reflect-writer.ts');

    assert.deepEqual(inventory.propertyUnitMutations[0].linkFields, ['building_unit_id']);
    assert.throws(
        () => validateInventoryAgainstPolicy(inventory, policyFor(inventory)),
        /자동 link writer|link field write/,
    );
});

test('payload를 unknown helper에 전달하는 우회를 차단한다', () => {
    const inventory = scanSourceText(`
declare function addBuildingLink(payload: Record<string, unknown>): void;
async function updateProperty(client: any) {
    const patch: Record<string, unknown> = { updated_at: '2026-07-15T00:00:00.000Z' };
    addBuildingLink(patch);
    await client.from('property_units').update(patch).eq('id', 'property-1');
}
`, 'src/helper-writer.ts');

    assert.throws(
        () => validateInventoryAgainstPolicy(inventory, policyFor(inventory)),
        /helper-escape:addBuildingLink/,
    );
});

test('property_units query builder alias write를 mutation으로 수집하고 escape도 차단한다', () => {
    const inventory = scanSourceText(`
async function updateProperty(client: any) {
    const patch = { updated_at: '2026-07-15T00:00:00.000Z' };
    const propertyTable = client.from('property_units');
    await propertyTable.update(patch).eq('id', 'property-1');
}
`, 'src/builder-alias-writer.ts');

    assert.equal(inventory.propertyUnitMutations.length, 1);
    assert.throws(
        () => validateInventoryAgainstPolicy(inventory, policyFor(inventory)),
        /escaped-without-inline-operation/,
    );
});

test('computed update method은 수집하고 dynamic method는 fail-closed 처리한다', () => {
    const staticMethod = scanSourceText(`
async function updateProperty(client: any) {
    const patch = { updated_at: '2026-07-15T00:00:00.000Z' };
    await client.from('property_units')['update'](patch).eq('id', 'property-1');
}
`, 'src/static-computed-method.ts');
    assert.equal(staticMethod.propertyUnitMutations[0].operation, 'update');

    const dynamicMethod = scanSourceText(`
async function updateProperty(client: any, operation: string) {
    const patch = { updated_at: '2026-07-15T00:00:00.000Z' };
    await client.from('property_units')[operation](patch).eq('id', 'property-1');
}
`, 'src/dynamic-computed-method.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(dynamicMethod, policyFor(dynamicMethod)),
        /dynamic-property_units-query-builder-operation/,
    );
});

test('dynamic table write와 신규 RPC는 policy 없이 통과하지 못한다', () => {
    const dynamicTable = scanSourceText(`
async function writeUnknown(client: any, table: string) {
    await client.from(table).update({ updated_at: 'now' }).eq('id', 'property-1');
}
`, 'src/dynamic-table-writer.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(dynamicTable, policyFor(dynamicTable)),
        /동적 table writer|dynamic-table-write/,
    );

    const baseline = scanSourceText('export const safe = true;', 'src/new-rpc.ts');
    const addedRpc = scanSourceText(`
async function link(client: any) {
    await client.rpc('link_property_units_to_buildings', {});
}
`, 'src/new-rpc.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(addedRpc, policyFor(baseline)),
        /미승인 RPC call/,
    );
});

test('property_units 호출 밖의 building_unit_id helper write도 0건 경계를 위반한다', () => {
    const inventory = scanSourceText(`
export function addBuildingLink(patch: Record<string, unknown>) {
    patch.building_unit_id = 'building-unit-1';
}
`, 'src/link-helper.ts');

    assert.equal(inventory.globalLinkFieldWrites.length, 1);
    assert.throws(
        () => validateInventoryAgainstPolicy(inventory, policyFor(inventory)),
        /building link field write/,
    );
});

test('building-family 4개 테이블의 신규 writer는 전역 exact policy 없이 통과하지 못한다', () => {
    const baseline = scanSourceText('export const safe = true;', 'src/new-building-writer.ts');
    for (const table of [
        'buildings',
        'building_units',
        'building_land_lots',
        'building_external_refs',
    ]) {
        const inventory = scanSourceText(`
async function writeBuilding(client: any) {
    await client.from('${table}').update({ updated_at: 'now' }).eq('id', 'row-1');
}
`, 'src/new-building-writer.ts');
        assert.equal(inventory.buildingMutations.length, 1, table);
        assert.equal(inventory.buildingMutations[0].table, table);
        assert.throws(
            () => validateInventoryAgainstPolicy(inventory, policyFor(baseline)),
            /미승인 building-family writer/,
            table,
        );
    }
});

test('기존 building-family writer도 occurrence와 전체 source hash가 같아야 한다', () => {
    const baselineSource = `
async function writeBuilding(client: any) {
    await client.from('buildings').update({ updated_at: 'now' }).eq('id', 'building-1');
}
`;
    const baseline = scanSourceText(baselineSource, 'src/exact-building-writer.ts');
    assert.doesNotThrow(() => validateInventoryAgainstPolicy(baseline, policyFor(baseline)));

    const changed = scanSourceText(
        baselineSource.replace('async function', 'const unrelatedChange = true;\nasync function'),
        'src/exact-building-writer.ts',
    );
    assert.throws(
        () => validateInventoryAgainstPolicy(changed, policyFor(baseline)),
        /sourceFileSha256/,
    );
});

test('building query builder alias writer도 수집하며 inline operation 없는 escape는 실패한다', () => {
    const inventory = scanSourceText(`
async function writeBuilding(client: any) {
    const patch = { updated_at: 'now' };
    const buildingTable = client.from('buildings');
    await buildingTable.update(patch).eq('id', 'building-1');
}
`, 'src/building-builder-alias.ts');

    assert.equal(inventory.buildingMutations.length, 1);
    assert.throws(
        () => validateInventoryAgainstPolicy(inventory, policyFor(inventory)),
        /query-builder-escaped-without-inline-operation/,
    );
});

test('bind로 추출한 from/rpc alias는 inventory가 비어도 fail-closed한다', () => {
    const inventory = scanSourceText(`
async function writeWithBoundMethods(client: any) {
    const from = client.from.bind(client);
    const rpc = client.rpc.bind(client);
    await from('buildings').update({ updated_at: 'now' }).eq('id', 'building-1');
    await rpc('link_property_units_to_buildings', {});
}
`, 'src/bound-method-writer.ts');

    assert.equal(inventory.buildingMutations.length, 0);
    assert.equal(inventory.rpcCalls.length, 0);
    assert.throws(
        () => validateInventoryAgainstPolicy(inventory, policyFor(inventory)),
        /extracted-from-method-not-allowed|extracted-rpc-method-not-allowed/,
    );
});

test('구조분해·element access·dynamic bind 방식의 from/rpc 추출도 실패한다', () => {
    const destructured = scanSourceText(`
async function writeWithDestructuring(client: any) {
    const { from, rpc: invokeRpc } = client;
    await from('property_units').update({ dong: '101' });
    await invokeRpc('new_link_rpc', {});
}
`, 'src/destructured-method-writer.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(destructured, policyFor(destructured)),
        /destructured-from-reference-not-allowed|destructured-rpc-reference-not-allowed/,
    );

    const elementAndDynamic = scanSourceText(`
function extract(client: any, method: string) {
    const from = client['from'];
    const dynamic = client[method].bind(client);
    return { from, dynamic };
}
`, 'src/extracted-method-writer.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(elementAndDynamic, policyFor(elementAndDynamic)),
        /extracted-from-method-not-allowed|dynamic-bound-method-not-allowed/,
    );
});

test('assignment 및 computed binding 구조분해로 from/rpc를 추출하는 우회를 차단한다', () => {
    const assignment = scanSourceText(`
async function writeWithAssignmentDestructuring(client: any) {
    let from: any;
    let rpc: any;
    ({ from, rpc } = client);
    await from('buildings').update({ updated_at: 'now' });
    await rpc('new_link_rpc', {});
}
`, 'src/assignment-destructured-method.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(assignment, policyFor(assignment)),
        /assignment-destructured-from-reference-not-allowed|assignment-destructured-rpc-reference-not-allowed/,
    );

    const computed = scanSourceText(`
async function writeWithComputedBinding(client: any) {
    const { ['from']: from, ['rpc']: rpc } = client;
    await from('building_units').update({ updated_at: 'now' });
    await rpc('new_link_rpc', {});
}
`, 'src/computed-binding-method.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(computed, policyFor(computed)),
        /destructured-from-reference-not-allowed|destructured-rpc-reference-not-allowed/,
    );
});

test('dynamic direct method와 문자열 결합 from key로 building writer를 숨길 수 없다', () => {
    const dynamic = scanSourceText(`
async function writeWithDynamicMethod(client: any, method: string) {
    await client[method]('buildings').update({ updated_at: 'now' });
}
`, 'src/dynamic-direct-method.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(dynamic, policyFor(dynamic)),
        /dynamic-data-client-method-not-allowed/,
    );

    const concatenated = scanSourceText(`
async function writeWithConcatenatedMethod(client: any) {
    await client['fr' + 'om']('building_units').delete().eq('id', 'unit-1');
}
`, 'src/concatenated-direct-method.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(concatenated, policyFor(concatenated)),
        /dynamic-data-client-method-not-allowed/,
    );
});

test('Reflect.get으로 from/rpc를 얻어 call 또는 bind하는 우회를 차단한다', () => {
    const inventory = scanSourceText(`
async function writeWithReflectGet(client: any) {
    const from = Reflect.get(client, 'from').bind(client);
    await from('buildings').update({ updated_at: 'now' });
    await Reflect.get(client, 'rpc').call(client, 'new_link_rpc', {});
}
`, 'src/reflect-get-method.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(inventory, policyFor(inventory)),
        /reflect-get-from-method-not-allowed|reflect-get-rpc-method-not-allowed/,
    );
});

test('read chain 뒤 building builder alias의 dynamic operation도 fail-closed한다', () => {
    const inventory = scanSourceText(`
async function writeWithDynamicBuilderOperation(client: any, operation: string) {
    const buildingTable = client.from('buildings').select('*');
    await buildingTable[operation]({ updated_at: 'now' });
}
`, 'src/building-builder-dynamic-operation.ts');
    assert.throws(
        () => validateInventoryAgainstPolicy(inventory, policyFor(inventory)),
        /dynamic-builder-alias-operation-not-resolved/,
    );
});

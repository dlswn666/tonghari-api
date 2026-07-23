import assert from 'node:assert/strict';
import test from 'node:test';
import {
    computePropertyMembershipHash,
    normalizePropertyMembershipOrder,
} from '../src/services/land-area-sync/scope';

// 설계 SQL(resolve_land_area_sync_scope_v1)의 propertyMembership item 필드명은
// propertyUnitId / pnu / buildingUnitId 이며 pu.id::text 오름차순으로 반환된다.
// scope.ts 정렬 키(propertyUnitId, 동률 시 buildingUnitId)가 이 필드명과 일치해야 한다.
const A = { propertyUnitId: 'aaaa', pnu: '1', buildingUnitId: 'b1' };
const B = { propertyUnitId: 'bbbb', pnu: '2', buildingUnitId: 'b2' };
const C = { propertyUnitId: 'cccc', pnu: '3', buildingUnitId: null };

test('propertyMembership hash 는 DB row 순서에 무관하다(뒤섞어도 동일 hash)', () => {
    const h1 = computePropertyMembershipHash([A, B, C]);
    const h2 = computePropertyMembershipHash([C, A, B]);
    const h3 = computePropertyMembershipHash([B, C, A]);
    assert.equal(h1, h2);
    assert.equal(h1, h3);
    assert.match(h1, /^[0-9a-f]{64}$/);
});

test('동일 propertyUnitId 는 buildingUnitId 로 안정 정렬된다', () => {
    const x = { propertyUnitId: 'same', pnu: '1', buildingUnitId: 'b1' };
    const y = { propertyUnitId: 'same', pnu: '1', buildingUnitId: 'b2' };
    assert.equal(computePropertyMembershipHash([x, y]), computePropertyMembershipHash([y, x]));
    const ordered = normalizePropertyMembershipOrder([y, x]) as Array<{ buildingUnitId: string }>;
    assert.deepEqual(ordered.map((o) => o.buildingUnitId), ['b1', 'b2']);
});

test('propertyUnitId 가 달라지면 hash 가 달라진다', () => {
    const changed = { propertyUnitId: 'zzzz', pnu: '1', buildingUnitId: 'b1' };
    assert.notEqual(computePropertyMembershipHash([A, B, C]), computePropertyMembershipHash([changed, B, C]));
});

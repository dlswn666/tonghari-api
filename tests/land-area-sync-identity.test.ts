import assert from 'node:assert/strict';
import test from 'node:test';
import {
    dedupLdaregObservations,
    detectAmbiguousPropertyKeys,
    resolveClosedWithoutIdentity,
    LDAREG_IDENTITY_HASH_VERSION,
    type LdaregObservationInput,
} from '../src/services/land-area-sync/identity';

function obs(over: Partial<LdaregObservationInput> = {}): LdaregObservationInput {
    return {
        targetPnu: '1111011700100010000',
        agbldgSn: '',
        buildingName: '테스트빌라',
        dong: '101동',
        floor: '3층',
        ho: '302호',
        room: null,
        ldaQotaRate: '181.7/15622.1',
        ...over,
    };
}

// ── source identity: primary vs fallback (§12.2) ─────────────────────

test('agbldgSn이 PNU 내 유일하면 PRIMARY identity(targetPnu+agbldgSn)', () => {
    const r = dedupLdaregObservations([
        obs({ agbldgSn: '1', dong: '101동', ho: '101호' }),
        obs({ agbldgSn: '2', dong: '101동', ho: '102호' }),
    ]);
    assert.equal(r.records.length, 2);
    assert.equal(r.records.every((x) => x.identity.kind === 'PRIMARY'), true);
    assert.equal(r.issues.length, 0);
});

test('동일 obs 반복은 1건으로 축약(stable identity, CURRENT)', () => {
    const r = dedupLdaregObservations([obs({ agbldgSn: '1' }), obs({ agbldgSn: '1' })]);
    // agbldgSn 중복 → PNU 내 유일 아님 → FALLBACK, 같은 unit → 같은 identity → 1건 축약
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].state, 'CURRENT');
    assert.equal(r.issues.length, 0);
});

test('agbldgSn 없는 동일 unit은 FALLBACK identity로 안정적 축약(version 포함)', () => {
    const r = dedupLdaregObservations([obs({ agbldgSn: '' }), obs({ agbldgSn: '' })]);
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].identity.kind, 'FALLBACK');
    assert.equal(r.records[0].identity.version, LDAREG_IDENTITY_HASH_VERSION);
});

test('identity hash는 immutable 필드만 사용(비율·기준일·관측시각 변해도 identity 동일)', () => {
    const a = dedupLdaregObservations([obs({ agbldgSn: '', ldaQotaRate: '181.7/15622.1', dataBaseDate: '2026-01-01', observedAt: 'T1' })]);
    const b = dedupLdaregObservations([obs({ agbldgSn: '', ldaQotaRate: '181.7/15622.1', dataBaseDate: '2099-12-31', observedAt: 'T2' })]);
    assert.equal(a.records[0].identity.value, b.records[0].identity.value);
});

// ── conflicting duplicate (§12.2): 동일 identity·다른 payload → 전체 conflict ─

test('동일 identity·다른 payload(비율 상이) → 전체 conflict, 적용 대상 0 (last-write-wins 금지)', () => {
    const r = dedupLdaregObservations([
        obs({ agbldgSn: '', ldaQotaRate: '181.7/15622.1' }),
        obs({ agbldgSn: '', ldaQotaRate: '200.0/15622.1' }),
    ]);
    assert.equal(r.records.length, 0); // 나중 값 채택 금지
    assert.equal(r.excludedIdentities.length, 1);
    assert.equal(r.issues.some((i) => i.code === 'LDAREG_IDENTITY_CONFLICT'), true);
});

// ── fallback hash collision (§12.2): 주입 hashFn 스텁으로 강제 ─────────

test('fallback hash collision(서로 다른 unit이 같은 hash) → 해당 key 제외', () => {
    const r = dedupLdaregObservations(
        [
            obs({ agbldgSn: '', dong: '101동', ho: '101호' }),
            obs({ agbldgSn: '', dong: '999동', ho: '999호' }),
        ],
        { hashFn: () => 'COLLIDE' } // 서로 다른 immutable source를 같은 hash로 강제
    );
    assert.equal(r.records.length, 0);
    assert.equal(r.excludedIdentities.length, 1);
    assert.equal(r.issues.some((i) => i.code === 'LDAREG_IDENTITY_CONFLICT'), true);
});

// ── same (property×PNU) key 에 2+ CURRENT identity → key 제외 (§12.2) ──

test('같은 property_unit+targetPnu에 서로 다른 CURRENT identity 2개+ → 해당 key 전체 제외', () => {
    const r = dedupLdaregObservations([
        obs({ agbldgSn: '1', dong: '101동', ho: '101호', propertyUnitId: 'P-1' }),
        obs({ agbldgSn: '2', dong: '101동', ho: '102호', propertyUnitId: 'P-1' }),
    ]);
    assert.equal(r.records.length, 2);
    const amb = detectAmbiguousPropertyKeys(r.records);
    assert.equal(amb.excludedKeys.length, 1);
    assert.equal(amb.issues.some((i) => i.code === 'LDAREG_IDENTITY_CONFLICT'), true);
});

test('같은 property_unit+PNU에 CURRENT identity 1개는 제외 아님', () => {
    const r = dedupLdaregObservations([obs({ agbldgSn: '1', propertyUnitId: 'P-1' })]);
    const amb = detectAmbiguousPropertyKeys(r.records);
    assert.equal(amb.excludedKeys.length, 0);
});

// ── CLOSED 는 같은 source identity 에만 적용 (§12.2) ──────────────────

test('CLOSED는 동일 identity 레코드만 CLOSED로 전환', () => {
    const r = dedupLdaregObservations([
        obs({ agbldgSn: '1', dong: '101동', ho: '101호' }),
        obs({ agbldgSn: '1', dong: '101동', ho: '101호', sourceState: 'CLOSED' }),
    ]);
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].state, 'CLOSED');
});

test('다른 identity의 CLOSED는 CURRENT 레코드를 닫지 않음', () => {
    const r = dedupLdaregObservations([
        obs({ agbldgSn: '1', dong: '101동', ho: '101호' }),
        obs({ agbldgSn: '2', dong: '202동', ho: '202호', sourceState: 'CLOSED' }),
    ]);
    const current = r.records.find((x) => x.state === 'CURRENT');
    assert.ok(current);
    assert.equal(current!.state, 'CURRENT');
});

test('identity 없는 CLOSED: 기존 key가 정확히 1개 증명될 때만 CLOSE, 모호하면 ACTIVE 유지+issue', () => {
    const one = resolveClosedWithoutIdentity([{ propertyUnitId: 'P-1', targetPnu: 'PNU-1' }]);
    assert.equal(one.action, 'CLOSE_ONE');

    const none = resolveClosedWithoutIdentity([]);
    assert.equal(none.action, 'KEEP_ACTIVE');
    assert.equal(none.action === 'KEEP_ACTIVE' && none.issue, 'LDAREG_IDENTITY_CONFLICT');

    const many = resolveClosedWithoutIdentity([
        { propertyUnitId: 'P-1', targetPnu: 'PNU-1' },
        { propertyUnitId: 'P-2', targetPnu: 'PNU-1' },
    ]);
    assert.equal(many.action, 'KEEP_ACTIVE');
});

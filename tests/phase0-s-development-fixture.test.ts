import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const fixtureSql = readFileSync('scripts/phase0-s-development-fixture.sql', 'utf8');
const cleanupSql = readFileSync('scripts/phase0-s-development-fixture-cleanup.sql', 'utf8');

const UNION_A = '00000000-0000-4000-a000-000000000001';
const UNION_B = '00000000-0000-4000-a000-000000000002';
const PROPERTY_A = '00000000-0000-4000-a000-000000000101';
const PROPERTY_B = '00000000-0000-4000-a000-000000000102';
const SHARED_PNU = '1130510100107450062';

test('개발 fixture는 transaction과 합성 identity 충돌 guard를 가진다', () => {
    assert.match(fixtureSql, /^-- Phase 0-S[\s\S]*\nbegin;/);
    assert.match(fixtureSql, /\[PHASE0_S_SYNTHETIC_FIXTURE\]/);
    assert.match(fixtureSql, /기존 비-fixture 행과 충돌/);
    assert.match(fixtureSql, /property identity가 기존 비-fixture 행과 충돌/);
    assert.match(fixtureSql, /ownership identity가 기존 비-fixture 행과 충돌/);
    assert.match(fixtureSql, /building-land-lot identity가 기존 비-fixture 행과 충돌/);
    assert.match(fixtureSql, /commit;\s*$/);
    assert.doesNotMatch(fixtureSql, /supabase_migrations|schema_migrations/i);
});

test('서로 다른 A/B 조합과 물건지가 같은 활성 PNU를 공유한다', () => {
    for (const identity of [UNION_A, UNION_B, PROPERTY_A, PROPERTY_B]) {
        assert.ok(fixtureSql.includes(identity));
        assert.ok(cleanupSql.includes(identity));
    }
    assert.ok(fixtureSql.match(new RegExp(SHARED_PNU, 'g'))!.length >= 4);
    assert.match(fixtureSql, /count\(distinct union_id\)[\s\S]*shared_union_count/);
    assert.match(fixtureSql, /shared_union_count <> 2/);
});

test('최초 fixture는 property building link를 만들지 않고 전 컬럼 불변 검증을 준비한다', () => {
    const propertyInsert = fixtureSql.match(
        /insert into public\.property_units \([\s\S]*?\n\);/
    )?.[0];
    assert.ok(propertyInsert);
    assert.match(propertyInsert, /building_unit_id/);
    assert.ok(propertyInsert.match(/\n\s*null,/g)!.length >= 4);
    assert.match(fixtureSql, /linked_property_count <> 0/);
    assert.match(fixtureSql, /'VILLA'/);
    assert.doesNotMatch(fixtureSql, /'MULTI_FAMILY'/);
});

test('cleanup은 고정 fixture identity만 제거하고 전체 테이블 삭제를 하지 않는다', () => {
    assert.match(cleanupSql, /begin;/);
    assert.match(cleanupSql, /commit;\s*$/);
    assert.match(cleanupSql, /cleanup 대상에 비-fixture 행이 포함되어 중단/);
    assert.ok(cleanupSql.match(/\[PHASE0_S_SYNTHETIC_FIXTURE\]/g)!.length >= 5);
    assert.doesNotMatch(cleanupSql, /truncate|delete\s+from\s+public\.[a-z_]+\s*;/i);
    assert.doesNotMatch(cleanupSql, /supabase_migrations|schema_migrations/i);
});

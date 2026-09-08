import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseLandRightLookupRepository, LandRightLookupError } from '../src/services/land-right-lookup/transient';

const UNION_ID = '11111111-1111-4111-8111-111111111111';
const PNU = '1168010100107360024';
const row = (index: number) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    union_id: UNION_ID, pnu: PNU, is_deleted: false,
    building_unit_id: null, dong: '101동', ho: `${index}호`,
    land_area: null, land_area_source: 'LEGACY_UNKNOWN',
});
type Page = { data: unknown; count: number | null; error: { message: string } | null };

function fixture(total: number, mutate?: (page: Page, index: number) => Page, cap = 1000) {
    const records = Array.from({ length: total }, (_, index) => row(index + 1));
    const ranges: number[][] = [];
    const signals: AbortSignal[] = [];
    const client = {
        from(table: string) {
            assert.equal(table, 'property_units');
            let start = -1, end = -1;
            const query = {
                select(_fields: string, options: unknown) {
                    assert.deepEqual(options, { count: 'exact' }); return query;
                },
                eq(column: string, value: unknown) {
                    assert.equal(value, column === 'union_id' ? UNION_ID : false); return query;
                },
                in(column: string, values: unknown) {
                    assert.equal(column, 'pnu'); assert.deepEqual(values, [PNU]); return query;
                },
                order(column: string, options: unknown) {
                    assert.equal(column, 'id'); assert.deepEqual(options, { ascending: true }); return query;
                },
                range(from: number, to: number) { start = from; end = to; return query; },
                abortSignal(signal: AbortSignal) { signals.push(signal); return query; },
                then(resolve: (page: Page) => unknown, reject: (error: unknown) => unknown) {
                    ranges.push([start, end]);
                    const page: Page = { data: records.slice(start, Math.min(end + 1, start + cap)), count: total, error: null };
                    return Promise.resolve(mutate ? mutate(page, ranges.length - 1) : page).then(resolve, reject);
                },
            };
            return query;
        },
    };
    return {
        repository: createSupabaseLandRightLookupRepository(
            client as unknown as Parameters<typeof createSupabaseLandRightLookupRepository>[0]
        ),
        ranges, signals, records,
    };
}

test('단지 2,654건을 안정된 ID 순서와 전체 count로 빠짐없이 읽는다', async () => {
    const f = fixture(2654);
    const signal = new AbortController().signal;
    assert.deepEqual(await f.repository.findPropertyMembership(UNION_ID, [PNU], signal), f.records);
    assert.deepEqual(f.ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
    assert.deepEqual(f.signals, [signal, signal, signal]);
});

test('서버 페이지 cap이 더 작아도 실제 반환 건수에서 이어 읽는다', async () => {
    const f = fixture(1001, undefined, 400);
    assert.equal((await f.repository.findPropertyMembership(UNION_ID, [PNU])).length, 1001);
    assert.deepEqual(f.ranges, [[0, 999], [400, 1399], [800, 1799]]);
});

test('빈 PNU는 조회하지 않고 실제 0건은 빈 결과로 반환한다', async () => {
    const f = fixture(0);
    assert.deepEqual(await f.repository.findPropertyMembership(UNION_ID, []), []);
    assert.equal(f.ranges.length, 0);
    assert.deepEqual(await f.repository.findPropertyMembership(UNION_ID, [PNU]), []);
    assert.equal(f.ranges.length, 1);
});

const failures: [string, (page: Page, index: number) => Page][] = [
    ['count 누락', (page) => ({ ...page, count: null })],
    ['count 변경', (page, index) => ({ ...page, count: page.count! + index })],
    ['음수 count', (page) => ({ ...page, count: -1 })],
    ['비정수 count', (page) => ({ ...page, count: 1.5 })],
    ['상한 초과', (page) => ({ ...page, count: 50001 })],
    ['중간 빈 페이지', (page, index) => index ? { ...page, data: [] } : page],
    ['중복 ID', (page, index) => index ? { ...page, data: [row(1000), row(1001)] } : page],
    ['ID 역순', (page) => ({ ...page, data: [...page.data as unknown[]].reverse() })],
    ['잘못된 ID', (page) => ({ ...page, data: [{ ...row(1), id: 'invalid' }] })],
    ['DB 오류', (page) => ({ ...page, error: { message: 'private detail' } })],
    ['잘못된 응답', (page) => ({ ...page, data: null })],
    ['count보다 많은 행', (page) => ({ ...page, count: 1 })],
];
for (const [label, mutate] of failures) {
    test(`불완전 membership은 반환하지 않는다: ${label}`, async () => {
        const f = fixture(1002, mutate);
        await assert.rejects(f.repository.findPropertyMembership(UNION_ID, [PNU]), (error: unknown) =>
            error instanceof LandRightLookupError && error.code === 'PROPERTY_LOOKUP_FAILED' && !error.message.includes('private detail'));
    });
}

test('취소된 조회는 다음 DB 요청을 시작하지 않는다', async () => {
    const f = fixture(1002);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.repository.findPropertyMembership(UNION_ID, [PNU], controller.signal), LandRightLookupError);
    assert.equal(f.ranges.length, 0);
});

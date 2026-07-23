/**
 * LAND_AREA_SYNC read-model 후보 조회 — 오류/0건 구분 (DESIGN §2.2, I4).
 *
 * DB 조회 error 는 fatal 로 throw 하고(→ queue fatal catch → job FAILED), error 없는 진짜
 * 0건만 빈 배열로 반환한다. error 를 빈 결과로 삼키면 "조회 실패"가 "후보 0건"으로 오인돼
 * 잘못된 under-match(NO_CHANGE)로 silently 종결되는 것을 막는다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    readPropertyUnitCandidates,
    readBuildingUnitCandidates,
    readCurrentLandTuples,
} from '../src/services/land-area-sync/readers';

const UNION = '00000000-0000-4000-a000-0000000000aa';
const PNU = '1168010100107360024';
const PUID = '11111111-1111-4111-8111-111111111111';

/** table 별 `{data,error}` 를 돌려주는 thenable 빌더(readers 는 await 로 소비). */
function readerClient(byTable: Record<string, { data: unknown; error: unknown }>): SupabaseClient {
    return {
        from(table: string) {
            const result = byTable[table] ?? { data: [], error: null };
            const b: Record<string, unknown> = {};
            b.select = () => b;
            b.eq = () => b;
            b.in = () => b;
            b.then = (resolve: (v: unknown) => void) => resolve(result);
            return b;
        },
    } as unknown as SupabaseClient;
}

const READ_FAILED = /조회 실패/;

// ── readPropertyUnitCandidates ─────────────────────────────────────

test('readPropertyUnitCandidates: DB error 는 throw(빈 결과 삼키지 않음)', async () => {
    const client = readerClient({ property_units: { data: null, error: { message: 'boom' } } });
    await assert.rejects(() => readPropertyUnitCandidates(client, UNION, [PNU]), READ_FAILED);
});

test('readPropertyUnitCandidates: error 없는 진짜 0건은 빈 배열', async () => {
    const client = readerClient({ property_units: { data: [], error: null } });
    assert.deepEqual(await readPropertyUnitCandidates(client, UNION, [PNU]), []);
});

test('readPropertyUnitCandidates: scopePnus 빈 배열이면 조회 없이 빈 배열', async () => {
    const client = readerClient({ property_units: { data: null, error: { message: 'should-not-run' } } });
    assert.deepEqual(await readPropertyUnitCandidates(client, UNION, []), []);
});

// ── readBuildingUnitCandidates(2단 조회) ───────────────────────────

test('readBuildingUnitCandidates: building_land_lots error 는 throw', async () => {
    const client = readerClient({ building_land_lots: { data: null, error: { message: 'boom' } } });
    await assert.rejects(() => readBuildingUnitCandidates(client, UNION, [PNU]), READ_FAILED);
});

test('readBuildingUnitCandidates: building_units error 는 throw(링크 조회는 성공)', async () => {
    const client = readerClient({
        building_land_lots: { data: [{ building_id: 'b1' }], error: null },
        building_units: { data: null, error: { message: 'boom' } },
    });
    await assert.rejects(() => readBuildingUnitCandidates(client, UNION, [PNU]), READ_FAILED);
});

test('readBuildingUnitCandidates: 링크 0건은 error 없이 빈 배열(building_units 미조회)', async () => {
    const client = readerClient({ building_land_lots: { data: [], error: null } });
    assert.deepEqual(await readBuildingUnitCandidates(client, UNION, [PNU]), []);
});

// ── readCurrentLandTuples ──────────────────────────────────────────

test('readCurrentLandTuples: DB error 는 throw', async () => {
    const client = readerClient({ property_units: { data: null, error: { message: 'boom' } } });
    await assert.rejects(() => readCurrentLandTuples(client, UNION, [PUID]), READ_FAILED);
});

test('readCurrentLandTuples: error 없는 0건은 빈 배열', async () => {
    const client = readerClient({ property_units: { data: [], error: null } });
    assert.deepEqual(await readCurrentLandTuples(client, UNION, [PUID]), []);
});

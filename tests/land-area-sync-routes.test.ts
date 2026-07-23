import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

async function gisRoute(): Promise<string> {
    return readFile('src/routes/gis.ts', 'utf8');
}

test('4개 LAND_AREA_SYNC route 가 인증·SYSTEM_ADMIN 미들웨어와 함께 등록된다', async () => {
    const s = await gisRoute();
    assert.match(s, /router\.post\('\/land-area-sync',\s*authMiddleware,\s*gisSystemAdminMiddleware/);
    assert.match(s, /router\.post\('\/land-area-sync\/:discoveryJobId\/confirm',\s*authMiddleware,\s*gisSystemAdminMiddleware/);
    assert.match(s, /router\.get\('\/land-area-sync\/latest',\s*authMiddleware,\s*gisSystemAdminMiddleware/);
    assert.match(s, /router\.get\('\/land-area-sync\/:jobId',\s*authMiddleware,\s*gisSystemAdminMiddleware/);
    // latest 는 :jobId 보다 먼저 등록되어야 한다(literal 우선).
    assert.ok(s.indexOf("'/land-area-sync/latest'") < s.indexOf("'/land-area-sync/:jobId'"));
});

test('POST /land-area-sync 는 UUID unionId·19자리 PNU 를 exact 검증하고 durable INSERT 후 202', async () => {
    const s = await gisRoute();
    assert.match(s, /if \(!isUuid\(unionId\)\)/);
    assert.match(s, /if \(!isPnu\(anchorPnu\)\)/);
    assert.match(s, /addDiscoveryJob\(/);
    assert.match(s, /res\.status\(202\)/);
    // databaseTarget 은 JWT claim 만 사용.
    assert.match(s, /databaseTarget: req\.user!\.databaseTarget/);
    // admission 실패는 sendGisQueueError(503 매핑) 로 처리.
    assert.match(s, /sendGisQueueError\(res, error\)/);
});

test('confirm route 는 확인자·시각 body 금지 + scope hash·정렬 propertyUnitIds·확인 플래그를 exact 검증한다', async () => {
    const s = await gisRoute();
    assert.match(s, /'confirmedByUserId' in body \|\| 'confirmedAt' in body/);
    assert.match(s, /HEX64_RE\.test\(expectedScopeHash\)/);
    assert.match(s, /propertyUnitIds\.every\(isUuid\)/);
    assert.match(s, /new Set\(propertyUnitIds as string\[\]\)\.size !== propertyUnitIds\.length/);
    assert.match(s, /JSON\.stringify\(sorted\) !== JSON\.stringify\(propertyUnitIds\)/);
    assert.match(s, /parcelScopeConfirmed !== true/);
    // admission RPC 경유 + 새 apply job 재실행.
    assert.match(s, /createLandAreaSyncConfirmationJob\(/);
    assert.match(s, /admitApplyJob\(newJobId, unionId, req\.user!\.databaseTarget\)/);
    // 확인자는 서버 세션 actorUserId 만 전달.
    assert.match(s, /p_actor_user_id: req\.user!\.actorUserId!/);
});

test('GET route 는 query union scope 를 검증하고 id\\+union\\+type 스코프 read 를 쓴다', async () => {
    const s = await gisRoute();
    // query union scope(system 제외) 검증.
    assert.match(s, /req\.user!\.unionId !== 'system' && req\.user!\.unionId !== unionId/);
    // id+union+type 스코프 repository read.
    assert.match(s, /getScopedJob\(client, jobId, unionId\)/);
    assert.match(s, /getLatestScopedJob\(client, unionId, pnu\)/);
    // 구 id-only updateSyncJobStatus 를 새 경로에서 쓰지 않는다.
    assert.ok(!/land-area-sync[\s\S]*updateSyncJobStatus/.test(s));
});

test('gis-system-admin 미들웨어 job scope 에 LAND_AREA_SYNC 가 포함된다', async () => {
    const s = await readFile('src/middleware/gis-system-admin.ts', 'utf8');
    assert.match(s, /'LAND_AREA_SYNC'/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePath = new URL('../src/services/gis.queue.service.ts', import.meta.url);

test('root operation admission이 끝나기 전에는 GIS jobs map과 queue를 열지 않는다', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const producerStart = source.indexOf('async addSyncJob(request: GisSyncRequest)');
    const durableAdmission = source.indexOf(
        'await persistBuildingQueueAdmissionOrThrow({',
        producerStart
    );
    const memoryAdmission = source.indexOf('this.jobs.set(', durableAdmission);
    const queueAdmission = source.indexOf('this.queue', memoryAdmission);

    assert.ok(producerStart >= 0);
    assert.ok(durableAdmission > producerStart);
    assert.ok(memoryAdmission > durableAdmission);
    assert.ok(queueAdmission > memoryAdmission);
});

test('GIS worker는 PNU 해소 직후 mutation 전에 operation input provenance를 기록한다', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const pnuResolved = source.indexOf('const { pnu, x, y } = geocodeData;');
    const appendInput = source.indexOf('await appendBuildingOperationInputPnuOrThrow({');
    const firstObservation = source.indexOf('getParcelBoundaryFromCoordinates(x, y)');
    const firstLandMutation = source.indexOf('const landLotSaved = await database.upsertLandLot({');
    const firstBuildingMutation = source.indexOf('database.saveBuildingWithUnits(pnu, buildingInfo)');

    assert.ok(pnuResolved >= 0);
    assert.ok(appendInput > pnuResolved);
    assert.ok(firstObservation > appendInput);
    assert.ok(firstLandMutation > appendInput);
    assert.ok(firstBuildingMutation > appendInput);
});

test('GIS append 실패는 durable FAILED 저장 뒤 즉시 반환해 해당 PNU mutation을 막는다', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const failClosedStart = source.indexOf('} catch (inputError: any) {');
    const failedStatus = source.indexOf(
        'await persistBuildingOperationInputFailureOrThrow({',
        failClosedStart
    );
    const failClosedReturn = source.indexOf('                    return;', failedStatus);
    const firstLandMutation = source.indexOf('const landLotSaved = await database.upsertLandLot({');

    assert.ok(failClosedStart >= 0);
    assert.ok(failedStatus > failClosedStart);
    assert.ok(failClosedReturn > failedStatus);
    assert.ok(firstLandMutation > failClosedReturn);
    assert.match(source.slice(failedStatus, failClosedReturn), /'FAILED'/);
    assert.match(
        source,
        /err instanceof BuildingOperationInputFailureFinalizationError[\s\S]*?throw err/
    );
});

test('operation identity는 GIS와 두 가격 worker context에 전달되고 command 기록은 TODO로 남는다', async () => {
    const source = await readFile(sourcePath, 'utf8');

    assert.match(source, /processSyncJob\(jobId, request, operationIdentity\)/);
    assert.match(
        source,
        /processApartmentPriceSync\([\s\S]*?request\.databaseTarget,[\s\S]*?operationIdentity[\s\S]*?\)/
    );
    assert.match(
        source,
        /processIndividualHousingPriceSync\([\s\S]*?request\.databaseTarget,[\s\S]*?operationIdentity[\s\S]*?\)/
    );
    assert.match(source, /TODO\(A1b\/W3\): legacy boolean writer/);
    assert.doesNotMatch(source, /create_building_write_operation_command/);
    assert.doesNotMatch(source, /complete_building_write_operation_command/);
});

test('GIS preview는 필지 성공과 건물 관측 및 저장 결과를 분리한다', async () => {
    const source = await readFile(sourcePath, 'utf8');

    for (const counter of [
        'parcelSuccessCount',
        'buildingObservationCount',
        'buildingSaveSuccessCount',
        'buildingSaveFailedCount',
    ]) {
        assert.match(source, new RegExp(`\\b${counter}\\b`));
    }
});

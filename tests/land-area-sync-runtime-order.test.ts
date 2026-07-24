import assert from 'node:assert/strict';
import test from 'node:test';
import {
    decideLandAreaSyncRuntimeOrder,
    type LandAreaSyncRuntimeWatermark,
} from '../src/verification/land-area-sync-runtime-order';

test('disable tombstone은 실패 후에도 과거 enable을 stale로 유지한다', () => {
    const enable100 = decideLandAreaSyncRuntimeOrder(null, {
        runNumber: 100,
        runAttempt: 1,
        action: 'enable',
    });
    assert.equal(enable100.kind, 'APPLY');

    const disable200 = decideLandAreaSyncRuntimeOrder(
        enable100.nextWatermark,
        {
            runNumber: 200,
            runAttempt: 1,
            action: 'disable',
        }
    );
    assert.deepEqual(disable200, {
        kind: 'APPLY',
        nextWatermark: {
            runNumber: 200,
            runAttempt: 1,
            action: 'disable',
        },
    });

    // 실제 disable apply가 실패해도 requested watermark는 rollback하지 않는다.
    const persistedAfterFailedDisable = disable200.nextWatermark;
    const delayedEnable150 = decideLandAreaSyncRuntimeOrder(
        persistedAfterFailedDisable,
        {
            runNumber: 150,
            runAttempt: 1,
            action: 'enable',
        }
    );
    assert.deepEqual(delayedEnable150, {
        kind: 'STALE',
        nextWatermark: persistedAfterFailedDisable,
    });
});

test('같은 run_number의 run_attempt는 ordering을 바꾸지 않고 disable retry는 재실행한다', () => {
    const watermark: LandAreaSyncRuntimeWatermark = {
        runNumber: 200,
        runAttempt: 1,
        action: 'disable',
    };
    assert.deepEqual(
        decideLandAreaSyncRuntimeOrder(watermark, {
            runNumber: 200,
            runAttempt: 2,
            action: 'disable',
        }),
        {
            kind: 'APPLY',
            nextWatermark: {
                runNumber: 200,
                runAttempt: 2,
                action: 'disable',
            },
        }
    );
    assert.deepEqual(
        decideLandAreaSyncRuntimeOrder(watermark, {
            runNumber: 200,
            runAttempt: 2,
            action: 'enable',
        }),
        {
            kind: 'STALE',
            nextWatermark: watermark,
        }
    );
});

test('stale disable은 실행하되 watermark sequence를 되감지 않는다', () => {
    const current: LandAreaSyncRuntimeWatermark = {
        runNumber: 300,
        runAttempt: 2,
        action: 'enable',
    };
    assert.deepEqual(
        decideLandAreaSyncRuntimeOrder(current, {
            runNumber: 250,
            runAttempt: 1,
            action: 'disable',
        }),
        {
            kind: 'APPLY',
            nextWatermark: {
                runNumber: 300,
                runAttempt: 2,
                action: 'disable',
            },
        }
    );
});

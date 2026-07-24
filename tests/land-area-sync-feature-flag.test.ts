import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';
import { parseExactTrueFeatureFlag } from '../src/config/feature-flags';
import {
    LAND_AREA_SYNC_DISABLED_CODE,
    LAND_AREA_SYNC_DISABLED_MESSAGE,
    LandAreaSyncDisabledError,
    assertLandAreaSyncEnabled,
} from '../src/security/land-area-sync-execution-policy';
import {
    LandAreaSyncCanaryError,
    parseLandAreaSyncAllowedTargets,
} from '../src/security/land-area-sync-canary-policy';

Object.assign(process.env, {
    JWT_SECRET: 'test-production-jwt-secret',
    DEV_API_JWT_SECRET: 'test-development-jwt-secret',
    ALIGO_API_KEY: 'test-aligo-key',
    ALIGO_USER_ID: 'test-aligo-user',
    ALIGO_SENDER_PHONE: '0212345678',
    DEFAULT_SENDER_KEY: 'test-sender-key',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'test-production-service-role-key',
    DEV_SUPABASE_URL: 'http://127.0.0.1:54322',
    DEV_SUPABASE_SERVICE_ROLE_KEY: 'test-development-service-role-key',
    BUILDING_WRITE_OPERATION_TARGETS: 'development',
    LAND_AREA_SYNC_ENABLED: 'false',
});

const middlewareModule = import('../src/middleware/land-area-sync-enabled');
const queueModule = import('../src/services/land-area-sync/queue');

test('비활성화 메시지는 사용자 화면 용어인 대지권면적을 사용한다', () => {
    assert.equal(
        LAND_AREA_SYNC_DISABLED_MESSAGE,
        '대지권면적 동기화는 현재 비활성화되어 있습니다.'
    );
});

test('feature flag parser는 정확한 소문자 true만 활성화한다', () => {
    assert.equal(parseExactTrueFeatureFlag('true'), true);

    for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true ', 'false ']) {
        assert.equal(parseExactTrueFeatureFlag(value), false, `unexpected enabled value: ${String(value)}`);
    }
});

test('실행 정책은 OFF를 안정된 typed 오류로 거부한다', () => {
    assert.doesNotThrow(() => assertLandAreaSyncEnabled(true));
    assert.throws(
        () => assertLandAreaSyncEnabled(false),
        (error: unknown) => {
            assert.ok(error instanceof LandAreaSyncDisabledError);
            assert.equal(error.code, LAND_AREA_SYNC_DISABLED_CODE);
            assert.equal(error.message, LAND_AREA_SYNC_DISABLED_MESSAGE);
            return true;
        }
    );
});

test('HTTP gate는 OFF에서 503을 반환하고 handler로 진행하지 않는다', async () => {
    const { landAreaSyncEnabledMiddleware } = await middlewareModule;
    let status: number | null = null;
    let payload: unknown = null;
    let nextCalled = false;

    const response = {
        status(code: number) {
            status = code;
            return response;
        },
        json(body: unknown) {
            payload = body;
            return response;
        },
    } as unknown as Response;

    landAreaSyncEnabledMiddleware(
        {} as Request,
        response,
        (() => {
            nextCalled = true;
        }) as NextFunction
    );

    assert.equal(status, 503);
    assert.deepEqual(payload, {
        success: false,
        code: LAND_AREA_SYNC_DISABLED_CODE,
        error: LAND_AREA_SYNC_DISABLED_MESSAGE,
    });
    assert.equal(nextCalled, false);
});

test('HTTP gate는 exact true로 파싱된 ON 상태에서만 handler로 진행한다', async () => {
    const [{ env }, { landAreaSyncEnabledMiddleware }] = await Promise.all([
        import('../src/config/env'),
        middlewareModule,
    ]);
    let nextCalled = false;
    const response = {
        status() {
            throw new Error('ON 상태에서 차단 응답을 보내면 안 됩니다.');
        },
        json() {
            throw new Error('ON 상태에서 차단 응답을 보내면 안 됩니다.');
        },
    } as unknown as Response;

    env.LAND_AREA_SYNC_ENABLED = true;
    try {
        landAreaSyncEnabledMiddleware(
            {} as Request,
            response,
            (() => {
                nextCalled = true;
            }) as NextFunction
        );
    } finally {
        env.LAND_AREA_SYNC_ENABLED = false;
    }

    assert.equal(nextCalled, true);
});

test('health 응답은 배포 검증용 LAND_AREA_SYNC 상태를 노출한다', async () => {
    const source = await readFile('src/routes/health.ts', 'utf8');
    assert.match(source, /landAreaSyncEnabled:\s*enabled/);
    assert.match(source, /landAreaSyncAllowedTargetCount:/);
    assert.match(source, /landAreaSyncAllowedTargetsDigest:/);
    const occurrences = source.match(/\.\.\.landAreaSyncHealthFeatures\(\)/g) ?? [];
    assert.equal(occurrences.length, 2);
});

test('queue 이중 방어는 discovery INSERT와 apply admission 전에 OFF를 거부한다', async () => {
    const { LandAreaSyncQueueService } = await queueModule;
    const queue = new LandAreaSyncQueueService();

    await assert.rejects(
        queue.addDiscoveryJob({
            unionId: '00000000-0000-4000-a000-000000000001',
            anchorPnu: '1130510100107450001',
            actorUserId: 'system-admin',
            databaseTarget: 'production',
        }),
        LandAreaSyncDisabledError
    );

    assert.throws(
        () => queue.admitApplyJob(
            '00000000-0000-4000-b000-000000000001',
            '00000000-0000-4000-a000-000000000001',
            '1130510100107450001',
            'production'
        ),
        LandAreaSyncDisabledError
    );
});

test('queue 이중 방어는 ON이어도 databaseTarget+union+anchor 불일치를 DB 접근 전에 거부한다', async () => {
    const [{ env }, { LandAreaSyncQueueService }] = await Promise.all([
        import('../src/config/env'),
        queueModule,
    ]);
    const queue = new LandAreaSyncQueueService();
    const originalAllowed = env.LAND_AREA_SYNC_ALLOWED_TARGETS;
    env.LAND_AREA_SYNC_ENABLED = true;
    env.LAND_AREA_SYNC_ALLOWED_TARGETS = parseLandAreaSyncAllowedTargets(
        'development:00000000-0000-4000-a000-000000000001:1130510100107450001'
    );

    try {
        await assert.rejects(
            queue.addDiscoveryJob({
                unionId: '00000000-0000-4000-a000-000000000001',
                anchorPnu: '1130510100107450001',
                actorUserId: 'system-admin',
                databaseTarget: 'production',
            }),
            LandAreaSyncCanaryError
        );
        assert.throws(
            () =>
                queue.admitApplyJob(
                    '00000000-0000-4000-b000-000000000001',
                    '00000000-0000-4000-a000-000000000001',
                    '1130510100107450001',
                    'production'
                ),
            LandAreaSyncCanaryError
        );
    } finally {
        env.LAND_AREA_SYNC_ALLOWED_TARGETS = originalAllowed;
        env.LAND_AREA_SYNC_ENABLED = false;
    }
});

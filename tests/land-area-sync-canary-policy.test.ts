import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import {
    LAND_AREA_SYNC_CANARY_DENIED_CODE,
    LAND_AREA_SYNC_CANARY_NOT_CONFIGURED_CODE,
    LandAreaSyncCanaryError,
    assertLandAreaSyncCanaryAllowed,
    assertLandAreaSyncScopeAllowed,
    createLandAreaSyncAllowedTargetsManifest,
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
    LAND_AREA_SYNC_ALLOWED_TARGETS: '',
});

const UNION = '00000000-0000-4000-a000-000000000001';
const PNU_A = '1130510100107450001';
const PNU_B = '1130510100107450002';

test('allowlist parser는 target+union+PNU exact 다중 항목만 허용한다', () => {
    const allowed = parseLandAreaSyncAllowedTargets(
        `development:${UNION}:${PNU_A}, development:${UNION.toUpperCase()}:${PNU_B}`
    );

    assert.doesNotThrow(() =>
        assertLandAreaSyncCanaryAllowed(allowed, 'development', UNION, PNU_A)
    );
    assert.doesNotThrow(() =>
        assertLandAreaSyncCanaryAllowed(allowed, 'development', UNION, PNU_B)
    );
    assert.throws(
        () => assertLandAreaSyncCanaryAllowed(allowed, 'production', UNION, PNU_A),
        (error: unknown) =>
            error instanceof LandAreaSyncCanaryError &&
            error.code === LAND_AREA_SYNC_CANARY_DENIED_CODE &&
            error.status === 403
    );
});

test('canonical manifest는 소문자 UUID+정렬을 고정하고 count+SHA-256을 산출한다', () => {
    const manifest = createLandAreaSyncAllowedTargetsManifest(
        `development:${UNION.toUpperCase()}:${PNU_B},development:${UNION}:${PNU_A}`
    );
    assert.equal(
        manifest.canonicalValue,
        `development:${UNION}:${PNU_A},development:${UNION}:${PNU_B}`
    );
    assert.equal(manifest.count, 2);
    assert.equal(
        manifest.digest,
        '9a538987c9a27f53bf2ac42c38f70715c69364b3c9d26e65605cdf5081e952e3'
    );
    assert.deepEqual(createLandAreaSyncAllowedTargetsManifest(''), {
        allowedTargets: new Set(),
        canonicalValue: '',
        count: 0,
        digest: '',
    });
});

test('allowlist parser는 wildcard·잘못된 target/PNU·중복을 시작 시점에 거부한다', () => {
    for (const value of [
        `*:${UNION}:${PNU_A}`,
        `development:*:${PNU_A}`,
        `development:${UNION}:*`,
        `development:${UNION}:123`,
        `staging:${UNION}:${PNU_A}`,
        `development:${UNION}:${PNU_A},development:${UNION}:${PNU_A}`,
    ]) {
        assert.throws(() => parseLandAreaSyncAllowedTargets(value));
    }
});

test('미설정 allowlist는 fail closed 503이다', () => {
    assert.throws(
        () =>
            assertLandAreaSyncCanaryAllowed(
                parseLandAreaSyncAllowedTargets(''),
                'development',
                UNION,
                PNU_A
            ),
        (error: unknown) =>
            error instanceof LandAreaSyncCanaryError &&
            error.code === LAND_AREA_SYNC_CANARY_NOT_CONFIGURED_CODE &&
            error.status === 503
    );
});

test('resolved scope는 scannedPnus 전부가 같은 target+union으로 허용돼야 한다', () => {
    const onlyAnchor = parseLandAreaSyncAllowedTargets(
        `development:${UNION}:${PNU_A}`
    );
    assert.throws(
        () =>
            assertLandAreaSyncScopeAllowed(
                onlyAnchor,
                'development',
                UNION,
                [PNU_A, PNU_B]
            ),
        (error: unknown) =>
            error instanceof LandAreaSyncCanaryError &&
            error.code === LAND_AREA_SYNC_CANARY_DENIED_CODE
    );

    const fullScope = parseLandAreaSyncAllowedTargets(
        `development:${UNION}:${PNU_A},development:${UNION}:${PNU_B}`
    );
    assert.doesNotThrow(() =>
        assertLandAreaSyncScopeAllowed(
            fullScope,
            'development',
            UNION,
            [PNU_B, PNU_A, PNU_A]
        )
    );
});

test('discovery HTTP gate는 JWT databaseTarget을 포함한 exact pair만 통과시킨다', async () => {
    const [{ env }, { landAreaSyncDiscoveryCanaryMiddleware }] =
        await Promise.all([
            import('../src/config/env'),
            import('../src/middleware/land-area-sync-enabled'),
        ]);
    const original = env.LAND_AREA_SYNC_ALLOWED_TARGETS;
    env.LAND_AREA_SYNC_ALLOWED_TARGETS = parseLandAreaSyncAllowedTargets(
        `development:${UNION}:${PNU_A}`
    );

    const run = (databaseTarget: 'development' | 'production') => {
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
        landAreaSyncDiscoveryCanaryMiddleware(
            {
                user: { databaseTarget },
                body: { unionId: UNION, anchorPnu: PNU_A },
            } as Request,
            response,
            (() => {
                nextCalled = true;
            }) as NextFunction
        );
        return { status, payload, nextCalled };
    };

    try {
        assert.deepEqual(run('development'), {
            status: null,
            payload: null,
            nextCalled: true,
        });
        const production = run('production');
        assert.equal(production.status, 403);
        assert.equal(
            (production.payload as { code: string }).code,
            LAND_AREA_SYNC_CANARY_DENIED_CODE
        );
        assert.equal(production.nextCalled, false);
    } finally {
        env.LAND_AREA_SYNC_ALLOWED_TARGETS = original;
    }
});

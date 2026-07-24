import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

const PRODUCTION_SECRET = 'test-production-jwt-secret';
const DEVELOPMENT_SECRET = 'test-development-jwt-secret';

Object.assign(process.env, {
    JWT_SECRET: PRODUCTION_SECRET,
    DEV_API_JWT_SECRET: DEVELOPMENT_SECRET,
    ALIGO_API_KEY: 'test-aligo-key',
    ALIGO_USER_ID: 'test-aligo-user',
    ALIGO_SENDER_PHONE: '0212345678',
    DEFAULT_SENDER_KEY: 'test-sender-key',
    SUPABASE_URL: 'https://production-ref.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-production-service-role-key',
    DEV_SUPABASE_URL: 'https://development-ref.supabase.co',
    DEV_SUPABASE_SERVICE_ROLE_KEY: 'test-development-service-role-key',
});

type DatabaseTarget = 'production' | 'development';

function signToken(input: {
    secret: string;
    kid?: 'prod' | 'dev';
    databaseTarget?: DatabaseTarget;
    issuer?: string;
    audience?: string;
    purpose?: 'GIS_SYSTEM_ADMIN' | 'MEMBER_QUEUE';
    scope?: 'GIS_ADDRESS_READ';
}) {
    const payload = {
        unionId: 'union-a',
        userId: 'auth-user-a',
        ...(input.databaseTarget ? { databaseTarget: input.databaseTarget } : {}),
        ...(input.issuer ? { iss: input.issuer } : {}),
        ...(input.audience ? { aud: input.audience } : {}),
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
    };

    return jwt.sign(payload, input.secret, {
        algorithm: 'HS256',
        expiresIn: '5m',
        ...(input.kid ? { keyid: input.kid } : {}),
    });
}

test('JWT kid와 실제 서명키가 target을 확정하고 claim/issuer/audience 불일치를 거부한다', async () => {
    const { AuthService } = await import('../src/services/auth.service');
    const auth = new AuthService({
        production: PRODUCTION_SECRET,
        development: DEVELOPMENT_SECRET,
    });

    const development = auth.verifyToken(signToken({
        secret: DEVELOPMENT_SECRET,
        kid: 'dev',
        databaseTarget: 'development',
        issuer: 'tonghari-web-dev',
        audience: 'tonghari-api',
        purpose: 'GIS_SYSTEM_ADMIN',
    }));
    assert.equal(development.valid, true);
    assert.equal(development.databaseTarget, 'development');
    assert.equal(development.legacyProductionToken, false);

    const production = auth.verifyToken(signToken({
        secret: PRODUCTION_SECRET,
        kid: 'prod',
        databaseTarget: 'production',
        issuer: 'tonghari-web',
        audience: 'tonghari-api',
        purpose: 'GIS_SYSTEM_ADMIN',
    }));
    assert.equal(production.valid, true);
    assert.equal(production.databaseTarget, 'production');
    assert.equal(production.legacyProductionToken, false);

    for (const token of [
        signToken({
            secret: DEVELOPMENT_SECRET,
            kid: 'dev',
            databaseTarget: 'production',
            issuer: 'tonghari-web',
            audience: 'tonghari-api',
        }),
        signToken({
            secret: PRODUCTION_SECRET,
            kid: 'prod',
            databaseTarget: 'development',
            issuer: 'tonghari-web-dev',
            audience: 'tonghari-api',
        }),
        signToken({
            secret: DEVELOPMENT_SECRET,
            kid: 'dev',
            databaseTarget: 'development',
            issuer: 'tonghari-web',
            audience: 'tonghari-api',
        }),
        signToken({
            secret: DEVELOPMENT_SECRET,
            kid: 'dev',
            databaseTarget: 'development',
            issuer: 'tonghari-web-dev',
            audience: 'another-api',
        }),
        signToken({
            secret: PRODUCTION_SECRET,
            kid: 'dev',
            databaseTarget: 'development',
            issuer: 'tonghari-web-dev',
            audience: 'tonghari-api',
        }),
    ]) {
        assert.equal(auth.verifyToken(token).valid, false);
    }
});

test('kid 없는 레거시 토큰은 운영 키로만 검증하고 production에만 고정한다', async () => {
    const { AuthService } = await import('../src/services/auth.service');
    const auth = new AuthService({
        production: PRODUCTION_SECRET,
        development: DEVELOPMENT_SECRET,
    });

    const legacyProduction = auth.verifyToken(signToken({ secret: PRODUCTION_SECRET }));
    assert.equal(legacyProduction.valid, true);
    assert.equal(legacyProduction.databaseTarget, 'production');
    assert.equal(legacyProduction.legacyProductionToken, true);

    assert.equal(auth.verifyToken(signToken({ secret: DEVELOPMENT_SECRET })).valid, false);
    assert.equal(auth.verifyToken(signToken({
        secret: PRODUCTION_SECRET,
        databaseTarget: 'production',
        issuer: 'tonghari-web',
        audience: 'tonghari-api',
    })).valid, false);
});

test('운영·개발 secret 또는 Supabase URL이 같거나 개발 설정이 일부면 시작을 거부한다', async () => {
    const { AuthService } = await import('../src/services/auth.service');
    assert.throws(
        () => new AuthService({ production: 'same-secret', development: 'same-secret' }),
        /달라야 합니다/
    );

    const { validateDevelopmentApiEnvironment } = await import('../src/config/env');
    assert.throws(() => validateDevelopmentApiEnvironment({
        productionJwtSecret: 'prod-secret',
        productionSupabaseUrl: 'https://prod.supabase.co',
        developmentJwtSecret: 'dev-secret',
        developmentSupabaseUrl: '',
        developmentSupabaseServiceRoleKey: '',
    }), /모두 설정/);
    assert.throws(() => validateDevelopmentApiEnvironment({
        productionJwtSecret: 'prod-secret',
        productionSupabaseUrl: 'https://same.supabase.co',
        developmentJwtSecret: 'dev-secret',
        developmentSupabaseUrl: 'https://same.supabase.co/',
        developmentSupabaseServiceRoleKey: 'dev-key',
    }), /달라야 합니다/);
});

test('production/development target은 서로 다른 Supabase service 인스턴스를 반환한다', async () => {
    const { getSupabaseService } = await import('../src/services/supabase.service');
    const production = getSupabaseService('production');
    const development = getSupabaseService('development');

    assert.notEqual(production, development);
    assert.notEqual(production.getClient(), development.getClient());
});

function createResponse() {
    const state: { status: number; body?: unknown } = { status: 200 };
    const response = {
        status(value: number) {
            state.status = value;
            return response;
        },
        json(value: unknown) {
            state.body = value;
            return response;
        },
    };
    return { response: response as unknown as Response, state };
}

test('dev 토큰은 target-aware allowlist에서만 허용되고 Origin은 DB 선택에 관여하지 않는다', async () => {
    const { authMiddleware, databaseTargetAuthMiddleware } = await import('../src/middleware/auth');
    const token = signToken({
        secret: DEVELOPMENT_SECRET,
        kid: 'dev',
        databaseTarget: 'development',
        issuer: 'tonghari-web-dev',
        audience: 'tonghari-api',
        purpose: 'GIS_SYSTEM_ADMIN',
    });
    const request = {
        headers: {
            authorization: `Bearer ${token}`,
            origin: 'https://johapon.kr',
        },
    } as Request;

    const blockedResponse = createResponse();
    authMiddleware(request, blockedResponse.response, (() => undefined) as NextFunction);
    assert.equal(blockedResponse.state.status, 403);
    assert.deepEqual(blockedResponse.state.body, {
        success: false,
        error: 'Development token is not allowed for this endpoint.',
        code: 'DEVELOPMENT_TARGET_NOT_SUPPORTED',
    });

    const allowedResponse = createResponse();
    let nextCalled = false;
    databaseTargetAuthMiddleware(
        request,
        allowedResponse.response,
        (() => { nextCalled = true; }) as NextFunction
    );
    assert.equal(nextCalled, true);
    assert.equal(request.user?.databaseTarget, 'development');
});

test('새 GIS 토큰은 production/development 모두 mutation purpose와 read scope를 exact하게 요구한다', async () => {
    const { gisSystemAdminMiddleware } = await import('../src/middleware/gis-system-admin');
    const { gisAddressReadRateLimitMiddleware } = await import('../src/middleware/gis-address-rate-limit');

    for (const databaseTarget of ['production', 'development'] as const) {
        const mutationResponse = createResponse();
        await gisSystemAdminMiddleware({
            body: { unionId: 'union-a' },
            params: {},
            user: {
                unionId: 'union-a',
                userId: 'auth-user-a',
                databaseTarget,
                legacyProductionToken: false,
                purpose: 'MEMBER_QUEUE',
            },
        } as Request, mutationResponse.response, (() => undefined) as NextFunction);
        assert.equal(mutationResponse.state.status, 403);
        assert.deepEqual(mutationResponse.state.body, {
            success: false,
            code: 'TOKEN_PURPOSE_INVALID',
            error: 'GIS 변경 전용 토큰이 필요합니다.',
        });

        const readResponse = createResponse();
        gisAddressReadRateLimitMiddleware({
            user: {
                unionId: 'union-a',
                userId: 'auth-user-a',
                databaseTarget,
                legacyProductionToken: false,
            },
        } as Request, readResponse.response, (() => undefined) as NextFunction);
        assert.equal(readResponse.state.status, 403);
        assert.deepEqual(readResponse.state.body, {
            success: false,
            code: 'TOKEN_SCOPE_INVALID',
            error: 'GIS 주소 조회 전용 토큰이 필요합니다.',
        });
    }
});

test('GIS/member/consent admission과 background worker는 bare 운영 singleton 없이 request target을 전파한다', async () => {
    const gisQueue = await readFile('src/services/gis.queue.service.ts', 'utf8');
    const memberQueue = await readFile('src/services/member.queue.service.ts', 'utf8');
    const consentQueue = await readFile('src/services/consent.queue.service.ts', 'utf8');
    const gisRoute = await readFile('src/routes/gis.ts', 'utf8');
    const memberRoute = await readFile('src/routes/member.ts', 'utf8');
    const consentRoute = await readFile('src/routes/consent.ts', 'utf8');
    const consentAdmin = await readFile('src/middleware/consent-admin.ts', 'utf8');

    for (const [file, source] of [
        ['gis.queue.service.ts', gisQueue],
        ['member.queue.service.ts', memberQueue],
        ['consent.queue.service.ts', consentQueue],
    ] as const) {
        assert.doesNotMatch(source, /\bsupabaseService\b/, `${file}: production singleton remains`);
        assert.match(source, /getSupabaseService\(/, `${file}: target-aware database selection missing`);
        assert.match(source, /request\.databaseTarget/, `${file}: queued request target missing`);
    }
    assert.match(gisQueue, /jobKey\(databaseTarget, jobId\)/);
    assert.match(memberQueue, /jobKey\(databaseTarget, jobId\)/);
    assert.match(consentQueue, /jobKey\(databaseTarget, jobId\)/);
    assert.match(gisRoute, /databaseTarget: req\.user!\.databaseTarget/);
    assert.match(memberRoute, /databaseTarget: req\.user!\.databaseTarget/);
    assert.match(consentRoute, /databaseTarget: req\.user!\.databaseTarget/);
    assert.match(consentRoute, /actorUserId: req\.user!\.actorUserId!/);
    assert.match(consentRoute, /databaseTargetAuthMiddleware as authMiddleware/);
    assert.doesNotMatch(consentAdmin, /\bsupabaseService\b/);
    assert.match(consentAdmin, /getSupabaseService\(req\.user\.databaseTarget\)/);
    assert.match(consentQueue, /assertAuthorizedAtExecution\(request\)/);
    assert.match(consentQueue, /\.eq\('status', 'PROCESSING'\)/);
    assert.match(consentQueue, /'memberIds' in request/);
});

test('consent만 target-aware allowlist에 추가하고 외부 운영 부작용 route는 기본 인증 차단을 유지한다', async () => {
    const consentRoute = await readFile('src/routes/consent.ts', 'utf8');
    const alimtalkRoute = await readFile('src/routes/alimtalk.ts', 'utf8');
    const smsRoute = await readFile('src/routes/sms.ts', 'utf8');

    assert.match(consentRoute, /databaseTargetAuthMiddleware as authMiddleware/);
    assert.match(alimtalkRoute, /import \{ authMiddleware \} from '\.\.\/middleware'/);
    assert.match(smsRoute, /import \{ authMiddleware \} from '\.\.\/middleware'/);
    assert.doesNotMatch(alimtalkRoute, /databaseTargetAuthMiddleware/);
    assert.doesNotMatch(smsRoute, /databaseTargetAuthMiddleware/);
});

test('배포 workflow는 GHCR digest와 EC2 env 단일 원본으로 안전하게 배포한다', async () => {
    const [workflow, packageJson, legacyBuildScript, legacyDeployScript, envExample] = await Promise.all([
        readFile('.github/workflows/docker-build.yml', 'utf8'),
        readFile('package.json', 'utf8'),
        readFile('scripts/build-and-push.sh', 'utf8'),
        readFile('scripts/deploy-to-ec2.sh', 'utf8'),
        readFile('.env.example', 'utf8'),
    ]);
    assert.match(workflow, /build-and-push:[\s\S]*permissions:\s+contents: read\s+packages: write/);
    assert.match(workflow, /deploy:[\s\S]*permissions:\s+contents: read\s+packages: read/);
    assert.doesNotMatch(workflow, /DOCKER_(?:USERNAME|PASSWORD)/);
    assert.match(workflow, /registry: ghcr\.io\s+username: \$\{\{ github\.actor \}\}\s+password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.ok(workflow.includes('IMAGE_REPOSITORY: ghcr.io/dlswn666/alimtalk-proxy'));
    assert.ok(workflow.includes('tags: ${{ env.IMAGE_REPOSITORY }}:${{ github.sha }}'));
    assert.ok(workflow.includes('IMAGE="${IMAGE_REPOSITORY}@${EXPECTED_DIGEST}"'));
    assert.match(workflow, /GHCR_USERNAME: \$\{\{ github\.actor \}\}/);
    assert.match(workflow, /GHCR_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.match(workflow, /printf '%s' "\$\{GHCR_TOKEN\}"[\s\\]+\| docker login ghcr\.io --username "\$\{GHCR_USERNAME\}" --password-stdin/);
    assert.match(workflow, /docker pull "\$\{IMAGE\}"\s+logout_registry/);
    assert.match(workflow, /needs: quality-gates/);
    assert.match(workflow, /needs: \[preflight, build-and-push\]/);
    for (const name of [
        'DEV_API_JWT_SECRET',
        'DEV_SUPABASE_URL',
        'DEV_SUPABASE_SERVICE_ROLE_KEY',
    ]) {
        assert.ok(workflow.includes(name));
        assert.ok(!workflow.includes(`${name}: \${{ secrets.${name} }}`));
        assert.ok(!workflow.includes(`-e ${name}`));
    }
    assert.match(workflow, /envs: GHCR_USERNAME,GHCR_TOKEN/);
    assert.match(workflow, /--env-file \.env/);
    assert.match(workflow, /env_mode="\$\(stat -c '%a' \.env\)"/);
    assert.match(workflow, /"\$\{env_mode\}" != "600"/);
    assert.match(workflow, /definition_count="\$\(grep -c "\^\$\{variable_name\}=" \.env \|\| true\)"/);
    assert.match(
        workflow,
        /operation_target_count="\$\(grep -c '\^BUILDING_WRITE_OPERATION_TARGETS=' \.env \|\| true\)"/
    );
    assert.match(workflow, /"\$\{operation_target_count\}" != "1"/);
    assert.match(workflow, /grep -qx 'BUILDING_WRITE_OPERATION_TARGETS=development' \.env/);
    assert.ok(workflow.includes(
        "land_area_sync_flag_count=\"$(grep -Ec '^[[:space:]]*LAND_AREA_SYNC_ENABLED[[:space:]]*=' .env || true)\""
    ));
    assert.match(workflow, /"\$\{land_area_sync_flag_count\}" -gt 1/);
    assert.match(workflow, /"\$\{land_area_sync_flag_count\}" -eq 1/);
    assert.match(workflow, /grep -qx 'LAND_AREA_SYNC_ENABLED=true' \.env/);
    assert.match(workflow, /grep -qx 'LAND_AREA_SYNC_ENABLED=false' \.env/);
    assert.match(workflow, /allowed_targets_count="\$\(grep -c '\^LAND_AREA_SYNC_ALLOWED_TARGETS=' \.env \|\| true\)"/);
    assert.match(workflow, /\^development:\[0-9a-fA-F\]\{8\}/);
    assert.match(workflow, /DEPLOY_EVENT_NAME: \$\{\{ github\.event_name \}\}/);
    assert.match(workflow, /"\$\{DEPLOY_EVENT_NAME\}" != "workflow_dispatch"/);
    assert.match(workflow, /EXPECTED_ALLOWLIST_DIGEST: \$\{\{ inputs\.land_area_sync_allowlist_sha256 \|\| '' \}\}/);
    assert.match(workflow, /EXPECTED_ALLOWLIST_COUNT: \$\{\{ inputs\.land_area_sync_allowlist_count \|\| '' \}\}/);
    assert.match(workflow, /node dist\/cli\/land-area-sync-allowlist-manifest\.js/);
    assert.match(workflow, /actual_allowlist_count.*EXPECTED_ALLOWLIST_COUNT/s);
    assert.match(workflow, /actual_allowlist_digest.*EXPECTED_ALLOWLIST_DIGEST/s);
    assert.ok(workflow.includes(
        '-e EXPECTED_LAND_AREA_SYNC_ENABLED="${expected_land_area_sync_enabled}"'
    ));
    assert.ok(workflow.includes(
        '-e EXPECTED_ALLOWLIST_COUNT="${actual_allowlist_count}"'
    ));
    assert.ok(workflow.includes(
        '-e EXPECTED_ALLOWLIST_DIGEST="${actual_allowlist_digest}"'
    ));
    assert.ok(workflow.includes(
        '=== process.env.EXPECTED_LAND_AREA_SYNC_ENABLED'
    ));
    assert.ok(workflow.includes(
        '=== process.env.EXPECTED_ALLOWLIST_COUNT'
    ));
    assert.ok(workflow.includes(
        '=== process.env.EXPECTED_ALLOWLIST_DIGEST'
    ));
    assert.match(envExample, /^LAND_AREA_SYNC_ENABLED=false$/m);
    assert.match(envExample, /^LAND_AREA_SYNC_ALLOWED_TARGETS=$/m);
    const operationTargetGuard = workflow.indexOf('operation_target_count="$(');
    const candidateStart = workflow.indexOf('docker run -d \\\n              --name "${CANDIDATE_CONTAINER}"');
    const productionReplacement = workflow.indexOf('docker stop "${CONTAINER_NAME}"');
    assert.ok(operationTargetGuard >= 0);
    assert.ok(candidateStart > operationTargetGuard);
    assert.ok(productionReplacement > operationTargetGuard);
    assert.doesNotMatch(workflow, /echo[^\n]*\$\{operation_target_(?:line|value)\}/);
    assert.match(workflow, /-p 127\.0\.0\.1:13100:3100/);
    assert.match(workflow, /Previous container preserved as \$\{ROLLBACK_CONTAINER\} for rollback/);
    assert.match(workflow, /ROLLBACK_FAILED: restored container health check failed/);
    assert.doesNotMatch(workflow, /uses: (?:actions|docker)\/[^@\s]+@v\d/);
    assert.doesNotMatch(workflow, /echo[^\n]*DEV_(?:API_JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY)/);
    assert.ok(!('docker:run' in JSON.parse(packageJson).scripts));
    assert.ok(!('docker:stop' in JSON.parse(packageJson).scripts));
    assert.ok(!('docker:compose:up' in JSON.parse(packageJson).scripts));
    assert.ok(!Object.keys(JSON.parse(packageJson).scripts).some((name) => name.startsWith('pm2:')));
    assert.doesNotMatch(legacyBuildScript, /docker (?:build|push)/);
    assert.doesNotMatch(legacyDeployScript, /docker (?:pull|run|stop|rm)/);
});

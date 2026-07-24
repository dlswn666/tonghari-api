import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(
    path.join(
        root,
        '.github/workflows/development-land-area-sync-run.yml'
    ),
    'utf8'
);
const runner = fs.readFileSync(
    path.join(root, 'src/operations/development-land-area-sync-runner.ts'),
    'utf8'
);
const cli = fs.readFileSync(
    path.join(root, 'src/cli/development-land-area-sync-runner.ts'),
    'utf8'
);
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

test('workflow는 protected environment, main-only, repository choice, exact actor UUID를 요구한다', () => {
    assert.match(workflow, /environment: land-area-sync-development-write/);
    assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
    assert.match(workflow, /type: choice/);
    assert.match(workflow, /mia-seven-representative-20260725/);
    assert.match(
        workflow,
        /EXPECTED_ACTOR_AUTH_USER_ID: \$\{\{ secrets\.DEV_GIS_SYSTEM_ADMIN_AUTH_UUID \}\}/
    );
    assert.match(
        workflow,
        /"\$\{ACTOR_AUTH_USER_ID\}" != "\$\{EXPECTED_ACTOR_AUTH_USER_ID\}"/
    );
});

test('workflow는 batch 전체에 공통 operation lock만 고정 순서로 보유하고 2400초로 제한한다', () => {
    assert.match(
        workflow,
        /operation_lock_path="\$\{HOME\}\/alimtalk-proxy\/\.land-area-sync-operation\.lock"/
    );
    assert.match(workflow, /exec 8>>"\$\{operation_lock_path\}"/);
    assert.match(workflow, /flock -w 900 8/);
    assert.match(
        workflow,
        /timeout --foreground --kill-after=15s 2400s[\s\S]+development-land-area-sync-runner\.js/
    );
    assert.doesNotMatch(
        workflow,
        /production_lock_path|\.tonghari-api-production\.lock/
    );
});

test('workflow와 runner는 raw JWT/secret/log를 artifact나 출력으로 내보내지 않는다', () => {
    assert.doesNotMatch(workflow, /docker logs/);
    assert.doesNotMatch(workflow, /DEV_API_JWT_SECRET/);
    assert.doesNotMatch(workflow, /DEV_SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(workflow, /Authorization:|Bearer \$\{/);
    assert.doesNotMatch(
        runner,
        /console\.(?:log|error)|process\.(?:stdout|stderr)/
    );
    assert.doesNotMatch(cli, /process\.env\.(?:JWT_SECRET|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\b.*write/);
});

test('DB 직접 접근은 development service-role read-only select이며 write는 localhost canonical API에만 맡긴다', () => {
    assert.match(cli, /process\.env\.DEV_SUPABASE_URL/);
    assert.match(cli, /process\.env\.DEV_SUPABASE_SERVICE_ROLE_KEY/);
    assert.match(cli, /\.from\('property_units'\)[\s\S]+\.select\(/);
    assert.doesNotMatch(
        cli,
        /\.(?:insert|update|upsert|delete|rpc)\s*\(/
    );
    assert.match(runner, /const LOCAL_API_ORIGIN = 'http:\/\/127\.0\.0\.1:3100'/);
    assert.match(runner, /keyid: 'dev'/);
    assert.match(runner, /databaseTarget: 'development'/);
    assert.match(runner, /iss: 'tonghari-web-dev'/);
    assert.match(runner, /aud: 'tonghari-api'/);
});

test('image는 non-root runner private directory를 mode 700으로 준비한다', () => {
    assert.match(dockerfile, /\.development-land-area-sync/);
    assert.match(
        dockerfile,
        /chown -R nodejs:nodejs[\s\S]+\.development-land-area-sync/
    );
    assert.match(
        dockerfile,
        /chmod 700[\s\S]+\.development-land-area-sync/
    );
});

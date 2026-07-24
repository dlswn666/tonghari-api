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
const guardian = fs.readFileSync(
    path.join(
        root,
        'scripts/development-land-area-sync-remote-guardian.sh'
    ),
    'utf8'
);

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

test('workflow는 SSH와 분리된 guardian이 공통 operation lock을 terminal drain과 cleanup까지 보유한다', () => {
    assert.match(
        guardian,
        /application_root="\$\{HOME\}\/alimtalk-proxy"[\s\S]+operation_lock_path="\$\{application_root\}\/\.land-area-sync-operation\.lock"/
    );
    assert.match(guardian, /exec 8>>"\$\{operation_lock_path\}"/);
    assert.match(guardian, /flock -w 900 8/);
    assert.match(
        workflow,
        /nohup setsid env[\s\S]+bash "\$\{guardian\}"/
    );
    assert.match(workflow, /while \[\[ ! -f "\$\{status_file\}" \]\]/);
    assert.match(workflow, /kill -0 "\$\{guardian_pid\}"/);
    assert.match(workflow, /exec 7>>"\$\{operation_lock_path\}"/);
    assert.match(workflow, /flock -w 30 7/);
    assert.doesNotMatch(workflow, /timeout .*development-land-area-sync-runner/);
    assert.doesNotMatch(
        `${workflow}\n${guardian}`,
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
    assert.match(
        cli,
        /land_area_synced_at, land_area_sync_job_id/
    );
    assert.match(cli, /\.in\('land_area_sync_job_id', syncJobIds\)/);
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

test('cleanup은 host/container/local evidence 부재를 재검증하며 실패를 무시하지 않는다', () => {
    assert.doesNotMatch(workflow, /\|\| true/);
    assert.doesNotMatch(guardian, /\|\| true/);
    assert.match(guardian, /cleanup_container_inputs/);
    assert.match(guardian, /cleanup_host_inputs/);
    assert.match(
        guardian,
        /docker exec "\$\{target_container\}" test ! -e "\$\{candidate\}"/
    );
    assert.match(workflow, /test ! -e "\$\{run_root\}"/);
    assert.match(workflow, /test ! -e "\$\{validation_root\}"/);
});

test('runner soft timeout은 API queue 10분보다 길고 terminal 전 반환하지 않는다', () => {
    assert.match(runner, /DEVELOPMENT_API_QUEUE_TIMEOUT_MS = 10 \* 60_000/);
    assert.match(
        runner,
        /DEVELOPMENT_JOB_POLL_SOFT_TIMEOUT_MS =[\s\S]+DEVELOPMENT_API_QUEUE_TIMEOUT_MS \+ 60_000/
    );
    assert.match(
        runner,
        /while \(current === null \|\| current\.status === 'PROCESSING'\)/
    );
    assert.match(runner, /JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL/);
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

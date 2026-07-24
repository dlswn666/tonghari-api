import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflow = readFileSync(
    join(
        process.cwd(),
        '.github/workflows/land-area-sync-runtime-allowlist.yml'
    ),
    'utf8'
);
const dockerBuildWorkflow = readFileSync(
    join(process.cwd(), '.github/workflows/docker-build.yml'),
    'utf8'
);

test('runtime allowlist workflow는 main workflow_dispatch와 보호 environment만 사용한다', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^\s{2}push:/m);
    assert.match(workflow, /GITHUB_EVENT_NAME.*workflow_dispatch/);
    assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
    assert.match(
        workflow,
        /environment: land-area-sync-development-backfill/
    );
    assert.match(workflow, /group: tonghari-api-production/);
    assert.match(workflow, /cancel-in-progress: false/);
});

test('runtime allowlist workflow는 raw 입력을 validator와 mode 600 파일로만 전달한다', () => {
    assert.match(
        workflow,
        /node dist\/cli\/land-area-sync-runtime-allowlist\.js/
    );
    assert.match(
        workflow,
        /install -m 600 \/dev\/null "\$\{allowlist_path\}"/
    );
    assert.match(
        workflow,
        /printf '%s' "\$\{RAW_ALLOWED_TARGETS\}" > "\$\{allowlist_path\}"/
    );
    assert.doesNotMatch(workflow, /echo [^\n]*RAW_ALLOWED_TARGETS/);
    assert.doesNotMatch(workflow, /echo [^\n]*EC2_SSH_KEY/);
    assert.doesNotMatch(workflow, /set -x/);
});

test('runtime allowlist workflow는 pinned SSH, regular .env 0600, atomic rename을 강제한다', () => {
    assert.match(workflow, /EC2_SSH_FINGERPRINT/);
    assert.match(workflow, /StrictHostKeyChecking=yes/);
    assert.match(workflow, /UserKnownHostsFile=/);
    assert.match(workflow, /! -f "\$\{env_path\}" \|\| -L "\$\{env_path\}"/);
    assert.match(
        workflow,
        /stat -c '%u' "\$\{env_path\}".*id -u/s
    );
    assert.match(workflow, /stat -c '%a' "\$\{env_path\}".*"600"/s);
    assert.match(
        workflow,
        /mktemp "\$\{application_root\}\/\.env\.land-area-sync\.next\.XXXXXX"/
    );
    assert.match(workflow, /mv -f -- "\$\{env_next\}" "\$\{env_path\}"/);
});

test('runtime allowlist workflow는 현재 image ID, health attestation, rollback을 검증한다', () => {
    assert.match(
        workflow,
        /current_image_id=.*docker container inspect --format '\{\{\.Image\}\}'/s
    );
    assert.match(workflow, /"\$\{current_image_id\}" >\/dev\/null/);
    assert.match(
        workflow,
        /actual_image_id.*!= "\$\{current_image_id\}"/s
    );
    assert.match(workflow, /landAreaSyncEnabled/);
    assert.match(workflow, /landAreaSyncAllowedTargetCount/);
    assert.match(workflow, /landAreaSyncAllowedTargetsDigest/);
    assert.match(workflow, /trap rollback ERR/);
    assert.match(
        workflow,
        /mv -f -- "\$\{env_backup\}" "\$\{env_path\}"/
    );
    assert.match(
        workflow,
        /Runtime change failed; previous \.env and container were restored/
    );
    assert.doesNotMatch(workflow, /docker pull/);
    assert.doesNotMatch(workflow, /docker build/);
});

test('runtime allowlist workflow는 Supabase나 DB에 연결하거나 운영 target을 구성하지 않는다', () => {
    assert.doesNotMatch(workflow, /SUPABASE_URL/);
    assert.doesNotMatch(workflow, /SERVICE_ROLE_KEY/);
    assert.doesNotMatch(workflow, /\bpsql\b/);
    assert.doesNotMatch(workflow, /\bsupabase\b/i);
    assert.doesNotMatch(
        workflow,
        /\bproduction:[0-9a-f*-]+:[0-9*]+\b/
    );
});

test('기존 docker-build push 배포는 enabled runtime을 계속 fail closed한다', () => {
    assert.match(dockerBuildWorkflow, /^\s{2}push:/m);
    assert.match(
        dockerBuildWorkflow,
        /Enabled LAND_AREA_SYNC is allowed only for an explicit workflow_dispatch/
    );
    assert.match(
        dockerBuildWorkflow,
        /Disabled LAND_AREA_SYNC requires an empty allowlist/
    );
    assert.match(dockerBuildWorkflow, /group: tonghari-api-production/);
});

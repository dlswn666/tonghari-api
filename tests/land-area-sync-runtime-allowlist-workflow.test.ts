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
const phase0CaptureWorkflow = readFileSync(
    join(process.cwd(), '.github/workflows/phase0-land-area-capture.yml'),
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
    assert.match(
        workflow,
        /group: tonghari-api-production-runtime-\$\{\{ inputs\.action \}\}/
    );
    assert.match(workflow, /cancel-in-progress: false/);
});

test('runtime allowlist workflow는 event payload에서 raw를 읽고 exact mask 뒤에만 사용한다', () => {
    assert.match(
        workflow,
        /node dist\/cli\/land-area-sync-runtime-allowlist\.js/
    );
    assert.match(workflow, /GITHUB_EVENT_PATH/);
    assert.match(
        workflow,
        /event\?\.inputs\?\.land_area_sync_allowed_targets/
    );
    assert.match(workflow, /::add-mask::\$\{commandValue\}/);
    assert.match(workflow, /\.replaceAll\("%", "%25"\)/);
    assert.match(workflow, /\.replaceAll\("\\r", "%0D"\)/);
    assert.match(workflow, /\.replaceAll\("\\n", "%0A"\)/);
    assert.ok(
        workflow.indexOf('::add-mask::${commandValue}') <
            workflow.indexOf('fs.writeFileSync(outputPath, raw'),
        'exact raw mask는 staged file 사용보다 먼저 등록해야 한다'
    );
    assert.match(
        workflow,
        /install -m 600 \/dev\/null "\$\{allowlist_path\}"/
    );
    assert.doesNotMatch(
        workflow,
        /\$\{\{ inputs\.land_area_sync_allowed_targets \}\}/
    );
    assert.doesNotMatch(workflow, /RAW_ALLOWED_TARGETS:/);
    assert.match(
        workflow,
        /IFS= read -r -d '' LAND_AREA_SYNC_ALLOWED_TARGETS/
    );
    assert.match(workflow, /IFS= read -r -d '' raw_allowed_targets/);
    assert.doesNotMatch(
        workflow,
        /LAND_AREA_SYNC_ALLOWED_TARGETS="\$\(</
    );
    assert.doesNotMatch(workflow, /raw_allowed_targets="\$\(</);
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

test('모든 production workflow는 동일한 EC2 advisory lock 계약을 강제한다', () => {
    for (const productionWorkflow of [
        workflow,
        dockerBuildWorkflow,
        phase0CaptureWorkflow,
    ]) {
        assert.match(
            productionWorkflow,
            /\.tonghari-api-production\.lock/
        );
        assert.match(productionWorkflow, /exec 9>>"\$\{production_lock_path\}"/);
        assert.match(productionWorkflow, /flock -w 2400 9/);
        assert.match(
            productionWorkflow,
            /deploy-user-owned regular mode 600 file/
        );
    }
});

test('컨테이너 재기동 workflow는 future runner와 동일한 bounded operation lock을 사용한다', () => {
    for (const restartWorkflow of [workflow, dockerBuildWorkflow]) {
        assert.match(restartWorkflow, /\.land-area-sync-operation\.lock/);
        assert.match(
            restartWorkflow,
            /exec 8>>"\$\{operation_lock_path\}"/
        );
        assert.match(restartWorkflow, /flock -w 2700 8/);
        assert.match(
            restartWorkflow,
            /Land-area operation lock must be a deploy-user-owned regular mode 600 file/
        );
        assert.ok(
            restartWorkflow.indexOf('flock -w 2400 9') <
                restartWorkflow.indexOf('flock -w 2700 8'),
            'production lock은 operation lock보다 먼저 획득해야 한다'
        );
    }
    assert.match(workflow, /batch runner는[\s\S]*최대 2400초만 보유/);
});

test('runtime action slot과 monotonic sequence는 pending disable 대체와 stale enable을 막는다', () => {
    assert.match(
        workflow,
        /group: tonghari-api-production-runtime-\$\{\{ inputs\.action \}\}/
    );
    assert.match(workflow, /REQUEST_SEQUENCE: \$\{\{ github\.run_id \}\}/);
    assert.match(workflow, /\.land-area-sync-runtime-sequence/);
    assert.match(workflow, /REQUEST_SEQUENCE < last_sequence/);
    assert.match(workflow, /Stale enable request skipped/);
    assert.match(
        workflow,
        /Stale enable request skipped[\s\S]*exit 75/
    );
    assert.match(
        workflow,
        /disable은 안전 동작이므로 stale이어도 실행/
    );
    assert.match(
        workflow,
        /sequence_to_store.*RUNTIME_ACTION.*runtime_sequence_path/s
    );
    assert.ok(
        workflow.indexOf(
            'mv -f -- "${sequence_next}" "${runtime_sequence_path}"'
        ) <
            workflow.indexOf('mv -f -- "${env_next}" "${env_path}"'),
        'sequence intent는 runtime env 변경보다 먼저 원자적으로 기록해야 한다'
    );
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

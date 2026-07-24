import assert from 'node:assert/strict';
import test from 'node:test';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
    assert.equal(
        (
            workflow.match(
                /install -m 600 \/dev\/null "\$\{allowlist_path\}"\n\s+echo "path=\$\{allowlist_path\}" >> "\$\{GITHUB_OUTPUT\}"\n\n\s+node -e/g
            ) ?? []
        ).length,
        2,
        'cleanup step이 실패한 staging step의 경로도 알 수 있도록 raw write 전에 output을 기록해야 한다'
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
    assert.match(
        workflow,
        /REQUEST_SEQUENCE: \$\{\{ github\.run_number \}\}/
    );
    assert.match(
        workflow,
        /REQUEST_ATTEMPT: \$\{\{ github\.run_attempt \}\}/
    );
    assert.doesNotMatch(
        workflow,
        /REQUEST_SEQUENCE: \$\{\{ github\.run_id \}\}/
    );
    assert.match(workflow, /\.land-area-sync-runtime-watermark/);
    assert.match(workflow, /REQUEST_SEQUENCE < last_sequence/);
    assert.match(workflow, /Stale enable request skipped/);
    assert.match(
        workflow,
        /Stale enable request skipped[\s\S]*exit 75/
    );
    assert.match(
        workflow,
        /disable은 안전 tombstone이므로 stale이어도 실행/
    );
    assert.match(
        workflow,
        /watermark_sequence_to_store.*watermark_attempt_to_store.*RUNTIME_ACTION/s
    );
    assert.ok(
        workflow.indexOf(
            'mv -f -- "${watermark_next}" "${runtime_watermark_path}"'
        ) <
            workflow.indexOf('mv -f -- "${env_next}" "${env_path}"'),
        'requested watermark는 runtime env 변경보다 먼저 원자적으로 기록해야 한다'
    );
    const rollbackBody =
        workflow.split('          rollback() {')[1]?.split(
            '          trap rollback ERR'
        )[0] ?? '';
    assert.doesNotMatch(
        rollbackBody,
        /mv -f -- .*runtime_watermark_path/
    );
    assert.doesNotMatch(
        rollbackBody,
        /rm -f -- .*runtime_watermark_path/
    );
});

test('정상-success cleanup은 rollback container와 secret backup 부재를 검증하고 실패를 green 처리하지 않는다', () => {
    const successCleanupBody =
        workflow.split('          rollback_cleanup_command_failed=0')[1]?.split(
            '          echo "Runtime action'
        )[0] ?? '';

    assert.notEqual(successCleanupBody, '');
    assert.doesNotMatch(workflow, /sequence_backup/);
    assert.doesNotMatch(
        successCleanupBody,
        /docker rm -f "\$\{rollback_container\}"[^\n]*\|\| true/
    );
    assert.doesNotMatch(
        successCleanupBody,
        /rm -f -- "\$\{env_backup\}"[^\n]*\|\| true/
    );
    assert.match(
        successCleanupBody,
        /if ! docker rm -f "\$\{rollback_container\}"/
    );
    assert.match(
        successCleanupBody,
        /docker container inspect "\$\{rollback_container\}"[\s\S]*false/
    );
    assert.match(
        successCleanupBody,
        /! rm -f -- "\$\{env_backup\}"[\s\S]*-e "\$\{env_backup\}"[\s\S]*-L "\$\{env_backup\}"/
    );
    assert.match(successCleanupBody, /CLEANUP_FAILED:[\s\S]*exit 71/);
});

test('rollback 실패 가능성이 있는 unique orphan env backup은 same-run return 전에 보존하고 fail closed한다', () => {
    const remoteRuntimeBody =
        workflow.split("<<'REMOTE_RUNTIME'")[1] ?? '';
    const functionStart = remoteRuntimeBody.indexOf(
        '          assert_no_orphan_env_backups() {'
    );
    const guardCall = '          assert_no_orphan_env_backups\n';
    const cleanupCallIndex = remoteRuntimeBody.indexOf(
        guardCall
    );
    const enableDecisionIndex = remoteRuntimeBody.indexOf(
        '          if [[ "${RUNTIME_ACTION}" == "enable" ]]; then'
    );
    const orphanGuardScript = remoteRuntimeBody
        .slice(functionStart, cleanupCallIndex + guardCall.length)
        .replace(/^ {10}/gm, '');

    assert.ok(functionStart >= 0);
    assert.notEqual(orphanGuardScript, '');
    assert.match(
        orphanGuardScript,
        /\.env\.land-area-sync\.backup\.\*/
    );
    assert.match(orphanGuardScript, /\$\{#orphan_backups\[@\]\} > 8/);
    assert.equal(
        (
            orphanGuardScript.match(
                /\.env\.land-area-sync\.backup\.\*/g
            ) ?? []
        ).length,
        1
    );
    assert.doesNotMatch(orphanGuardScript, /\brm\b|\bunlink\b/);
    assert.match(
        orphanGuardScript,
        /\$\{#orphan_backups\[@\]\} > 0[\s\S]*preserved for manual review[\s\S]*return 71/
    );
    assert.ok(cleanupCallIndex >= 0);
    assert.ok(
        cleanupCallIndex < enableDecisionIndex,
        'orphan backup guard는 same-run enable early return보다 먼저 실행해야 한다'
    );

    const testRoot = mkdtempSync(
        join(tmpdir(), 'land-area-sync-orphan-backup-')
    );
    const uniqueRecoveryBackup = join(
        testRoot,
        '.env.land-area-sync.backup.unique'
    );
    try {
        writeFileSync(uniqueRecoveryBackup, 'recovery-secret', {
            mode: 0o600,
        });
        chmodSync(uniqueRecoveryBackup, 0o600);
        const result = spawnSync(
            'bash',
            [
                '-c',
                `set -Eeuo pipefail
application_root="$1"
stat() {
    case "$2" in
        "%u") id -u ;;
        "%a") printf '600\\n' ;;
        *) return 1 ;;
    esac
}
${orphanGuardScript}`,
                'workflow-orphan-guard',
                testRoot,
            ],
            { encoding: 'utf8' }
        );
        assert.equal(result.status, 71);
        assert.equal(existsSync(uniqueRecoveryBackup), true);
        assert.match(result.stdout, /preserved for manual review/);
    } finally {
        rmSync(testRoot, { recursive: true, force: true });
    }
});

test('staged raw allowlist는 모든 local/remote 종료 경로에서 fail-closed cleanup한다', () => {
    const remoteExitCleanupBody =
        workflow.split('          cleanup_run_files() {')[1]?.split(
            '          trap cleanup_run_files EXIT'
        )[0] ?? '';
    const sshExitCleanupBody =
        workflow.split('          cleanup_remote() {')[1]?.split(
            '          trap cleanup_remote EXIT'
        )[0] ?? '';
    const localCleanupSteps = [
        'Remove staged validator input',
        'Remove staged runner input',
    ].map(
        (name) =>
            workflow.split(`      - name: ${name}`)[1]?.split(
                '\n  apply-runtime-gate:'
            )[0] ?? ''
    );

    for (const cleanupBody of [
        remoteExitCleanupBody,
        sshExitCleanupBody,
        ...localCleanupSteps,
    ]) {
        assert.notEqual(cleanupBody, '');
        assert.doesNotMatch(cleanupBody, /\|\| true/);
        assert.match(
            cleanupBody,
            /-e "\$\{(?:allowlist_path|cleanup_path)\}" \|\| -L/
        );
        assert.match(cleanupBody, /CLEANUP_FAILED:[\s\S]*exit 71/);
    }
    assert.equal(
        (
            workflow.match(
                /cleanup_path="\$\{ALLOWLIST_PATH:-\$\{RUNNER_TEMP\}\/land-area-sync-(?:validate|runtime)-\$\{RUN_KEY\}\/allowlist\}"/g
            ) ?? []
        ).length,
        2,
        'staging step이 실패해 output이 비어도 exact RUN_KEY 경로를 정리해야 한다'
    );
});

test('Docker deploy timeout은 두 lock 대기와 배포 rollback의 전체 worst-case 예산보다 크다', () => {
    const deployJob =
        dockerBuildWorkflow.split('\n  deploy:\n')[1] ?? '';
    const jobTimeoutMatch = deployJob.match(/timeout-minutes: ([0-9]+)/);
    const commandTimeoutMatch = deployJob.match(
        /command_timeout: ([0-9]+)m/
    );

    assert.notEqual(deployJob, '');
    assert.ok(jobTimeoutMatch);
    assert.ok(commandTimeoutMatch);
    const jobTimeoutSeconds = Number(jobTimeoutMatch[1]) * 60;
    const commandTimeoutSeconds = Number(commandTimeoutMatch[1]) * 60;
    const worstCaseSeconds = 2400 + 2700 + 1800;
    assert.ok(
        commandTimeoutSeconds > worstCaseSeconds,
        'SSH command timeout은 lock 2개와 배포/rollback 예산 합보다 커야 한다'
    );
    assert.ok(
        jobTimeoutSeconds > commandTimeoutSeconds,
        'deploy job timeout은 SSH command timeout 뒤 후처리 여유를 남겨야 한다'
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

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
const captureWorkflow = fs.readFileSync(
    path.join(
        root,
        '.github/workflows/development-land-area-evidence-capture.yml'
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
const pagedRead = fs.readFileSync(
    path.join(root, 'src/cli/development-land-area-paged-read.ts'),
    'utf8'
);
const validatorCli = fs.readFileSync(
    path.join(root, 'src/cli/development-land-area-sync-validate.ts'),
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

test('workflow는 protected environment secret의 actor UUID만 내부 사용하고 공개 입력을 금지한다', () => {
    const dispatchBlock = workflow.slice(
        workflow.indexOf('workflow_dispatch:'),
        workflow.indexOf('permissions:')
    );
    // 환경은 manifest 라벨 하나로만 결정된다 — 라벨에 '-production-' 이 있으면
    // 별도 보호 환경(land-area-sync-production-write), 그 외 전부 dev 환경이다.
    // (선례: development-building-registry-relation-adoption.yml)
    assert.match(
        workflow,
        /environment: >-\n\s+\$\{\{ contains\(inputs\.manifest, '-production-'\)\n\s+&& 'land-area-sync-production-write'\n\s+\|\| 'land-area-sync-development-write' \}\}/
    );
    // 환경 선언은 이 식 하나뿐이다 — 리터럴 라벨 비교가 남아 있으면 안 된다.
    assert.equal((workflow.match(/^\s+environment:/gm) ?? []).length, 1);
    assert.doesNotMatch(workflow, /inputs\.manifest ==/);
    assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
    assert.match(workflow, /type: choice/);
    assert.match(workflow, /mia-seven-representative-20260725/);
    // actor 도 같은 라벨 식으로만 분기한다 — production 은 환경 스코프 시크릿.
    const actorExpression =
        /ACTOR_AUTH_USER_ID: \$\{\{ contains\(inputs\.manifest, '-production-'\) && secrets\.PROD_GIS_SYSTEM_ADMIN_AUTH_UUID \|\| secrets\.DEV_GIS_SYSTEM_ADMIN_AUTH_UUID \}\}/g;
    assert.equal(
        (workflow.match(actorExpression) ?? []).length,
        2,
        'actor 시크릿 분기는 검증 스텝과 원격 스텝 두 곳 모두에 있어야 한다'
    );
    // 라벨 부분문자열이 환경을 정하므로, 라벨과 target 문서의 databaseTarget 이
    // 어긋나면 EC2 로 가기 전에 manifest 해석 단계에서 멈춰야 한다.
    assert.match(
        workflow,
        /const productionLabel =\n\s+String\(process\.env\.MANIFEST_NAME \?\? ""\)\.includes\("-production-"\);\n\s+if \(\(target\.databaseTarget === "production"\) !== productionLabel\) \{\n\s+process\.exit\(1\);/
    );
    assert.doesNotMatch(dispatchBlock, /actor_auth_user_id|auth UUID/i);
    assert.doesNotMatch(
        dispatchBlock,
        /[0-9a-f]{8}-[0-9a-f-]{27}|[0-9]{19}|secret/i
    );
    assert.doesNotMatch(workflow, /\$\{\{ inputs\.actor_auth_user_id \}\}/);
    assert.doesNotMatch(workflow, /EXPECTED_ACTOR_AUTH_USER_ID/);
    assert.doesNotMatch(
        workflow,
        /echo[^\n]*\$\{ACTOR_AUTH_USER_ID\}/
    );
});

test('791-2280 API target은 read-only capture에서만 선택되고 v2 전체 scope로 임시 approval을 검증한다', () => {
    const label =
        'mia-seven-791-2280-ldareg-api-readonly-20260725';
    assert.match(captureWorkflow, new RegExp(label));
    assert.match(
        captureWorkflow,
        /mia-seven-791-2280-ldareg-api-readonly-target-20260725\.json/
    );
    assert.match(
        captureWorkflow,
        /const approvedScopePnus = Array\.isArray\(target\.allowedScopePnus\)[\s\S]+pnus: approvedScopePnus,[\s\S]+targetCount: approvedScopePnus\.length/
    );
    assert.match(
        captureWorkflow,
        /const approvedScopeDigest = typeof target\.scopeDigest === "string"[\s\S]+manifestDigest: approvedScopeDigest/
    );
    assert.match(
        captureWorkflow,
        /evidence\.manifestDigest !== target\.manifestDigest/
    );
    assert.doesNotMatch(workflow, new RegExp(label));
    assert.doesNotMatch(
        workflow,
        /mia-seven-791-2280-ldareg-api-readonly-target-20260725\.json/
    );
});

test('미아7 전체 299 anchor API 재조회 legacy route는 read-only capture에 보존한다', () => {
    const label = 'mia-seven-full-299-api-readonly-20260728';
    const selection = captureWorkflow.slice(
        captureWorkflow.indexOf(`${label})`),
        captureWorkflow.indexOf(
            'mia-seven-auto-286-20260725)',
            captureWorkflow.indexOf(`${label})`)
        )
    );
    assert.match(captureWorkflow, new RegExp(`- ${label}`));
    assert.match(
        selection,
        /mia-seven-full-299-api-readonly-target-20260728\.json/
    );
    assert.match(selection, /target_count="299"/);
    assert.match(selection, /property_unit_count="429"/);
    assert.doesNotMatch(workflow, new RegExp(label));
    assert.doesNotMatch(
        workflow,
        /mia-seven-full-299-api-readonly-target-20260728\.json/
    );
});

test('미아7 278 official component·422 물건지(도로지분 7건 제외) 전체 재조회는 299 active PNU와 300 scanned PNU를 분리해 검증한다', () => {
    const label =
        'mia-seven-full-278-official-components-api-readonly-20260729';
    const selection = captureWorkflow.slice(
        captureWorkflow.indexOf(`${label})`),
        captureWorkflow.indexOf(
            'mia-seven-full-299-api-readonly-20260728)',
            captureWorkflow.indexOf(`${label})`)
        )
    );
    assert.match(
        captureWorkflow,
        new RegExp(`default: ${label}`)
    );
    assert.match(captureWorkflow, new RegExp(`- ${label}`));
    assert.match(
        selection,
        /mia-seven-full-278-official-components-api-readonly-target-20260729\.json/
    );
    assert.match(selection, /target_count="278"/);
    assert.match(selection, /property_unit_count="422"/);
    assert.match(
        captureWorkflow,
        /audit\?\.activePnuCount !== target\.expectedUnionActivePnuCount/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.resolvedComponentCount !== target\.targetCount/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.scannedPnuCount !== approvedScopePnus\.length/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.verifiedNoDataCount[\s\S]+audit\?\.sameRunOfficialComponentCount[\s\S]+audit\?\.sameRunOfficialParcelCount[\s\S]+target\.targetCount/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.promotionGate\?\.status !== "PASS"/
    );
    assert.match(
        captureWorkflow,
        /audit\?\.promotionGate\?\.writeEligible !== true/
    );
    assert.match(workflow, new RegExp(label));
    assert.match(
        workflow,
        /mia-seven-full-278-official-components-api-readonly-target-20260729\.json/
    );
    assert.match(
        workflow,
        /db_approval_path=""[\s\S]+evidence_path=""[\s\S]+full_refresh_mode="1"/
    );
    assert.match(
        workflow,
        /if \[\[ "\$\{FULL_REFRESH_MODE\}" == "0" \]\]; then[\s\S]+scp "\$\{ssh_options\[@\]\}" "\$\{DB_APPROVAL_PATH\}"/
    );
    assert.match(
        guardian,
        /-e LAND_AREA_SYNC_ENABLED=[\s\S]+development-land-area-evidence-capture\.js/
    );
    assert.match(
        guardian,
        /audit\?\.promotionGate\?\.status !== "PASS"[\s\S]+audit\?\.promotionGate\?\.writeEligible !== true/
    );
    assert.match(
        guardian,
        /audit\?\.verifiedNoDataCount[\s\S]+audit\?\.sameRunOfficialComponentCount[\s\S]+audit\?\.sameRunOfficialParcelCount[\s\S]+target\.targetCount/
    );
    assert.match(
        guardian,
        /runner\.validateDevelopmentRunnerManifests\(target, approval, evidence\)/
    );
    assert.match(
        runner,
        /DEVELOPMENT_FULL_REFRESH_ADMISSION_CUTOFF_MS\s*=\s*225 \* 60_000/
    );
    assert.match(
        runner,
        /FULL_REFRESH_ADMISSION_CUTOFF_REACHED/
    );
    for (const table of [
        'land_lots',
        'building_land_lots',
        'buildings',
        'building_units',
        'building_external_refs',
        'building_registry_land_lot_relations',
        'building_land_lot_manual_overrides',
    ]) {
        assert.match(cli, new RegExp(`['"]${table}['"]`));
    }
    assert.match(cli, /select\('\*', \{ count: 'exact' \}\)/);
    // 페이징 helper 는 공용 모듈로 분리됐다 — CLI 는 그 모듈로만 읽고, 모듈은
    // 500행 exact 페이지와 절단 시 fail-closed(_TRUNCATED)를 유지한다.
    assert.match(
        cli,
        /\} from '\.\/development-land-area-paged-read';/
    );
    assert.doesNotMatch(cli, /const readExactPaged = |const readChunked = /);
    assert.match(pagedRead, /DEVELOPMENT_PAGED_READ_PAGE_SIZE = 500/);
    assert.match(pagedRead, /\$\{code\}_TRUNCATED/);
    assert.match(pagedRead, /\$\{code\}_COUNT_INVALID/);
    assert.match(cli, /readPropertyUnitLandRights/);
});

test('read-only capture는 raw evidence를 업로드하지 않고 비식별 순번 진단·집계만 게시한 뒤 private 파일을 제거한다', () => {
    const uploadBlock = captureWorkflow.slice(
        captureWorkflow.indexOf(
            '- name: Upload sanitized read-only capture artifact'
        ),
        captureWorkflow.indexOf('- name: Enforce capture gate')
    );
    const publicArtifactBlock = captureWorkflow.slice(
        captureWorkflow.indexOf(
            '- name: Build sanitized read-only capture artifact'
        ),
        captureWorkflow.indexOf(
            '- name: Upload sanitized read-only capture artifact'
        )
    );
    const cleanupBlock = captureWorkflow.slice(
        captureWorkflow.indexOf('- name: Remove private capture files')
    );
    assert.match(
        uploadBlock,
        /path: development-land-area-evidence-public\/artifact\.json/
    );
    assert.doesNotMatch(
        uploadBlock,
        /development-land-area-evidence-output|audit\.json|evidence\.json/
    );
    assert.match(
        publicArtifactBlock,
        /land-area-development-evidence-public-artifact@4/
    );
    assert.match(publicArtifactBlock, /retry: \{/);
    assert.match(publicArtifactBlock, /rounds: audit\.retry\.rounds/);
    assert.match(
        publicArtifactBlock,
        /retriedAnchorCount: audit\.retry\.retriedAnchorCount/
    );
    assert.match(
        publicArtifactBlock,
        /recoveredAnchorCount: audit\.retry\.recoveredAnchorCount/
    );
    assert.match(
        publicArtifactBlock,
        /skipped: audit\.retry\.skipped/
    );
    assert.match(publicArtifactBlock, /attempts: entry\.attempts/);
    assert.match(
        publicArtifactBlock,
        /Number\.isSafeInteger\(entry\.attempts\)/
    );
    assert.match(publicArtifactBlock, /entry\.attempts >= 0/);
    assert.match(
        publicArtifactBlock,
        /const retrySkippedValues = new Set\(/
    );
    assert.match(publicArtifactBlock, /"TOO_MANY_FAILURES"/);
    assert.match(publicArtifactBlock, /!audit\.retry\b/);
    assert.match(
        publicArtifactBlock,
        /Number\.isSafeInteger\(audit\.retry\.rounds\)/
    );
    assert.match(publicArtifactBlock, /audit\.retry\.rounds < 0/);
    assert.match(
        publicArtifactBlock,
        /Number\.isSafeInteger\(audit\.retry\.retriedAnchorCount\)/
    );
    assert.match(
        publicArtifactBlock,
        /audit\.retry\.retriedAnchorCount < 0/
    );
    assert.match(
        publicArtifactBlock,
        /Number\.isSafeInteger\(audit\.retry\.recoveredAnchorCount\)/
    );
    assert.match(
        publicArtifactBlock,
        /audit\.retry\.recoveredAnchorCount < 0/
    );
    assert.match(
        publicArtifactBlock,
        /retrySkippedValues\.has\(audit\.retry\.skipped\)/
    );
    assert.match(publicArtifactBlock, /redactedAggregate/);
    assert.match(publicArtifactBlock, /redactedIssueCounts/);
    assert.match(publicArtifactBlock, /redactedFailureDetails/);
    assert.match(publicArtifactBlock, /targetOrdinal: index \+ 1/);
    assert.match(publicArtifactBlock, /failureDetailsValid/);
    assert.match(publicArtifactBlock, /classifyFailure/);
    assert.match(
        publicArtifactBlock,
        /redactedFailureDetails\.filter/
    );
    assert.match(publicArtifactBlock, /activePnuCount/);
    assert.match(publicArtifactBlock, /resolvedComponentCount/);
    assert.match(publicArtifactBlock, /scannedPnuCount/);
    assert.match(publicArtifactBlock, /sameRunOfficialComponentCount/);
    assert.match(publicArtifactBlock, /sameRunOfficialParcelCount/);
    assert.match(publicArtifactBlock, /verifiedNoDataCount/);
    assert.match(
        publicArtifactBlock,
        /\["CAPTURED", "VERIFIED_NO_DATA", "FAILED"\]/
    );
    assert.match(publicArtifactBlock, /"VERIFIED_NO_DATA"/);
    assert.match(publicArtifactBlock, /promotionGate/);
    assert.doesNotMatch(publicArtifactBlock, /anchorIndex/);
    assert.doesNotMatch(publicArtifactBlock, /redactedDiagnostics/);
    assert.doesNotMatch(publicArtifactBlock, /targetPnu/);
    assert.match(publicArtifactBlock, /productionWrites: 0/);
    assert.match(
        publicArtifactBlock,
        /anchorPnu\|propertyUnitId\|allowedPrestates\|proposedLandAreas\|landArea/
    );
    assert.match(
        publicArtifactBlock,
        /\^\(\?!\.\*\[0-9\]\{19\}\)\[A-Z0-9_\]\{1,100\}/
    );
    assert.match(publicArtifactBlock, /\\b\[0-9\]\{19\}\\b/);
    assert.equal(
        /^(?!.*[0-9]{19})[A-Z0-9_]{1,100}$/.test(
            'ERR_1130510100107912280'
        ),
        false
    );
    assert.match(cleanupBlock, /rm -f -- "\$\{candidate\}"/);
    assert.match(cleanupBlock, /rmdir -- "\$\{root\}"/);
    assert.match(cleanupBlock, /test ! -e "\$\{root\}"/);
});

test('workflow는 full artifact를 로컬 gate에만 쓰고 strict 공개 artifact만 업로드한다', () => {
    const uploadBlock = workflow.slice(
        workflow.indexOf('- name: Upload sanitized run artifact'),
        workflow.indexOf('- name: Enforce development run gate')
    );
    const gateBlock = workflow.slice(
        workflow.indexOf('- name: Enforce development run gate')
    );
    assert.match(workflow, /--manifest-label "\$\{MANIFEST_LABEL\}"/);
    assert.match(
        workflow,
        /--public-out "\.development-land-area-sync\/public-artifact\.json"/
    );
    assert.match(
        uploadBlock,
        /path: development-land-area-sync-output\/public-artifact\.json/
    );
    assert.doesNotMatch(
        uploadBlock,
        /path: development-land-area-sync-output\/artifact\.json/
    );
    assert.match(
        gateBlock,
        /artifact_file="development-land-area-sync-output\/artifact\.json"/
    );
    assert.match(
        validatorCli,
        /createDevelopmentPublicRunArtifact[\s\S]+validateDevelopmentPublicRunArtifact/
    );
    assert.match(validatorCli, /flag: 'wx'/);
    assert.match(runner, /PUBLIC_RUN_ARTIFACT_INVALID/);
});

test('workflow는 SSH와 분리된 guardian이 공통 operation lock을 terminal drain과 cleanup까지 보유한다', () => {
    assert.match(
        guardian,
        /application_root="\$\{HOME\}\/alimtalk-proxy"[\s\S]+operation_lock_path="\$\{application_root\}\/\.land-area-sync-operation\.lock"/
    );
    assert.match(guardian, /exec 8>>"\$\{operation_lock_path\}"/);
    assert.match(guardian, /flock -w 300 8/);
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
    assert.match(workflow, /timeout-minutes: 420/);
    assert.match(guardian, /capture_timeout_seconds=3600/);
    assert.match(guardian, /runner_timeout_seconds=18000/);
    assert.match(guardian, /post_timeout_quarantine_seconds=720/);
    assert.match(
        guardian,
        /timeout --foreground --kill-after=30s "\$\{capture_timeout_seconds\}"[\s\S]+development-land-area-evidence-capture\.js/
    );
    assert.match(
        guardian,
        /timeout --foreground --kill-after=30s "\$\{runner_timeout_seconds\}"/
    );
    assert.match(
        guardian,
        /runner_status.*124.*runner_status.*137[\s\S]+sleep "\$\{post_timeout_quarantine_seconds\}"/
    );
    assert.ok(
        3_600 + 18_000 + 720 + 300 + 600 < 420 * 60,
        'lock/capture/runner/quarantine/cleanup은 workflow hard timeout에 setup 여유를 남겨야 한다'
    );
    assert.match(
        guardian,
        /host_self_cleanup_delay_seconds=1200[\s\S]+schedule_host_self_cleanup/
    );
    assert.match(
        guardian,
        /exec 8>&-[\s\S]+sleep "\$\{host_self_cleanup_delay_seconds\}"[\s\S]+rm -f --[\s\S]+artifact\.json[\s\S]+rmdir -- "\$\{host_root\}"/
    );
    assert.match(
        guardian,
        /cleanup_complete=1[\s\S]+write_private_line "\$\{host_status\}" "\$\{final_status\}"[\s\S]+schedule_host_self_cleanup[\s\S]+trap - EXIT/
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

test('DB 직접 접근은 target 축 service-role read-only select이며 write는 localhost canonical API에만 맡긴다', () => {
    // 접속 정보는 validateDevelopmentRunnerEnvironment 의 target 선택 결과만 쓴다.
    // 원시 env 를 CLI 에서 직접 집어 쓰는 경로는 금지한다.
    assert.match(cli, /environment\.supabaseUrl/);
    assert.match(cli, /environment\.supabaseServiceRoleKey/);
    assert.doesNotMatch(cli, /process\.env\.DEV_SUPABASE_URL/);
    assert.doesNotMatch(cli, /process\.env\.SUPABASE_URL/);
    // 선언한 target 과 실제 접속 프로젝트의 exact 일치를 강제한다.
    assert.match(
        cli,
        /SUPABASE_URL_BY_TARGET\[target\.databaseTarget\]/
    );
    assert.match(cli, /RUNNER_DATABASE_TARGET_MISMATCH/);
    assert.match(cli, /yxypndgipnxrdfyctmvh/);
    assert.match(cli, /bpdjashtxqrcgxfequgf/);
    assert.match(cli, /\.from\('property_units'\)[\s\S]+\.select\(/);
    assert.match(
        cli,
        /land_area_synced_at, land_area_sync_job_id/
    );
    // attribution 읽기는 writer job id 를 100건 chunk 로 나눠 `.in()` 한다.
    assert.match(
        cli,
        /\.in\('land_area_sync_job_id', syncJobIdChunk\)/
    );
    assert.match(
        cli,
        /readChunked\(\s*'DEVELOPMENT_WRITE_ATTRIBUTION',\s*\[\.\.\.new Set\(syncJobIds\)\]/
    );
    assert.doesNotMatch(
        cli,
        /\.(?:insert|update|upsert|delete|rpc)\s*\(/
    );
    assert.match(runner, /const LOCAL_API_ORIGIN = 'http:\/\/127\.0\.0\.1:3100'/);
    // JWT 는 서명키(kid)가 환경을 확정한다 — dev/prod 두 flavor 만 존재한다.
    assert.match(runner, /keyid: development \? 'dev' : 'prod'/);
    assert.match(
        runner,
        /iss: development \? 'tonghari-web-dev' : 'tonghari-web'/
    );
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
        /current\.status === 'PROCESSING'[\s\S]+!hasWorkerFinalization\(current\)/
    );
    assert.match(runner, /JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL/);
});

test('admission 응답 유실 진단 프로브는 고정 토큰 마커·카운트만 내보내고 원문 로그를 반출하지 않는다', () => {
    const probeCli = fs.readFileSync(
        path.join(root, 'src/cli/development-land-area-sync-probe.ts'),
        'utf8'
    );
    const probeModule = fs.readFileSync(
        path.join(
            root,
            'src/operations/land-area-sync-localhost-probe.ts'
        ),
        'utf8'
    );
    // guardian: fresh-process 프로브 + runner 센티널 승격 + 실패 시 카운트 마커
    assert.match(guardian, /development-land-area-sync-probe\.js/);
    assert.match(
        guardian,
        /append_stage "PRERUN_PROBE_EXIT_\$\{prerun_probe_status\}"/
    );
    assert.match(
        guardian,
        /\^LAND_AREA_SYNC_RUNNER_PROBE_\[A-Z0-9_\]\{1,44\}\$/
    );
    assert.match(
        guardian,
        /docker logs --since "\$\{probe_window_started_at\}"/
    );
    assert.match(guardian, /ADMISSION_202_LOGGED_/);
    assert.match(guardian, /RESPONSE_CLOSED_EARLY_/);
    assert.match(guardian, /GIS_AUTH_SLOW_LOGGED_/);
    // 서버 로그 원문은 stage/host 어디에도 쓰지 않는다 — grep 카운트만 쓴다.
    assert.doesNotMatch(
        guardian,
        /append_stage "\$\{server_http_window\}"|server_http_window[^\n]*>+ *"?\$\{host_/
    );
    // runner CLI: in-process 프로브 센티널(startup/postfail) — target 축 인증 전달
    assert.match(
        cli,
        /emitRunnerProbe\('STARTUP', args\.actorAuthUserId, probeAuth\)/
    );
    assert.match(
        cli,
        /emitRunnerProbe\(\s*'POSTFAIL',\s*args\.actorAuthUserId,\s*probeAuth\s*\)/
    );
    assert.match(
        cli,
        /ADMISSION\|API_NETWORK\|API_RESPONSE/
    );
    // 진단이 게이트 판정을 바꾸지 않는다 — 프로브는 exitCode에 관여하지 않는다.
    assert.match(cli, /LAND_AREA_SYNC_RUNNER_PROBE_\$\{phase\}_EXIT_/);
    // localhost client 타임아웃은 서버측 지연/유실 판별을 위해 60초다.
    assert.match(
        runner,
        /LOCAL_API_REQUEST_TIMEOUT_MS = 60_000/
    );
    assert.doesNotMatch(runner, /15_000/);
    // 프로브 출력은 고정 토큰·상태코드·소요시간뿐 — 식별자 출력 금지.
    assert.match(probeModule, /LAND_AREA_SYNC_PROBE_SUMMARY/);
    assert.doesNotMatch(
        probeCli,
        /anchorPnu|unionId|process\.env\.DEV_SUPABASE/
    );
});

test('image는 non-root runner private directory를 mode 700으로 준비한다', () => {
    assert.match(dockerfile, /\.development-land-area-sync/);
    assert.match(
        dockerfile,
        /\.development-land-area-evidence-capture/
    );
    assert.match(
        dockerfile,
        /chown -R nodejs:nodejs[\s\S]+\.development-land-area-sync[\s\S]+\.development-land-area-evidence-capture/
    );
    assert.match(
        dockerfile,
        /chmod 700[\s\S]+\.development-land-area-sync[\s\S]+\.development-land-area-evidence-capture/
    );
});

test('미아7 production read-only 캡처 경로는 캡처 워크플로에만 있고 합성 approval은 target 환경을 따른다', () => {
    const label =
        'mia-seven-full-278-official-components-api-readonly-production-20260812';
    const selection = captureWorkflow.slice(
        captureWorkflow.indexOf(`${label})`),
        captureWorkflow.indexOf(
            '*)',
            captureWorkflow.indexOf(`${label})`)
        )
    );
    assert.match(captureWorkflow, new RegExp(`- ${label}`));
    assert.match(
        selection,
        /mia-seven-full-278-official-components-api-readonly-production-target-20260812\.json/
    );
    assert.match(selection, /target_count="278"/);
    assert.match(selection, /property_unit_count="422"/);
    // 합성 approval 하드코딩 금지 — target 문서의 환경을 그대로 따라야 한다.
    assert.match(
        captureWorkflow,
        /databaseTarget: target\.databaseTarget/
    );
    assert.doesNotMatch(
        captureWorkflow,
        /databaseTarget: "development"/
    );
    // full-278 production(REVIEW 11 포함)은 write run 워크플로에 없어야 한다 —
    // write 는 검증된 standard-267 부분집합만 허용한다.
    assert.doesNotMatch(workflow, new RegExp(label));
    assert.doesNotMatch(
        workflow,
        /mia-seven-full-278-official-components-api-readonly-production-target-20260812\.json/
    );
    // dev 기본값은 그대로다.
    assert.match(
        captureWorkflow,
        /default: mia-seven-full-278-official-components-api-readonly-20260729/
    );
});

test('미아7 standard-267 production write 경로는 in-run 캡처 모드로만 있고 계약은 target 환경으로 갈린다', () => {
    const label =
        'mia-seven-standard-267-api-readonly-production-20260812';
    const selection = workflow.slice(
        workflow.indexOf(`${label})`),
        workflow.indexOf('*)', workflow.indexOf(`${label})`))
    );
    assert.match(workflow, new RegExp(`- ${label}`));
    // 환경식이 라벨 부분문자열로 갈리므로 production 라벨은 반드시 '-production-'
    // 을 포함해야 production 환경(리뷰어 승인)으로 간다.
    assert.ok(label.includes('-production-'));
    assert.match(
        selection,
        /mia-seven-standard-267-api-readonly-production-target-20260812\.json/
    );
    // in-run 캡처 모드 — 저장소에 커밋된 evidence/approval 파일을 쓰지 않는다.
    assert.match(
        selection,
        /db_approval_path=""[\s\S]+evidence_path=""[\s\S]+full_refresh_mode="1"/
    );
    // manifest 검증: dev 는 마커 필수, production 은 마커 부재 필수.
    assert.match(
        workflow,
        /if \(target\.databaseTarget === "development"\) \{[\s\S]+if \(!marker\) process\.exit\(1\);[\s\S]+\} else if \(marker !== null\) \{[\s\S]+process\.exit\(1\);/
    );
    // guardian: in-container 검증도 환경으로 갈린다 — production 은 same-run
    // official 0 을 요구하고, 합성 approval 은 target 환경을 따른다.
    assert.match(
        guardian,
        /development \? !marker : marker !== null/
    );
    assert.match(
        guardian,
        /audit\?\.databaseTarget !== target\.databaseTarget/
    );
    assert.match(
        guardian,
        /=== \(development \? target\.targetCount : 0\)/
    );
    assert.match(
        guardian,
        /databaseTarget: target\.databaseTarget/
    );
    assert.doesNotMatch(
        guardian,
        /databaseTarget: "development"/
    );
    // dev 기본값·기존 dev 경로는 그대로다.
    assert.match(workflow, /default: mia-seven-representative-20260725/);
});


test('삼양동(solsam) full-1086 production read-only 캡처 라벨은 캡처 워크플로에만 있고 라벨·아티팩트 규칙을 만족한다', () => {
    const label = 'solsam-full-1086-api-readonly-production-20260904';
    const selection = captureWorkflow.slice(
        captureWorkflow.indexOf(`${label})`),
        captureWorkflow.indexOf('*)', captureWorkflow.indexOf(`${label})`))
    );
    assert.match(captureWorkflow, new RegExp(`- ${label}`));
    assert.match(
        selection,
        /solsam-full-1086-api-readonly-production-target-20260904\.json/
    );
    // 활성 필지 1,086 anchor 전수 · 활성 물건지 1,607 — 캡처 카운트 검사(:135-152)
    // 는 이 값을 target 문서의 targetCount/expectedPropertyUnitCount 와 대조한다.
    assert.match(selection, /target_count="1086"/);
    assert.match(selection, /property_unit_count="1607"/);
    // 공개 아티팩트 빌드 단계의 라벨 규칙: ^[a-z0-9-]{1,100}$ 이고 19자리 숫자
    // (PNU 형상)를 포함하면 안 된다. 아티팩트 이름은 라벨을 그대로 쓴다.
    assert.match(label, /^[a-z0-9-]{1,100}$/);
    assert.doesNotMatch(label, /[0-9]{19}/);
    assert.match(
        captureWorkflow,
        /name: development-land-area-evidence-summary-\$\{\{ inputs\.manifest \}\}-\$\{\{ github\.run_id \}\}/
    );
    // 캡처 워크플로는 환경이 단일(dev backfill)이고 접속 DB 는 CLI 가 target 문서의
    // databaseTarget 으로 고른다 — 라벨은 '-production-' 관례를 따라야 한다.
    assert.ok(label.includes('-production-'));
    assert.match(captureWorkflow, /environment: land-area-sync-development-backfill/);
    // full 전수(REVIEW 집합 미확정)는 write run 워크플로에 있어서는 안 된다 —
    // write 는 캡처로 실증된 standard 부분집합 라벨을 별도로 추가할 때만 허용한다.
    assert.doesNotMatch(workflow, new RegExp(label));
    assert.doesNotMatch(
        workflow,
        /solsam-full-1086-api-readonly-production-target-20260904\.json/
    );
    // 기본값(dev)은 그대로다.
    assert.match(
        captureWorkflow,
        /default: mia-seven-full-278-official-components-api-readonly-20260729/
    );
});

test('두 워크플로의 라벨·case·target 파일명은 서로 정합하고 production 여부는 라벨 부분문자열과 파일명이 일치한다', () => {
    const dispatchOptions = (source: string): string[] => {
        const block = source.slice(
            source.indexOf('options:'),
            source.indexOf('permissions:')
        );
        return [...block.matchAll(/^\s+- ([a-z0-9-]+)$/gm)].map(
            (match) => match[1]
        );
    };
    const caseEntries = (
        source: string
    ): Array<{ label: string; targetPath: string }> =>
        [
            ...source.matchAll(
                /^ {12}([a-z0-9-]+)\)\n(?: {14}#[^\n]*\n)* {14}target_path="([^"]+)"/gm
            ),
        ].map((match) => ({ label: match[1], targetPath: match[2] }));

    const captureEntries = caseEntries(captureWorkflow);
    const runEntries = caseEntries(workflow);
    // 파서가 아무것도 못 잡고 통과하는 일이 없도록 건수를 고정한다.
    assert.equal(captureEntries.length, 13);
    assert.equal(runEntries.length, 8);
    // options ↔ case 라벨 집합이 같아야 한다(도달 불가 case·해석 불가 option 금지).
    assert.deepEqual(
        [...dispatchOptions(captureWorkflow)].sort(),
        captureEntries.map((entry) => entry.label).sort()
    );
    assert.deepEqual(
        [...dispatchOptions(workflow)].sort(),
        runEntries.map((entry) => entry.label).sort()
    );
    for (const entry of [...captureEntries, ...runEntries]) {
        // 라벨 규칙(공개 아티팩트 빌드 단계와 동일).
        assert.match(entry.label, /^[a-z0-9-]{1,100}$/);
        assert.doesNotMatch(entry.label, /[0-9]{19}/);
        assert.match(
            entry.targetPath,
            /^development-land-area-sync-manifests\/[a-z0-9-]+\.json$/
        );
        // '-production-' 라벨 ⇔ '-production-target-' 파일 — run 워크플로의
        // 환경식·actor 식이 이 부분문자열로 갈리므로 어긋나면 안 된다.
        assert.equal(
            entry.label.includes('-production-'),
            entry.targetPath.includes('-production-target-'),
            `${entry.label} 의 production 여부가 target 파일명과 어긋난다`
        );
        // case 가 가리키는 target 파일은 저장소에 실재하는 일반 파일이어야 한다 —
        // 누락이면 dispatch 뒤(환경 승인 소모 후) Resolve 스텝에서야 죽는다.
        const targetFile = path.join(root, entry.targetPath);
        assert.ok(
            fs.existsSync(targetFile) &&
                !fs.lstatSync(targetFile).isSymbolicLink(),
            `${entry.label} 의 target 파일이 없다: ${entry.targetPath}`
        );
        const size = fs.statSync(targetFile).size;
        assert.ok(size >= 2 && size <= 1_048_576);
    }
    // production 라벨은 두 워크플로 합쳐 정확히 이 여섯뿐이다.
    assert.deepEqual(
        [...new Set(
            [...captureEntries, ...runEntries]
                .filter((entry) => entry.label.includes('-production-'))
                .map((entry) => entry.label)
        )].sort(),
        [
            'mia-seven-full-278-official-components-api-readonly-production-20260812',
            'mia-seven-standard-267-api-readonly-production-20260812',
            'solsam-full-1086-api-readonly-production-20260904',
            'solsam-g1-40-api-readonly-production-20260907',
            'solsam-standard-a-851-api-readonly-production-20260904',
            'solsam-standard-b-101-api-readonly-production-20260904',
        ]
    );
    // write run 에 있는 solsam 라벨은 캡처로 실증된 standard A/B 와 잔여 G1 뿐이다
    // (전수 full 금지 — 제외 목록의 부분편입 필지가 무가드로 덮인다).
    assert.deepEqual(
        runEntries
            .map((entry) => entry.label)
            .filter((label) => label.startsWith('solsam-'))
            .sort(),
        [
            'solsam-g1-40-api-readonly-production-20260907',
            'solsam-standard-a-851-api-readonly-production-20260904',
            'solsam-standard-b-101-api-readonly-production-20260904',
        ]
    );
    for (const label of [
        'solsam-standard-a-851-api-readonly-production-20260904',
        'solsam-standard-b-101-api-readonly-production-20260904',
        'solsam-g1-40-api-readonly-production-20260907',
    ]) {
        const selection = workflow.slice(
            workflow.indexOf(`${label})`),
            workflow.indexOf('*)', workflow.indexOf(`${label})`))
        );
        // 미아7 standard-267 과 같은 in-run 캡처 모드 — 커밋된 evidence/approval 파일 없음.
        assert.match(
            selection,
            /db_approval_path=""[\s\S]+evidence_path=""[\s\S]+full_refresh_mode="1"/
        );
    }
});

test('러너 CLI 입력 상한은 8 MiB 이고 guardian 은 runner exit/실패 코드를 고정 토큰 마커로 남긴다 (2026-09-06 삼양동 창 A 재발 방지)', () => {
    // 851 anchor/965 물건 evidence(pretty JSON ≈1.1 MiB)가 1 MiB 상한에 걸려
    // 러너가 프로브 이전에 종료했고, guardian.log 는 host 에서 만료되어 원인이
    // 워크플로 로그 어디에도 남지 않았다.
    assert.match(cli, /const INPUT_SIZE_LIMIT = 8 \* 1024 \* 1024;/);
    const validateCli = fs.readFileSync(
        path.join(root, 'src/cli/development-land-area-sync-validate.ts'),
        'utf8'
    );
    assert.match(validateCli, /const INPUT_SIZE_LIMIT = 8 \* 1024 \* 1024;/);
    // 고정 어휘 plain Error(CLI_*)는 코드 그대로, 그 외는 UNEXPECTED 로 뭉갠다.
    assert.match(cli, /const FIXED_FAILURE_CODE_RE = \/\^\[A-Z\]\[A-Z0-9_\]\{1,47\}\$\//);
    assert.match(
        cli,
        /`LAND_AREA_DEVELOPMENT_RUNNER_ERROR:\$\{runnerFailureCode\(error\)\}\\n`/
    );
    assert.match(guardian, /append_stage "RUNNER_EXIT_\$\{runner_status\}"/);
    assert.match(
        guardian,
        /\^LAND_AREA_DEVELOPMENT_RUNNER_ERROR:\(\[A-Z0-9_\]\{1,48\}\)\$/
    );
    assert.match(guardian, /append_stage "RUNNER_ERROR_\$\{BASH_REMATCH\[1\]\}"/);
    // 마커는 workflow 의 `^[A-Z0-9_]{1,64}$` 필터를 통과해야 한다: 13 + 48 ≤ 64.
    assert.ok('RUNNER_ERROR_'.length + 48 <= 64);
});

test('러너 anchor 재시도(최대 10회)는 고정 토큰 마커로 guardian 을 거쳐 워크플로 로그에 남는다', () => {
    assert.match(runner, /export const DEVELOPMENT_ANCHOR_MAX_RETRIES = 10;/);
    // admission POST 5xx → durable 부재 확인 코드도 재시도 대상.
    assert.match(runner, /startsWith\('AMBIGUOUS_ADMISSION_NOT_DURABLE'\)/);
    assert.match(runner, /function isRetryableAnchorFailure\(/);
    assert.match(runner, /throw new ControlledRunnerError\('APPLY_JOB_FAILED'\);/);
    // CLI: 재시도마다 시도 번호·실패 코드, 종료 시 총계. 식별자(PNU 등)는 출력하지 않는다.
    assert.match(cli, /onAnchorRetry\(event\)/);
    assert.match(cli, /`LAND_AREA_SYNC_RUNNER_RETRY_\$\{event\.attempt\}_\$\{code\}\\n`/);
    assert.match(cli, /`LAND_AREA_SYNC_RUNNER_RETRY_TOTAL_\$\{anchorRetryCount\}\\n`/);
    assert.doesNotMatch(cli, /RUNNER_RETRY_[^\n]*event\.pnu/);
    // guardian: RETRY 마커도 stage 로 승격(상한 16).
    assert.match(
        guardian,
        /\^LAND_AREA_SYNC_RUNNER_RETRY_\[A-Z0-9_\]\{1,44\}\$/
    );
    assert.match(guardian, /runner_retry_marker_count}" -lt 16/);
    // 총계 마커는 마지막에 나오므로 상한과 무관하게 승격한다.
    assert.match(
        guardian,
        /\^LAND_AREA_SYNC_RUNNER_RETRY_TOTAL_\[0-9\]\{1,6\}\$/
    );
    // 마커 길이 예산: workflow 는 64자를 넘는 줄이 하나라도 있으면 stage 로그 전체를 억제한다.
    assert.match(cli, /\/\^\[A-Z0-9_\]\{1,32\}\$\/\.test\(event\.failureCode\)/);
    assert.ok('LAND_AREA_SYNC_RUNNER_RETRY_'.length + 2 + 1 + 32 <= 64);
});

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# GitHub SSH session과 분리된 host-side guardian이다. 이 프로세스가 operation
# lock을 직접 보유하므로 workflow 취소/SSH 단절이 진행 중인 API job과 lock을
# 분리하지 못한다. runner는 admission된 job을 durable terminal까지 drain한다.

uuid_pattern='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
sha_pattern='^[0-9a-f]{40}$'
if [[
  ! "${RUN_KEY:-}" =~ ^[0-9]+-[0-9]+$
  || ! "${ACTOR_AUTH_USER_ID:-}" =~ ${uuid_pattern}
  || ! "${EXPECTED_GIT_SHA:-}" =~ ${sha_pattern}
  || "${EXPECTED_IMAGE_TAG:-}" != "ghcr.io/dlswn666/alimtalk-proxy:${EXPECTED_GIT_SHA}"
 ]]; then
  exit 64
fi

container_name="alimtalk-proxy"
application_root="${HOME}/alimtalk-proxy"
host_root="${application_root}/.development-land-area-sync-workflow/${RUN_KEY}"
host_target="${host_root}/target.json"
host_db_approval="${host_root}/db-approval.json"
host_evidence="${host_root}/evidence.json"
host_artifact="${host_root}/artifact.json"
host_status="${host_root}/status"
host_validated="${host_root}/validated"
host_started="${host_root}/guardian-started"
operation_lock_path="${application_root}/.land-area-sync-operation.lock"
container_root="/app/.development-land-area-sync"
container_target="${container_root}/target-${RUN_KEY}.json"
container_db_approval="${container_root}/db-approval-${RUN_KEY}.json"
container_evidence="${container_root}/evidence-${RUN_KEY}.json"
container_artifact="${container_root}/artifact-${RUN_KEY}.json"
validation_sentinel="LAND_AREA_DEVELOPMENT_RUN_ARTIFACT_VALIDATED"
target_container=""
cleanup_complete=0
final_status=90

write_private_line() {
  local target="$1"
  local value="$2"
  local temporary="${target}.tmp.$$"
  local write_status=0
  if ! install -m 600 /dev/null "${temporary}"; then
    write_status=1
  fi
  if ! printf '%s\n' "${value}" > "${temporary}"; then
    write_status=1
  fi
  if ! mv -f -- "${temporary}" "${target}"; then
    write_status=1
  fi
  if ! chmod 600 "${target}"; then
    write_status=1
  fi
  return "${write_status}"
}

verify_absent() {
  local candidate
  for candidate in "$@"; do
    if [[ -e "${candidate}" || -L "${candidate}" ]]; then
      return 1
    fi
  done
}

cleanup_container_inputs() {
  if [[ -z "${target_container}" ]]; then
    return 0
  fi
  local cleanup_status=0
  if ! docker exec "${target_container}" rm -f -- \
      "${container_target}" \
      "${container_db_approval}" \
      "${container_evidence}" \
      "${container_artifact}"
  then
    cleanup_status=1
  fi
  local candidate
  for candidate in \
    "${container_target}" \
    "${container_db_approval}" \
    "${container_evidence}" \
    "${container_artifact}"
  do
    if ! docker exec "${target_container}" test ! -e "${candidate}"; then
      cleanup_status=1
    fi
  done
  return "${cleanup_status}"
}

cleanup_host_inputs() {
  local cleanup_status=0
  if ! rm -f -- \
      "${host_target}" \
      "${host_db_approval}" \
      "${host_evidence}"
  then
    cleanup_status=1
  fi
  if ! verify_absent \
      "${host_target}" \
      "${host_db_approval}" \
      "${host_evidence}"
  then
    cleanup_status=1
  fi
  return "${cleanup_status}"
}

finish_guardian() {
  local prior_status="$?"
  trap - EXIT
  set +e
  local cleanup_status=0
  if [[ "${cleanup_complete}" -ne 1 ]]; then
    cleanup_container_inputs
    if [[ "$?" -ne 0 ]]; then
      cleanup_status=1
    fi
    cleanup_host_inputs
    if [[ "$?" -ne 0 ]]; then
      cleanup_status=1
    fi
  fi
  if [[ "${prior_status}" -ne 0 || "${cleanup_status}" -ne 0 ]]; then
    final_status=90
  fi
  write_private_line "${host_status}" "${final_status}"
  local status_write_status="$?"
  set -e
  if [[ "${status_write_status}" -ne 0 ]]; then
    exit 91
  fi
  exit 0
}

# nohup/setsid guardian은 workflow cancellation의 HUP과 SSH 단절에 영향받지
# 않는다. TERM/INT도 foreground runner가 terminal drain을 마칠 때까지 무시한다.
trap ':' HUP INT TERM
trap finish_guardian EXIT

if [[ ! -e "${operation_lock_path}" && ! -L "${operation_lock_path}" ]]; then
  if ! (
    umask 077
    set -o noclobber
    : > "${operation_lock_path}"
  ) 2>/dev/null; then
    test -f "${operation_lock_path}"
    test ! -L "${operation_lock_path}"
  fi
fi
if [[ ! -f "${operation_lock_path}" || -L "${operation_lock_path}" ]] \
  || [[ "$(stat -c '%u' "${operation_lock_path}")" != "$(id -u)" ]] \
  || [[ "$(stat -c '%a' "${operation_lock_path}")" != "600" ]]; then
  exit 65
fi
exec 8>>"${operation_lock_path}"
if ! flock -w 900 8; then
  exit 66
fi

test -d "${host_root}"
test ! -L "${host_root}"
test "$(stat -c '%u' "${host_root}")" = "$(id -u)"
test "$(stat -c '%a' "${host_root}")" = "700"
for candidate in \
  "${host_target}" \
  "${host_db_approval}" \
  "${host_evidence}"
do
  test -f "${candidate}"
  test ! -L "${candidate}"
  test "$(stat -c '%u' "${candidate}")" = "$(id -u)"
  test "$(stat -c '%a' "${candidate}")" = "600"
  size="$(stat -c '%s' "${candidate}")"
  test "${size}" -ge 2
  test "${size}" -le 1048576
done

target_container="$(docker inspect --format '{{.Id}}' "${container_name}")"
target_image_id="$(docker inspect --format '{{.Image}}' "${container_name}")"
target_revision="$(
  docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "${target_image_id}"
)"
if [[
  ! "${target_container}" =~ ^[0-9a-f]{64}$
  || ! "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$
  || "${target_revision}" != "${EXPECTED_GIT_SHA}"
 ]]; then
  exit 67
fi

verify_health() {
  docker exec \
    -e "EXPECTED_GIT_SHA=${EXPECTED_GIT_SHA}" \
    -e "EXPECTED_IMAGE_TAG=${EXPECTED_IMAGE_TAG}" \
    "${target_container}" \
    node -e '
      const http = require("node:http");
      const reject = () => process.exit(1);
      const request = http.get(
        "http://127.0.0.1:3100/health",
        { timeout: 5000 },
        (response) => {
          if (response.statusCode !== 200) return reject();
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 65536) request.destroy();
          });
          response.on("end", () => {
            try {
              const health = JSON.parse(body);
              if (
                health?.status !== "ok"
                || health?.gitSha !== process.env.EXPECTED_GIT_SHA
                || health?.imageTag !== process.env.EXPECTED_IMAGE_TAG
              ) return reject();
              process.exit(0);
            } catch {
              reject();
            }
          });
        }
      );
      request.on("timeout", () => request.destroy());
      request.on("error", reject);
    '
}

stream_file() {
  local source="$1"
  local target="$2"
  docker exec -i \
    -e "PRIVATE_INPUT_PATH=${target}" \
    "${target_container}" \
    node -e '
      const fs = require("node:fs");
      const target = process.env.PRIVATE_INPUT_PATH ?? "";
      if (!/^\/app\/\.development-land-area-sync\/[a-z-]+-[0-9]+-[0-9]+\.json$/.test(target)) {
        process.exit(1);
      }
      const chunks = [];
      let size = 0;
      process.stdin.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1048576) process.exit(1);
        chunks.push(chunk);
      });
      process.stdin.on("end", () => {
        if (size < 2) process.exit(1);
        fs.writeFileSync(target, Buffer.concat(chunks), {
          flag: "wx",
          mode: 0o600,
        });
      });
      process.stdin.on("error", () => process.exit(1));
    ' < "${source}"
}

verify_health
stream_file "${host_target}" "${container_target}"
stream_file "${host_db_approval}" "${container_db_approval}"
stream_file "${host_evidence}" "${container_evidence}"
write_private_line "${host_started}" "$$"

set +e
docker exec -w /app "${target_container}" \
  node dist/cli/development-land-area-sync-runner.js \
  --target ".development-land-area-sync/target-${RUN_KEY}.json" \
  --db-approval ".development-land-area-sync/db-approval-${RUN_KEY}.json" \
  --evidence ".development-land-area-sync/evidence-${RUN_KEY}.json" \
  --actor-auth-user-id "${ACTOR_AUTH_USER_ID}" \
  --out ".development-land-area-sync/artifact-${RUN_KEY}.json"
runner_status="$?"
set -e
final_status="${runner_status}"

if [[ "${runner_status}" -eq 0 || "${runner_status}" -eq 1 ]]; then
  validation_output="$(
    docker exec -w /app "${target_container}" \
      node dist/cli/development-land-area-sync-validate.js \
      --target ".development-land-area-sync/target-${RUN_KEY}.json" \
      --artifact ".development-land-area-sync/artifact-${RUN_KEY}.json"
  )"
  if [[ "${validation_output}" != "${validation_sentinel}" ]]; then
    final_status=92
  else
    verify_health
    container_after="$(docker inspect --format '{{.Id}}' "${container_name}")"
    if [[ "${container_after}" != "${target_container}" ]]; then
      final_status=93
    else
      docker cp "${target_container}:${container_artifact}" "${host_artifact}"
      chmod 600 "${host_artifact}"
      artifact_sha="$(sha256sum "${host_artifact}" | awk '{print $1}')"
      write_private_line \
        "${host_validated}" \
        "${validation_sentinel}:${artifact_sha}"
    fi
  fi
fi

# 민감/evidence input은 operation lock을 놓기 전에 host/container 양쪽에서
# 제거하고 부재를 다시 검사한다. cleanup 실패는 status 90으로 green을 금지한다.
cleanup_container_inputs
cleanup_host_inputs
cleanup_complete=1
write_private_line "${host_status}" "${final_status}"
trap - EXIT
exit 0

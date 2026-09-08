# 통하리 공공 GIS MCP 운영 런북

## 운영 표면

- endpoint: `POST /gis-mcp` (MCP `2026-07-28` modern 경로와 Codex용
  `2025-06-18` stateless 경로; 그 외 revision을 명시한 후속 요청은 거부하고
  GET/DELETE는 405)
- read-only tools: 기존 versioned 5개 도구 + `lookup_full_gis_public_data_v1`
- prompt: 공개 데이터 검토 prompt 1개
- resource: `tonghari-gis://policy/public-data/v1`
- health: `GET /health`, `GET /health/detailed`의 `gisMcp*` 필드

필수 설정이 없거나 형식이 잘못되면 `/gis-mcp`만 503
`GIS_MCP_NOT_CONFIGURED`로 닫힌다. 기존 API와 법률 `/mcp`는 계속 동작한다.

## 필수 환경변수

| 변수 | 의미 |
|---|---|
| `VWORLD_API_KEY` | VWorld 운영키. 원문은 서버 secret에만 둔다. |
| `VWORLD_API_DOMAIN` | VWorld에 등록한 서비스 URL의 hostname과 동일해야 한다. |
| `DATA_PORTAL_API_KEY` | 건축HUB serviceKey. Encoding/Decoding 키를 1회 정규화한다. |
| `GIS_MCP_TOKEN_REGISTRY_FILE` | 운영 권장 client registry의 container 절대 경로. regular non-symlink, app UID 1001 소유, mode `600` |
| `GIS_MCP_TOKEN_REGISTRY_JSON` | 최초 file 이전·로컬 개발용 client registry. 1~32개 client, raw bearer 금지 |
| `GIS_MCP_TOKEN_SHA256` | legacy 단일 client digest. 신규 운영에는 사용하지 않음 |
| `GIS_MCP_PROXY_TOKEN_SHA256` | Caddy 전용 raw proxy secret의 서버측 digest |
| `GIS_MCP_ALLOWED_HOSTS` | scheme/port/path 없는 hostname allowlist |
| `GIS_MCP_ALLOWED_ORIGINS` | Origin을 보내는 서버 client allowlist, 선택 |
| `GIS_MCP_REQUESTS_PER_MINUTE` | bearer별 upstream 도구 분당 제한, 기본 20 |
| `GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE` | 프로세스 전체 분당 제한, 기본 40 |
| `GIS_MCP_REQUEST_DEADLINE_MS` | admission 포함 전체 deadline, 기본 45000ms |
| `GIS_MCP_MAX_CONCURRENCY` | 동시 upstream 도구 상한, 기본 2 |
| `GIS_MCP_MAX_QUEUE` | 대기 요청 상한, 기본 4 |

`GIS_MCP_TOKEN_REGISTRY_FILE`, `GIS_MCP_TOKEN_REGISTRY_JSON`,
`GIS_MCP_TOKEN_SHA256` 중 둘 이상을 동시에 설정하면 우선순위나 병합 없이
잘못된 구성으로 판정한다. 운영은 file registry만 사용하며 서버에는
`clientId`와 SHA-256 digest만 남긴다.

```bash
npm run gis:mcp:token -- client-generate --client-id codex-mac-202609
npm run gis:mcp:token -- client-digest --client-id codex-mac-202609
npm run gis:mcp:token -- proxy-generate
```

raw bearer는 client secret store에만, raw proxy token은 Caddy owner-only secret에만
둔다. API와 배포 secret에는 digest만 저장한다.

## EC2 file registry와 hot reload

소수 초대 client는 법률 MCP와 분리된 다음 GIS 전용 경로를 사용한다.

```text
host directory  /home/ubuntu/alimtalk-proxy/.gis-mcp-secrets
host file       /home/ubuntu/alimtalk-proxy/.gis-mcp-secrets/clients.json
container dir   /run/secrets/tonghari-gis-mcp
container file  /run/secrets/tonghari-gis-mcp/clients.json
```

host directory는 UID/GID `1001:1001`, mode `700`, `clients.json`은 UID `1001`,
mode `600`을 유지한다. 메인 container에는 file 자체가 아닌 상위 directory를
다음과 같이 read-only bind mount한다.

```text
type=bind,src=/home/ubuntu/alimtalk-proxy/.gis-mcp-secrets,dst=/run/secrets/tonghari-gis-mcp,readonly
```

file만 bind mount하면 atomic rename 후 container가 이전 inode를 계속 볼 수 있으므로
금지한다. 서버는 auth·health 요청 시 변경 fingerprint를 확인하고 변경된
registry를 재검증한다. 누락, symlink, 권한, schema 오류는 기존 snapshot을
계속 쓰지 않고 `/gis-mcp`를 fail-closed한다. 정상 add/revoke는 재배포나
container 재시작 없이 바로 반영된다.
인증에 성공한 요청은 client ID, 안전하게 정규화한 MCP method/tool 이름,
HTTP 상태, 처리시간, 완료 여부만 감사 로그에 남긴다. bearer, 요청 본문, IP는
기록하지 않으며 rate-limit 등 인증 후 거부도 같은 client ID로 추적한다.

## 최초 JSON → file 배포 이전

`.github/workflows/docker-build.yml`은 최초 1회에 한해 기존 EC2 `.env`의
`GIS_MCP_TOKEN_REGISTRY_JSON`을 새 이미지의 no-network one-shot helper로 file에
이전한다. registry 원문은 GitHub input, step environment, stdout, artifact로
전송하지 않는다. 기존 file이 있으면 `.env` JSON과 semantic equality가 증명될
때만 재사용한다.

원본 `.env`를 유지한 채 file-only next env로 candidate와 final을 검증하고,
final health 통과를 commit point로 삼는다. commit point 전 실패는 기존
container를 복구한다. 통과 후에는 구 env-mode rollback 제거, file-only
`.env` atomic install, deploy-user 소유 mode `600`의
`.gis-mcp-file-registry-v1` marker 생성 순서로 마감한다. 이 단계의
cleanup 실패는 폐기된 env token을 복원하지 않고 새 file-mode container를
유지한 채 exit `71`로 수동 조치를 요청한다.

최초 설정을 쓰기 전에는 `.github/workflows/gis-mcp-initial-activation-audit.yml`을
`main`에서 수동 실행한다. 이 workflow는 보호 environment `gis-mcp-registry`와 기존
EC2 fingerprint 고정 SSH 연결을 사용하며, production lock 아래에서 다음 항목의
상태만 출력한다.

- VWorld·건축HUB key 및 VWorld domain의 존재·형식. 최초 활성화
  직전에 `VWORLD_API_DOMAIN`과 legacy `VWORLD_DOMAIN`이 모두 없으면
  저장소 canonical 기본값 `www.tonghari.kr`을 prepare 단계에서
  명시적으로 추가할 수 있는 `missing-bootstrapable`로 판정한다.
  이 호스트는 prepare 전 VWorld 인증키 관리의 서비스 URL과 다시
  일치하는지 확인한다. 두 변수 중 다른 값이 이미 있거나 legacy
  변수가 남아 있으면 덮어쓰지 않고 감사를 중단한다.
- GIS 인증 source, proxy digest, Host allowlist, file marker·registry의 미설정 여부
- 현재 container가 `disabled`와 client/token `0/0`인지 여부
- `/opt/caddy/Caddyfile`, root-only proxy env, Caddy container가 문서화한 baseline인지 여부

provider key, proxy 원문, client bearer, registry JSON, digest는 출력하지 않는다.
`stageReady=true`는 최초 쓰기를 해도 되는 구조적 전제조건일 뿐 provider 실제 호출
성공을 뜻하지 않는다. Caddy baseline hash나 상태가 예상과 다르면 템플릿으로
덮어쓰지 말고 실제 운영 구성을 별도로 검토한다.

## 최초 활성화 승인·배포·공개 순서

최초 활성화는 `.github/workflows/gis-mcp-initial-activation.yml`의
`prepare → status → publish`와 `.github/workflows/docker-build.yml`의 승인된 수동
배포를 조합한다. EC2에서 Git 저장소를 pull하거나 checkout하지 않는다. GitHub Actions가
승인된 `main` revision으로 immutable GHCR 이미지를 만든 뒤 EC2에 그 digest를 배포하는
기존 간접 연동만 사용한다.

초기 client도 별도 `ADMIN`/`USER` role을 갖지 않는다. GIS registry entry는
`clientId + tokenSha256`이고 인증된 모든 entry가 동일한 read-only `gis:read` scope를
받는다. 따라서 “일반 사용자 추가”는 개인정보 없는 client ID로 별도 bearer를 등록하는
것을 뜻한다. 현재 Mac client처럼 `codex-mac-gis-202609` 형식을 쓰고, 사람 이름·이메일·
전화번호를 client ID에 넣지 않는다.

1. client raw bearer를 로컬에서 생성해 macOS Keychain 같은 client secret store에만
   저장한다. raw bearer를 GitHub, EC2 명령행, 저장소, 로그에 넣지 않는다.
2. bearer의 SHA-256 digest와 다음 canonical JSON의 commitment를 로컬에서 계산한다.
   environment `gis-mcp-registry`의 임시 secret
   `GIS_MCP_REGISTRY_PENDING_SHA256`에는 digest만 둔다.

   ```text
   SHA-256(JSON.stringify({
     version: 1,
     operationId: "<activation-id>",
     action: "add",
     clientId: "<client-id>",
     tokenSha256: "<64-hex-token-digest>"
   }))
   ```

3. 보호 environment 승인 후 initial activation workflow를 다음 동일 binding으로
   `prepare` 실행한다.
   `activation_id`, `client_id`, 감사에서 확인한 `expected_caddyfile_sha256`,
   `pending_digest_commitment`를 입력한다. workflow와 원격 operator가 digest를 각각
   commitment에 재결합하며, digest는 마스킹 후 SSH stdin 한 줄로만 보낸다.
4. `prepare`는 현재 배포 SHA·법률 MCP `1/1`·GIS disabled `0/0`·loopback 3100·
   legal-only Caddy exact baseline을 다시 확인한다. 그 뒤 EC2 `.env`에만 단일-client
   JSON registry, proxy digest, Host allowlist와 필요한 경우 canonical VWorld domain을
   staging한다. GIS proxy raw는 EC2 root process가 새로 만들고 root-only Caddy candidate에만
   저장한다. 이 단계에서는 현재 Caddyfile/container를 바꾸지 않아 `/gis-mcp`를 공개하지 않는다.
5. 성공한 prepare는 deploy-user 소유 mode `600`의
   `.gis-mcp-initial-activation-prepared-v1`을 다음 6줄로 원자 게시한다.

   ```text
   version=1
   activationId=<activation-id>
   clientId=<client-id>
   gitSha=<40-hex-main-revision>
   runtimeEnvSha256=<64-hex-staged-env-digest>
   tokenCommitment=<64-hex-commitment>
   ```

   prepare 결과와 6줄 binding을 확인하면 임시 GitHub
   `GIS_MCP_REGISTRY_PENDING_SHA256`을 즉시 삭제한다. 이후 `status`, Docker 배포,
   `publish`, `recover`는 digest secret 없이 receipt·commitment로 검증한다.

6. Docker workflow를 `workflow_dispatch`로 실행하면서 같은
   `gis_mcp_activation_id`, `gis_mcp_token_commitment`를 입력한다. 일반 `push`와 GitHub
   re-run은 JSON bootstrap을 거부한다. 배포는 준비 파일의 SHA·`.env` digest·commitment를
   검증하고, 새 이미지의 no-network helper로 file registry를 만든 뒤 candidate/final health와
   registry attestation을 통과해야 commit한다.
7. 배포 commit 뒤에만 준비 파일을
   `.gis-mcp-initial-activation-receipts/<activation-id>`로 atomic rename한다. 같은 6줄을
   유지하므로 publish는 승인된 staged env가 실제 배포에서 소비됐음을 다시 증명할 수 있다.
8. initial activation workflow의 `status`가 `deployed`인지 확인한 뒤 같은 binding으로
   `publish`한다. publish는 file-only env, marker, UID `1001` registry, client commitment,
   GIS `vworld_and_data_portal` health와 기존 법률 MCP health를 모두 확인한 뒤에만 root-only
   Caddy candidate를 설치·재시작한다.
9. publish는 public GIS 무인증/잘못된 bearer `401`, loopback proxy 증명 없음 `403`,
   public 법률 MCP 무인증 `401`, loopback 법률 MCP proxy 증명 없음 `403`을 확인한다.
   실패하면 원래 Caddy를 복구하며, 어느 쪽 endpoint인지 증명할 수 없으면 exit `75`
   `COMMIT_STATE_UNKNOWN`으로 닫는다.
10. publish와 실제 client `tools/list`, 5개 provider live 호출까지 확인한다. 임시 GitHub
    digest secret이 prepare 직후 삭제됐는지도 다시 확인한다. Codex client 설정 파일 작성과
    client-side 승인/연결은 별도 gate이며, 설정 파일만 존재하는 상태를 연결 완료로 보고하지 않는다.

`rollback`은 준비 파일이 아직 있고 deployment receipt·file marker·registry가 모두 없는
배포 전 단계에서만 허용한다. 배포가 file migration을 commit한 뒤에는 구 JSON env로
돌리지 않는다. state-changing operation의 GitHub re-run은 금지한다. exit `75` 또는
`.gis-mcp-initial-activation-commit-unknown`이 보이면 mutation을 재시도하지 말고 같은
binding의 `status`로 관찰한 뒤 `recover`로 현재 endpoint를 수렴시킨다.
unknown marker는 prepare 당시 Git SHA와 승인된 Caddy SHA도 보존하므로 그 뒤 `main`이
이동해도 과거 receipt/state와 교차검증한다. Caddy 두 파일 교체 또는 container 재시작
중 중단된 경우 `recover`는 root-only backup으로 legal-only endpoint를 먼저 복구한다.
publish가 성공하고 backup/stage 정리만 실패하면 `status`는 `cleanupRequired=true`와
exit `71`을 반환하며, `recover`가 활성 endpoint를 재증명한 뒤 잔여 복사본만 제거한다.

### Acceptance checklist

- [ ] 기획/분석: 최신 `main`의 감사 run이 `stageReady=true`이고 VWorld 서비스 URL,
  Caddy baseline SHA, 현재 API revision을 별도 증거로 확인했다.
- [ ] 구현: `prepare` receipt의 6개 필드와 Docker dispatch의 ID·SHA·commitment가 정확히
  일치하며, EC2에는 Git checkout이 없다.
- [ ] 구현: 일반 GIS client는 별도 client ID/digest 한 건이고 registry/client scope는
  read-only `gis:read`이며 raw bearer는 client secret store에만 있다.
- [ ] 리뷰: 법률 `/mcp`, fallback API route, `encode gzip`, Caddy image/network/volume/
  restart contract가 candidate에도 보존됐다.
- [ ] 검증: Docker migration 후 marker, file-only env, registry owner/mode, commitment,
  GIS/법률 health가 모두 통과했다.
- [ ] 검증: publish의 public/loopback `401/403` 경계와 client `tools/list`가 통과했다.
- [ ] 검증: partial Caddy swap, prepare intent-only, publish cleanup-only interruption이
  각각 `recover`로 legal-only 또는 완료 상태에 수렴하고, 과거 activation Git SHA를 유지했다.
- [ ] 검증: 다섯 GIS 도구의 실제 provider 호출과 출처 metadata를 확인했다.
- [ ] 완료: 임시 GitHub digest secret을 삭제했고, client 설정·승인·실제 연결 상태를
  서로 구분해 기록했다.

## 소수 client 초대·폐기·회전

client ID는 개인정보 없는 lowercase 영문·숫자·단일 하이픈 조합으로 정한다.
신규 bearer는 다음 감사된 CLI로 만들고 raw 값은 한 번만 client 소유자에게
보안 전달한다.

```bash
npm run gis:mcp:token -- client-generate --client-id claude-gis-202609
npm run gis:mcp:token -- client-digest --client-id claude-gis-202609
```

`.github/workflows/gis-mcp-client-registry.yml`은 `main`의 수동 dispatch와
보호 environment `gis-mcp-registry`에서만 실행한다. environment에는 required
reviewer와 `main` deployment branch 제한을 설정하고 EC2 접속 secret 외에
`add`의 1회성 digest용 `GIS_MCP_REGISTRY_PENDING_SHA256`만 임시로 둔다.
raw bearer를 GitHub에 저장하지 않는다. workflow는 `validate`, `list`, `add`,
`revoke`, `recover`를 지원하고 `gis-mcp-client-registry-production`
concurrency로 운영 mutation을 직렬화한다.

`add`는 environment secret의 digest와 dispatch input의
`pending_digest_commitment`가 다음 canonical 객체에 같이 묶여 있을 때만
SSH stdin으로 전달한다.

```text
SHA-256(JSON.stringify({
  version: 1,
  operationId: "<opaque-operation-id>",
  action: "add",
  clientId: "<opaque-client-id>",
  tokenSha256: "<64-hex-token-digest>"
}))
```

원격 operator도 stdin digest로 같은 commitment를 다시 계산하고, `add` 게시 뒤
registry에 실제 저장된 해당 client digest로 commitment를 독립 재계산한다. 둘이
다르면 count/client ID가 맞아도 `verified`로 확정하지 않는다. operation marker와
receipt v4에는 digest 원문 대신 `tokenCommitment`, 실행한 operator의
`scriptSha256`만 기록하며 새 mutation의 `operation_id`가 기존 marker 또는 durable
receipt와 중복되면 fail-closed한다.

순서는 **environment secret 임시 설정 → 대응 ID·commitment로 1회 dispatch
→ 최종 상태 확인 → environment secret 삭제**다. `add`, `revoke`, `recover`는
GitHub re-run을 금지하며 실패 후에는 새 operation ID로 판정한다.
`COMMIT_STATE_UNKNOWN`이나 미해결 `.gis-mcp-registry-commit-unknown`이 있으면
재시도하지 말고 `list`/`validate`로 count와 target state를 확정한 뒤
동일 `client_id`, `expected_client_count`, `expected_client_state=present|absent`로
guarded `recover`를 실행한다. recover는 registry entry를 변경하지 않고
정확히 검증된 operation 증거만 수렴시킨다. `intent`/`unknown`도 현재 상태가
정확히 pre/post endpoint 하나와만 일치해야 하며, 그 판정 결과를 mode `600`
terminal receipt로 원자 게시·fsync·재검증한 뒤에만 marker를 삭제한다. 게시 도중
중단되면 다음 recover가 terminal receipt 또는 `.tmp`와 죽은 이전 recover run
증거를 검증해 이어서 수렴한다.

무중단 회전은 **새 세대 client ID `add` → 새 raw bearer로 `tools/list`
HTTP 200 확인 → 구 ID `revoke` → 구 bearer HTTP 401 확인** 순서다.
마지막 1개 client를 단독으로 revoke하지 않는다. 운영 갱신은 배포와
같은 `.tonghari-api-production.lock`을 사용하며 registry·operation marker·receipt는
법률 MCP의 경로나 secret과 공유하지 않는다.

## Caddy exact route

법률 MCP와 GIS MCP proxy token은 서로 재사용하지 않는다.

```caddyfile
api.tonghari.kr {
    @legal_mcp path /mcp
    handle @legal_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-MCP-Proxy-Token {$LEGAL_MCP_PROXY_TOKEN}
        }
    }

    @gis_mcp path /gis-mcp
    handle @gis_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-GIS-MCP-Proxy-Token {$GIS_MCP_PROXY_TOKEN}
        }
    }

    handle {
        reverse_proxy 127.0.0.1:3100
    }

    encode gzip
}
```

3100은 loopback 또는 host firewall/security group에서 공개 ingress를 차단한다.

## Codex client 예시

```toml
[mcp_servers.tonghari_gis]
url = "https://api.tonghari.kr/gis-mcp"
bearer_token_env_var = "TONGHARI_GIS_MCP_TOKEN"
enabled = true
required = true
enabled_tools = [
  "resolve_address_to_pnu_v1",
  "lookup_parcel_public_data_v1",
  "lookup_building_register_v1",
  "lookup_housing_official_price_v1",
  "lookup_land_right_registration_v1"
]
```

## 운영 활성화 gate

1. VWorld 운영키 신청/변경 내역에 통하리 상용 MCP 조회 용도가 포함됐는지 확인한다.
2. 건축HUB 운영계정과 호출량을 확인하고 필요하면 활용사례 등록 후 증설한다.
3. MCP 서버의 조회 경로에는 영구 저장을 추가하지 않고 모든 응답에 VWorld 출처를 유지한다.
   소비자의 별도 저장 경로까지 금지하는 내부 경고·지시는 2026-09-08 사용자 요청으로 제거했다.
   원천 서비스의 이용조건이나 자료별 이용허락을 변경한다는 의미는 아니다.
4. Caddy/API의 proxy raw/digest가 같은 발급 쌍인지 값을 출력하지 않고 확인한다.
5. 최초 배포 전 승인된 initial activation `prepare`로 EC2 `.env`에 초기 client 한 건의
   `GIS_MCP_TOKEN_REGISTRY_JSON`을 중복 없이 정확히 한 번 staging한다. file·JSON·legacy
   중 정확히 하나만 설정되어야 하며 운영 설정은 코드 배포와 별도로 승인한다.
6. 배포 후 `GET /health`에서 `gisMcpConfigurationValid=true`,
   `gisMcpAuthMode=client_registry`, `gisMcpAuthSource=file_registry`,
   `gisMcpProviderMode=vworld_and_data_portal`과 등록 client/token count 일치를 확인한다.
   health는 비밀 원문이나 digest를 출력하지 않는다.
7. HTTPS에서 hidden-input smoke를 실행한다.

```bash
npm run gis:mcp:smoke -- --endpoint https://api.tonghari.kr/gis-mcp
npm run gis:mcp:smoke -- --endpoint https://api.tonghari.kr/gis-mcp --protocol-version 2025-06-18
```

두 번째 명령은 Codex와 같은 `2025-06-18` client의
initialize → initialized → tools/list lifecycle을 검증한다.

8. 정확한 테스트 PNU로 5개 도구를 각각 live 호출해 provider 성공/무자료/일시 장애
   상태와 출처표시를 확인한다. 이 live smoke 전에는 외부 MCP가 완료됐다고 보고하지 않는다.

## 공식 근거

- [VWorld Open API 목록](https://www.vworld.kr/dev/v4apiRefer.do)
- [연속지적도 2D Data API](https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral)
- [VWorld 국가중점데이터 API](https://www.vworld.kr/dtna/dtna_apiSvcList_s001.do)
- [VWorld 대지권등록 API](https://www.vworld.kr/dtna/dtna_apiSvcFc_s001.do?apiNum=78)
- [VWorld 주소→좌표 제한](https://www.vworld.kr/dev/v4dv_geocoderguide2_s001.do)
- [VWorld 이용약관](https://www.vworld.kr/v4po_prcint_a001.do)
- [VWorld 저작권 정책](https://www.vworld.kr/v4po_prcint_a006.do)
- [공공데이터포털 건축HUB](https://www.data.go.kr/data/15134735/openapi.do)


## 14개 공부 자료 전체 조회

기존 5개 도구의 계약은 유지한다. 전체 비교가 필요하면 아래 도구를 호출한다.

```json
{
  "name": "lookup_full_gis_public_data_v1",
  "arguments": {
    "address": "서울특별시 중구 태평로1가 31",
    "year": 2026,
    "limit": 10
  }
}
```

- 주소 또는 PNU 중 하나가 필요하다. 둘 다 입력하면 서로 일치해야 한다.
- PNU만 입력하면 주소·좌표가 필요한 앞 3항목은 미호출로 표시한다. 14개 실호출 확인에는 주소를 사용한다.
- 각 `steps[].pagination`의 `total`, `hasMore`, `nextOffset`을 확인한다. 다음 조회에서는 `offsets`의 해당 source ID에 `nextOffset`을 넣는다.
- 예: `offsets: {"building_units": 10, "building_floors": 10}`. 자료별 독립 offset을 지원하며 공통 `offset`은 기본 0이다.
- `allSourcesQueried`는 모든 자료를 요청했는지, `allRecordsReturned`는 첫 행부터 전량을 한 응답에 반환했는지 뜻한다.
- 14항목의 개별 오류와 무자료는 그대로 보존한다. `PARTIAL`을 완료나 무자료로 바꾸지 않는다.
- 건물호수조회는 운영자가 별도 이용허락을 확보했다고 확인한 범위에 포함된다. 일반 공개 이용조건 변경을 의미하지 않는다.
- 표제부·전유부·층별개요를 합쳐 가상 세대나 단일 면적을 만들지 않는다. 원래 필드와 대지권 분수 문자열을 대조 자료로 사용한다.

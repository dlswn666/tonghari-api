# EC2 API HTTPS 전환 가이드 (api.tonghari.kr)

> 목적: 운영 웹(Vercel)의 GIS 프록시 기능이 `GIS_PROXY_HTTPS_REQUIRED` 가드에 막혀 있다.
> (SYSTEM_ADMIN Bearer 토큰을 공용망 평문 HTTP로 보내지 않는 fail-closed 설계 — 운영 예외 없음)
> EC2의 tonghari-api(:3100) 앞에 Caddy 리버스 프록시를 붙여 HTTPS를 제공하면 해소된다.
> Caddy는 Let's Encrypt 인증서를 자동 발급·자동 갱신한다.
> 법률 MCP `/mcp`는 여기에 더해 Caddy가 주입하는 별도 proxy 증명을 요구한다.
> 공공 GIS MCP `/gis-mcp`도 서로 다른 proxy secret을 쓰는 exact route가 필요하다.
> 전체 설정은 `docs/2026-09-03-public-data-gis-mcp-runbook.md`를 따른다.

작성: 2026-07-23, 법률 MCP proxy 증명 보강: 2026-08-31. 관련:
`DOCKER_DEPLOYMENT.md:119` (공개 HTTP 3100은 합성 개발 전용),
`tonghari-web/app/_lib/features/gis/actions/gisProxyEndpoint.ts` (가드 구현),
`docs/2026-08-31-current-law-legal-mcp-runbook.md` (법률 MCP 운영 계약).

---

## 0. 사전 준비 (사용자 작업)

1. **DNS A 레코드 추가** — 도메인 관리처(tonghari.kr 등록한 곳)에서:
   ```
   api.tonghari.kr  →  <EC2 퍼블릭 IP>   (A 레코드, TTL 기본값)
   ```
   ⚠️ EC2에 Elastic IP가 아니라면 인스턴스 재시작 시 IP가 바뀐다 — Elastic IP 권장.

2. **보안 그룹 인바운드 오픈** — EC2 콘솔 → 해당 인스턴스 보안 그룹:
   - `80/tcp` (0.0.0.0/0) — Let's Encrypt HTTP-01 챌린지 + http→https 리다이렉트
   - `443/tcp` (0.0.0.0/0) — HTTPS 서비스
   - `3100/tcp` — **공개 인바운드 금지**. Caddy가 같은 host에서 loopback으로만 접근한다.

   johapon-dev·KG이니시스 callback 등 과거 `http:3100` caller가 남아 있다면 §6을
   먼저 완료한다. 전환 기간에 3100 공개 예외가 남아 있는 상태는 법률 MCP 외부
   운영의 No-Go다. Host allowlist와 `/mcp` proxy guard가 포트 차단을 대체하지 않는다.

3. DNS 전파 확인 (로컬 어디서든):
   ```bash
   dig +short api.tonghari.kr
   # → EC2 퍼블릭 IP가 나오면 진행
   ```

## 1. Caddy proxy secret 준비 (EC2에서 SSH로 실행)

법률 MCP token provisioning 명령으로 proxy 전용 발급 쌍을 만든다. raw 값은 Caddy
owner-only secret에만, SHA-256 digest는 API의
`LEGAL_MCP_PROXY_TOKEN_SHA256`에만 저장한다. client bearer나 packet signing key와
재사용하지 않는다. 자세한 명령과 회전 절차는 법률 MCP 런북을 따른다.

Caddy container에는 root-only env file로 raw 값을 주입한다. raw 값을 shell argument,
Docker label, Caddyfile, 저장소, CI log에 쓰지 않는다.

```bash
sudo install -d -o root -g root -m 700 /opt/caddy
sudo install -o root -g root -m 600 /dev/null /opt/caddy/legal-mcp-proxy.env
sudoedit /opt/caddy/legal-mcp-proxy.env
# 편집기에서 LEGAL_MCP_PROXY_TOKEN key에 발급된 raw 값을 1줄로 저장한다.
# 값을 이 문서나 터미널 명령행에 직접 적지 않는다.
```

API에는 raw 값이 아니라 같은 발급 결과의 digest만 배포 secret으로 주입한다. Caddy
env file과 API runtime secret의 파일 내용을 출력해 대조하지 않는다.

## 2. Caddy 컨테이너 기동 (EC2에서 SSH로 실행)

도커가 이미 있으므로 OS(Amazon Linux/Ubuntu) 무관하게 동일하다.
`--network host`로 띄워 호스트의 3100(api 컨테이너가 publish)에 127.0.0.1로 프록시한다.
`handle @legal_mcp`와 fallback `handle`은 mutually exclusive이므로 `/mcp`만 proxy
증명을 덮어쓰고 기존 일반 API route는 그대로 proxy한다. `handle_path`는 path를
strip하므로 여기서는 사용하지 않는다.

```bash
# 1) Caddyfile 작성
sudo mkdir -p /opt/caddy
sudo tee /opt/caddy/Caddyfile > /dev/null << 'EOF'
api.tonghari.kr {
    @legal_mcp path /mcp
    handle @legal_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-MCP-Proxy-Token {$LEGAL_MCP_PROXY_TOKEN}
        }
    }

    handle {
        reverse_proxy 127.0.0.1:3100
    }

    encode gzip
}
EOF

# 2) owner-only env를 주입한 상태로 config 검증
sudo docker run --rm \
  --env-file /opt/caddy/legal-mcp-proxy.env \
  -v /opt/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# 3) Caddy 컨테이너 실행 (인증서는 caddy_data 볼륨에 보존 — 재생성해도 유지)
sudo docker run -d \
  --name caddy \
  --restart unless-stopped \
  --network host \
  --env-file /opt/caddy/legal-mcp-proxy.env \
  -v /opt/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v caddy_data:/data \
  -v caddy_config:/config \
  caddy:2

# 4) 인증서 발급 로그 확인 (수십 초 내 "certificate obtained successfully" 비슷한 로그)
sudo docker logs -f caddy
# Ctrl+C로 빠져나옴
```

prefix 없는 `header_up <field> <value>`는 외부 동명 header를 upstream 값으로
덮어쓴다. 같은 필드에 삭제와 설정 연산을 함께 두지 않는다.
`{$LEGAL_MCP_PROXY_TOKEN}`은 Caddyfile parse 시 owner-only 환경변수로 치환되며,
`/mcp`에서는 `X-Forwarded-Proto`도 `https`로 명시한다. 공식 근거:
[Caddy reverse_proxy headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers),
[Caddyfile environment variables](https://caddyserver.com/docs/caddyfile/concepts#environment-variables),
[Caddy handle](https://caddyserver.com/docs/caddyfile/directives/handle).

환경변수 주입을 빠뜨린 container를 실행하거나 값이 빈 상태에서 reload하지 않는다.
`docker inspect`나 환경 전체 dump로 raw 값을 확인하지 않는다. 회전 때는 새 env file과
새 API digest를 준비해 둘의 적용 창을 최소화하고, 양쪽 적용 뒤 HTTPS smoke를 다시
수행한다.

메모리: Caddy는 RSS ~40MB 수준 — 1GB RAM + 2GB swap 환경에서 무리 없음.

## 3. 동작 검증 (EC2 또는 로컬 어디서든)

```bash
curl -s https://api.tonghari.kr/health | head -c 300
# → {"status":"ok", ... GIT_SHA 포함} 이면 성공
```

- 인증서 오류가 나면: DNS 전파 미완(§0-3 재확인) 또는 80 포트 미오픈이 대부분.
- `docker logs caddy`에서 ACME 챌린지 실패 사유를 확인.
- 인터넷의 별도 host에서 EC2 public IP의 TCP 3100 연결은 실패해야 한다.
- API host의 loopback 3100에서 proxy 증명 없이 `/mcp`를 호출하면
  `403 LEGAL_MCP_PROXY_FORBIDDEN`이어야 한다. production Host allowlist가
  domain-only이면 허용된 Host를 명시한다.

  ```bash
  curl -sS -X POST -H 'Host: api.tonghari.kr' \
    http://127.0.0.1:3100/mcp
  ```
- 발급 client에서 다음 hidden-input smoke가 HTTP 200이어야 한다. 이 명령은 HTTPS만
  허용하고 redirect, URL credential/query/fragment를 거부하며 token이나 body를
  출력하지 않는다.

  ```bash
  npm run legal:mcp:smoke -- --endpoint https://api.tonghari.kr/mcp
  ```

- HTTP URL에는 bearer를 보내지 않는다. 인증서 hostname/chain과 HTTPS 최종 endpoint를
  별도로 확인한다.

## 4. Vercel 운영 env 변경 (사용자 작업 — Sensitive env)

Vercel 대시보드 → tonghari-web(운영 프로젝트) → Settings → Environment Variables:

```
ALIMTALK_PROXY_URL = https://api.tonghari.kr
```

변경 후 **재배포**(Deployments → 최신 프로덕션 Redeploy — env만 바꿔도 재배포 필요).

## 5. 최종 확인

- `/systemAdmin/gis/inspector`에서 주소 검색 → 13스텝 결과가 뜨면 완료
- 같은 가드를 쓰는 기존 기능도 함께 살아난다: systemAdmin GIS 동기화·주소 추가,
  조합원 등록 모달의 주소→PNU 검색

## 6. 후속 마이그레이션 (법률 MCP 외부 운영 전 완료)

| 항목 | 변경 | 주의 |
|---|---|---|
| johapon-dev (Vercel dev 프로젝트) | `ALIMTALK_PROXY_URL=https://api.tonghari.kr`로 통일, `ALLOW_INSECURE_GIS_PROXY_FOR_SYNTHETIC_DEV` 제거 가능 | HTTPS는 가드를 항상 통과하므로 합성dev 예외 불필요해짐 |
| `KG_INICIS_CALLBACK_BASE_URL` (대상 환경별) | `https://<web-origin>/api/identity-verification/callback` | 본인확인 콜백은 Web BFF에서 수신한 뒤 API로 중계한다. API origin을 콜백으로 사용하지 않는다. 연결 전에는 비워 두고, 실제 설정 시 생성 URL 전체 128바이트 한도를 확인한다. |
| tonghari-api `KG_INICIS_ALLOWED_HOSTS` | `api.tonghari.kr` 포함하도록 갱신 | SEC-2: 비어 있으면 검증 스킵되므로 반드시 값 유지 |
| 보안 그룹 3100 | 위 항목 전부 전환 후 공개 인바운드 차단 | 차단 전 `docker logs`로 3100 직접 호출 잔존 여부 확인. 차단 전에는 법률 MCP 외부 운영 금지 |

## 트러블슈팅

- **80/443 이미 사용 중**: `sudo ss -tlnp | grep -E ':80|:443'` — 기존 nginx 등이 있으면 그쪽에 TLS를 붙이는 것으로 대체.
- **Let's Encrypt 발급 한도**: 동일 도메인 주간 한도 있음 — Caddyfile 오타 상태로 반복 재시작하지 말 것.
- **api 컨테이너 재배포와의 관계**: Caddy는 api 컨테이너와 독립(호스트 3100만 바라봄) — GitHub Actions 배포 플로우 변경 불필요.
- **`LEGAL_MCP_PROXY_FORBIDDEN`**: direct 3100 접근, 비 HTTPS forwarding, Caddy raw
  proxy secret과 API `LEGAL_MCP_PROXY_TOKEN_SHA256`의 발급 쌍 불일치를 확인한다.
  client bearer를 새로 발급해 우회하지 않는다.
- **Caddy 재생성 뒤 `/mcp`만 403**: 새 container에 `--env-file`이 빠지지 않았는지,
  Caddy와 API secret이 같은 발급 쌍인지 secret 값을 출력하지 않고 배포 revision으로
  확인한다.

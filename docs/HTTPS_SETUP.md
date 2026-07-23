# EC2 API HTTPS 전환 가이드 (api.tonghari.kr)

> 목적: 운영 웹(Vercel)의 GIS 프록시 기능이 `GIS_PROXY_HTTPS_REQUIRED` 가드에 막혀 있다.
> (SYSTEM_ADMIN Bearer 토큰을 공용망 평문 HTTP로 보내지 않는 fail-closed 설계 — 운영 예외 없음)
> EC2의 tonghari-api(:3100) 앞에 Caddy 리버스 프록시를 붙여 HTTPS를 제공하면 해소된다.
> Caddy는 Let's Encrypt 인증서를 자동 발급·자동 갱신한다.

작성: 2026-07-23. 관련: `DOCKER_DEPLOYMENT.md:119` (공개 HTTP 3100은 합성 개발 전용),
`tonghari-web/app/_lib/features/gis/actions/gisProxyEndpoint.ts` (가드 구현).

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
   - `3100/tcp`은 **당분간 유지** (johapon-dev·KG이니시스 콜백이 아직 http:3100 사용 — §5 마이그레이션 후 닫기)

3. DNS 전파 확인 (로컬 어디서든):
   ```bash
   dig +short api.tonghari.kr
   # → EC2 퍼블릭 IP가 나오면 진행
   ```

## 1. Caddy 컨테이너 기동 (EC2에서 SSH로 실행)

도커가 이미 있으므로 OS(Amazon Linux/Ubuntu) 무관하게 동일하다.
`--network host`로 띄워 호스트의 3100(api 컨테이너가 publish)에 127.0.0.1로 프록시한다.

```bash
# 1) Caddyfile 작성
sudo mkdir -p /opt/caddy
sudo tee /opt/caddy/Caddyfile > /dev/null << 'EOF'
api.tonghari.kr {
    reverse_proxy 127.0.0.1:3100
    encode gzip
}
EOF

# 2) Caddy 컨테이너 실행 (인증서는 caddy_data 볼륨에 보존 — 재생성해도 유지)
docker run -d \
  --name caddy \
  --restart unless-stopped \
  --network host \
  -v /opt/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v caddy_data:/data \
  -v caddy_config:/config \
  caddy:2

# 3) 인증서 발급 로그 확인 (수십 초 내 "certificate obtained successfully" 비슷한 로그)
docker logs -f caddy
# Ctrl+C로 빠져나옴
```

메모리: Caddy는 RSS ~40MB 수준 — 1GB RAM + 2GB swap 환경에서 무리 없음.

## 2. 동작 검증 (EC2 또는 로컬 어디서든)

```bash
curl -s https://api.tonghari.kr/health | head -c 300
# → {"status":"ok", ... GIT_SHA 포함} 이면 성공
```

- 인증서 오류가 나면: DNS 전파 미완(§0-3 재확인) 또는 80 포트 미오픈이 대부분.
- `docker logs caddy`에서 ACME 챌린지 실패 사유를 확인.

## 3. Vercel 운영 env 변경 (사용자 작업 — Sensitive env)

Vercel 대시보드 → tonghari-web(운영 프로젝트) → Settings → Environment Variables:

```
ALIMTALK_PROXY_URL = https://api.tonghari.kr
```

변경 후 **재배포**(Deployments → 최신 프로덕션 Redeploy — env만 바꿔도 재배포 필요).

## 4. 최종 확인

- `/systemAdmin/gis/inspector`에서 주소 검색 → 13스텝 결과가 뜨면 완료
- 같은 가드를 쓰는 기존 기능도 함께 살아난다: systemAdmin GIS 동기화·주소 추가,
  조합원 등록 모달의 주소→PNU 검색

## 5. 후속 마이그레이션 (별도 진행 — 완료 전까지 3100 유지)

| 항목 | 변경 | 주의 |
|---|---|---|
| johapon-dev (Vercel dev 프로젝트) | `ALIMTALK_PROXY_URL=https://api.tonghari.kr`로 통일, `ALLOW_INSECURE_GIS_PROXY_FOR_SYNTHETIC_DEV` 제거 가능 | HTTPS는 가드를 항상 통과하므로 합성dev 예외 불필요해짐 |
| `NEXT_PUBLIC_API_URL` (운영/dev) | `https://api.tonghari.kr` | KG이니시스 콜백 URL(successUrl/failUrl)이 이 값 기반 — KG이니시스 측에 등록된 URL이 있으면 함께 변경 확인 |
| tonghari-api `KG_INICIS_ALLOWED_HOSTS` | `api.tonghari.kr` 포함하도록 갱신 | SEC-2: 비어 있으면 검증 스킵되므로 반드시 값 유지 |
| 보안 그룹 3100 | 위 항목 전부 전환 후 인바운드 차단 | 차단 전 `docker logs`로 3100 직접 호출 잔존 여부 확인 |

## 트러블슈팅

- **80/443 이미 사용 중**: `sudo ss -tlnp | grep -E ':80|:443'` — 기존 nginx 등이 있으면 그쪽에 TLS를 붙이는 것으로 대체.
- **Let's Encrypt 발급 한도**: 동일 도메인 주간 한도 있음 — Caddyfile 오타 상태로 반복 재시작하지 말 것.
- **api 컨테이너 재배포와의 관계**: Caddy는 api 컨테이너와 독립(호스트 3100만 바라봄) — GitHub Actions 배포 플로우 변경 불필요.

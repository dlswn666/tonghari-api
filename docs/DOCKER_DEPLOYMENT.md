# Tonghari API Docker 배포 가이드

## 운영 원칙

Tonghari API는 `.github/workflows/docker-build.yml`을 통한 자동 배포만 사용한다.

- 이미지는 GitHub Actions에서 빌드하고 GHCR(`ghcr.io/dlswn666/alimtalk-proxy`)에 저장한다.
- 배포 대상은 `latest`가 아니라 Git SHA 태그와 `sha256` digest로 고정한다.
- EC2에서는 이미지를 빌드하지 않고 검증된 digest를 pull해 실행한다.
- 런타임 비밀값은 GitHub에 복제하지 않고 EC2의 `/home/ubuntu/alimtalk-proxy/.env`만 사용한다.
- 후보 컨테이너를 `127.0.0.1:13100`에서 검증한 후 공개 포트 `3100`을 교체한다.
- 성공 후 직전 컨테이너를 `alimtalk-proxy-rollback`이라는 정지 상태 컨테이너로 1세대 보존한다.

기존 `scripts/build-and-push.sh`와 `scripts/deploy-to-ec2.sh`의 Docker Hub/`latest` 방식은 사용하지 않는다.

## GitHub Actions 설정

Repository Settings > Secrets and variables > Actions에는 EC2 접속에 필요한 다음 값만 저장한다.

- `EC2_HOST`: EC2 퍼블릭 IP 또는 호스트명
- `EC2_USERNAME`: 현재 서버 기준 `ubuntu`
- `EC2_SSH_KEY`: EC2 SSH private key 원문
- `EC2_SSH_FINGERPRINT`: 접속 대상 EC2 host key fingerprint

`GITHUB_TOKEN`은 Actions가 자동 발급하며 GHCR 로그인에만 사용한다. 다음 런타임 값은 GitHub Secrets에 저장하지 않는다.

- `DEV_API_JWT_SECRET`
- `DEV_SUPABASE_URL`
- `DEV_SUPABASE_SERVICE_ROLE_KEY`

## EC2 런타임 설정

파일 위치:

```text
/home/ubuntu/alimtalk-proxy/.env
```

필수 보안 조건:

```bash
cd /home/ubuntu/alimtalk-proxy
stat -c 'owner=%U group=%G mode=%a file=%n' .env
```

정상 기준은 `owner=ubuntu`, `mode=600`이다. 배포 workflow도 컨테이너를 건드리기 전에 이 조건을 검사한다.

개발 DB 분기를 위한 필수 항목은 다음 세 개다.

```text
DEV_API_JWT_SECRET
DEV_SUPABASE_URL
DEV_SUPABASE_SERVICE_ROLE_KEY
```

기준지번/부속지번 W1 operation 원장이 적용된 target은 비밀값이 아닌 아래 allowlist로 명시한다.

```text
BUILDING_WRITE_OPERATION_TARGETS=development
```

운영 DB에 W1을 적용하기 전에는 `production`을 추가하지 않는다. 이 값이 없으면 개발 GIS의
building-family queue producer는 `BUILDING_OPERATION_CAPABILITY_DISABLED`로 fail-closed한다.

적용 토지면적 동기화는 별도 canary allowlist가 구현·승인되기 전까지 전역 OFF를 유지한다.

```text
LAND_AREA_SYNC_ENABLED=false
```

이 항목은 누락되어도 서버가 OFF로 해석한다. 항목을 넣는 경우 배포 workflow는 정확히 한 줄
`LAND_AREA_SYNC_ENABLED=false`만 허용한다. `true`는 현재 배포 계약에서 거부하며, 후보·최종
컨테이너의 `/health`도 `features.landAreaSyncEnabled=false`를 반환해야 한다.

값을 출력하지 않고 항목 수만 확인한다.

```bash
for key in DEV_API_JWT_SECRET DEV_SUPABASE_URL DEV_SUPABASE_SERVICE_ROLE_KEY; do
  printf '%s count=' "$key"
  grep -c "^${key}=" .env
done
```

각 항목은 정확히 `count=1`이어야 한다. Supabase secret key와 JWT 원문은 터미널 로그, GitHub, 저장소에 남기지 않는다.

## 자동 배포 흐름

`main` push 또는 수동 workflow 실행 시 다음 순서로 진행한다.

1. 테스트, TypeScript 컴파일, property-building writer guard를 실행한다.
2. Git SHA 태그로 이미지를 빌드하고 GHCR에 push한다.
3. push 결과의 digest 형식을 검증한다.
4. EC2 접속 비밀과 EC2 `.env` 소유자·권한·필수 항목을 검사한다.
5. `repo@sha256:digest` 형식으로 정확한 이미지를 pull한다.
6. 후보 컨테이너를 `127.0.0.1:13100`에 띄워 SHA, build time, image tag와 LAND_AREA_SYNC OFF를 검증한다.
7. 후보가 통과한 경우에만 기존 `3100` 컨테이너를 rollback 이름으로 보존하고 새 컨테이너로 교체한다.
8. 최종 `3100` health 검증에 실패하면 직전 컨테이너를 복구한다.

## 상태 확인과 롤백

배포 상태 확인:

```bash
docker ps --filter name=alimtalk-proxy
curl -fsS http://127.0.0.1:3100/health
```

배포 성공 후 rollback 컨테이너 확인:

```bash
docker ps -a --filter name=alimtalk-proxy-rollback
```

자동 rollback이 실패한 비상 상황에서만 다음을 실행한다.

```bash
docker rm -f alimtalk-proxy
docker rename alimtalk-proxy-rollback alimtalk-proxy
docker start alimtalk-proxy
curl -fsS http://127.0.0.1:3100/health
```

비상 롤백 전에는 실행 중인 컨테이너와 rollback 컨테이너의 존재를 먼저 확인한다.

## 주의사항

- `.env`를 수정해도 실행 중인 컨테이너에는 반영되지 않는다. `docker restart`도 환경변수를 다시 읽지 않으므로 새 컨테이너 배포가 필요하다.
- Vercel 환경변수도 새 배포부터 적용된다. 공유 JWT를 교체한 경우 API와 `johapon-dev`를 연속으로 재배포한다.
- 공개 HTTP `3100`은 HTTPS 전환 전 합성 개발 GIS 검증에만 제한한다. 운영 bearer token 검증에 사용하지 않는다.
- `.env` 원문은 저장소나 GitHub Actions artifact에 백업하지 않는다. 별도의 암호화 백업 절차를 사용한다.

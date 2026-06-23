# EC2 인스턴스 초기 설정 가이드

## 개요

이 문서는 알림톡 프록시 서버를 AWS EC2 (1GB RAM) 환경에 배포하기 위한 초기 설정 가이드입니다.

## 사전 요구사항

-   AWS EC2 인스턴스 (Amazon Linux 2 또는 Ubuntu)
-   SSH 접속 가능
-   보안 그룹에서 포트 3100 열림

## 1. Swap 메모리 설정 (필수)

### 왜 필요한가?

1GB RAM 환경에서 Node.js 앱과 Docker 데몬이 동시에 실행되면, 순간적으로 큐에 작업이 몰리거나 GC(Garbage Collection)가 늦어질 때 OOM(Out Of Memory)으로 서버가 죽을 수 있습니다.

Swap 메모리는 RAM이 부족할 때 디스크를 메모리처럼 사용합니다. 속도는 느려지지만 서버가 다운되는 것보다 낫습니다.

### 자동 설정 (권장)

```bash
# 스크립트 다운로드 후 실행
chmod +x scripts/setup-swap.sh
sudo ./scripts/setup-swap.sh
```

### 수동 설정

```bash
# 2GB Swap 파일 생성
sudo fallocate -l 2G /swapfile

# 권한 설정 (root만 읽기/쓰기)
sudo chmod 600 /swapfile

# Swap 파일 포맷
sudo mkswap /swapfile

# Swap 활성화
sudo swapon /swapfile

# 재부팅 후에도 유지되도록 설정
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 설정 확인

```bash
# Swap 상태 확인
free -h

# 출력 예시:
#               total        used        free      shared  buff/cache   available
# Mem:          987Mi       450Mi       120Mi       0.0Ki       417Mi       395Mi
# Swap:         2.0Gi          0B       2.0Gi

# Swap 파일 확인
swapon --show

# /etc/fstab 확인
cat /etc/fstab
# 마지막 줄에 '/swapfile none swap sw 0 0' 확인
```

## 2. Docker 설치

### Amazon Linux 2

```bash
# Docker 설치
sudo yum update -y
sudo yum install -y docker

# Docker 시작 및 자동 시작 설정
sudo systemctl start docker
sudo systemctl enable docker

# 현재 사용자를 docker 그룹에 추가 (sudo 없이 docker 명령 사용)
sudo usermod -aG docker $USER

# 변경 적용을 위해 재로그인
exit
# SSH 재접속
```

### Ubuntu

```bash
# Docker 설치
sudo apt update
sudo apt install -y docker.io

# Docker 시작 및 자동 시작 설정
sudo systemctl start docker
sudo systemctl enable docker

# 현재 사용자를 docker 그룹에 추가
sudo usermod -aG docker $USER

# 변경 적용을 위해 재로그인
exit
# SSH 재접속
```

### Docker 설치 확인

```bash
docker --version
docker ps
```

## 3. 환경 변수 설정

### .env 파일 생성

```bash
# 프로젝트 디렉토리 생성
mkdir -p ~/alimtalk-proxy
cd ~/alimtalk-proxy

# .env 파일 생성
vim .env
```

### .env 파일 내용

```env
# 서버 설정
NODE_ENV=production
PORT=3100

# JWT 인증 (통하리 서버와 동일한 값)
JWT_SECRET=your-jwt-secret-key-here

# 알리고 API
ALIGO_API_KEY=your-aligo-api-key
ALIGO_USER_ID=your-aligo-user-id
ALIGO_SENDER_PHONE=01012345678

# Sender Key
DEFAULT_SENDER_KEY=your-default-sender-key
DEFAULT_CHANNEL_NAME=통하리

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

# 큐 설정
QUEUE_CONCURRENCY=5
QUEUE_MAX_SIZE=100
```

> ⚠️ **보안 주의**: `.env` 파일은 절대 Git에 커밋하지 마세요!

## 4. 서버 배포

### Docker 이미지 Pull 및 실행

```bash
# 이미지 Pull
docker pull your-dockerhub-username/alimtalk-proxy:latest

# 컨테이너 실행
docker run -d \
  --name alimtalk-proxy \
  --restart unless-stopped \
  -p 3100:3100 \
  --env-file .env \
  -v $(pwd)/logs:/app/logs \
  --memory=800m \
  --memory-swap=1600m \
  your-dockerhub-username/alimtalk-proxy:latest
```

### 또는 배포 스크립트 사용

```bash
# 스크립트 다운로드
curl -O https://raw.githubusercontent.com/.../scripts/deploy-to-ec2.sh
chmod +x deploy-to-ec2.sh

# 환경 변수 설정
export DOCKER_USERNAME=your-dockerhub-username

# 배포 실행
./deploy-to-ec2.sh
```

## 5. 배포 확인

### 컨테이너 상태 확인

```bash
# 실행 중인 컨테이너 확인
docker ps

# 로그 확인
docker logs -f alimtalk-proxy
```

### 헬스체크

```bash
# 기본 헬스체크
curl http://localhost:3100/health

# 상세 헬스체크
curl http://localhost:3100/health/detailed
```

## 6. 유용한 명령어

```bash
# 컨테이너 중지
docker stop alimtalk-proxy

# 컨테이너 재시작
docker restart alimtalk-proxy

# 컨테이너 삭제
docker rm alimtalk-proxy

# 이미지 업데이트
docker pull your-dockerhub-username/alimtalk-proxy:latest
./deploy-to-ec2.sh

# 메모리 사용량 확인
free -h

# Swap 사용량 확인
swapon --show

# 디스크 사용량 확인
df -h
```

## 7. 트러블슈팅

### 컨테이너가 계속 재시작되는 경우

```bash
# 로그 확인
docker logs alimtalk-proxy

# 컨테이너 상태 확인
docker inspect alimtalk-proxy
```

### 메모리 부족 오류

```bash
# Swap 사용량 확인
free -h

# Swap이 활성화되어 있지 않으면 다시 설정
sudo swapon /swapfile
```

### 포트 연결 실패

```bash
# 보안 그룹에서 포트 3100이 열려 있는지 확인
# AWS Console > EC2 > 보안 그룹 > 인바운드 규칙

# 컨테이너가 실행 중인지 확인
docker ps

# 포트 바인딩 확인
netstat -tlnp | grep 3100
```

## 체크리스트

배포 전 확인 사항:

-   [ ] Swap 메모리 설정 완료 (2GB)
-   [ ] `/etc/fstab`에 Swap 설정 추가됨
-   [ ] Docker 설치 및 실행 중
-   [ ] `.env` 파일 생성 및 환경 변수 설정
-   [ ] `JWT_SECRET`이 통하리 서버와 동일
-   [ ] 보안 그룹에서 포트 3100 열림
-   [ ] 컨테이너 실행 및 헬스체크 통과

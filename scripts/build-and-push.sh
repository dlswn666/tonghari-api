#!/bin/bash
# ============================================================
# Docker 이미지 빌드 및 Push 스크립트
# 로컬에서 실행 (Build Local, Run Remote 전략)
# ============================================================

set -e

# 변수 설정 (필요에 따라 수정)
IMAGE_NAME="alimtalk-proxy"
DOCKER_REGISTRY="${DOCKER_REGISTRY:-docker.io}"  # docker.io 또는 AWS ECR URL
DOCKER_USERNAME="${DOCKER_USERNAME:-}"
TAG="${1:-latest}"
GIT_SHA="${GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
BUILD_TIME="${BUILD_TIME:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
IMAGE_TAG="${IMAGE_TAG:-${IMAGE_NAME}:${TAG}}"

echo "=========================================="
echo "Docker 이미지 빌드 및 Push"
echo "=========================================="
echo "이미지: ${IMAGE_NAME}"
echo "태그: ${TAG}"
echo "레지스트리: ${DOCKER_REGISTRY}"
echo "Git SHA: ${GIT_SHA}"
echo "Build time: ${BUILD_TIME}"
echo ""

# Docker 로그인 확인
if [ -z "$DOCKER_USERNAME" ]; then
    echo "⚠️  DOCKER_USERNAME이 설정되지 않았습니다."
    echo "Docker Hub 사용 시: export DOCKER_USERNAME=your-username"
    echo ""
fi

# 이미지 빌드
echo "=========================================="
echo "1. Docker 이미지 빌드 중..."
echo "=========================================="
docker build \
    --build-arg GIT_SHA="${GIT_SHA}" \
    --build-arg BUILD_TIME="${BUILD_TIME}" \
    --build-arg IMAGE_TAG="${IMAGE_TAG}" \
    -t ${IMAGE_NAME}:${TAG} .

# 이미지 태깅 (Docker Hub용)
if [ -n "$DOCKER_USERNAME" ]; then
    FULL_IMAGE_NAME="${DOCKER_USERNAME}/${IMAGE_NAME}:${TAG}"
    echo ""
    echo "=========================================="
    echo "2. 이미지 태깅: ${FULL_IMAGE_NAME}"
    echo "=========================================="
    docker tag ${IMAGE_NAME}:${TAG} ${FULL_IMAGE_NAME}
    
    # Docker Hub에 Push
    echo ""
    echo "=========================================="
    echo "3. Docker Hub에 Push 중..."
    echo "=========================================="
    docker push ${FULL_IMAGE_NAME}
    
    echo ""
    echo "=========================================="
    echo "✅ 완료!"
    echo "=========================================="
    echo "Push된 이미지: ${FULL_IMAGE_NAME}"
    echo ""
    echo "EC2에서 Pull하려면:"
    echo "  docker pull ${FULL_IMAGE_NAME}"
else
    echo ""
    echo "=========================================="
    echo "⚠️  Push 생략 (DOCKER_USERNAME 미설정)"
    echo "=========================================="
    echo "로컬 빌드만 완료되었습니다."
    echo ""
    echo "Docker Hub에 Push하려면:"
    echo "  1. export DOCKER_USERNAME=your-username"
    echo "  2. docker login"
    echo "  3. 이 스크립트 다시 실행"
fi

echo ""
echo "=========================================="
echo "로컬 이미지 목록:"
echo "=========================================="
docker images | grep ${IMAGE_NAME}

# Node.js 20 Alpine 기반 경량 이미지
FROM node:20-alpine AS builder

# 작업 디렉토리 설정
WORKDIR /app

# package.json과 package-lock.json 복사
COPY package*.json ./

# 모든 의존성 설치 (devDependencies 포함 - TypeScript 빌드 필요)
RUN npm ci

# 소스 코드 복사
COPY . .

# TypeScript 빌드
RUN npm run build

# 불필요한 devDependencies 제거 (이미지 크기 최적화)
RUN npm prune --production

# 프로덕션 이미지
FROM node:20-alpine AS production

ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG IMAGE_TAG=local

# 작업 디렉토리 설정
WORKDIR /app

# 필요한 파일만 복사
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/data ./data

# 로그 디렉토리 생성
RUN mkdir -p logs

# 비특권 사용자로 실행
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs

# 환경 변수 설정
ENV NODE_ENV=production
ENV PORT=3100
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV IMAGE_TAG=${IMAGE_TAG}

# 포트 노출
EXPOSE 3100

# 헬스체크
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3100/health || exit 1

# 애플리케이션 시작
CMD ["node", "dist/index.js"]

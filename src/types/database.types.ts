/**
 * 단일 API 프로세스가 접근할 수 있는 논리 데이터베이스 환경.
 *
 * 요청의 URL/Origin이 아니라 검증에 성공한 JWT 서명키가 이 값을 결정한다.
 */
export type DatabaseTarget = 'production' | 'development';

export const PRODUCTION_DATABASE_TARGET: DatabaseTarget = 'production';
export const DEVELOPMENT_DATABASE_TARGET: DatabaseTarget = 'development';

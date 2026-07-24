/**
 * 대지권면적 자동 동기화 — strict API adapter 타입.
 *
 * 권위 스펙: docs/2026-07-23-land-area-sync-design.md §10.
 * 상태값은 enum이 아니라 string union으로 관리한다.
 */

import type { GisSharedEndpointName } from '../services/gis-shared/endpoints';

/** strict scan 4상태 (DESIGN §10.1) */
export type StrictScanState = 'COMPLETE' | 'COMPLETE_ZERO' | 'FAILED' | 'INCOMPLETE';

/**
 * strict scan 공통 결과형 (DESIGN §10.1).
 *
 * - `COMPLETE`: 전 페이지를 완전하게 조회하고 dedup까지 끝난 정상 결과.
 * - `COMPLETE_ZERO`: provider success envelope + 명시적 `totalCount=0`이 모두 있을 때만.
 *   빈 배열, container 누락, schema 오류는 zero가 아니다.
 * - `FAILED`: 재시도 불가한 치명적 실패(HTTP 오류, provider error envelope, schema 오류, 취소).
 * - `INCOMPLETE`: pagination 불일치(누락·초과·반복·totalCount 변경 등).
 */
export type StrictScan<T> =
    | { state: 'COMPLETE'; rows: T[]; totalCount: number; pagesFetched: number }
    | { state: 'COMPLETE_ZERO'; rows: []; totalCount: 0; pagesFetched: number }
    | { state: 'FAILED'; issue: ProviderIssue }
    | { state: 'INCOMPLETE'; issue: ProviderIssue };

/**
 * adapter 수준 실패 분류.
 *
 * - `HTTP_ERROR`: 재시도 소진 후 429/5xx, 또는 401/403/기타 4xx 즉시 실패.
 * - `TRANSPORT_ERROR`: timeout이 아닌 네트워크 오류(DNS 등) 즉시 실패.
 * - `TIMEOUT`: timeout 재시도 소진.
 * - `PROVIDER_ERROR_ENVELOPE`: HTTP 200 이지만 provider 오류 envelope.
 * - `SCHEMA_ERROR`: container 누락·malformed·totalCount 부정합·잘못된 PNU 형식.
 * - `PAGINATION_MISMATCH`: 페이지 누락·초과·반복·짧은 중간 페이지·totalCount 변경.
 * - `ABORTED`: AbortSignal에 의한 취소.
 */
export type ProviderIssueKind =
    | 'HTTP_ERROR'
    | 'TRANSPORT_ERROR'
    | 'TIMEOUT'
    | 'PROVIDER_ERROR_ENVELOPE'
    | 'SCHEMA_ERROR'
    | 'PAGINATION_MISMATCH'
    | 'ABORTED';

/** raw body 없이 응답 계약 차이를 구분하는 고정 구조 코드. */
export type ProviderSchemaErrorCode =
    | 'RESPONSE_CONTAINER_MISSING'
    | 'RESULT_CODE_MISSING'
    | 'BODY_MISSING'
    | 'ENDPOINT_RESPONSE_NON_OBJECT'
    | 'ENDPOINT_CONTAINER_MISSING_EMPTY_OBJECT'
    | 'ENDPOINT_CONTAINER_MISSING_RESPONSE'
    | 'ENDPOINT_CONTAINER_MISSING_OTHER'
    | 'ENDPOINT_CONTAINER_INVALID'
    | 'TOTAL_COUNT_INVALID'
    | 'INPUT_PNU_INVALID';

/**
 * strict scan 실패 정보.
 *
 * 보안(§14.2): message는 고정 한국어 요약만 담고 provider raw body·resultMsg·secret·
 * stack trace를 포함하지 않는다. providerCode는 식별용 코드('00','INVALID_KEY' 등)만.
 */
export interface ProviderIssue {
    kind: ProviderIssueKind;
    endpoint: GisSharedEndpointName;
    message: string;
    /** HTTP 상태 코드 (HTTP_ERROR일 때) */
    httpStatus?: number;
    /** provider 식별용 코드 (resultCode, INVALID_KEY 등). PII·raw body는 담지 않는다 */
    providerCode?: string;
    /** SCHEMA_ERROR의 구조적 원인. provider body나 비밀값은 포함하지 않는다. */
    schemaErrorCode?: ProviderSchemaErrorCode;
    /** 실패 시점까지 조회한 페이지 수 */
    pagesFetched?: number;
    /** 첫 페이지에서 확정한 totalCount */
    expectedTotalCount?: number;
    /** 누적 조회된 raw row 수 */
    receivedRows?: number;
    /** 해당 페이지에서 시도한 HTTP 요청 횟수 */
    attempts?: number;
}

/** 주입 가능한 HTTP 요청 (axios 기본, 테스트는 mock) */
export interface HttpRequest {
    url: string;
    params: Record<string, unknown>;
    timeout: number;
    signal?: AbortSignal;
}

/** HTTP 응답 — 상태코드로 분류하므로 4xx/5xx에서 throw하지 않는다 */
export interface HttpResponse {
    status: number;
    data: unknown;
    headers: Record<string, string>;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/** envelope 파싱 결과 */
export type ParsedEnvelope<T> =
    | { kind: 'SUCCESS'; totalCount: number; rows: T[] }
    | { kind: 'PROVIDER_ERROR'; providerCode?: string; message: string }
    | {
          kind: 'SCHEMA_ERROR';
          message: string;
          schemaErrorCode: ProviderSchemaErrorCode;
      };

export type EnvelopeParser<T> = (data: unknown) => ParsedEnvelope<T>;

/**
 * endpoint별 COMPLETE_ZERO 라벨 (DESIGN §10.7).
 * 공통 adapter의 COMPLETE_ZERO를 job outcome 하나로 합치지 않고 endpoint별로 분리한다.
 */
export type EndpointZeroLabel =
    | 'TITLE_COMPLETE_ZERO'
    | 'ATTACHED_COMPLETE_ZERO'
    | 'EXPOS_COMPLETE_ZERO'
    | 'BASIS_COMPLETE_ZERO'
    | 'LADFRL_COMPLETE_ZERO'
    | 'LDAREG_COMPLETE_ZERO';

// ── 판정 계층 공통 타입 (DESIGN §9, §10.4, §11, §14.3) ──────────────
//
// bylot.ts / classifier.ts / scope.ts가 공유하는 상태값·issue code를 여기서 한 번만
// 정의한다. 모든 상태값은 enum이 아니라 string union으로 관리한다.

/**
 * §14.3 주요 issue code. apply/REVIEW/FAILED 판정에서 원인을 식별하는 코드다.
 * 설계서 §14.3 목록의 이름만 사용한다(임의 신설 금지).
 */
export const LAND_AREA_SYNC_ISSUE_CODES = [
    'LDAREG_PERMISSION_REQUIRED',
    'PROVIDER_PROTOCOL_ERROR',
    'PAGINATION_INCOMPLETE',
    'BUILDING_CLASSIFICATION_CONFLICT',
    'UNSUPPORTED_HOUSING_TYPE',
    'SCOPE_NOT_LINKED',
    'SCOPE_PENDING',
    'SCOPE_REVERSE_LOOKUP_UNPROVEN',
    'SCOPE_BLOCKING_EVIDENCE',
    'SCOPE_COMPONENT_TOO_LARGE',
    'ATTACHED_SCAN_INCOMPLETE',
    'ATTACHED_PNU_INVALID',
    'BYLOT_COUNT_UNAVAILABLE',
    'BYLOT_COUNT_SOURCE_CONFLICT',
    'BYLOT_ATTACHED_COUNT_MISMATCH',
    'SCOPE_CACHE_SCAN_CONFLICT',
    'MULTI_PNU_GENERAL_BUILDING',
    'LAND_OWNERSHIP_UNCONFIRMED',
    'LAND_SCOPE_CONFIRMATION_MISMATCH',
    'MANUAL_OVERWRITE_UNCONFIRMED',
    'MANUAL_OVERWRITE_CONFIRMATION_REQUIRED',
    'SCOPE_CHANGED_DURING_SYNC',
    'RATIO_PARSE_FAILED',
    'RATIO_DENOMINATOR_MISMATCH',
    'LDAREG_IDENTITY_CONFLICT',
    'UNIT_NORMALIZATION_COLLISION',
    'PROPERTY_UNIT_NOT_FOUND',
    'PROPERTY_UNIT_AMBIGUOUS',
    'EXPECTED_PNU_COVERAGE_INCOMPLETE',
    'ALL_COMPONENTS_CLOSED_REVIEW_REQUIRED',
    'STALE_SCAN_REJECTED',
] as const;

export type LandAreaSyncIssueCode =
    (typeof LAND_AREA_SYNC_ISSUE_CODES)[number];

/** 공통 parcel-scope completeness gate 반환 상태 5종 (DESIGN §11). */
export type ParcelScopeState =
    | 'SINGLE_SCOPE_CONFIRMATION_REQUIRED'
    | 'SINGLE_PNU_CONFIRMED'
    | 'LINKED_SCOPE_RESOLVED'
    | 'REVIEW_REQUIRED'
    | 'FAILED';

/**
 * `bylotCnt` 원천 정책 (DESIGN §10.4).
 * Phase 0에서 검토 가능한 소스 상수/fixture로 확정한다. 환경변수로 조용히 바꾸지 않는다.
 */
export type BylotSourcePolicy = 'TITLE_ONLY' | 'TITLE_WITH_BASIS_FALLBACK';

/**
 * `bylotCnt` 교차검증 상태 (DESIGN §10.4).
 * - `TITLE_ONLY`: title에서 확정, basis 미조회
 * - `FALLBACK_RESOLVED`: title 유효값 0개라 basis fallback으로 확정
 * - `MATCHED`: title 확정 + basis 교차검증 일치
 * - `CROSS_CHECK_NOT_AVAILABLE`: title 확정, basis 조회했으나 해당 PK의 유효 basis 값 없음
 * - `UNAVAILABLE`: 어느 원천에서도 유효값 미확정
 * - `CONFLICT`: 유효값 충돌(서로 다른 값·title/basis 불일치)
 */
export type BylotCrossCheckState =
    | 'TITLE_ONLY'
    | 'FALLBACK_RESOLVED'
    | 'MATCHED'
    | 'CROSS_CHECK_NOT_AVAILABLE'
    | 'UNAVAILABLE'
    | 'CONFLICT';

/** 관리 PK별 최종 `bylotCnt` 근거 (DESIGN §10.4). */
export interface BylotEvidence {
    mgmBldrgstPk: string;
    /** 값을 확정한 원천. 미확정(UNAVAILABLE)·충돌(CONFLICT)이면 null */
    source: 'TITLE' | 'BASIS_FALLBACK' | null;
    /** 확정에 사용한 원본 문자열. 미확정이면 null */
    rawValue: string | null;
    /** 정규화된 외필지 수. 미확정·충돌이면 null */
    count: number | null;
    crossCheckState: BylotCrossCheckState;
}

// ── endpoint별 row 타입 (파서는 totalCount·rows만 검증하고 필드는 통과시킨다) ──

/** 건축물대장 표제부 row (getBrTitleInfo) */
export interface BrTitleRow {
    mgmBldrgstPk?: string | number;
    /** 상위 관리 PK(root 관리번호 계열 판정 참고용) */
    mgmUpBldrgstPk?: string | number;
    bylotCnt?: string | number;
    /** 대장 구분: 1=일반, 2=집합 (DESIGN §9) */
    regstrGbCd?: string;
    /** 주용도 코드 */
    mainPurpsCd?: string;
    /** 주용도 명 */
    mainPurpsCdNm?: string;
    [key: string]: unknown;
}

/** 건축물대장 부속지번 row (getBrAtchJibunInfo) */
export interface BrAtchJibunRow {
    mgmBldrgstPk?: string | number;
    sigunguCd?: string;
    bjdongCd?: string;
    platGbCd?: string;
    bun?: string;
    ji?: string;
    atchSigunguCd?: string;
    atchBjdongCd?: string;
    atchPlatGbCd?: string;
    atchBun?: string;
    atchJi?: string;
    [key: string]: unknown;
}

/** 건축물대장 전유부 row (getBrExposInfo) */
export interface BrExposRow {
    mgmBldrgstPk?: string | number;
    mgmUpBldrgstPk?: string | number;
    [key: string]: unknown;
}

/** 건축물대장 기본개요 row (getBrBasisOulnInfo) */
export interface BrBasisOulnRow {
    mgmBldrgstPk?: string | number;
    mgmUpBldrgstPk?: string | number;
    bylotCnt?: string | number;
    [key: string]: unknown;
}

/** V-World 토지대장 row (ladfrlList) */
export interface LadfrlRow {
    pnu?: string;
    lndpclAr?: string;
    lndcgrCode?: string;
    [key: string]: unknown;
}

/** V-World 대지권등록부 row (ldaregList) */
export interface LdaregRow {
    pnu?: string;
    agbldgSn?: string;
    ldaQotaRate?: string;
    clsSeCode?: string;
    [key: string]: unknown;
}

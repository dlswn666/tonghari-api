/**
 * 주택 유형 분류용 공식 (대장구분·주용도) exact pair frozen fixture (DESIGN §9.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ Phase 0 실측 확정 전 PLACEHOLDER ⚠️
 *
 * 아래 `mainPurpsCd` / `mainPurpsCdNm` / `regstrGbCd` 값은 국토교통부 건축물대장
 * codebook의 표준 코드를 근거로 잠정 기입한 것이다. Phase 0에서 실제 운영 응답으로
 * 코드·명칭 표기(공백·괄호·유사 명칭 등)를 실측 확정하기 전까지는 placeholder이며,
 * 확정 시 이 파일의 상수만 교체한다(코드 로직·env 변경 없음).
 *
 * 확정된 pair만 허용한다. `mainPurpsCdNm.includes('주택')` 같은 substring 분류는
 * 절대 사용하지 않는다 (DESIGN §9.1). 매칭은 (regstrGbCd, mainPurpsCd, mainPurpsCdNm)
 * 세 필드가 정확히 일치할 때만 성립한다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 주택 세부 유형 */
export type HousingCategory = 'DETACHED' | 'MULTIFAMILY' | 'MULTIPLEX';

/** 자동 적용 전략 계열 (DESIGN §9.2) */
export type HousingStrategyFamily = 'LADFRL' | 'LDAREG';

/** 공식 (대장구분·주용도) pair 1건 */
export interface HousingPurposePair {
    /** 대장 구분: 1=일반, 2=집합 */
    regstrGbCd: '1' | '2';
    /** 주용도 코드 (Phase 0 placeholder) */
    mainPurpsCd: string;
    /** 주용도 명 (Phase 0 placeholder) */
    mainPurpsCdNm: string;
    category: HousingCategory;
    family: HousingStrategyFamily;
}

/**
 * 자동 진행이 허용되는 공식 pair allowlist (DESIGN §9.2 결정표 상단 3종).
 * - 단독주택 / 다가구주택: 일반(regstrGbCd=1) → LADFRL 계열
 * - 다세대주택:            집합(regstrGbCd=2) → LDAREG 계열
 */
export const HOUSING_PURPOSE_ALLOWLIST: readonly HousingPurposePair[] = [
    // 단독주택 (일반건축물) — LADFRL
    { regstrGbCd: '1', mainPurpsCd: '01000', mainPurpsCdNm: '단독주택', category: 'DETACHED', family: 'LADFRL' },
    // 다가구주택 (일반건축물) — LADFRL
    { regstrGbCd: '1', mainPurpsCd: '01002', mainPurpsCdNm: '다가구주택', category: 'MULTIFAMILY', family: 'LADFRL' },
    // 다세대주택 (집합건축물) — LDAREG
    { regstrGbCd: '2', mainPurpsCd: '02003', mainPurpsCdNm: '다세대주택', category: 'MULTIPLEX', family: 'LDAREG' },
] as const;

/**
 * "인지 가능하지만 v1에서 미지원"인 주택 유형 명칭 (DESIGN §9.2).
 *
 * ⚠️ Phase 0 placeholder — exact 전체 문자열 일치로만 사용한다(substring 아님).
 * 이 목록은 REVIEW 사유를 `UNSUPPORTED_HOUSING_TYPE`로 더 구체화하기 위한 용도일 뿐이며,
 * 어떤 경우에도 자동 적용(allowlist)으로 승격시키지 않는다. 즉 안전한 방향(REVIEW)에서
 * 이유만 세분화한다.
 */
export const UNSUPPORTED_HOUSING_TYPE_NAMES: readonly string[] = [
    '아파트',
    '연립주택',
    '다중주택',
] as const;

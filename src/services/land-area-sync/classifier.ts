/**
 * 주택 유형 분류 (DESIGN §9).
 *
 * 현재 앱의 `building_type`이나 사용자 입력을 쓰지 않고, Building HUB 표제부의
 * (regstrGbCd, mainPurpsCd, mainPurpsCdNm) 공식 pair만으로 판정한다.
 *
 * 핵심 계약:
 *  - allowlist에 있는 exact (대장구분·주용도) pair만 자동 진행을 허용한다.
 *  - `mainPurpsCdNm.includes('주택')` 같은 substring 분류는 금지한다 (DESIGN §9.1).
 *  - 혼재(일반·집합/purpose pair)·빈 코드·code/name 불일치·root 복수는 REVIEW_REQUIRED.
 *  - §9.2 결정표의 분류 관련 전 행을 구현한다(자동 전략 확정은 scope gate와 결합해 결정).
 */

import type { LandAreaSyncIssueCode } from '../../types/land-area-sync.types';
import {
    HOUSING_PURPOSE_ALLOWLIST,
    UNSUPPORTED_HOUSING_TYPE_NAMES,
    type HousingCategory,
    type HousingStrategyFamily,
} from './housing-purpose-allowlist.fixture';
import { housingOtherPurposeSignals } from './housing-purpose-signals';

/** 분류 입력. 분류에 필요한 표제부 필드와 root 관리번호 집합만 받는다. */
export interface HousingClassifierInput {
    titleRows: Array<{
        regstrGbCd?: string;
        mainPurpsCd?: string;
        mainPurpsCdNm?: string;
        etcPurps?: string;
    }>;
    /** DB resolver·title seed가 확정한 root 관리번호 집합(복수면 REVIEW). */
    rootIdentities: string[];
}

export type ClassificationReason =
    | 'NO_TITLE_ROWS'
    | 'MULTIPLE_ROOT_IDENTITIES'
    | 'MIXED_REGISTER_GB'
    | 'MIXED_PURPOSE_PAIR'
    | 'EMPTY_PURPOSE_CODE_OR_NAME'
    | 'CODE_NAME_MISMATCH'
    | 'REQUIRED_OTHER_PURPOSE_SIGNAL_MISSING'
    | 'CONTRADICTORY_OTHER_PURPOSE_SIGNAL'
    | 'UNSUPPORTED_HOUSING_TYPE'
    | 'NON_RESIDENTIAL_OR_MIXED';

export type HousingClassification =
    | { kind: 'CLASSIFIED'; family: HousingStrategyFamily; category: HousingCategory; regstrGbCd: '1' | '2' }
    | { kind: 'REVIEW_REQUIRED'; reason: ClassificationReason; issue: LandAreaSyncIssueCode };

function s(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function review(reason: ClassificationReason, issue: LandAreaSyncIssueCode): HousingClassification {
    return { kind: 'REVIEW_REQUIRED', reason, issue };
}

/**
 * 표제부 rows로 주택 유형을 분류한다 (DESIGN §9.2).
 * 자동 진행이 가능한 CLASSIFIED 또는 사유가 붙은 REVIEW_REQUIRED만 반환한다.
 */
export function classifyHousingType(inputData: HousingClassifierInput): HousingClassification {
    const { titleRows, rootIdentities } = inputData;

    // 분류할 표제부 없음(TITLE_COMPLETE_ZERO) → REVIEW
    if (titleRows.length === 0) {
        return review('NO_TITLE_ROWS', 'BUILDING_CLASSIFICATION_CONFLICT');
    }
    // root 관리번호 여러 개 → REVIEW
    if (new Set(rootIdentities.map((r) => s(r)).filter((r) => r.length > 0)).size > 1) {
        return review('MULTIPLE_ROOT_IDENTITIES', 'BUILDING_CLASSIFICATION_CONFLICT');
    }

    // 각 row 정규화 + 빈 코드·명칭 검사
    const norm = titleRows.map((r) => ({
        regstrGbCd: s(r.regstrGbCd),
        mainPurpsCd: s(r.mainPurpsCd),
        mainPurpsCdNm: s(r.mainPurpsCdNm),
        otherPurposeSignals: housingOtherPurposeSignals(r.etcPurps),
    }));
    for (const r of norm) {
        if (!r.regstrGbCd || !r.mainPurpsCd || !r.mainPurpsCdNm) {
            return review('EMPTY_PURPOSE_CODE_OR_NAME', 'BUILDING_CLASSIFICATION_CONFLICT');
        }
    }

    // 일반·집합 혼재
    if (new Set(norm.map((r) => r.regstrGbCd)).size > 1) {
        return review('MIXED_REGISTER_GB', 'BUILDING_CLASSIFICATION_CONFLICT');
    }

    // purpose pair 혼재 — 모든 row가 정확히 같은 (대장구분·코드·명칭) 세트여야 한다
    const distinctPairs = new Set(norm.map((r) => `${r.regstrGbCd}|${r.mainPurpsCd}|${r.mainPurpsCdNm}`));
    if (distinctPairs.size > 1) {
        return review('MIXED_PURPOSE_PAIR', 'BUILDING_CLASSIFICATION_CONFLICT');
    }

    const one = norm[0];

    // allowlist exact (대장구분·코드·명칭) 조회
    const exactPairMatches = HOUSING_PURPOSE_ALLOWLIST.filter(
        (p) => p.regstrGbCd === one.regstrGbCd && p.mainPurpsCd === one.mainPurpsCd && p.mainPurpsCdNm === one.mainPurpsCdNm
    );
    const matched = exactPairMatches.find(
        (pair) => {
            const expectedSignal =
                pair.category === 'DETACHED'
                    ? 'DETACHED_HOUSE'
                    : pair.category === 'MULTIFAMILY'
                      ? 'MULTI_UNIT_HOUSE'
                      : 'MULTIPLEX_HOUSE';
            return norm.every(
                (row) =>
                    row.otherPurposeSignals.every(
                        (signal) => signal === expectedSignal
                    ) &&
                    (!pair.requiredOtherPurposeSignal ||
                        row.otherPurposeSignals.includes(
                            pair.requiredOtherPurposeSignal
                        ))
            );
        }
    );
    if (matched) {
        return { kind: 'CLASSIFIED', family: matched.family, category: matched.category, regstrGbCd: matched.regstrGbCd };
    }
    if (exactPairMatches.length > 0) {
        const pair = exactPairMatches[0];
        const expectedSignal =
            pair.category === 'DETACHED'
                ? 'DETACHED_HOUSE'
                : pair.category === 'MULTIFAMILY'
                  ? 'MULTI_UNIT_HOUSE'
                  : 'MULTIPLEX_HOUSE';
        if (
            norm.some((row) =>
                row.otherPurposeSignals.some(
                    (signal) => signal !== expectedSignal
                )
            )
        ) {
            return review(
                'CONTRADICTORY_OTHER_PURPOSE_SIGNAL',
                'BUILDING_CLASSIFICATION_CONFLICT'
            );
        }
        return review(
            'REQUIRED_OTHER_PURPOSE_SIGNAL_MISSING',
            'BUILDING_CLASSIFICATION_CONFLICT'
        );
    }

    // 인지 가능하지만 미지원(아파트·연립·다중) — exact 명칭 일치로만 사유를 세분화(자동 승격 아님)
    if (UNSUPPORTED_HOUSING_TYPE_NAMES.includes(one.mainPurpsCdNm)) {
        return review('UNSUPPORTED_HOUSING_TYPE', 'UNSUPPORTED_HOUSING_TYPE');
    }

    // code/name 불일치인지(코드는 allowlist에 있으나 명칭·대장구분이 다름) 구체화
    const codeKnown = HOUSING_PURPOSE_ALLOWLIST.some((p) => p.mainPurpsCd === one.mainPurpsCd);
    const nameKnown = HOUSING_PURPOSE_ALLOWLIST.some((p) => p.mainPurpsCdNm === one.mainPurpsCdNm);
    if (codeKnown || nameKnown) {
        return review('CODE_NAME_MISMATCH', 'BUILDING_CLASSIFICATION_CONFLICT');
    }

    // 비주거·복합용도 등 그 외
    return review('NON_RESIDENTIAL_OR_MIXED', 'BUILDING_CLASSIFICATION_CONFLICT');
}

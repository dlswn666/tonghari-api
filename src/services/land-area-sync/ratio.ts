/**
 * 대지권 비율(ldaQotaRate) parser + 분모-필지면적 허용오차 (DESIGN §12.1, §7.5).
 *
 * 핵심 계약:
 *  - 허용 형식은 `분자/분모`(슬래시 주변 공백 변형 허용)의 정확한 소수/정수 쌍뿐이다.
 *  - 파싱은 **복사본만 trim** 하고, 반환 구조의 `raw`에는 **원문 문자열을 그대로 보존**한다.
 *  - 거부: 분모 0, 음수·0 분자, 분자>분모, 지수 표기, 임의 문자, overflow (DESIGN §12.1).
 *  - 분모 vs LADFRL 면적 비교는 호출측(Task 10)이 수행한다. 여기서는 순수 비교 함수만 제공한다.
 *  - 대지권면적은 분자다(`land_lots.area × 분자 ÷ 분모`로 재비례하지 않는다, §7.5).
 */

import type { LandAreaSyncIssueCode } from '../../types/land-area-sync.types';

/** §7.5 절대 허용오차(㎡). env로 조용히 완화하지 않는다. */
export const RATIO_DENOMINATOR_ABS_TOLERANCE = 0.1;
/** §7.5 상대 허용오차(0.001% = 0.00001). */
export const RATIO_DENOMINATOR_REL_TOLERANCE = 0.00001;

/** 부호 없는 십진수(지수 표기 불허). 예: `181.7`, `15622`, `0`. */
const DECIMAL_TOKEN_RE = /^\d+(\.\d+)?$/;
/** 음수 분자 감지용(부호 허용). */
const SIGNED_DECIMAL_TOKEN_RE = /^-\d+(\.\d+)?$/;

/** 비율 파싱 실패 사유(테스트·audit 식별용 string union). */
export type RatioParseFailReason =
    | 'EMPTY'
    | 'MALFORMED_STRUCTURE'
    | 'EXPONENT_NOTATION'
    | 'NON_NUMERIC'
    | 'DENOMINATOR_ZERO'
    | 'NUMERATOR_NOT_POSITIVE'
    | 'NUMERATOR_EXCEEDS_DENOMINATOR'
    | 'OVERFLOW';

/** 비율 파싱 결과. 성공/실패 모두 원문(raw)을 보존한다. */
export type RatioParseResult =
    | {
          ok: true;
          /** 원문 문자열(trim 하지 않음). */
          raw: string;
          numerator: number;
          denominator: number;
          /** trim된 복사본의 분자/분모 텍스트(정확 저장용). */
          numeratorText: string;
          denominatorText: string;
      }
    | {
          ok: false;
          raw: string;
          issue: Extract<LandAreaSyncIssueCode, 'RATIO_PARSE_FAILED'>;
          reason: RatioParseFailReason;
      };

function fail(raw: string, reason: RatioParseFailReason): RatioParseResult {
    return { ok: false, raw, issue: 'RATIO_PARSE_FAILED', reason };
}

/**
 * ldaQotaRate 문자열을 파싱한다 (DESIGN §12.1).
 * 원문은 raw로 보존하고 파싱은 복사본만 trim한다.
 */
export function parseLdaQotaRate(raw: unknown): RatioParseResult {
    // 원문 보존: 문자열이 아니면 빈 문자열로 취급하되 raw에는 안전한 표현을 담는다.
    const original = typeof raw === 'string' ? raw : '';
    const work = original.trim();

    if (work === '') return fail(original, 'EMPTY');

    // 정확히 하나의 슬래시로 분리되어야 한다.
    const parts = work.split('/');
    if (parts.length !== 2) return fail(original, 'MALFORMED_STRUCTURE');

    const numeratorText = parts[0].trim();
    const denominatorText = parts[1].trim();
    if (numeratorText === '' || denominatorText === '') return fail(original, 'MALFORMED_STRUCTURE');

    // 지수 표기 우선 거부(둘 중 하나라도 e/E 포함).
    if (/[eE]/.test(numeratorText) || /[eE]/.test(denominatorText)) {
        return fail(original, 'EXPONENT_NOTATION');
    }

    // 분자: 음수는 NUMERATOR_NOT_POSITIVE로 구체화, 그 외 형식 위반은 NON_NUMERIC.
    if (SIGNED_DECIMAL_TOKEN_RE.test(numeratorText)) {
        return fail(original, 'NUMERATOR_NOT_POSITIVE');
    }
    if (!DECIMAL_TOKEN_RE.test(numeratorText)) {
        return fail(original, 'NON_NUMERIC');
    }
    if (!DECIMAL_TOKEN_RE.test(denominatorText)) {
        return fail(original, 'NON_NUMERIC');
    }

    const numerator = Number(numeratorText);
    const denominator = Number(denominatorText);

    // overflow(무한대) 방어 — 지수 표기는 이미 거부됐으므로 초장문 숫자만 남는다.
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
        return fail(original, 'OVERFLOW');
    }

    if (denominator === 0) return fail(original, 'DENOMINATOR_ZERO');
    if (numerator <= 0) return fail(original, 'NUMERATOR_NOT_POSITIVE');
    if (numerator > denominator) return fail(original, 'NUMERATOR_EXCEEDS_DENOMINATOR');

    return { ok: true, raw: original, numerator, denominator, numeratorText, denominatorText };
}

/**
 * 분모가 같은 실행의 LADFRL 필지면적과 허용오차 이내인지 검사한다 (DESIGN §7.5).
 * `abs(denominator - ladfrlArea) <= max(0.1㎡, ladfrlArea × 0.00001)`.
 */
export function isDenominatorWithinTolerance(denominator: number, ladfrlArea: number): boolean {
    const tolerance = Math.max(RATIO_DENOMINATOR_ABS_TOLERANCE, ladfrlArea * RATIO_DENOMINATOR_REL_TOLERANCE);
    return Math.abs(denominator - ladfrlArea) <= tolerance;
}

/**
 * 분모-면적 불일치를 issue code로 반환하는 얇은 래퍼(호출측 편의).
 * 불일치는 자동 보정이 아니라 검토 사유다(§7.5).
 */
export function checkDenominatorAgainstArea(
    denominator: number,
    ladfrlArea: number
): { ok: true } | { ok: false; issue: Extract<LandAreaSyncIssueCode, 'RATIO_DENOMINATOR_MISMATCH'> } {
    return isDenominatorWithinTolerance(denominator, ladfrlArea)
        ? { ok: true }
        : { ok: false, issue: 'RATIO_DENOMINATOR_MISMATCH' };
}

/**
 * 동·층·호·실 exact normalizer 지하 표기 codebook frozen fixture (DESIGN §12.3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 보수적 최소 집합 (conservative minimal set) ⚠️
 *
 * §12.3은 "codebook에 정의한 지하 표기만 `B`로 통일"을 허용하고, 그 외 임의 추론·
 * fuzzy·contains 는 금지한다. 지하 표기의 실제 원문 변형은 Phase 0 실측으로 확정되지
 * 않았으므로, 브리프가 예시로 든 세 형태(`지하1`, `지1`, `B1`)만 근거로 하는 최소
 * codebook 으로 시작한다. 확정 시 이 배열만 교체한다(정규화 로직·env 변경 없음).
 *
 * 규칙: segment 가 아래 prefix 중 하나로 정확히 시작하고 그 바로 뒤가 숫자일 때만
 * 해당 prefix 를 `B` 로 통일한다. prefix 뒤가 숫자가 아니면(예: `지하`, `동`) 매핑하지
 * 않는다. 더 긴 prefix(`지하`)를 짧은 prefix(`지`)보다 먼저 검사한다(normalizer 가
 * 길이 내림차순으로 정렬해 사용).
 *
 * `b` 는 소문자 입력을 위해 포함한다. NFKC 후에도 ASCII `B`/`b` 는 그대로이므로
 * 대문자 통일은 codebook 매핑 단계에서 수행한다.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const BASEMENT_PREFIX_CODEBOOK: readonly string[] = ['지하', '지', 'B', 'b'] as const;

# 법령 MCP 응답 파싱 오류 복구

## 요구사항과 정본

사용자 요청: 지역별 과소필지 검토를 막는 법령 MCP 오류부터 수정한다.
정본은 `docs/2026-08-31-current-law-legal-mcp-acceptance.md`와 Obsidian `Projects/도시정비법-분석-MCP.md`다.
운영은 `https://api.tonghari.kr/mcp`, `tonghari-api/src/services/legal-research`의 research → render 계약이다.

## 역할과 실행 순서

1. 기획/분석: 최소 질문으로 실패 단계를 분리하고 실제 공급자 응답을 확인한다.
2. 구현: 실응답의 재현 테스트를 먼저 추가하고 확인된 형식 차이만 처리한다.
3. 리뷰: 현행성·관할·출처 식별 검증이 느슨해지지 않는지 독립 검토한다.
4. 검증: 파서·provider 회귀, 전체 테스트·빌드, 공식 GitHub 배포, 실제 MCP research → render를 확인한다.

## Acceptance checklist

- [ ] 외부 응답에서 실패 지점과 원인을 확인한다. 오류 이름만으로 파서 문제를 추정하지 않는다.
- [ ] 인증값과 개인정보가 없는 최소 재현 fixture 및 회귀 테스트로 실패를 입증한다.
- [ ] 정상 현행 법령·서울 과소필지 조례 조회가 원문과 출처 식별자를 보존해 반환된다.
- [ ] 잘못된 형식·다른 출처·현행이 아닌 근거를 기존과 같이 거부한다.
- [ ] 공개 도구 계약 및 research packet → render 검증을 유지한다.
- [ ] 필요한 진단 정보는 고정 단계/필드 등으로 제한하고 OC·URL 인증값·원문·질문을 로그에 노출하지 않는다.
- [ ] 관련 테스트, 전체 API 테스트, TypeScript 빌드와 writer guard가 통과한다.
- [ ] 최신 main을 반영한 후보를 공식 배포 workflow로 운영에 반영하고 health의 소스 SHA와 기존 MCP 인증 상태를 확인한다.
- [ ] 실패하던 실제 MCP 질문을 재호출하고 research와 render 결과를 확인한다.

## 범위

이번 작업은 법령 MCP 조회 복구다. 지역별 과소필지 필터 확장과 소유 원장 변경은 별도다.
근거 부족에 따른 정상적인 결론 유보는 성공적인 조회와 구분하여 보고한다.

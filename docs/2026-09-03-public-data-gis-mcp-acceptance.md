# 통하리 공공 GIS MCP v1 acceptance

> 2026-09-08 변경: 소비자에게 결과 저장을 금지하던 내부 지시는 사용자 요청으로
> 제거한다. 이 서버 자체가 DB·queue에 쓰지 않는 구조는 유지한다.
> 최신 계약은 `2026-09-08-gis-mcp-storage-instructions-acceptance.md`를 따른다.

## 정본과 목적

- 구조 정본: 현행 법률 MCP의 `POST /mcp` Streamable HTTP, client별 digest
  bearer registry, Caddy proxy 증명, 설정 누락 시 독립 503, health 설정 상태 계약.
- 데이터 정본: `tonghari-api`의 VWorld/data.go.kr GIS 서비스와 Obsidian
  `통하리-GIS-API-인스펙터`, `VWorld-API` 노트.
- 목적: VWorld와 건축HUB의 공개 데이터를 DB 쓰기 없이 조회하는 별도
  `POST /gis-mcp` surface를 제공한다.

현재 화면이나 13단계 raw inspector는 정본이 아니다. MCP는 외부 공개 데이터만
조회하며 조합, 사용자, `property_units`, Supabase 또는 sync queue를 읽거나 쓰지 않는다.

## 역할별 관점

- 기획/분석: 법률 `/mcp`와 별도 endpoint·scope·secret·rate bucket을 사용한다.
- 구현: 기존 PNU·경계·가격·건축물대장·NED pagination/projection을 재사용한다.
- 리뷰: provider allowlist 밖 필드와 개인정보, 비밀, 상업 이용 금지 데이터를 제거한다.
- 검증: schema, middleware 순서, body/output budget, deadline, admission, rate limit,
  provider 실패와 pagination을 테스트한다.

## 공개 surface

다음 기존 다섯 read-only 도구와 전체 조회 도구를 공개한다.

1. `resolve_address_to_pnu_v1`
2. `lookup_parcel_public_data_v1`
3. `lookup_building_register_v1`
4. `lookup_housing_official_price_v1`
5. `lookup_land_right_registration_v1`
6. `lookup_full_gis_public_data_v1` — 2026-09-06 추가, 14개 자료별 상태·페이지·원래 필드 의미 보존

추가로 review prompt 1개와
`tonghari-gis://policy/public-data/v1` policy resource 1개를 제공한다.

## 계층별 acceptance checklist

### API/data shape

- [x] 주소는 1~300자, PNU는 정확한 숫자 19자리만 허용한다.
- [x] 연도는 2000~호출 시점의 다음 해, 페이지는 `offset >= 0`, `limit 1..100`이다.
- [x] client가 endpoint, key, URL, provider raw parameter, WFS filter를 지정할 수 없다.
- [x] 모든 성공/부분 결과에는 provider, operation/source URL, queriedAt/asOf,
  VWorld 출처표시가 있다.
- [x] `SUCCESS | PARTIAL | NO_DATA | FAILED | INCOMPLETE`를 구분하고 provider
  실패를 확정적 무자료로 바꾸지 않는다.

### runtime/model

- [x] 전체 요청 deadline 기본 45초, 동시 2, 대기 4를 적용한다.
- [x] bearer별/프로세스 rate limit은 법률 MCP와 독립이다.
- [x] output JSON은 128KB를 넘으면 원문 없이 fail-closed 한다.
- [x] geometry와 records는 bounded projection만 반환한다.

### transport/security

- [x] 허용 revision은 `2026-07-28`과 Codex 호환 `2025-06-18`로 고정하고,
  2025 경로는 SDK stateless fallback만 사용한다.
- [x] `/gis-mcp`는 전역 1MB JSON parser보다 먼저 mount하고 전용 256KB 제한을 쓴다.
- [x] 검증 순서는 Host → Origin → Caddy HTTPS/proxy 증명 → Bearer → JSON →
  rate limit → MCP handler다.
- [x] `GIS_MCP_TOKEN_REGISTRY_JSON`은 client 1~32 strict v1이며 raw token을 저장하지 않는다.
- [x] registry와 legacy digest 동시 설정, upstream key 누락, proxy digest/host 형식 오류는
  `/gis-mcp`만 stable 503으로 닫는다.
- [x] health는 설정 유효성/모드/count만 노출하고 secret 또는 provider reachability를
  성공으로 주장하지 않는다.

### 금지 범위

- [x] `GisInspectService.rawJson`, provider error body, stack, API key, JWT, service role,
  소유자 이름/연락처를 반환하거나 로그에 남기지 않는다.
- [x] 기존 5개 도구는 `buldHoCoList`를 호출하지 않는다. 전체 조회 도구는 사용자가 별도 이용허락 확보를 확인한 2026-09-06 요청 범위에서 호출한다. 상세 정본은 `2026-09-06-gis-mcp-full-lookup-acceptance.md`다.
- [x] 폐기된 data.go.kr `ContinuousLandInfoService`를 사용하지 않는다.
- [x] MCP 서버 자체는 geocoder 결과를 캐시/DB/sync job에 저장하지 않는다.
  소비자의 후속 저장을 금지하는 경고·지시는 제공하지 않는다.
- [x] 공시가격을 감정평가로, 대지권/건축물대장을 등기상 권리 확정으로 표현하지 않는다.

## 실행 순서와 완료 기준

1. 데이터 projection과 provider/runtime 테스트
2. MCP server contract와 transport/auth/rate 테스트
3. TypeScript build와 전체 회귀 테스트
4. 최신 `main`을 작업 브랜치에 merge한 뒤 동일 검증
5. merge/push 이후 별도 운영 활성화 gate

코드 merge는 live MCP 활성화를 뜻하지 않는다. 운영 완료는 VWorld 운영키의 MCP 용도,
건축HUB 활용계정/한도, Caddy owner-only proxy secret, API digest registry, 공개 3100 차단,
HTTPS tools/list와 각 provider live smoke를 모두 확인한 경우에만 보고한다.

# 건축물대장 기준·부속지번 자동연결 구현 계획

- 작성일: 2026-07-18
- 기준 설계: `docs/2026-07-14-building-registry-parcel-auto-link-design.md` §19
- 기준 노트: `Projects/Johapon-건축물대장-기준지번-부속지번-자동연결.md`
- 대상 저장소: `tonghari-api`, `tonghari-web`
- 현재 실행 권한: 개발 코드·개발 DB·개발 Vercel 검증. 운영 DB DDL/DML/history repair는 포함하지 않음

## 1. 목표와 구현 범위

GIS 업로드로 들어온 PNU가 건축물대장의 기준지번인지 부속지번인지 관측하고, 각 PNU를 독립 필지로 유지하면서 동일한 공식 관리번호로 증명된 경우에만 같은 canonical `building_id`에 투영한다.

이 작업은 대표 PNU 하나로 합치는 기능이 아니다.

```text
land_lots / property_units.pnu
  기준 PNU와 부속 PNU를 각각 보존
          ↓
building_registry_land_lot_relations
  기준 PNU ↔ 부속 PNU ↔ mgmBldrgstPk evidence
          ↓
canonical writer RPC
  충돌·권한·operation epoch·관리번호 cardinality 검증
          ↓
building_land_lots
  두 PNU가 같은 canonical building을 가리키는 projection
```

최초 릴리스 범위는 다음까지다.

- GIS 업로드 중 기준·부속지번 공식 API 관측
- API 관측과 관리자의 수동 보정을 같은 evidence/projection 파이프라인으로 처리
- 단일 관리번호이고 충돌이 없는 component만 projection
- `building_land_lots` provenance, quarantine, append-only event
- 기존 GIS_DIRECT·가격·공식명 writer를 typed canonical RPC로 이관
- 비파괴 수동 기준·부속지번 연결 UI
- `property_units`, `property_ownerships`, 과소필지 결과 불변 검증

다음은 최초 릴리스에서 제외한다.

- `property_units.pnu` 대표 지번 치환 또는 행 병합
- `property_units.building_unit_id`, building-derived `dong/ho` 자동 기록
- 복수 관리번호 component의 자동 건물 선택
- `building_group → registry_building → unit` 다중 건물 모델 개편
- 삼양동 운영 데이터 보정

## 2. 구현 전 acceptance checklist

### 2.1 요구사항

- [ ] 기준·부속 PNU는 각각 `land_lots(pnu, union_id)` 행으로 남는다.
- [ ] API evidence와 수동 evidence는 구분해 저장하되 같은 canonical projection RPC를 사용한다.
- [ ] 동일 component의 공식 관리번호가 정확히 1개일 때만 신규/재사용 projection을 허용한다.
- [ ] 관리번호가 0개 또는 2개 이상이면 기존 mapping을 덮어쓰지 않는다.
- [ ] `building_land_lots`의 기준/부속 방향은 단순 role 컬럼이 아니라 relation evidence가 결정한다.
- [ ] 모든 building family mutation은 DB lock 안의 typed RPC에서만 일어난다.
- [ ] 모든 조합 범위 입력은 `union_id`, actor, source, explicit input PNU를 서버와 DB에서 다시 검증한다.
- [ ] 최초 릴리스에서 property link flag는 항상 OFF다.
- [ ] API 누락 시 수동 보정도 `PNU 확보 → evidence → 검증 → projection` 순서를 따른다.

### 2.2 역할별 관점

| 역할 | 책임 | 승인 기준 |
| --- | --- | --- |
| 기획/분석 | §19의 불변식과 현재 코드 차이를 acceptance item으로 고정 | 구현이 대표 PNU 병합으로 변질되지 않음 |
| DB 구현 | W1/W2/W3P/W3F migration, RLS/ACL, canonical RPC, lock/epoch/replay | clean replay, SQL 회귀, public direct access 차단 |
| API 구현 | DB target routing, queue admission, 건축물대장 client, dark adapter, canonical writer adapter | 잘못된 target으로 fallback 0, partial/error를 empty로 오독 0 |
| Web 구현 | scoped read, 개발 DB 토큰, 수동 relation UI, 기존 destructive UI 제거 | 브라우저 direct building 접근 0, dev Vercel 실제 검증 |
| 리뷰 | schema DAG, source matrix, 멀티테넌시, 동시성, 보안 독립 검토 | blocker 0, migration/code diff 승인 |
| 검증 | A/B shared-PNU, replay, fault injection, canary artifact | 대상·타 조합 property/과소필지 hash 불변 |
| Arbitrator | 설계와 기존 코드 판단이 충돌할 때 §19 근거로 판정 | 설계를 약화하는 임시 우회 금지 |
| Release | 정확한 SHA, migration parity, dev-first promotion, rollback 준비 | 같은 후보 SHA만 승격 |

### 2.3 완료 판단의 공통 증거

모든 단계는 다음 다섯 종류의 증거를 남긴다.

1. 소스·migration exact Git SHA
2. 실행한 명령과 종료 코드
3. schema/ACL 또는 writer manifest hash
4. 합성 fixture 전후 hash-only artifact
5. 다음 단계 진입 가능 여부와 남은 blocker

테스트가 통과했다는 문장만으로는 exit gate를 닫지 않는다.

## 3. 현재 상태 기준선

상태 표시는 `완료`, `부분 완료`, `미착수`, `운영 승인 대기`를 사용한다.

| 작업 | 상태 | 현재 확인된 사실 | 다음 조치 |
| --- | --- | --- | --- |
| API Phase 0-S 안전 차단 | 부분 완료 | `ecf6392`가 API `main`에 있고 route scope·queue admission·property auto-link 차단 테스트가 존재함 | 운영 배포 SHA와 실제 HTTPS smoke를 다시 확인 |
| Web destructive 병합 차단 | 완료(저장소) | `101c95f`가 Web `master`에 있고 merge/delete/link 함수와 UI가 fail-closed | 신규 수동 relation UI가 준비될 때까지 유지 |
| API Phase 0 gate 브랜치 | 부분 완료 | `codex/building-registry-phase0-gates`가 API `main`보다 6커밋 앞섬 | 최신 `main` 반영, dirty DB routing 변경을 별도 review/commit |
| Web baseline 브랜치 | 부분 완료 | audited operating schema baseline 후보와 manifest/tooling이 전용 worktree에 존재 | clean replay/fingerprint parity와 history manifest 확정 |
| Web dev-release 브랜치 | 부분 완료 | Phase 0 gate 커밋을 포함하나 API target/proxy 변경이 미커밋 | `origin/dev` 최신 반영 후 같은 후보로 검증 |
| 개발 DB A/B fixture | 완료(로컬 artifact) | GIS·토지 가격·공동주택 가격·개별주택 가격·member import 5개 gate와 property/ownership/과소필지 hash 불변 검증이 PASS | 후보 SHA와 artifact index를 고정하고 배포된 dev route smoke에서 재확인 |
| 운영 read-only preflight | 부분 완료 | 2026-07-15 aggregate/catalog 보고서가 있음 | 배포 후보 SHA 기준 재실행, 원문 개인정보 저장 금지 |
| DB target routing | 부분 완료 | 양 저장소 worktree에 production/development 분기 코드와 테스트가 있으나 미커밋·미배포 | 4단계의 D0 gate 수행 |
| W1 operation/command schema | 미착수 | migration과 RPC 없음 | W0/R0 증거 확정 뒤 전용 브랜치와 `tonghari_dev`에서 dev-only 개발·적용·테스트 |
| W2 relation/observation schema | 미착수 | relation·manual override·scan ledger 없음 | W1/A1a PASS 뒤 시작 |
| W3P provenance/canonical RPC | 미착수 | `building_land_lots`에 provenance 컬럼이 없고 canonical RPC 없음 | W2 PASS 뒤 시작 |
| A1b 건축물대장 adapter | 미착수 | `getBrAtchJibunInfo`, `bylotCnt`, 공통 resultCode/pagination adapter 없음 | W3P/A0b PASS 뒤 시작 |
| Projection | 미착수 | 현재 PNU별 `upsertBuilding`이 별도 building을 만들 수 있음 | A2-RC typed RPC로 교체 |
| 수동 relation UI | 미착수 | 기존 destructive action은 Phase F 오류로 차단됨 | W4-RC에서 비파괴 UI로 교체 |

### 3.1 현재 코드와 목표의 핵심 차이

현재 GIS 흐름은 입력 주소마다 `getBuildingInfo(pnu)`와 `saveBuildingWithUnits(pnu, ...)`를 실행한다. `upsertBuilding`은 같은 PNU의 mapping만 찾으므로 기준 PNU와 부속 PNU가 각각 입력되면 별도 building을 만들 수 있다.

현재 `building_land_lots`에는 `building_id`, `pnu`, `previous_building_id`, `note` 등만 있고 다음 컬럼이 없다.

- `mapping_source`
- `support_status`
- `last_verified_at`
- `last_sync_job_id`
- `last_applied_operation_id`

현재 건축물대장 client는 `getBrTitleInfo`, `getBrExposInfo`만 사용하고 다음 계약이 없다.

- `getBrAtchJibunInfo`
- `getBrExposPubuseAreaInfo`
- `platGbCd 0/1 ↔ PNU 토지구분 1/2` 변환
- 모든 페이지 수집과 `resultCode` 상태 분류
- partial/protocol/throttle 오류의 fail-closed 처리

## 4. 운영 DB 무변경 경계

이 문서에 따른 현재 개발 실행은 운영 DB를 변경하지 않는다.

- 운영 project: `tonghari_prod` / `bpdjashtxqrcgxfequgf`
- 개발 project: `tonghari_dev` / `yxypndgipnxrdfyctmvh`
- 운영에서는 aggregate/catalog/schema/history 읽기만 허용한다.
- 운영 DDL, DML, `migration repair`, history INSERT/DELETE, fixture 적용을 금지한다.
- 개발 DB에는 합성 A/B fixture만 사용하며 운영 조합원·소유자·개인정보를 복사하지 않는다.
- 모든 개발 DB runner는 운영/개발 project ref와 URL 동일 여부를 검사하고 fail-closed한다.
- 개발 JWT 또는 개발 DB 설정이 불완전하면 운영 DB로 fallback하지 않는다.
- 로그와 artifact에는 DB URL, service-role key, JWT secret, 원문 개인정보를 남기지 않는다.

설계의 O0는 운영 application DDL/data를 변경하지 않더라도 `supabase_migrations.schema_migrations` history를 변경하는 운영 write다. 따라서 현재 권한에는 포함되지 않는다.

**O0 전에도 W1 이후 migration과 코드는 전용 작업 브랜치에서 개발하고 별도 `tonghari_dev`에 적용·테스트할 수 있다. 검증 후보는 Web `dev`에만 merge/push해 개발 Vercel과 함께 확인할 수 있다. 다만 O0 PASS 전에는 W1 이후 후보를 API `main`, Web `master`에 merge하거나 운영 DB에 적용하지 않는다. O0는 개발 착수 차단이 아니라 기본 브랜치·운영 승격 차단이다.**

## 5. 브랜치와 dev-first 승격 규칙

### 5.1 공통 브랜치 규칙

1. 각 저장소 기본 브랜치를 `fetch` 후 `pull --ff-only`로 최신화한다.
2. 기존 dirty worktree 변경은 reset하지 않고 먼저 범위별 diff와 테스트로 보존한다.
3. 작업 단위마다 전용 브랜치를 사용한다. W1, W2, W3P, A1b, projection, manual UI를 한 브랜치에 섞지 않는다.
4. 의존 단계의 exit artifact가 없으면 다음 브랜치를 merge하지 않는다.
5. merge 준비 시 작업 브랜치에 최신 기본 브랜치를 먼저 merge하고 전체 검증을 반복한다.

### 5.2 `tonghari-web` dev promotion gate

모든 Web 릴리스 후보는 다음 순서를 강제한다.

```text
작업 브랜치 exact SHA
  → dev 브랜치 merge/push
  → 개발 Supabase migration 적용
  → 개발 Vercel 배포
  → 자동 테스트 + 브라우저 실제 기능 검증
  → 후보 SHA/DB migration hash 고정
  → 같은 후보만 master merge/push
```

- dev 검증 뒤 코드가 한 줄이라도 바뀌면 새 후보로 처음부터 반복한다.
- dev 실패 또는 실환경 검증 미완료 상태에서는 `master`에 merge하지 않는다.
- D0 같은 schema 비의존 안전 변경은 dev PASS 뒤 동일 SHA를 기존 규칙대로 승격할 수 있다.
- W1 이후 schema·relation·projection 후보는 dev PASS만으로 `master`/API `main`에 승격하지 않으며 O0 PASS를 추가로 요구한다.

## 6. 실행 순서와 단계별 gate

### D0. Phase 0 DB target routing 확정·배포

#### 목적

별도 API 개발 컨테이너를 만들지 않고, 현재 `tonghari-api`가 서명된 proxy JWT의 `databaseTarget`에 따라 운영 또는 개발 Supabase를 선택하게 한다. Web dev는 같은 API endpoint를 호출하되 개발 JWT만 발급한다.

#### API 구현

- 현재 dirty 변경을 최신 `main` 기준 전용 브랜치로 보존한다.
- `DatabaseTarget = 'production' | 'development'`를 request identity에 포함한다.
- production/development JWT secret을 분리하고 issuer/`kid`/target 조합을 검증한다.
- `getSupabaseService(databaseTarget)`가 target별 singleton client를 반환하게 한다.
- GIS·가격·member·consent queue request와 in-memory job key에 target을 끝까지 전달한다.
- `sync_jobs` 조회·갱신도 같은 target client를 사용한다.
- 개발 설정 일부 누락, 운영과 같은 URL/key/secret, 알 수 없는 target은 서버 시작 또는 요청 단계에서 거부한다.
- 알림톡·SMS·전자투표 알림 등 운영 side effect는 development token에서 거부한다.

#### Web 구현

- 공용 `apiProxyToken`에서 `API_DATABASE_TARGET`을 필수로 읽는다.
- production은 `JWT_SECRET`, development는 `DEV_API_JWT_SECRET`만 사용한다.
- GIS API base URL은 중앙 `gisProxyEndpoint`에서 결정한다.
- production target의 공용 HTTP를 금지하고, 합성 개발 DB에 한해서만 명시적 임시 플래그를 허용한다.
- GIS, member invite, consent, mobile match, 알림 관련 모든 API proxy가 같은 target 계약을 사용하게 한다.

#### 배포 순서

1. API routing 후보의 unit/build/test를 통과한다.
2. API 배포 환경에 `DEV_API_JWT_SECRET`, `DEV_SUPABASE_URL`, `DEV_SUPABASE_SERVICE_ROLE_KEY`를 추가한다.
3. API 후보를 배포하고 production token smoke가 기존 production target을 유지하는지 확인한다.
4. Vercel dev에 `API_DATABASE_TARGET=development`, 같은 `DEV_API_JWT_SECRET`, API URL을 설정한다.
5. Web 후보를 `dev`에 배포한다.
6. 개발 Web에서 생성한 token으로 GIS sync를 실행하고 개발 `sync_jobs`에만 행이 생기는지 확인한다.
7. 운영/개발 양 DB의 target 외 delta가 0인지 read-only 검증한다.

#### 자동 검증

- API: `npm test`, `npm run build`, DB target routing/security middleware 테스트
- Web: Phase 0 DB gate, unit test, typecheck, lint, production build compile/type 단계
- 부정 테스트:
  - development token + production issuer/secret
  - production token + development issuer/secret
  - target claim 누락/오타
  - 개발 환경변수 일부만 설정
  - 운영과 개발 Supabase URL/key 동일
  - 동일 job UUID의 서로 다른 target 조회
  - development token의 운영 side-effect route 호출

#### Exit gate

- [ ] 잘못된 target으로 fallback하는 경로 0건
- [ ] 개발 GIS write는 개발 DB에만 존재
- [ ] production token 동작 회귀 0건
- [ ] secret/URL 원문 로그 0건
- [ ] API exact SHA와 Web dev exact SHA 기록

### W0/R0. baseline과 Phase 0 안전 증거 마감

#### W0 산출물

- 운영 `public` application schema 전체의 schema-only dump
- 운영 393 history의 statements 보존본과 signed manifest
- repository migration manifest와 frozen legacy hash
- pinned Supabase CLI/config/runbook
- promoted audited squash baseline 1개와 static seed 분리
- baseline-only, baseline+seed clean reset
- replay DB와 운영 catalog/ACL fingerprint exact parity
- disposable clone에서 history reconciliation과 inverse rehearsal

기존 baseline 후보는 출발점이지 완료 증거가 아니다. `IF NOT EXISTS`로 drift를 숨기거나 네 토대 테이블만 손으로 복구하지 않는다.

#### R0 산출물

- production read-only preflight 재실행
- building writer/read/property-link manifest
- sync-job, unit identity, external identity conflict report
- A/B shared-PNU fixture의 다음 다섯 작업 전후 artifact
  - GIS sync
  - land price
  - apartment price
  - individual housing price
  - 승인된 member import
- `property_units`, `property_ownerships`, canonical member property, 과소필지, `building_land_lots`, orphan summary hash

#### Exit gate

- [ ] baseline replay와 운영 fingerprint exact match
- [ ] migration/history signed manifest 검증
- [x] 다섯 작업의 대상·peer 조합 불변식 PASS — 현재 로컬 hash-only artifact로 검증 완료
- [ ] automatic property-building writer allowlist 0건
- [ ] `building_external_refs` 조기 잠금 migration의 review 준비
- [ ] O0 실행·inverse 명령과 dry-run 보고서 승인 준비

W0/R0의 남은 baseline·history 증거를 마감하면 O0 준비와 W1 dev-only 구현을 병렬로 진행한다. O0가 승인되지 않아도 W1은 전용 브랜치와 `tonghari_dev`에서 개발·적용·검증할 수 있지만 기본 브랜치와 운영으로 승격할 수 없다.

### O0. 운영 baseline history cutover — 별도 승인 단계

O0는 이 계획의 자동 실행 대상이 아니며 W1의 dev-only 개발을 막지 않는다. 사용자 승인, Supabase 백업/PITR, write freeze, drain을 별도 확인한 뒤 기본 브랜치·운영 승격 전에 수행한다.

#### 필수 순서

1. 배포 SHA와 운영 catalog/history fingerprint를 freeze한다.
2. PITR/backup 상태를 확인한다.
3. 승인된 repair manifest와 exact inverse manifest hash를 확인한다.
4. migration history만 baseline 상태로 reconciliation한다.
5. application schema/data/ACL fingerprint가 byte-equivalent인지 확인한다.
6. local/remote migration parity와 pending DDL 0을 확인한다.

#### 실패 처리

- 운영 W1 DDL 적용 전 부분 실패: 승인된 inverse manifest만 사용한다.
- 운영 W1 DDL 적용 후: history inverse를 금지하고 forward corrective migration만 사용한다.
- application schema/data/ACL delta가 하나라도 있으면 W1 후보의 기본 브랜치 merge와 운영 적용을 시작하지 않는다. `tonghari_dev`의 dev-only 실험은 운영과 분리해 유지한다.

### W1/A1a. operation·input scope·command foundation

W0/R0의 개발 선행 증거가 PASS하면 전용 작업 브랜치와 `tonghari_dev`에서 시작하는 첫 additive schema 작업이다. O0 PASS 전에는 API `main`, Web `master`, 운영 DB에 승격하지 않는다.

#### W1 migration

CLI timestamp migration `sync_job_operation_foundation`을 생성한다.

- `sync_jobs` composite identity와 archive/preflight
- `building_write_operations`
- append-only `building_write_operation_input_pnus`
- `building_write_operation_commands`
- DB 발급 `operation_epoch`
- canonical request manifest와 DB 계산 hash
- immutable explicit input PNU evidence
- command key/hash, retry lock set, terminal result replay

생성하는 public table/view/sequence/function은 같은 transaction에서 RLS, PUBLIC/anon/auth revoke, 최소 service-role grant를 적용한다.

#### A1a API

- GIS·가격·member·consent queue가 `sync_jobs`와 필요한 operation 저장 성공 후에만 `queue.add`/jobs map에 등록된다.
- Phase A는 입력 주소에서 정규화된 explicit PNU manifest를 저장한다.
- operation/command 저장 실패 시 503으로 종료하고 메모리 job을 남기지 않는다.

#### 검증

- FK/UNIQUE/CHECK/RLS/ACL SQL
- 같은 operation key/hash replay는 기존 결과 반환
- 같은 key의 다른 hash는 `*_REPLAY_MISMATCH`
- input PNU update/delete 차단
- operation epoch 단조 증가
- INSERT/operation fault injection 후 queue/jobs map 잔존 0
- baseline→W1 clean replay

#### Exit gate

- [ ] W1 migration과 A1a가 개발 DB·dev API에서 PASS
- [ ] operation 없는 building/queue write 0건
- [ ] manifest hash가 호출자 값이 아니라 DB 계산값과 일치
- [ ] Web dev gate의 동일 후보 SHA 기록
- [ ] O0 미완료 상태에서는 후보가 `dev`와 `tonghari_dev` 밖으로 승격되지 않았음을 확인

### W2. relation·manual override·observation ledger

#### Migration DAG

1. `building_registry_relation_foundation`
   - `building_registry_land_lot_relations`
   - `building_land_lot_manual_overrides`
   - 각 `(id, union_id)` unique
   - `(base_pnu, union_id)`, `(attached_pnu, union_id)` composite FK
2. `building_registry_observation_ledger`
   - `building_registry_scan_observations`
   - `building_registry_scan_observation_pairs`
   - `building_registry_relation_group_states`
   - `building_registry_land_lot_unresolved_observations`
   - `building_source_unresolved_observations`

#### 상태 계약

- relation observation: `OBSERVED`, `STALE_CANDIDATE`, `INACTIVE`
- projection: `PENDING`, `LINKED`, `REVIEW_REQUIRED`, `CONFLICT`, `STALE_REVIEW`
- scan: `COMPLETE_NONZERO`, `COMPLETE_ZERO`, `EMPTY_NOT_FOUND`, `PARTIAL`, `RETRYABLE_ERROR`, `PERMANENT_ERROR`, `PROTOCOL_ERROR`
- manual override: `ACTIVE`, `REVOKED`
- 복수 관리번호: `MULTI_BUILDING_ON_PARCEL`
- 공식 ID 부족: `INSUFFICIENT_CANONICAL_EVIDENCE`

#### 검증

- PNU 19자리와 base/attached 상이 CHECK
- 조합 밖 PNU FK 차단
- 같은 observation/key/hash replay 멱등
- 같은 key의 다른 payload 무변경 거부
- partial/protocol/error가 zero miss를 증가시키지 않음
- 첫 complete-zero는 pending, 독립 operation의 두 번째 zero와 기간 조건에서만 stale 진행
- 같은 attached PNU가 다른 active base와 연결되면 자동 선택하지 않고 conflict
- manual revoke 감사 필드 필수와 이력 삭제 금지
- baseline→W2 clean replay

#### Exit gate

- [ ] relation/observation row는 생성 가능하나 building family mutation은 0건
- [ ] positive-cache predicate가 한 DB view/RPC로 중앙화
- [ ] RLS/ACL negative test PASS
- [ ] current-scan connected component fixture PASS

### W3P/A0b. projection 준비와 legacy writer admission

#### W3P additive schema

- `building_land_lots`
  - `mapping_source`
  - `support_status`
  - `last_verified_at`
  - `last_sync_job_id`
  - `last_applied_operation_id`
- 기존 mapping은 `LEGACY/SUPPORTED` snapshot backfill
- `building_external_refs.external_identity_key`, `legacy_identity_status` nullable prepare
- non-null ACTIVE external identity partial unique index
- `building_projection_events` append-only
- component quarantine와 effective-support view
- building unit nullable identity/provenance, conflict/event, Phase F shadow event
- rollout/admission state와 전역 kill switch
- 비활성 canonical writer RPC와 typed result contract

W3P에서는 기존 unit FK 이동, property link, NOT NULL finalize를 하지 않는다.

#### A0b

- API의 모든 `buildings`, `building_units`, `building_land_lots`, `building_external_refs` legacy writer에 admission/version guard를 적용한다.
- mismatch, state row 누락, paused 상태, row lock 실패는 503으로 fail-closed한다.
- unguarded direct API writer를 manifest 0건으로 만든다.

#### 검증

- 기존 legacy writer가 임시 default/dual-write 계약으로 동작
- mapping/source/support null delta 0
- advisory lock namespace와 정렬 순서
- 동시 projection/GIS_DIRECT race에서 orphan 0
- stale operation이 최신 provenance를 역행하지 못함
- multi-mgm 신규 mapping/building mutation 0
- quarantine closure가 unrelated mapping을 포함하지 않음
- rollout flag 행 없음·오류·OFF에서 mutation 0
- baseline→W3P clean replay

#### Exit gate

- [ ] canonical RPC가 존재하되 projection flag OFF
- [ ] property link flag OFF
- [ ] `building_external_refs` public/anon/auth direct access 차단
- [ ] legacy-v1 writer 전부 admission guard 적용

### A1b. 건축물대장 공통 client와 dark adapter

#### API client

공통 client 한 곳에서 다음 endpoint를 지원한다.

- `getBrTitleInfo`
- `getBrAtchJibunInfo`
- `getBrExposInfo`
- `getBrExposPubuseAreaInfo`

공통 계약은 다음과 같다.

- HTTPS
- timeout 15초
- 최대 3회 retry, exponential backoff+jitter, `Retry-After` 우선
- PNU 토지구분 `1 → platGbCd 0`, `2 → platGbCd 1`
- 모든 페이지를 `totalCount`까지 수집
- 단일 객체/배열 응답 정규화
- HTTP 200이어도 `response.header.resultCode` 우선 판정
- `00`, `03`, retryable, permanent, protocol error를 구분
- `00 + totalCount>0`인데 item/page 누락이면 `PARTIAL`
- `bylotCnt`가 명시적 0일 때만 attached 호출 생략
- 전유/공용 면적은 `getBrExposPubuseAreaInfo`에서만 계산

#### PNU와 relation 변환

- 기준: `sigunguCd + bjdongCd + platGbCd 변환 + bun + ji`
- 부속: `atchSigunguCd + atchBjdongCd + atchPlatGbCd 변환 + atchBun + atchJi`
- 19자리 숫자, base와 attached 상이, 법정동 유효성 검사
- 변환 실패 row는 정식 relation FK를 우회하지 않고 unresolved observation으로 저장

#### Dark adapter

- GIS root operation 아래 PNU/관리번호별 안정 command를 만든다.
- API의 모든 title/attached page로 current-scan connected component를 만든다.
- observation flag OFF이면 evidence도 쓰지 않는다.
- observation ON/projection OFF이면 evidence와 scan ledger만 저장한다.
- 같은 root+command replay는 event와 relation을 중복 생성하지 않는다.
- 기존 `upsertBuilding`/`saveBuildingWithUnits`를 호출하지 않는다.

#### 검증

- pagination, object/array, mountain lot, block lot, retry-after fixture
- `00`, `03`, throttle, malformed JSON/XML/HTML, missing header fixture
- partial page가 existing relation을 stale 처리하지 않음
- base-only 입력과 attached-only positive cache lookup
- 같은 pair 중복·순서 변경 replay
- 여러 관리번호 component의 `REVIEW_REQUIRED`
- dark run 전후 building family/property hash byte-equivalent

#### Exit gate

- [ ] 완전 snapshot coverage 100%
- [ ] relation/scan evidence expected=actual
- [ ] building/unit/ref/mapping/quarantine mutation 0건
- [ ] 외부 API 실호출 smoke는 개발 credential과 합성 PNU로 별도 PASS

### W4-prep/A2-RC. canonical projection writer

#### W4-prep

- Web browser의 direct/embedded building SELECT·DML을 server-only scoped read adapter로 이동한다.
- 남은 Web writer에 legacy-v1 admission guard와 transition dual-write를 적용한다.
- rollback 후보 조회도 actor/union scope가 있는 server path만 사용한다.

#### A2-RC

- `GIS_DIRECT`, `BUILDING_REGISTER`, relation projection, 가격, 공식명 writer를 typed canonical RPC adapter로 교체한다.
- RPC는 DB가 발급한 operation/command를 필수로 요구한다.
- lock 순서:
  1. 전역 PNU namespace
  2. canonical external identity namespace
  3. canonical building namespace
  4. relation 보조 lock
- 새 closure PNU/identity가 발견되면 어떤 source/projection도 쓰지 않고 `RETRY_REQUIRED`를 반환한다.
- API는 bounded retry로 lock set만 확장하고 source command hash는 바꾸지 않는다.
- 단일 관리번호와 conflict 없음이 확인될 때만 같은 building projection을 만든다.
- 기존 다른 building support가 있으면 자동 덮어쓰지 않고 conflict/quarantine으로 보낸다.
- `property_units`와 `property_ownerships`는 읽기·쓰기 모두 projection 결과로 변경하지 않는다.

#### 검증

- 동일 PNU 동시 GIS job
- 다른 조합의 shared PNU 동시 job
- relation과 GIS_DIRECT 동시 실행
- 같은 external identity의 역순 lock 요청
- retry-required lock 확장과 최대 횟수 종료
- 단일 mgm create/reuse exact result
- multi mgm 신규 building/ref/mapping 0
- stale operation/epoch 역행 0
- orphan building delta 0
- 대상·peer property/ownership/과소필지 hash 불변

#### Exit gate

- [ ] writer manifest 허용 canonical adapter 외 0건
- [ ] property-building-link writer 0건
- [ ] A2 release candidate는 아직 운영 배포하지 않음
- [ ] development projection flag OFF에서도 기존 GIS behavior가 안전하게 유지됨

### W4-RC. 비파괴 수동 relation UI

#### UI와 Server Action

- GIS 필지 상세에 `기준·부속지번 연결` 액션을 제공한다.
- 입력:
  - 기준 PNU
  - 부속 PNU
  - reason code/text
  - 근거 metadata
- API 누락/오류 상태와 마지막 재관측 결과를 함께 표시한다.
- 등록은 `MANUAL_RELATION` command를 생성하고 canonical RPC만 호출한다.
- 해제는 기존 row 삭제나 `undoMergeForPnu`가 아니라 `REVOKED` 감사 event를 추가한다.
- 등록 후 API 재관측을 요청할 수 있게 한다.
- projection OFF에서는 `ACTIVE/PENDING` evidence만 저장하고 성공 메시지에 “건물 projection 미적용”을 명시한다.

#### 제거할 기존 동작

- `property_units.pnu` 변경
- `previous_pnu` 기반 대표지번 흡수
- `building_units.building_id` 브라우저/Server Action 직접 이동
- `building_land_lots.building_id` 직접 update
- destructive multi-PNU merge/undo

기존 fail-closed 함수 이름을 재활성화해 내부만 바꾸지 않는다. 새 relation domain action과 타입을 만든다.

#### 검증

- SYSTEM_ADMIN만 등록·해제 가능
- union PNU scope 위반 거부
- 동일 active pair 멱등
- base/attached 동일 PNU 거부
- 근거 없는 수동 등록 거부
- API와 일치하면 source가 공식 evidence로 전환되며 수동 감사 이력 유지
- API와 모순이면 기존 projection 덮어쓰기 없이 conflict
- projection OFF/ON UI 상태와 toast 구분
- 모바일 viewport 포함 브라우저 E2E
- 기존 property PNU·ownership row 불변

#### Exit gate

- [ ] destructive action/UI 호출 0건
- [ ] browser building direct access 0건
- [ ] Web 자동 테스트와 개발 Vercel 실제 기능 PASS
- [ ] dev 검증한 exact SHA만 master 승격 후보로 고정

### C0 이후. 운영 cutover와 canary — 현재 실행 범위 밖

다음은 개발 구현이 모두 PASS한 뒤 별도 운영 승인으로만 수행한다.

1. W3F-RC finalize SQL review
2. admission OFF와 queue drain 0
3. W3F migration 적용과 delta/check/partial-index 검증
4. A2/W4 exact release candidate 배포
5. 양 저장소 manifest/version/smoke 확인
6. canonical-v1 admission ON
7. relation observation canary O1
8. 단일 관리번호 projection canary O2
9. legacy reader/writer drain O3
10. final ACL W5

운영 canary 순서에서도 observation과 projection을 동시에 켜지 않는다.

```text
observation_enabled ON / projection_enabled OFF / property_unit_link_enabled OFF
  → evidence-only canary
  → projection_enabled ON / property_unit_link_enabled OFF
  → canonical projection canary
```

## 7. 단계별 테스트 매트릭스

| 시나리오 | W1 | W2 | A1b | Projection | Manual UI |
| --- | ---: | ---: | ---: | ---: | ---: |
| 같은 command/hash replay | 필수 | 필수 | 필수 | 필수 | 필수 |
| 같은 key/different hash | 필수 | 필수 | 필수 | 필수 | 필수 |
| 기준 PNU만 입력 | - | evidence | API/positive cache | safe projection | 조회 가능 |
| 부속 PNU만 입력 | - | unresolved/cache | reverse wait | 무변경 | 수동 보정 가능 |
| 기준·부속 모두 입력 | scope | pair | complete scan | 단일 mgm 연결 | 상태 표시 |
| mountain lot | input | PNU FK | platGbCd 변환 | canonical | 입력 검증 |
| API partial/throttle | command | miss 불변 | error 분류 | 무변경 | 오류 표시 |
| 관리번호 0개 | command | review | unresolved | projection 0 | 근거 보강 |
| 관리번호 2개 이상 | command | review | full evidence | 신규 projection 0 | conflict 표시 |
| shared PNU 두 조합 | scope | union evidence | scan 격리 | global lock | union UI scope |
| stale old job | epoch | miss guard | old result | 역행 0 | 최신 상태 표시 |
| concurrent GIS_DIRECT | command | - | adapter | orphan 0 | - |
| property/과소필지 불변 | hash | hash | hash | byte-equivalent | byte-equivalent |

## 8. 리뷰 체크포인트

각 PR은 최소 다음 독립 리뷰를 거친다.

### DB 리뷰

- migration DAG와 FK 생성 순서
- RLS/REVOKE/GRANT가 객체 생성 transaction에 포함되는지
- nullable prepare와 finalize가 분리됐는지
- append-only row UPDATE/DELETE 차단
- advisory lock namespace/정렬과 retry 결과
- operation epoch와 replay state CHECK

### API 리뷰

- target client가 request 시작부터 끝까지 동일한지
- 외부 API empty/partial/error 분류
- command hash에서 시각·retry lock set을 제외했는지
- direct building writer가 남지 않았는지
- service-role이 union/actor/source 검증을 우회하지 않는지

### Web 리뷰

- 브라우저 direct building query가 없는지
- dev JWT와 production JWT fallback이 없는지
- 수동 relation이 destructive helper를 호출하지 않는지
- 실제 API 상태를 count로 축약해 conflict 근거를 잃지 않는지
- UI 테스트가 projection OFF/ON 상태를 구분하는지

### 검증 리뷰

- 성공 케이스뿐 아니라 retry/mismatch/partial/conflict가 포함됐는지
- A/B fixture의 두 조합 전체 hash를 비교했는지
- orphan, external identity, unit conflict delta를 함께 확인했는지
- 실제 배포 SHA와 테스트 SHA가 같은지

## 9. 최종 완료 기준

개발 완료는 다음을 모두 만족해야 한다.

- [ ] D0 DB target routing이 배포되고 개발 Web → 공용 API → 개발 Supabase write가 검증됨
- [ ] W0/R0/O0 gate가 각각 증거와 함께 PASS
- [ ] W1/A1a, W2, W3P/A0b, A1b, W4-prep/A2-RC, W4-RC가 순서대로 PASS
- [ ] W1부터 현재 additive chain까지 각 단계 clean replay PASS
- [ ] API/Web writer manifest가 canonical adapter 외 0건
- [ ] 브라우저 building direct access 0건
- [ ] 단일 관리번호 relation만 same-building projection
- [ ] 복수 관리번호의 신규/재지정 projection 0건
- [ ] GIS/relation/가격/수동 연결 전후 property·ownership·과소필지 결과 byte-equivalent
- [ ] 기준·부속 PNU가 각각 `land_lots`와 원래 `property_units.pnu`에 유지됨
- [ ] property unit link flag가 최초 릴리스 전체에서 OFF
- [ ] Web은 dev 검증한 동일 SHA만 master에 승격
- [ ] 운영 migration과 canary는 별도 승인·백업·rollback 증거 뒤에만 수행

## 10. 즉시 실행할 다음 작업

현재 권한과 실제 브랜치 상태에서 바로 실행할 수 있는 순서는 다음과 같다.

1. API Phase 0 dirty DB routing diff를 최신 `main`과 대조해 독립 커밋 후보로 정리한다.
2. Web dev-release의 proxy token/endpoint/side-effect 차단 diff를 최신 `origin/dev`와 대조한다.
3. 양 저장소 DB target routing 테스트·전체 회귀를 실행한다.
4. API routing 후보를 배포하고 Vercel dev 환경변수를 확정한다.
5. 개발 Web에서 GIS route가 개발 DB에만 쓰는지 실제 검증한다.
6. 이미 PASS한 GIS·가격 3종·member import A/B artifact를 exact 후보 SHA와 artifact index에 결합해 보존한다.
7. audited baseline replay/fingerprint/history manifest의 남은 증거를 마감한다.
8. 전용 W1 작업 브랜치를 만들고 `sync_job_operation_foundation` migration과 SQL 테스트를 작성한다.
9. W1을 `tonghari_dev`에 적용해 clean replay, RLS/ACL, replay/mismatch, immutable input-PNU 테스트를 실행한다.
10. A1a queue fail-closed adapter를 개발 API에 연결하고 개발 Web/API route로 fault injection을 검증한다.
11. W1/A1a exact SHA와 dev artifact를 고정하되 API `main`·Web `master`·운영 DB로 승격하지 않는다.
12. O0 실행 계획과 inverse artifact를 별도 승인 안건으로 제출한다.

O0 승인 전에는 W1 migration을 전용 작업 브랜치·Web `dev`·`tonghari_dev`에서만 검증하며 API `main`, Web `master`, 운영 DB에는 적용하지 않는다.

# Phase 0-S 공유 PNU 비운영 DB gate

이 gate는 disposable Supabase clone 또는 영구 개발 프로젝트에서 A·B 조합이 같은 PNU를 가진 fixture를 검증한다. CLI 자체는 조회만 수행하며 GIS·가격·조합원 작업을 시작하지 않는다. 각 작업은 기존 인증 경계로 별도 실행하고, 실행 전후 snapshot만 이 CLI로 수집한다. 영구 개발 프로젝트의 데이터는 작업 후에도 유지되므로 운영 데이터나 개인정보를 복사하지 않고 합성 fixture만 사용한다.

## 검증 데이터

원문 row는 파일이나 stdout에 저장하지 않는다. 다음 6개 dataset을 컬럼별 SHA-256과 row/dataset digest로 바꾼 hash-only artifact만 `.phase0-s/`에 저장한다.

artifact schema는 `phase0-s-artifact/v3`다. v3의 `rowHash`는 정렬된 `columnHashes`와 coverage metadata 전체에 대한 canonical commitment이므로 parser가 원문 없이 결합을 재검증한다. 기존 v1/v2 artifact는 호환 처리하지 않으며 새로 capture해야 한다.

- `property_units` 전체 컬럼과 활성/삭제 상태
- `property_ownerships` 전체 컬럼과 활성 상태
- `v_member_property_units_canonical`
- `get_admin_member_list_rows_lite`의 unit `minor_parcel_phase1` 및 group summary
- 전역 `building_land_lots`
- 전체 `buildings` 대비 mapping이 없는 building id 집합·orphan count와 건물별 orphan 여부

`sharedPnuHashes`는 단순 활성 PNU 목록이 아니다. parser는 원문 PNU 없이 hashed column 관계를 따라 활성 `property_units` → 활성 ownership → 동일 ownership/unit/PNU의 canonical row → status가 있는 과소필지 UNIT 및 해당 GROUP summary → 같은 PNU의 `building_land_lots` → mapping 건물의 non-orphan 상태를 다시 계산한다. 이 결과와 6개 dataset digest는 `sharedPnuCoverageCommitment`로 함께 묶인다. 배열 또는 commitment를 임의 SHA로 바꾸면 parser가 거부하며, A·B 사이에 완전 coverage hash 교집합이 없으면 데이터가 불변이어도 실패한다.

## 비운영 DB 대상 안전장치

hosted Supabase에서는 아래 환경변수를 모두 명시한다. clone ref와 운영 ref가 같거나, `SUPABASE_URL`과 clone URL이 같거나, 일반 외부 주소이면 실행하지 않는다. localhost는 confirmation 값이 있는 경우만 허용한다.

```bash
export PHASE0_S_CLONE_URL=https://<non-production-ref>.supabase.co
export PHASE0_S_CLONE_SERVICE_ROLE_KEY=<non-production-service-role-key>
export PHASE0_S_CLONE_PROJECT_REF=<non-production-ref>
export PHASE0_S_PRODUCTION_PROJECT_REF=<production-ref>
export PHASE0_S_CLONE_CONFIRMED=PERSISTENT_DEVELOPMENT_READ_ONLY
```

일회성 clone이면 기존 확인값 `DISPOSABLE_CLONE_READ_ONLY`를 사용한다. 운영 service-role key를 사용하지 않는다. `PHASE0_S_CLONE_*` 이름은 기존 실행 환경과의 호환을 위해 유지하며 영구 개발 프로젝트도 동일 변수에 개발 프로젝트 값만 넣는다.

## snapshot 수집

artifact는 반드시 gitignored `.phase0-s/` 아래에 저장된다.
각 `--union` alias는 서로 다른 실제 `union_id`를 가리켜야 하며 같은 조합을 A/B로 중복 지정할 수 없다.

영구 개발 프로젝트의 합성 fixture는
`scripts/phase0-s-development-fixture.sql`을 target guard가 있는 DB 실행 경로로 적용한다.
이 파일은 migration이나 일반 seed가 아니며 운영 프로젝트에는 적용하지 않는다. 고정 fixture identity는 다음과 같다.

- A 조합: `00000000-0000-4000-a000-000000000001`
- B 조합: `00000000-0000-4000-a000-000000000002`
- 공유 PNU: `1130510100107450062`

fixture는 두 조합의 `land_lots`, `property_units`, `property_ownerships`를 각각 독립 행으로 만들고,
전역 `building_land_lots`만 같은 물리 건물 projection을 가리킨다. 두 `property_units.building_unit_id`는
Phase F 승인 전까지 `NULL`이다. 검증을 모두 마친 뒤에는
`scripts/phase0-s-development-fixture-cleanup.sql`로 고정 identity만 제거한다.

2026-07-15 개발 DB 리허설에서는 외부 GIS 응답만 결정적인 합성값으로 대체하고 실제
`GisQueueService.addSyncJob`과 실제 `tonghari_dev` DB write를 실행했다. A 조합의 토지·건물·2개 호실
저장은 완료됐고, 전후 hash-only artifact의 A/B `propertyUnits`, `propertyOwnerships`,
`canonicalMemberProperties`, `minorParcelResults`, `buildingLandLots`, `buildingOrphanSummary`는 모두
byte-equivalent였다. 이어서 개발 Supabase Auth에 임시 합성 사용자를 만들고 `user_auth_links`로 합성
SYSTEM_ADMIN 프로필에 연결한 뒤, 로컬 서명 JWT로 실제 `POST /api/gis/sync` HTTP route를 호출했다.
현재 역할·차단·조합 scope 재검증, queue admission, GIS job과 DB persistence가 HTTP 200/COMPLETED로
끝났고 A/B 여섯 dataset도 다시 byte-equivalent였다. 임시 Auth 사용자와 link는 종료 시 0건으로
정리했다. 이 결과는 외부 응답을 결정적 합성값으로 대체했으므로 VWorld·data.go.kr 실호출을 통과했다는
뜻은 아니다. 실호출 smoke test만 개발용 외부 API credential 준비 후 별도로 수행한다.

같은 날 `PRE_REGISTER`는 합성 SYSTEM_ADMIN 프로필과 A 조합의 기존 합성 조합원·물건지로
실제 queue/개발 DB 리허설을 수행했다. 최초 시도는 입력 지번과 fixture 지번 문자열이 달라 사전 승인에
없는 변경으로 정확히 실패했고, 두 번째 시도는 DB `updated_at` trigger 때문에 동일 입력도 불필요한
UPDATE를 만드는 멱등성 결함을 드러냈다. 사후 승인으로 우회하지 않고 기존 property/ownership 값과
입력을 비교해 실제 변경 컬럼이 있을 때만 UPDATE하도록 수정했다. 초기화 후 새 사전 승인(변경 0건)으로
다시 실행한 결과 `updatedCount=0`, `propertyLinkUpdatedCount=0`이었고 A/B 여섯 dataset 모두
byte-equivalent로 `MEMBER_IMPORT` gate를 통과했다.

```bash
npm run phase0-s:gate -- capture \
  --label before-gis \
  --union A=<union-a-uuid> \
  --union B=<union-b-uuid> \
  --out .phase0-s/before-gis.json

# 동일 비운영 DB에서 인증된 기존 경로로 GIS 또는 가격 작업 실행

npm run phase0-s:gate -- capture \
  --label after-gis \
  --union A=<union-a-uuid> \
  --union B=<union-b-uuid> \
  --out .phase0-s/after-gis.json
```

## GIS·가격 불변 gate

```bash
npm run phase0-s:gate -- verify-invariant \
  --before .phase0-s/before-gis.json \
  --after .phase0-s/after-gis.json \
  --operation GIS_SYNC \
  --union A \
  --union B
```

`APT_PRICE`, `INDIVIDUAL_HOUSE_PRICE`, `LAND_PRICE`도 각각 별도 전후 artifact로 반복한다. 6개 dataset 중 한 row의 한 컬럼이라도 달라지면 exit code 1이다.
`verify-invariant`와 `verify-member-import`는 동일한 비운영 DB 종류와 `projectRefHash`를 가진 artifact pair만 허용한다. `DISPOSABLE_CLONE`과 `DEVELOPMENT_PROJECT`를 섞거나 `FIXTURE` artifact를 사용하거나 서로 다른 프로젝트를 비교하면 내부 비교 결과와 무관하게 실패한다.

## member import gate

member import 전에 deterministic fixture의 예상 결과로 승인 파일을 먼저 작성·리뷰한다. 실제 after artifact를 보고 승인 파일을 사후 생성하면 gate 근거로 인정하지 않는다.

```json
{
  "schemaVersion": "phase0-s-member-approval/v2",
  "targetAlias": "A",
  "peerAliases": ["B"],
  "expectedTargetCanonicalMemberPropertiesDigest": "sha256:<64 hex>",
  "expectedTargetMinorParcelDigest": "sha256:<64 hex>",
  "changes": [
    {
      "dataset": "propertyUnits",
      "operation": "UPDATE",
      "rowKeyHash": "sha256:<64 hex>",
      "changedColumns": ["property_address_jibun", "updated_at"],
      "matchAfterColumnHashes": {
        "property_address_jibun": "sha256:<64 hex>",
        "updated_at": "sha256:<64 hex>"
      },
      "source": "PROPERTY_OWNED_INPUT"
    }
  ]
}
```

```bash
npm run phase0-s:gate -- verify-member-import \
  --before .phase0-s/before-member.json \
  --after .phase0-s/after-member.json \
  --approval .phase0-s/member-approval.json
```

대상 A는 승인된 property/ownership diff와 예상 canonical/과소필지 digest만 허용한다. approval v2는 UPDATE/INSERT 모두 `changedColumns` 전부의 expected after hash를 정확히 요구하며 빈 값·부분 값·다른 값은 거부한다. `building_unit_id`, `dong`, `ho`, 전역 mapping/orphan은 변경할 수 없다. B의 6개 dataset은 모두 byte-equivalent digest여야 한다.

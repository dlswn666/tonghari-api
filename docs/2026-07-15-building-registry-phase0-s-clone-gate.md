# Phase 0-S 공유 PNU clone gate

이 gate는 disposable Supabase clone에서 A·B 조합이 같은 PNU를 가진 fixture를 검증한다. CLI 자체는 조회만 수행하며 GIS·가격·조합원 작업을 시작하지 않는다. 각 작업은 기존 인증 경계로 별도 실행하고, 실행 전후 snapshot만 이 CLI로 수집한다.

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

## clone 대상 안전장치

hosted Supabase에서는 아래 환경변수를 모두 명시한다. clone ref와 운영 ref가 같거나, `SUPABASE_URL`과 clone URL이 같거나, 일반 외부 주소이면 실행하지 않는다. localhost는 confirmation 값이 있는 경우만 허용한다.

```bash
export PHASE0_S_CLONE_URL=https://<clone-ref>.supabase.co
export PHASE0_S_CLONE_SERVICE_ROLE_KEY=<clone-service-role-key>
export PHASE0_S_CLONE_PROJECT_REF=<clone-ref>
export PHASE0_S_PRODUCTION_PROJECT_REF=<production-ref>
export PHASE0_S_CLONE_CONFIRMED=DISPOSABLE_CLONE_READ_ONLY
```

운영 service-role key를 사용하지 않는다.

## snapshot 수집

artifact는 반드시 gitignored `.phase0-s/` 아래에 저장된다.
각 `--union` alias는 서로 다른 실제 `union_id`를 가리켜야 하며 같은 조합을 A/B로 중복 지정할 수 없다.

```bash
npm run phase0-s:gate -- capture \
  --label before-gis \
  --union A=<union-a-uuid> \
  --union B=<union-b-uuid> \
  --out .phase0-s/before-gis.json

# disposable clone에서 인증된 기존 경로로 GIS 또는 가격 작업 실행

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
`verify-invariant`와 `verify-member-import`는 모두 동일 disposable clone의 `DISPOSABLE_CLONE` artifact pair만 허용한다. `FIXTURE` artifact 또는 서로 다른 `projectRefHash` pair는 내부 비교 결과와 무관하게 실패한다.

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

# 개발 미아7 대지권 동기화 runner

## 목적과 범위

이 runner는 미아7구역 개발 DB의 활성 물건지 `429/429`가 검증된
`LADFRL`/`LDAREG` 대지권 면적을 갖게 하는 단계적 실행 도구다. 운영 DB는 대상이 아니며
production target, production JWT, 외부 API origin을 입력으로 받을 수 없다.

현재 저장소 승인 bundle은 대표 LADFRL PNU
`1130510100107912166` 한 건만 포함한다. 이 bundle의 PASS는 `1/1` canary PASS이지
미아7 전체 완료가 아니다. 전체 완료는 아래 단계별 manifest/evidence를 추가하고 마지막
postflight가 활성 물건 `429`, 고유 PNU `299`, 양수 면적 `429`를 확인해야 한다.

## acceptance checklist

- target/API allowlist/DB approval manifest의 development + union + 정렬 PNU +
  count + canonical digest가 exact 일치한다.
- EC2 컨테이너 안의 `DEV_API_JWT_SECRET`으로만 10분 HS256 JWT를 만들며
  `kid=dev`, `iss=tonghari-web-dev`, `aud=tonghari-api`,
  `databaseTarget=development`, `purpose=GIS_SYSTEM_ADMIN`을 고정한다.
- JWT의 `sub`와 `userId`는 보호 environment secret과 exact 대조한
  개발 `auth.users` SYSTEM_ADMIN UUID다.
- 서비스 역할의 DB 직접 접근은 개발 `property_units` read-only pre/postflight뿐이다.
  discovery/confirm/apply write는 localhost canonical API route만 사용한다.
- PNU를 직렬 처리하고 latest job을 먼저 resume한다. FAILED, unexpected REVIEW,
  cache/conflict issue가 나오면 다음 PNU admission을 즉시 중단한다.
- confirmation 전에 frozen scope, strategy, property membership, proposed area,
  same-run LADFRL scope evidence를 per-PNU evidence manifest와 exact 대조한다.
- LADFRL confirmation은 parcel-scope evidence와 land-ownership evidence가 모두
  존재할 때만 두 확인값을 true로 만든다.
- 실행 전 활성 물건 membership/면적/source가 evidence의 명시적 prestate 중 하나와
  exact 일치해야 한다. 실행 후 대상 면적은 양수이고 source는 예상 strategy여야 한다.
- pre/post 활성 물건 수, PNU 수, property identity digest가 불변이어야 한다.
- pre/post 429개 전체 tuple은
  `land_area / land_area_source / land_area_synced_at / land_area_sync_job_id`
  네 필드를 포함한다. 승인 target만 expected area/source와 exact writer job으로 바뀔 수 있고,
  non-target tuple digest는 exact 불변이어야 한다.
- 이번 실행의 writer job ID로 개발 DB를 bounded 역조회하여 반환된 모든 물건이 exact
  union/target membership에 속하는지 검사한다. 타 조합 또는 승인 scope 밖 행이 하나라도
  잡히면 cross-union write로 FAIL한다.
- full artifact의 PNU/job/property 식별자는 runner 재검증과 최종 gate에만 사용하고
  GitHub artifact로 업로드하지 않는다. 업로드용 public artifact는 version,
  development target, repository manifest label, 집계 count, digest, strategy/outcome
  집계, gate status/failure code만 허용하며 timestamp와 target 배열도 포함하지 않는다.

## manifest canonical 계약

PNU를 오름차순 정렬한 뒤 각 행을 아래 형태로 만들고 쉼표로 결합해 SHA-256을 계산한다.

```text
development:<lowercase-union-uuid>:<19-digit-pnu>
```

대표 PNU canonical digest는
`423d4b2ef2df290fa1d168acf31c8ea38eb9816f2319fb34f4e11a23af48ff23`이다.
현재 확인된 전체 299 PNU digest는
`638977eb11e2e09afdb949179fe59e7944c2ed4c973fe2695bf0628239a2e219`이지만,
전체 exact PNU 배열과 429개 property evidence가 저장소 bundle로 승인되기 전에는 이
digest만으로 전체 실행을 허용하지 않는다.

DB approval JSON은 실행 의도를 exact 대조하는 두 번째 입력이다. 실제 DB의 private
approval manifest 활성 여부와 scanned PNU 포함 여부는 confirmation/apply RPC가 같은
transaction 안에서 다시 검사하므로 JSON만으로 승인된 것으로 간주하지 않는다.

## evidence reference 경계

`sourceReferences`의 `*ReferenceSha256` 값은 사람 검토와 원본 추적을 위한 reference다.
runner가 EC2에서 로컬 Excel이나 과거 artifact 파일을 다시 열어 검증한다는 의미가 아니다.
관찰 reference는 아래에 명시한 UTF-8 canonical JSON의 SHA-256이다. JSON 앞뒤 공백과
마지막 개행은 없으며, key 순서는 표시된 그대로 고정한다. 따라서 원본이 없는 임의 digest를
근거처럼 사용할 수 없다.

```text
selectedCellsReferenceSha256 preimage:
{"cells":{"E29":"791-2166","F29":"161"},"sheet":"미아791"}

phase0ObservationReferenceSha256 preimage:
{"landArea":"161","pnu":"1130510100107912166","runId":"30105293359","strategy":"LADFRL"}

developmentObservationReferenceSha256 preimage:
{"landLotsArea":"161","pnu":"1130510100107912166","propertyUnitId":"5a1a4cbb-c8ad-45a3-ae40-b90665dc949c","unionId":"00f48b95-e9bc-4c92-a0e5-6b9a57adcfb9"}
```

각 preimage의 digest는 각각 다음과 같다.

- selected cells:
  `1d1ec3caca19963e8b296380368a27002d21fc0b72cb48575802aaf9b00f2cfb`
- Phase 0 observation:
  `b20591216e7e7108e5ea3d6fdd8ca774b4acc40a35791d652737b6e975f43497`
- development observation:
  `bb61e80f085e7ce36432c4154427f052884969656c0a315d85cdee5263c84d7f`

따라서 runtime 승인 근거는 reference hash의 형식이 아니라 다음 exact gate다.

- read-only 개발 DB prestate
- 현재 discovery frozen snapshot
- expected property membership
- expected proposed area
- same-run LADFRL/LDAREG evidence
- DB private approval gate
- read-only 개발 DB poststate

대표 reference:

- workbook file reference:
  `13fa8a38896e6964c42121b5e8d46173d4fb89ef629f830005ff815f2da29723`
- sheet/cells: `미아791!E29,F29`
- Phase 0 run: `30105293359`
- Phase 0 artifact file reference:
  `63dc038ffb83ef923a1f760f812271d1d27168aa7c8f5105c2f24b00d7ff167b`
- 개발 property unit:
  `5a1a4cbb-c8ad-45a3-ae40-b90665dc949c`

원본 값이나 소유자 개인정보는 manifest에 넣지 않는다.

## 현재 전체 evidence 분류

- Excel 숫자형 evidence: 275 PNU, digest
  `dc352ca35355d04715d0774d94331c9b918f7fbf208d62e7af96b5b54af20606`
- 그중 274 PNU는 `land_lots.area`와 exact 일치한다.
- PNU `1130510100107450076`은 Excel reference 면적과 개발 `land_lots.area`가
  다르므로 LADFRL 자동 confirmation에서 제외하고 STOP/REVIEW로 남겨야 한다.
- 나머지 24 PNU / 154 active units는 숫자형 evidence가 없으며, 검증된 LDAREG
  scope evidence를 별도로 만들어야 한다.

## workflow 운영 계약

GitHub workflow는 `main`에서만 실행되고 보호 environment
`land-area-sync-development-write`를 사용한다. 이 environment에는 다음 secret이
필요하다.

```text
DEV_GIS_SYSTEM_ADMIN_AUTH_UUID
```

SYSTEM_ADMIN UUID는 공개 `workflow_dispatch` 입력으로 받지 않고 보호 environment의
이 secret에서만 읽어 형식을 검사한 뒤 내부 실행에 사용한다. 값을 로그에 출력하지 않는다.
JWT secret과 개발 service-role key는 GitHub runner로 전달하지 않고 현재 EC2 컨테이너
환경에서만 사용한다.

EC2에서는 deploy-user 소유 mode `600` 파일
`.land-area-sync-operation.lock`을 `flock`으로 잡은 전체 구간에서만 실행한다.
runtime enable/disable 및 deploy는 같은 operation lock을 사용하므로 runner 중
컨테이너를 재기동할 수 없다. lock 소유자는 GitHub SSH shell이 아니라
`nohup + setsid`로 분리한 host guardian이다. 따라서 GitHub 취소나 SSH 단절 뒤에도
guardian은 runner, terminal drain, artifact 검증, 민감 input cleanup이 끝날 때까지
lock을 놓지 않는다. GitHub concurrency group은 pending run을 대체할 수 있으므로
직렬화 권위로 사용하지 않는다.

API `LAND_AREA_SYNC` p-queue의 600초는 worker 실행 상한이고 queue 대기 시간은 별도다.
runner의 job soft deadline은 전파 여유 60초를 더한 660초 이상으로 고정한다. 이 deadline이
지나도 runner는 실패 artifact를 즉시 반환하지 않고, API 일시 오류를 재시도하면서 해당
durable job이 `COMPLETED` 또는 `FAILED`이면서
`workerFinalization={version:1,finalizedAt}` immutable receipt를 가질 때까지 drain한다.
apply RPC는 scopeState/outcome/counts/issues/`issuesTotal`/`issuesTruncated`/receipt를
같은 DB transaction의 한 UPDATE로 확정한다. receipt 없는 raw terminal은 API가
`PROCESSING`으로 투영하고 runner도 terminal로 인정하지 않는다. terminal 확인 후에만
`JOB_POLL_SOFT_TIMEOUT_AFTER_TERMINAL`로 FAIL하므로 cancel endpoint나 새 DB lock 없이도
늦은 job write와 operation lock 조기 해제가 분리되지 않는다. terminal을 영구 확인할 수
없으면 guardian도 lock을 영구 보유하는 것이 의도된 fail-closed 상태다.
discovery/review/failed terminal도 direct `sync_jobs` UPDATE를 쓰지 않고
`finalize_land_area_sync_job_v1`이 phase/outcome/counts/issues를 검증한 뒤 같은 방식의 DB
transaction timestamp receipt로 원자 종결한다. APPLIED/PARTIAL은 이 finalizer가 거부하며
기존 atomic apply RPC만 생성한다.
discovery/confirmation POST 응답 자체가 유실된 경우도 실패로 바로 반환하지 않는다.
runner가 POST 전에 UUID admission key를 생성하고, 5xx/timeout 뒤에는 `latest`나 job id를
추정하지 않고 인증된 union+admissionKey+sourceDiscoveryJobId endpoint만 최대 10회 조회한다.
confirmation apply의 실제 job UUID는 admission key와 다를 수 있다. durable row가 없으면
`AMBIGUOUS_ADMISSION_NOT_DURABLE`로 FAIL하고 중복 POST를 만들지 않는다. exact row가
있으면 anchor/admissionKey/sourceDiscoveryJobId lineage를 대조한다. 아직 PROCESSING이면
DB INSERT 뒤 메모리 queue admission 유실만 복구하도록 동일 key+digest POST를 한 번 재전송한
뒤 같은 terminal drain에 연결한다. confirmation admission RPC v2는 동일 key+동일 request digest replay에 같은
apply job id를 반환하고, 동일 key+다른 digest는 거부한다.

guardian은 lock을 보유한 상태에서 container의 target/approval/evidence/artifact와 host의
target/approval/evidence를 삭제하고 각 경로의 부재를 재검증한다. cleanup 명령이나 부재
검사가 하나라도 실패하면 status `90`으로 고정하며 green을 허용하지 않는다. 로컬 재검증
임시 파일도 같은 방식으로 삭제와 디렉터리 부재를 확인한다. 원격에서 내려받은 full
artifact는 저장소 validator로 다시 검증하고 최종 PASS/FAIL gate를 판정하는 데만 쓴다.
그 검증 뒤 exact-key public artifact를 별도로 만들며, GitHub upload에는 이 공개 파일만
지정한다.

40분을 넘는 전체 작업은 evidence가 완결된 repository-approved wave로 나눈다.
각 wave는 terminal artifact를 남기고, 다음 wave는 최신 job과 read-only prestate를
다시 검증한다.

## 완료 판정

대표 bundle PASS만으로 전체 완료라고 보고하지 않는다. 최종 PASS는 적어도 다음을 모두
만족해야 한다.

1. 전체 승인 PNU manifest digest가 `638977...e219`와 exact 일치
2. per-PNU evidence의 고유 property unit 수가 429
3. pre/post active property unit `429`, active PNU `299`
4. postflight positive land area `429`
5. target source가 evidence strategy와 exact 일치
6. FAILED/REVIEW_REQUIRED/NO_DATA/PARTIAL 잔여 0
   - terminal issues가 `issuesTruncated=false`이고 `issuesTotal===issues.length`
7. property identity digest 불변
8. non-target 4-field tuple digest 불변, writer-job attribution scope exact
9. guardian terminal drain 및 host/container/local cleanup PASS
10. 개발 feature flag와 allowlist를 후속 disable workflow로 원복
11. 운영 DB write 0

# 본인확인 연결 전 API 계약

2026-09-13. 사용자 범위는 외부 연결 직전까지의 개발이며 계정/키 설정, KG 요청, 런타임 활성화는 수행하지 않는다.

기준: web `docs/development/identity-verification-preconnect.md`, KG [통합인증](https://manual.inicis.com/sa/auth.html), [SEED 및 userHash](https://manual.inicis.com/assets/add-option.html).

## 준비된 경계

- 기본 `KG_INICIS_ENABLED=false`. MID/API KEY 존재만으로 켜지지 않는다. 대상 환경·UTF-8 16바이트 IV·계약기관·HTTPS 콜백 길이·SEED 런타임을 모두 확인한다.
- web 서버는 환경별 서명키와 kid/iss/aud가 일치하는 60초 JWT를 발급한다. `purpose=IDENTITY_VERIFICATION`, `assemblyId`, `verificationPurpose=ENTRY|VOTE`가 필수다. API는 토큰을 발급하지 않는다. 본인확인용 JWT는 다른 일반 API 인증에서 거부한다.
- `GET /api/kg-inicis/auth/readiness`, `POST /auth/request`, `POST /auth/result`, `GET /auth/status/:mTxId`는 이 JWT를 요구한다. API 응답은 `{success,data}` 봉투이며 기본 미연결 코드는 `IDENTITY_VERIFICATION_UNAVAILABLE`이다.
- 요청은 `{reqSvcCd:'03',expectedIdentity:{name,phone,birthday?}}`. web 서버가 조합원 신원을 확정한다. 실제 생년월일이 없으면 `flgFixedUser=N`; 있으면 공식 `userBirth` 및 `userHash`로 고정한다. 전자서명/간편인증은 이 경로에서 지원하지 않는다.
- 콜백은 web origin의 `/api/identity-verification/callback/success|fail?t=<20자리거래>&s=<22자리난수>`로 만든다. 전체 128바이트 한도이며 설정 URL에 경로 접미 `/`, query, fragment가 없어야 한다. web이 공식 POST 필드 `resultCode/authRequestUrl/txId/token`만 API `/auth/success|fail`로 중계한다. API에서도 동일 `t/s` query를 검증한다.
- 콜백은 아직 인증 성공이 아니다. 결과조회에서 `mid/txId`만 공식 결과호스트 `fcsa.inicis.com`, `kssa.inicis.com`의 HTTPS 443에 전송한다. 리다이렉트 금지, 5초 제한, 응답 16KiB 제한이다. token은 SEED 복호화 키이며 요청 본문으로 재전송하지 않는다.
- `mTxId/txId/svcCd/계약기관`과 복호화 이름·전화·실제 생년월일·CI 형식을 검사한다. 원시 CI/DI/서명/결과/토큰을 반환하거나 기록하지 않는다. 예상 신원은 임시 HMAC으로만 저장한다.
- 거래는 사용자·조합·환경·총회·ENTRY/VOTE에 귀속된다. TTL 5분, 사용자당 동시 5개, 전체 1000개. 콜백/결과 단회성 및 첫 await 전 소비 잠금, await 후 만료를 검증한다. 실패·재시작·응답 유실 시 다시 인증한다. 여러 API 인스턴스로 확장하려면 별도 거래 저장소/원자적 소비 설계가 필요하다.
- 서버 결과 영수증에는 원거래 `issuedAt/expiresAt` 및 64hex HMAC `expectedSubjectDigest/verifiedSubjectDigest/requestPayloadDigest/providerEvidenceDigest/callbackDigest`를 포함한다. web 서버의 receipt/RPC 연결용이며 브라우저에는 전달하지 않는다. HMAC 키는 프로세스 메모리에만 존재하고 장기 재식별 키로 사용하지 않는다.

## 연결 때 남은 확인

계약된 실제 본인확인기관 코드, MID/API KEY/SEED IV, 동일 web origin callback, 개발 target, 배포 런타임 `seed-cbc` 지원을 확인한다. Node 22 기본 OpenSSL에서 SEED가 없으면 readiness는 false다. 이번 변경은 Docker·OpenSSL runtime flags를 바꾸지 않는다. RFC4269 B.1 및 한국어/잘못된 padding/UTF-8 복호화는 합성값을 사용하는 테스트 자식 프로세스에서만 legacy provider를 켜서 검증한다.

실제 연결 전 web receipt 테이블/nonce RPC의 환경별 권한과 원자적 소비, 현재 계약기관이 반환하는 CI 형식·암호문 인코딩, 성공/취소/실패/중복/만료 및 제공사 결과 장애를 개발환경에서 실측해야 한다. 공개 문서상 복수 `directAgency` 구분자가 확인되지 않아 단일기관인 경우만 요청창을 제한하고, 모든 결과는 계약기관 allowlist로 검증한다. 복수기관 UI 제한은 공급사 규격 확인 후 추가한다.

## 검증

`npm run build`

`node --import tsx --test tests/kg-inicis-verification.test.ts tests/kg-inicis-routes.test.ts tests/database-target-routing.test.ts`

라우터 테스트는 합성 서명키와 127.0.0.1 서버만 사용한다. 서비스 테스트는 주입한 합성 transport를 사용한다. KG 네트워크·DB mutation은 없다. 로컬 샌드박스에서 listen이 차단되면 해당 테스트만 로컬 포트 권한을 허용해 실행한다.

콜백 URL query의 `s`는 일회성 인증 state다. API 애플리케이션 로그는 query/body를 기록하지 않지만 nginx/Vercel 등 앞단 access 로그·APM·오류 추적에서 callback query와 POST body를 수집하지 않도록 실제 활성화 전에 확인해야 한다. 이번 개발은 실서버 로깅 설정을 변경하지 않는다. 전역 JSON/form 파서에서 발생한 KG 경로 오류도 원문/stack을 API 로그나 응답에 출력하지 않는다.

결과 요청은 `{mTxId,expectedIdentity:{name,phone,birthday?}}`이며 web이 현재 조합원 프로필을 다시 읽어 전송해야 한다. API는 제공사 결과조회 전에 저장된 예상 신원과 현재 프로필을 비교한다. 이름·전화·생년월일 변경뿐 아니라 생년월일의 생성/삭제도 기존 거래를 `FAILED`로 종료하고 개인정보·token을 정리한다. web은 결과 응답 이후에도 현재 프로필이 유지되는지 확인한 뒤 영수증을 저장한다.

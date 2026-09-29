# 공통 색인 모델 규칙 — v-astra, 2026-09-30

먼저 실행 가능한 규칙을 고정한다. 아래는 **색인 누출 구조의 메모리 재현**이며 외부 SDK 전체·키관리·암호문 형식의 호환 구현이나 제품 보안 인증이 아니다. 제품·DB 변경 없음. 지원하지 않는 검색은 복원율0 대신 해당 없음이다.

## 공통 입력과 채점

- 기존 fixture의 고정 seed 재생과 기존 shuffled victim10000/reference10000 분할을 재사용하고 identityDigest 일치를 단언한다. 새로운 데이터를 생성하지 않는다. 피해와 참조는 행 ID 비중첩이며 동일 값의 중복은 허용된다.
- 같은 검색 의미 비교를 위해 **앱이 미리 SealQL 정규화를 적용한 문자열**을 모든 모델에 입력한다(NFC, 전각 ASCII→반각, ASCII 소문자, 공백 제거). 이것은 Acra/AWS/CipherSweet의 제품 기본 정규화라는 뜻이 아니다. 공식 Acra 문서는 정규화를 앱 책임으로 명시한다. 원문 복원 대신 이 공통 정규화 값의 복원을 채점한다.
- 본 실험의 기본 범위는 같은 필드·같은 키 범위다. 공격자가 모르는 키를 공격 함수에 주지 않는다. 색인 생성용 키 접근은 평가자에만 있다. 순수 T1에는 API 사전 계산을 제공하지 않는다.
- 동일 입력·동일 seed·동일 사전·동일 예산을 공유한다. known1/5%는 각각100/500개 피해 행을 고정해 나머지9900/9500행만 채점한다. 선택 삽입100/1000은 reference에서 정한 동일 정상 값 목록이다. 무작위 기준선은 참조 행 분포에서 독립 표본을 뽑는 방법과 균등 고유값 추측을 구별해 적는다.

## 파라미터 및 변환

| ID | 저장·질의 재현 규칙 | 파라미터 / 주의 | 공식 근거 |
|---|---|---|---|
| S0 | 현재 SealQL profile/searchPieces/searchTokens·exact/positionProof를 재사용. T1은 조각 토큰·행 salt·도장·길이·위치 배열. T4는 실제 전송하는 조각 키·정확 키를 사용 | substring16bits, exact 기본16/company2를 기존 시험과 맞추고 명시. P1은 **저장 토큰을3개로 줄이지 않음**; 질의 후보만3개, 판정 조각 키는 전체. | docs/current-state.md, src/core/search-tokens.ts, src/core/search-stamps.ts |
| AWS-standard | 동일 필드·partition 키의 HMAC-SHA384(정규화 전체 값)의 첫8바이트 중 오른쪽 b비트 추출, ceil(b/4)자리 hex. 정렬·부분 토큰 없음 | b=max(1,floor(log2(U_ref)−1)), U_ref=참조 고유값 수. 이는 공식 시작식의 실험 선택이며 제품 고정 기본값이 아님. 단일partition 기본 비교, 편향·상관 데이터에서는 권장 안전 구성으로 주장 금지 | https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/choosing-beacon-length.html ; https://github.com/aws/aws-database-encryption-sdk-dynamodb/blob/main/specification/searchable-encryption/beacons.md |
| AWS-partition(optional) | 같은 b, 행마다 값과 독립적으로 P개 partition 중 하나 배정; partition별 독립 비밀키 HMAC. 저장 partition ID는 공격자에게 공개. 질의는 모든 P partition 토큰 관찰 | 시간 허용 시 P=4 민감도. **4는 문서 예시이지 기본값 아님**. T3 삽입자는 자신이 배정받은 partition만 라벨링, 임의 target partition 계산 권한은 추가하지 않음 | https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/beacons.html ; 위 길이 문서의 random distribution/known hot values |
| CipherSweet-FIPS-fast | 값 전체에 FIPSCrypto fast의 PBKDF2-HMAC-SHA384 1회, salt=해당 blind-index 비밀키, password=입력값. field/index별 독립키 | **b=8**(정수 바이트), R=10000 단일 index에서 C≈39.06으로 일반식 범위2~100 안. **고정 제품 기본값 아님**, 낮은 도메인·편향에는 안전 보장 없음. PHP FIPSCrypto는 출력 바이트를 bitLength>>3으로 잡아 비정수 바이트 처리가 문서상 이상적 절단과 다를 수 있어 이번 재현은8비트로 고정한다. 입력 도메인 제한 planner 검토는 별도 | https://ciphersweet.paragonie.com/internals/blind-index ; https://ciphersweet.paragonie.com/php/blind-index-planning ; https://raw.githubusercontent.com/paragonie/ciphersweet/master/src/Backend/FIPSCrypto.php ; https://raw.githubusercontent.com/paragonie/ciphersweet/master/src/Planner/FieldIndexPlanner.php |
| CipherSweet-transform(optional) | 위 blind index에 Unicode codepoint 기준 앞3자 또는 뒤4자 변환을 별도 index key로 적용 | exact-only와 **추가 index를 함께 저장한 구성**을 구분. 이 변환·길이는 벤치 선택이며 제품 기본이 아님. 여러 index의 교집합 누출과 비트 합산을 보고 | https://ciphersweet.paragonie.com/security ; https://ciphersweet.paragonie.com/php |
| CipherStash-unique | HMAC-SHA256 전체 값 256비트, 절단 없음. 같은 field/key의 값 동등성 | EQL v3 text_eq의 hm. ordering/OPE는 켜지 않음. unique-only와 match-only, 함께 저장한 구성 구분 | https://cipherstash.com/docs/reference/eql/core-concepts |
| CipherStash-match | Unicode codepoint 연속3gram 집합, downcase, 중복/순서 제거 → keyed Bloom. 저장된 set-bit 위치 집합으로 질의 Bloom 포함 여부 | **Stack/EQL3 기본 m=2048,k=6, ngram3, downcase 확인 완료**. v3는 include_original=false. include_original을 true로 해도 현재 FFI는 무시한다고 공급자 테스트가 명시. Bloom 해시 배치는 core0.42.3의 HMAC-SHA256/UInt16LE로 재현(아래 근거) | https://cipherstash.com/docs/reference/eql/text ; https://github.com/cipherstash/stack/blob/6a92634498499705da3317b78c90820ca2985f37/packages/stack/src/schema/match-defaults.ts ; https://github.com/cipherstash/stack/blob/6a92634498499705da3317b78c90820ca2985f37/packages/stack/src/eql/v3/columns.ts |
| Acra-CE-exact | 같은 ClientID 키로 HMAC-SHA256(전체 값) 256비트, 절단 없음. 본문 옆 hash | 기본 정규화 없음(이번 시험은 앱 공통 정규화). prefix 없는 CE exact 구성. ClientID가 달라지면 키 분리. EE prefix를 CE에 덧붙이지 않음 | https://docs.cossacklabs.com/acra/security-controls/searchable-encryption/ |

## 오해 방지 및 T4

**Bloom 해시 배치 확인 완료:** 공식 cipherstash-core **0.42.3**의 `src/bloom_filter.rs::add_single_term`: HMAC-SHA256(key32, term UTF8) → `i=0..k-1`마다 digest의 `[2i,2i+1]`을 **UInt16LE**로 읽고 `%m` → 중복 제거. Stack은 core 자체 기본 m256/k3을 m2048/k6으로 덮는다. 독립 field key를 쓴다는 차이는 남지만 Bloom 원시 연산 자체는 이 규칙으로 재현 가능하다. 근거: https://docs.rs/crate/cipherstash-core/0.42.3/source/src/bloom_filter.rs ; 배포 원문 https://static.crates.io/crates/cipherstash-core/cipherstash-core-0.42.3.crate . Stack 의존성은 cipherstash-client/core0.42.3으로 고정돼 있다.

- CipherSweet의 Boring/Modern fast는 keyed BLAKE2b이며 단순 HMAC-SHA256이 아니다. 이번 선택은 공식 지원 FIPS-fast를 정확히 재현하기 위한 것이다. slow50,000/Argon2id와 동일 제품 기본이라고 하지 않는다.
- AWS 공식 길이 계산의 population은 **행 수가 아니라 고유값 수**다. 편향 fixture에 공식 균등식만 적용한 결과는 튜닝된 AWS 전반의 성능·보안 평가가 아니다.
- EQL3 match는 Bloom fuzzy ngram 검색이며 SQL LIKE와 같지 않다. query<3codepoints는 SDK에서 거절 대상으로 처리한다. 없는 2글자 지원을 강제로 만들지 않는다. 같은 질의 비교에서는 모든 모델이 지원하는 exact와 공통지원 substring≥3만 별도 비교한다.
- T4 known-query는 관찰한 표현과 검색어 라벨을 제공한다. unknown-query에는 token/key와 결과·반복만 제공하고 평가자의 정답 라벨을 공격 함수에 넘기지 않는다. 경쟁 equality모델에 S0의 조각 키를 주거나, S0에 전체 키를 주면 안 된다.
- AWS/CipherSweet/Acra/CipherStash의 trunc/Bloom 후보 조회는 후보 접근 집합이며 앱의 최종 정답 ID가 관찰된다고 자동 가정하지 않는다. 앱 최종 정답까지 아는 버전은 강화된 추가 공격으로 구분한다.
- 같은 알고리즘 가족의 결과와 모델별 강화 공격을 모두 남긴다. 가장 높은 맞힘률만 뽑더라도 위협 조건·조회 표현·기능 차이를 숨기지 않는다. 예상 복원율이0이어도 안전 증명은 아니다.

## 교차 검산 계약

공통 모듈 API와 결정 seed, 데이터 digest, 파라미터, 각 공격의 **행별 예측 또는 재생 가능한 결정 로직**을 결과와 함께 알려 달라. 임의 표본의 색인 재계산(생성자), 공격자 가용 정보 확인, 정답 비교·분모 재계산을 별도로 수행한다. 결과 숫자만 있는 JSON은 교차 검산 완료로 세지 않는다.

AWS 원시 연산 추가 확인: 공식 Beacon.dfy getHmac/hash/BytesToHex는 HMAC-SHA384 첫 8바이트의 오른쪽 b비트이다. 한 partition에서는 val+partition 중 partition 문자열은 빈 문자열. 실제 SDK 키 파생(HKDF-SHA512/64B) 대신 독립 시뮬레이션 field key를 쓰는 차이는 명시한다. 고정 근거: https://github.com/aws/aws-database-encryption-sdk-dynamodb/blob/96d6132720b8014b8c28a051e3e7cd953d0c41bd/DynamoDbEncryption/dafny/DynamoDbEncryption/src/Beacon.dfy

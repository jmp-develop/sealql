# X1·X2 설계 게이트: 미선언 부모 토큰 칸과 BEFORE 트리거

2026-09-27. **연구 결과이며 설계 확정 근거로는 부족하다.** `127.0.0.1:56439`의 소유·데이터 디렉터리를 `assertDisposable`로 확인했다. 원본 `bench_standard_next_100k.customers_skip_product_multi` 10만 행, companion, `bench_realistic_100k.customers`는 읽기만 했다. X1은 전용 스키마를, X2는 이름이 `x2_`로 시작하는 파생 테이블을 사용하고 종료 시 삭제했다. `src/`는 바꾸지 않았다. [X1 원시 결과](x1.json), [X2 원시 결과와 SQL](x2.json), [drizzle-kit 기록](kit.json)에 재현 가능한 세부값이 있다.

## 판정

**X1: 부분 통과, 확정 보류.** 단건·배열 INSERT, 값·NULL patch, `set: v` 단건 upsert, `DO NOTHING`, 조건 거짓 upsert, 롤백·savepoint, 행·scope 변경 거부는 확인됐다. 그러나 patch가 **0행**을 맞추면 트리거가 실행되지 않아 `SQL03` 대신 정상 종료 `rowCount=0`이다. §3의 “patch의 where가 다른 행이면 SQL03”을 이 범위까지 요구한다면 트리거만으로는 불가능하다. `excluded.memo_ct` upsert는 예상대로 `SQL02`였다. 복원 허용 예외는 같은 열을 명시한 INSERT로 확인했으며 실제 COPY 프로토콜은 확인하지 않았다. `pg_stat_user_functions`는 일반 열 UPDATE 후 0회를 보고했지만 통계 flush 지연이 있을 수 있어 `UPDATE OF` 문법의 보조 증거로 둔다.

**drizzle-kit `generate`: 확인. `tablesFilter`를 둔 `push`: 반박.** 숨은 `memo_tok_s`와 GIN이 존재하는 전용 스키마에서 `generate`를 실행했고 기존 코드 스냅샷에 변경 없음이었다. 생성된 초기 SQL은 선언된 열만 포함한다. 하지만 `tablesFilter: ['plain']`, `schemaFilter: ['gate_x1x2_kit']`, 스키마 파일에서 encrypted 테이블 제외, `push --force` 조건에서도 kit가 전용 스키마를 **DROP**하려 했다. PostgreSQL 의존성 오류 `2BP01`로 막혔고 kit 프로세스는 종료 코드 0을 냈다. 이 설정은 암호화 테이블 보호 수단으로 문서화하면 안 된다. 다른 스키마 구성에서 push가 같은 동작을 하는지는 추가 검증 대상이다.

**X2: 쓰기 목표는 이 측정에서 충족, 검색 목표는 미확정.** 1,000행 트리거 경로는 companion보다 빠르다. 직접 부모 토큰 SQL은 21개 중 4개에서 V3 SQL 시간을 넘었다. 256행 prefix 대체 SQL은 그 4개를 개선했으나 다른 사례에서는 느렸고, `sub_long`은 prefix 4.90 ms로 V3 4.66 ms를 약간 넘었다. 실제 제품의 분기 정책과 전체 인증 검색을 구현·측정한 것이 아니므로 21개 전체의 “V3 이하”를 확정하지 않는다.

## X1 관찰

| 항목 | 결과 |
|---|---|
| 단건 INSERT, 2행 배열 INSERT | 확인. 저장 첫 바이트 0x03, exact 1개·substring 토큰 생성 |
| patch 값 / NULL | 확인. NULL에서 암호문·두 토큰 배열 모두 NULL |
| 봉투 없는 UPDATE | `SQL02` |
| 봉투 row·scope·필드 번호 불일치, 다른 기존 행을 맞춘 WHERE, 다중 행 UPDATE | `SQL03`, 문장 전체 롤백 |
| WHERE가 아무 행도 맞추지 않음 | **반박:** 성공, `rowCount=0`. 트리거 호출 자체 없음 |
| id·tenant 변경 | `SQL01` |
| `(tenant,id)` upsert `SET memo_ct=$3` (`set: v`의 SQL 형태) | 확인. `UPDATE OF` 트리거 작동 |
| `DO NOTHING`, 조건 거짓 `DO UPDATE` | 확인. 각각 `rowCount=0` |
| `SET memo_ct=EXCLUDED.memo_ct` | `SQL02`. INSERT BEFORE 단계에서 EXCLUDED 값은 v3로 바뀜 |
| id만 unique target, 다른 tenant와 충돌 | `SQL01` (tenant를 함께 SET한 형태) |
| 암호문과 토큰을 함께 담은 복원 INSERT | 확인. 실제 COPY 명령은 미실행 |
| ROLLBACK TO SAVEPOINT | 확인, 삽입 행 없음 |
| 일반 status UPDATE | 함수 통계 0회. 통계 flush 가능성 때문에 보조 증거 |

봉투는 기존 평문 fixture의 `memo_plain`을 `Sealer.seal`과 제품 `searchPieces/searchTokens`로 처리한 실제 v3 암호문·토큰으로 조립했다. 필드 하나를 쓰는 X1 프로브이므로 여섯 필드의 모든 조합에 대한 형식 검증은 아니다. 트리거 초안의 복원·명시 재색인 예외는 암호문과 토큰을 동시에 신뢰하므로, 이 경로의 호출 권한은 별도 설계 판단이 필요하다.

## X2 성능

Node `pg` 요청 시작부터 응답까지의 ms. 각 경로 2회 예열, 교차 또는 동일 조건 7회 측정의 중앙값. 암호화·토큰 생성과 애플리케이션 트랜잭션 시간은 쓰기 표에 포함하지 않는다. 트리거 봉투의 암호문·토큰은 기존 fixture에서 읽었으며 그 fixture는 제품 `Sealer`/`searchTokens`로 생성됐다. 트리거 경로는 여섯 필드, 각 exact·substring 토큰 칸을 처리했다.

| 1,000행 합계 ms | companion | 부모 직접, 트리거 없음 | 부모 + 트리거 | 트리거 / companion |
|---|---:|---:|---:|---:|
| INSERT | 699.69 | 481.66 | 589.30 | 0.84× |
| memo patch | 678.01 | 395.62 | 423.38 | 0.62× |
| DELETE | 500.36 | 276.91 | 280.32 | 0.56× |

100행 배열 INSERT는 companion 16.15 ms, 트리거 15.39 ms였다. DELETE에는 트리거가 발동하지 않으므로 작은 차이는 측정 변동과 저장 구조 차이를 포함한다. 같은 값의 암호문·토큰으로 patch했으므로 변경 평문을 다시 암호화하는 관리형 쓰기 비용은 측정하지 않았다.

| 20행 조회 SQL ms | companion 구성 | 부모 토큰 구성 |
|---|---:|---:|
| `SELECT *` | 0.666 | 4.174 (+526%) |
| 토큰 제외 명시 열 | 0.429 | 0.449 (+4.6%) |

Drizzle가 선언된 칸만 조회한다는 §1 사실과 일치하는 SQL 투영 모사다. 실제 Drizzle select/relations 전체 요청 시간은 재측정하지 않았다. 원시 `SELECT *`의 큰 비용은 여전히 존재하므로 원시 SQL 사용자는 숨은 칸을 명시적으로 제외해야 한다.

| 검색 SQL ms | V3 SQL | 부모 직접 | 256행 prefix 실험 |
|---|---:|---:|---:|
| exact_common | 0.81 | 0.28 | 0.52 |
| exact_mid | 0.75 | 0.31 | 0.91 |
| exact_one | 0.41 | 0.32 | 0.84 |
| exact_zero | 0.44 | 0.30 | 1.12 |
| sub2_common | 1.17 | 0.37 | 0.54 |
| sub_mid | 1.16 | **38.88** | 0.75 |
| sub_mid_space | 2.68 | 1.25 | 2.13 |
| sub_rare | 1.73 | 0.44 | 1.12 |
| sub_long | 4.66 | 2.94 | **4.90** |
| sub_name_suffix | 1.00 | 0.36 | 1.09 |
| sub_zero | 1.26 | 0.38 | 0.95 |
| starts | 1.23 | 0.36 | 0.62 |
| ends | 1.28 | **59.70** | 0.73 |
| and2 | 1.20 | 0.35 | 0.69 |
| and4 | 6.99 | 5.52 | 6.23 |
| and6 | 8.98 | 7.89 | **9.33** |
| or2 | 1.30 | 0.49 | 0.81 |
| or3 | 1.47 | 0.44 | 1.15 |
| drain101 | 2.26 | 0.58 | 1.20 |
| word_boundary | 1.66 | **64.41** | 0.70 |
| word_inside_longer | 1.68 | **66.43** | 0.64 |

V3 열은 [기존 제품 V3 검증](../2026-09-27-core-verification/v3/report-ko.md)의 제품 전체 경로 SQL 시간이며, 이번 두 열은 **후보 ID만** 받는 SQL 시간이다. 따라서 절대값 판정은 탐색적이다. 21개에서 부모 직접·companion 후보 ID 순서가 같고 평문 첫 20개 적중 ID가 후보에 포함됨을 단언했다. prefix SQL은 같은 후보 ID를 돌려줬다. 인증 복호화 필드 수와 최종 반환 행은 이번 SQL 전용 측정에 포함하지 않았다. OR·exact에 prefix를 적용한 열도 실험값일 뿐 제품 경로 제안이 아니다.

## 설계 의견과 재현

§3의 `tablesFilter` push 제외 지시는 이번 실측과 충돌한다. 암호화 테이블이 포함된 데이터베이스에는 `push`를 금지하고 커스텀 마이그레이션 경로만 안내하는 편이 현재 증거상 안전하다. “WHERE 다른 행 → SQL03”은 일치 행이 없으면 SQL 트리거가 알 수 없으므로 `rowCount=0` 허용으로 계약을 명확히 하거나, API가 결과 행 수를 확인하는 별도 호출을 해야 한다. 이 판단은 공개 API 계약에 영향을 줄 수 있어 사용자 결정이 필요하다(이후 `rowCount=0` 허용으로 결정, [plan/001](../../../plan/001-drizzle-native-api.md) §2.2).

재현: `rtk proxy npx tsx bench/gate-x1x2/x1.ts`, `rtk proxy npx tsx bench/gate-x1x2/x2.ts`, `rtk proxy npx tsx bench/gate-x1x2/kit.ts`. 각 스크립트는 사전 DB 소유·주소 검사를 하고 자신이 만든 DB 객체만 삭제한다. `kit.ts`는 `push --force`를 전용 스키마에만 실행하며 stderr의 오류를 `kit.json`에 남긴다. `x2.ts`의 재실행 시에도 파생 객체가 없는지 먼저 검사한다. 결과는 로컬 일회용 DB 관찰이며 운영 처리량·보안 인증이 아니다.

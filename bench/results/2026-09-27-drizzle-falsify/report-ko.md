# Drizzle 통합 반증 실험 E1–E7 — 연구 기록 (2026-09-27)

상태: E1–E7 실험 완료. 제품 `src/`는 변경하지 않았다. `drizzle-orm@0.45.3`, `drizzle-kit@0.31.11`, `pg@8.23.0`, `miniflare@4.20260730.0`, Node 24.18.0을 사용했다. DB 실험은 `assertDisposable`로 소유를 확인한 `127.0.0.1:56439`에서만 `drizzle_falsify`와 `drizzle_falsify_perf` 전용 임시 스키마를 만들었고 끝에 둘 다 삭제했다. 기능 검사의 입력은 동작 확인용 수 행이며 성능 자료가 아니다. 재현: `rtk proxy node bench/drizzle-poc/falsify-runtime.mjs`, `rtk proxy node --import tsx bench/drizzle-poc/falsify-db.ts`, `rtk proxy node --import tsx bench/drizzle-poc/falsify-perf.ts`, `rtk proxy node --import tsx bench/drizzle-poc/falsify-snapshot.ts`, `rtk proxy npx drizzle-kit generate --config bench/drizzle-poc/falsify.config.ts`. 원자료: [runtime.json](runtime.json), [db.json](db.json), [perf.json](perf.json), [snapshot.json](snapshot.json), [kit-e5](kit-e5/).

| 실험 | 주안 기각 조건 판정 | 실측 사실 |
|---|---|---|
| E1 | **부분** | Node와 workerd에서 AES-GCM(AAD 포함) 암호문, HMAC-SHA-384, HKDF-SHA-384 출력이 WebCrypto와 바이트 단위로 일치했다. 1만 행×6필드에 해당하는 동기 복호화 60,000회는 Node 경과 1,962ms·`process.cpuUsage` 1,969ms, workerd 경과 930ms였다(각 15바이트 평문, 동일 키·nonce·AAD 반복, 순차 실행). workerd의 CPU 계측값과 실제 배포 CPU 한도는 얻지 못했으므로 초과 여부는 판정하지 않는다. 필드당 경과시간은 각각 약 32.7µs·15.5µs다. |
| E2 | **확인: 기각 조건 발생** | node-postgres의 일반 select, 부분 선택, join, insert/update `returning`, prepared, 관계형 `with`, 트랜잭션 결과에는 `fromDriver`가 적용됐다. `db.execute(sql\`select secret ...\`)`의 raw 결과는 `enc:two`로 그대로 나왔다. `fromDriver` 반환값은 `two`다. |
| E3 | **부분: 호출 형태에 따라 문맥 유실** | Node의 pool 최대 1개를 점유해 쿼리를 대기시키고 A/B 요청을 병렬 실행해도, `als.run(scope, async () => await drizzleQuery)`에서는 `toDriver`·`fromDriver`가 A/B를 각각 읽었다. 트랜잭션에서는 TX가 유지됐다. workerd의 Drizzle `pg-proxy` 가짜 비동기 쿼리에서도 같은 패턴은 A/B를 읽었다. 반면 `await als.run(scope, () => drizzleQuery)`처럼 Drizzle thenable을 문맥 밖에서 기다리면 Node와 workerd 모두 `toDriver`·`fromDriver`에서 문맥이 `undefined`였다. workerd에서 실제 pg pool 대기·트랜잭션은 실행하지 않았다. |
| E4 기능 | **확인: 기각 조건 발생** | BEFORE 트리거가 입력을 `ct`·`tokens`로 나누는 일반 insert와 부분 update, 열 복사, 두 동시 트랜잭션의 마지막 갱신, 롤백은 관찰한 상태가 일치했다. 그러나 `INSERT ... ON CONFLICT DO UPDATE SET input=excluded.input`은 BEFORE INSERT 트리거가 `excluded.input`을 `NULL`로 만든 탓에 기존 `c1/x`를 `c2/y`로 갱신하지 못했다. `UPDATE ct='raw-corrupt'`도 트리거를 통과해 토큰과 암호문이 불일치했다. |
| E5 | **부분** | 전용 복합 타입의 `like(col,'%a%')`는 PostgreSQL `42883` 오류를 냈다. `lt(col,v)`의 평범한 바인딩은 `0A000` 오류였지만 `::seal_pair` 명시 캐스트를 붙인 raw `<`는 두 행을 반환했다. 타입과 연산자만으로 모든 비검색 연산을 일률적으로 막았다고 볼 수 없다. `drizzle-kit generate`는 `"drizzle_falsify.seal_pair"` 열을 출력했으나 타입·연산자 생성 DDL은 없었다. |
| E5 복합 `=` 변형 | **확인: 후보 반환** | `(ct text, token text)` 복합 타입에 동일 타입 `=` 연산자를 토큰 비교로 정의했다. `eq(col,{ct:'probe',plain:'alpha'})`가 다른 암호문 `cipher1`과 `cipher2`의 두 행을 반환했다. 8비트 HMAC 토큰이 같은 `alpha`와 `other368`의 의도적인 충돌이다. 즉 `eq` 결과에는 오탐이 포함됐다. 해당 연산자를 보이게 하기 위해 세션 `search_path`를 임시 스키마로 설정했다. |
| E6 | **확인: 일부 거부, 완전성 기각** | `CHECK`가 원시 SQL 평문 `hello`와 범위가 다른 `sealed:B:abc`를 각각 `23514`로 거부했다. 같은 형식의 위조 문자열 `sealed:A:fake`는 통과했다. DB의 문자열 형식·scope CHECK만으로 암호 인증을 확인하지 못했다. |
| E7 | **확인 (실행한 공격 범위)** | 행 ID 없는 AAD로 암호화한 값을 같은 scope의 다른 행 ID로 이동해 복호화가 성공했다. 행 ID 결속 AAD 값은 이동 후 `AUTH_FAIL`이었다. 한 샘플에서 토큰과 암호문 길이는 같았다. 기존 2만 피해 행의 메모 토큰을 변경 없는 제품 토큰 함수로 전부 재생성해 DB 배열과 비교하니 불일치 0행이었다. 동일한 피해 2만·참고 2만·알려진 5%(1천)·시드 99로 빈도/알려진 행 공격을 양쪽 토큰 집합에 다시 실행한 점수가 같았다(아래 표). |

## E4 검색 측정

측정 허락을 받은 뒤 기존 `bench_standard_next_100k.customers`와 companion의 **같은 100,000개 행·토큰·암호문**에서 `drizzle_falsify_perf.rows`를 파생했다. BEFORE 트리거가 입력을 인라인 `memo_ct`·`tokens` 열로 옮겼고 GIN 색인을 만든 뒤 `ANALYZE`했다. 원본 스키마는 읽기만 했다. 원본 첫 행 메모의 첫 세 글자로 제품 `searchPieces`·`searchTokens`가 만든 실제 `contains` 토큰을 양쪽 경로에 사용했다. 동일 scope, `id` 오름차순, LIMIT 20, 메모 한 필드 인증 복호화·평문 재확인으로 맞추고 2회 예열 뒤 순서를 번갈아 7회 측정했다. 반환 ID·복호화 값은 매회 일치했다. 중앙값(ms):

| 경로 | SQL 요청~응답 | 전체(복호화·재확인 포함) | 후보 | 반환 | 인증 필드 |
|---|---:|---:|---:|---:|---:|
| 현재 companion 형태 SQL | 0.891 | 1.570 | 20 | 20 | 20 |
| 트리거 파생 인라인 SQL | 0.489 | 1.181 | 20 | 20 | 20 |

이 한 검색의 SQL 형태 비교이며 제품 `findMany` 전체 호출이나 일반적인 쓰기 성능을 나타내지 않는다. 두 경로 모두 이 조건에서만 수치가 나온 것이다. 파생 스키마는 측정 후 삭제했다.

## E7 기계적 스냅샷 공격

| 공격 | 현재 토큰 | 행 ID 없는 AAD 후보의 동일 토큰 |
|---|---:|---:|
| 빈도 공격 조각 등장 해독 | 7.80% | 7.80% |
| 알려진 행 대조 공격 조각 등장 해독 | 45.75% | 45.75% |
| 알려지지 않은 행의 80% 이상 해독 | 19.20% | 19.20% |

행 ID 결속은 본문 AAD만 바꾸며 이 비교의 검색 프로필·토큰 생성 입력은 같다. 후보의 2만 행 토큰은 원본 평문에서 제품 함수로 재생성했고 기존 DB 토큰과 0행 불일치였다. 새 본문 암호문 2만 개를 만들지는 않았으므로 암호문 길이·형식 추론 공격의 집계 점수는 측정하지 않았다. **실행한 빈도·알려진 행 공격의 점수는 누출 하한**이다. 동시출현·길이 추론·쿼리 관찰·다중 스냅샷 공격은 실행하지 않았다.

E5의 정확 토큰은 검색 후보만 만들며, 충돌 행의 실제 평문 일치 여부를 인증 복호화로 재확인하지 않았다. 위 결과는 동작 확인과 로컬 비교이며 운영 성능이나 보안 인증이 아니다.

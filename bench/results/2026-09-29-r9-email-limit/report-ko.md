# R9 ID 순 페이지의 조기 종료

## 결과와 조건

일반 quick/fallback을 채택한다. `orderBy` 생략과 명시적 `id asc`는 같은 SQL을 만들며, 연산자·필드·검색어 특례는 없다. `biz.test` 목록300 SQL 요청~응답 중앙값은 679.27→14.92ms, 전체 API는 745.46→77.35ms였다. 희귀어와 45자 0건 질의의 추가 비용은 아래에 그대로 기록한다.

- 이전 제품은 `04994b2`의 소스를 별도 폴더에서 빌드했다. 이후 제품은 이 보고서와 함께 커밋한 코드다.
- 원문 fixture에서 독립 적재한 `test_r9_verify_main` 100,000행을 읽었다. 회사 exact bits2, 나머지 exact 기본16, substring words 스트림 포함이다. 키·scope·인덱스·물리 배치·통계는 전후 동일하다.
- 일회용 DB 포트56439 확인과 `assertDisposable`을 먼저 실행했다. 풀 최대 연결1, `default_transaction_read_only=on`, `work_mem=4MB`이며 비교 시작과 종료의 backend PID가 같음을 단언했다. 테이블·함수·통계·물리 순서를 변경하지 않았다.
- 측정 락을 보유한 상태에서 예열2회 후 경로 순서를 교차하며7회 측정했다. 원문 평문을 별도 정규화한 oracle로 모든 반복의 count·반환 ID 순서·선택한6필드 값을 대조했다. 목록은 limit300, ID 오름차순, ID와6필드 투영이다.
- SQL 요청~응답은 클라이언트 왕복 합계, 전체는 API 시작~반환이다. 각 지표 중앙값은 서로 합산되지 않을 수 있다. EXPLAIN은 측정 샘플과 별도의1회 실행이며 중앙값이 아니다. OS 캐시는 비우지 않았다.
- 원본: [comparison.json](comparison.json), 실행: [email-limit.ts](../../r9/email-limit.ts), 이전 제품 준비: [prepare-email-limit.mjs](../../r9/prepare-email-limit.mjs).

## 목록300 전후

단위 ms. 두 경로 모두 SQL1회이며 앱으로 받은 행과 최종 반환 행이 같다. 인증 복호화는 실제 `Sealer.open` 호출을 계측했다. 대표8조건에 포함된 `biz.test`·45자를 중복 집계하지 않고, 두 번째 suffix `est`와 희귀어 `푸른달`을 더해10조건이다.

| 조건 | SQL 이전 | SQL 이후 | 차이 | 전체 이전 | 전체 이후 | 반환 행 | 인증 복호화 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 회사명 exact 흔한 값 | 3.07 | 2.71 | -0.35 | 65.60 | 64.33 | 300 | 1800 |
| 메모 contains 서비스 | 37.86 | 8.56 | -29.30 | 101.55 | 72.09 | 300 | 1800 |
| 메모 contains 푸른달 | 3.22 | 6.36 | +3.14 | 24.59 | 28.50 | 101 | 606 |
| 주소 startsWith 서울 | 118.84 | 25.69 | -93.16 | 180.57 | 91.81 | 300 | 1800 |
| email endsWith biz.test | 679.27 | 14.92 | -664.35 | 745.46 | 77.35 | 300 | 1800 |
| AND2 | 233.44 | 108.41 | -125.03 | 294.21 | 172.87 | 300 | 1800 |
| AND6 | 37.45 | 30.12 | -7.33 | 101.46 | 95.74 | 300 | 1800 |
| OR2 | 4.49 | 5.66 | +1.17 | 65.05 | 67.01 | 300 | 1800 |
| 45자 contains | 22.60 | 38.32 | +15.72 | 25.23 | 41.38 | 0 | 0 |
| email endsWith est | 6.30 | 7.18 | +0.88 | 75.44 | 74.93 | 300 | 1800 |

`푸른달`은 전체101건이라 quick만으로300건을 채울 수 없어 prefix와 fallback 비용을 모두 낸다(+3.14ms). 45자는 최종0건이며 prefix1200개 판정에 더해 후보2440개의 ID 정렬·proof 재조회가 필요하다(+15.72ms). OR2와 `est`는 이전 Merge Join도 일찍 멈추던 조건이라 quick CTE 비용이 각각 약1.17ms·0.88ms 추가된다. 더 좁은 연산자 특례로 이를 숨기지 않는다.

## count 전후

아래 모든 count의 전후 SQL 문자열은 동일하다. SQL1회·스칼라1행·인증 복호화0이며, 수치 차이는 이번 실행의 변동으로 해석한다.

| 조건 | 정확한 count | SQL 이전 | SQL 이후 | 전체 이전 | 전체 이후 |
|---|---:|---:|---:|---:|---:|
| 회사명 exact 흔한 값 | 28331 | 60.46 | 59.54 | 61.37 | 60.51 |
| 메모 contains 서비스 | 40097 | 267.55 | 269.06 | 268.60 | 270.05 |
| 메모 contains 푸른달 | 101 | 2.08 | 1.91 | 2.89 | 2.71 |
| 주소 startsWith 서울 | 16574 | 135.86 | 139.09 | 136.86 | 139.97 |
| email endsWith biz.test | 26598 | 643.93 | 642.51 | 645.82 | 644.03 |
| AND2 | 21176 | 270.88 | 269.43 | 272.06 | 270.64 |
| AND6 | 624 | 36.18 | 36.15 | 38.71 | 38.66 |
| OR2 | 28400 | 141.38 | 147.88 | 142.61 | 149.02 |
| 45자 contains | 0 | 22.52 | 22.17 | 25.03 | 24.55 |
| email endsWith est | 100000 | 485.67 | 485.97 | 487.00 | 487.11 |

## 기본 정렬과 명시적 ID 정렬

두 표현은 SQL 문자열까지 동일함을 단언했다. 이전 제품의 무거운 쿼리와 섞여 실행되는 영향을 분리하기 위해 현재 제품의 두 표현만 별도 세션 안에서 예열2회·교차7회 비교했다. 이 표는 위 전후 표와 다른 세션의 결과이므로 섞어 중앙값을 만들지 않았다. 원본: [order-parity.json](order-parity.json).

| 조건 | 명시적 id asc SQL | 기본 정렬 SQL |
|---|---:|---:|
| 회사명 exact 흔한 값 | 2.77 | 2.69 |
| 메모 contains 서비스 | 8.55 | 8.48 |
| 메모 contains 푸른달 | 6.69 | 6.52 |
| 주소 startsWith 서울 | 24.81 | 24.36 |
| email endsWith biz.test | 11.44 | 11.54 |
| AND2 | 103.30 | 103.92 |
| AND6 | 30.12 | 30.51 |
| OR2 | 6.03 | 5.88 |
| 45자 contains | 37.57 | 37.93 |
| email endsWith est | 7.33 | 7.24 |

기존 명시적 ID 커서의 정렬 결속·형식은 보존했다. 이전 제품이 만든 `biz.test` 첫300행 다음 커서를 새 제품에 넘겼고, 다음300행이 평문301–600번째와 일치했다([cursor.json](cursor.json)). SQL용 정렬만 정규화하며 cursor query digest의 기존 요청 표현은 유지한다.

## 실행 계획으로 확인한 원인

| 경로 | 확인한 계획 | 의미 |
|---|---|---|
| 이전 명시적 ID, biz.test | proof 통과26,598행 → 부모 PK 조회26,598회 → top-N300 | `!orders.length` 조건 때문에 기본 정렬의 조기 종료 경로에서 빠졌다. |
| 이전 기본 정렬, biz.test | 후보 ID 정렬 → proof·부모300회에서 LIMIT 종료 | 의미가 같은 정렬 표현에 따라 실행 계획이 달랐다. |
| bounded를 모든 ID 정렬에 그대로 적용, 메모 | 후보40,097개의 ID를 모두 읽고 정렬 | 원래 Merge Join은 부모746개에서 끝났다. 37.97→108.81ms 악화 원인이다. |
| 같은 중간안, 45자 | 후보2440개 정렬 후 proof2440회 재조회 | 원래 Bitmap Heap이 직접 탈락시키던 행을 재조회했다. 21.73→34.20ms였다. |
| 최종 메모 | prefix에서746개를 읽어 최종300개 충족, fallback 하위 노드 loops0 | 전체40,097개 후보 정렬을 실행하지 않는다. |
| 최종 biz.test | prefix1055개 중 최종300개 충족, fallback 하위 노드 loops0 | 부모 조회300회에서 멈춘다. |
| 최종45자 | prefix1200개 탈락 → 후보2440개 ID 정렬·proof조회 →0건 | 결과 누락 없이 fallback을 완주하는 비용이다. |

최종 위 계획의 temp I/O는0이었다. 계획 원본은 [diagnosis.json](diagnosis.json), [전체 bounded 중간안](rejected-all-id-orders.json), 최종 [comparison.json](comparison.json)의 `plans`에 있다. 별도 EXPLAIN의 서버 시간은 클라이언트 중앙값과 구분한다.

## 채택한 일반 규칙과 기각한 중간안

유한 ID 오름차순의 기존 안전 조건(암호 검색식, substring 포함, 별도 부모 WHERE 없음)을 만족하면 한 SQL 안에서 ID prefix → 최종 판정 quick → 부족할 때 전체 fallback 순서로 실행한다. **prefix는 요청 limit의4배, 최소256인 내부 실행 상수**이며 결과나 작업량 상한이 아니다. 최종 판정 후 LIMIT을 적용하며, OR의 전체 후보 fallback도 유지한다. 추가 통계 조회·왕복·서버 수명 행 캐시는 없다. 다른 정렬이나 SQL 혼합 조건의 기존 경로는 유지한다.

중간 산출물은 재현과 기각 근거로만 보존한다. `rejected-all-id-orders.json`은 quick 없이 ID 경로만 확대한 안, `suffix-materialized.json`·`rejected-suffix-special-case.json`은 채택하지 않은 suffix 특례, `quick-fallback-initial.json`·`quick-before-sql-canonicalization.json`은 SQL 정규화 전 중간안이다. 최종 수치는 `comparison.json`과 `order-parity.json`뿐이다.

## 실행 및 게이트

측정 명령(각 exit0):

```text
rtk proxy node --import tsx bench/r9/email-limit.ts
rtk proxy node --import tsx bench/r9/email-limit.ts --order-parity
rtk proxy node --import tsx bench/r9/email-limit.ts --cursor-only
```

실제 커서 출력의 핵심: `oldExplicitCursorAccepted:true, secondPageRows:300, plaintextEqual:true`.

집중 회귀 `rtk proxy node --import tsx --test test/standard-r9-review.test.ts`: tests1, pass1, fail0, duration7294.53ms. 기본·명시 ID 정렬 각각 limit201, 최상위OR, prefix에서 못 찾는 fallback, 전체 keyset 이어받기를 평문과 대조한다. 긴 값 근접 불일치 contains·LIKE도 유지한다.

첫 전체 실행은 pass37/fail1이었다([원본 로그](gate-test-initial.log)). 실패는 `candidate batches above 200 use the direct index path`라는 폐기한 분기를 고정한 단언이었다. 이를 501행 요청의 평문 결과·명시/기본 정렬 결과·SQL 동일성 검증으로 바꿨다. 제품 코드는 이 수정에서 바꾸지 않았다.

| 명령 | 실제 출력 / 결과 | 로그 |
|---|---|---|
| `rtk proxy npm run build` | `tsc -p tsconfig.json`, exit0 | [build](gate-build.log) |
| `rtk proxy npm run check` | `tsc -p tsconfig.check.json --noEmit`, exit0 | [check](gate-check.log) |
| `rtk proxy npm test` | `tests 38`, `pass 38`, `fail 0`, `duration_ms 134790.6139`, exit0 | [test](gate-test.log) |
| `rtk proxy npm run docs:check` | `Documentation entry, links, decisions, plans, exports, and shared example references PASS`, exit0 | [docs](gate-docs-check.log) |
| `rtk proxy npm run test:install` | `Installed standard consumer compiles with drizzle-orm 0.45.3` 및 `0.45.2`, exit0 | [install](gate-test-install.log) |

설치 검증은 기존 스크립트대로 upstream Drizzle 선언 진단70개를 제외했다. 타입 게이트 실패를 숨긴 것이 아니며, 제외 동작도 원본 로그에 남겼다.

전체 테스트의 실제 드라이버 출력은 Node pg·postgres-js·workerd pg 모두 `ok:true, insert:1, count:1, update:1, reindex:1, search:1, substring:1, afterDelete:0`이었다. 트랜잭션 없는 드라이버의 `UNSUPPORTED_DRIVER` 테스트도 통과했다.

## 한계

- 평문 대조는 원본 값의 독립 oracle 정확성 확인이다. 이 과제에서 평문 SQL 지연이나 평문 대비2배 목표는 다시 측정하지 않았고, 달성했다고 주장하지 않는다.
- 이 독립 적재의 기존 물리 배치에서만 전후 비교했다. 두 물리 상관도·다른 규모·호스팅 Workers/Hyperdrive는 이번에 재측정하지 않았다.
- 희귀어·0건 질의의 추가 probe 비용은 남는다. 모든 조건에서 최선이라는 주장은 하지 않는다.
- 암호·저장·누출 형식을 바꾸지 않았다. 기계적 공격 시뮬레이션은 이번 SQL 계획 변경에서 새로 실행하지 않았다.
- 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.

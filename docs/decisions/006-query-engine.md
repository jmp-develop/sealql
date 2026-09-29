# 006. 쿼리 엔진

- 상태: 확정 (2026-09-27)
- 일부 대체: 앱 후보 판정·증가 배치·count 경로는 [015](015-database-search-proofs.md)으로 대체됐다. 아래 본문은 당시 결정 기록이다.
- 기본·최대 예산, count 반복, 배치 상한과 커서 결속의 일부는 [014](014-unbounded-query-work.md)로 대체됐다.

## 결정

- **페이지당 후보 SQL 1회.** 첫 후보 묶음은 `limit + ceil(limit/4) + 2`행이다. 바이트 예산은 실제 수신 바이트로 검사한다.
- 검색식 전체(AND/OR)를 **companion에 대한 단일 semi-join** 하나로 만든다: `id in (select row_id from companion where scope and <토큰 불리언식>)`.
- **2단계 복호화:** 묶음 전체의 조건 필드만 먼저 동시에 인증 복호화해 재확인하고, 통과한 행의 투영 필드만 복호화한다. 동시성 상한 `budgets.decryptConcurrency`는 기본·최대 64다.
- 페이지가 모자라면 keyset으로 다음 후보를 가져와 채운다. **커서 페이지네이션만** 지원한다(오프셋 없음).
- **count는 항상 정확한 `number`다.** 후보 전체의 조건 필드를 재확인해 센다. 후보·시간 예산을 넘으면 근사값 대신 `LIMIT_EXCEEDED` 오류를 낸다. 내부 후보 묶음은 최대 2,000행이다.
- ID 오름차순 일반 부분 검색 페이지는 companion 기본키 순서로 **최대 256행 prefix**의 토큰만 먼저 확인하고, 요청 수를 채우지 못하면 **같은 SQL 안에서** GIN 경로로 넘어간다. 정확 일치, 공개 필터, 다른 정렬, 고급 질의, 큰 count 묶음은 직접 색인 경로를 쓴다.
- 재확인 후에도 페이지가 모자라면 다음 묶음 크기를 **그 호출 안에서 관측한 통과율**로 키운다(통과 0이면 2배). 상한은 `budgets.batch`, 남은 `maxCandidates`, 수신 바이트다. 200행을 넘는 묶음은 직접 경로를 쓴다. 통과율과 빈도 정보는 저장하지 않는다.

## 근거

| 항목 | 전 → 후 | 출처 |
|---|---|---|
| 페이지당 SQL | 3–5회 → 1회 | [10만 행 검증](../../bench/results/2026-09-27-standard-next/report-ko.md) |
| OR 3개(상관 `EXISTS … OR EXISTS …`가 hashed SubPlan으로 부모 전체 스캔) | 341.53 → 2.23 ms | 같은 보고서, [std-matrix-baseline.json](../../bench/results/standard-review-2026-09-26/std-matrix-baseline.json) |
| `세종대로`: `@>` 선택도 과소추정(예상 455 / 실제 16,574행)으로 bitmap 전체 읽기·정렬 | 39.08 → 7.58 ms (건너뜀 92.18 → 7.99) | [SQL 계획 후속](../../bench/results/2026-09-27-standard-next-sqlplan/report-ko.md) |
| 띄어쓰기 구분 검색 | 130.26 → 7.55 ms | 같은 보고서 |
| count 1,770건 SQL 회수 | 9 → 1회(전체 시간은 1,770필드 복호화 때문에 개선 없음) | 같은 보고서 |
| `대로6고`(적중 10, 후보 170) SQL 회수 / SQL ms | 7 → 2회 / 16.60 → 5.73 | [후보 배치 확대](../../bench/results/2026-09-27-candidate-batching/report-ko.md) |

- prefix 크기 스윕(적중 10–16,821행 검색어 9개): 9개 최악 SQL이 기본 기준 직접 37.46 / **256행 16.92** / 1024행 21.58 / 2048행 27.62 / 4096행 39.52 ms였다. 256행이 가장 작아 채택했다. 적중 빈도만으로 직접 경로 비용을 예측할 수 없었다(`ch` 0.74 ms, `세종대로` 37.46 ms) ([sweep-ko.md](../../bench/results/2026-09-27-standard-next-sqlplan/sweep-ko.md)). 다른 분포·크기의 최적값은 보장하지 않는다.
- 부분 0건은 prefix 탐색 때문에 SQL 0.61 → 1.25 ms로 조금 늘었다. 감추지 않는다.
- 12개 GIN 모두 pending list가 0이었다. AND 4/6 비용은 긴 posting list(1.6만–4만 행)의 bitmap 결합과 heap 재검사에서 왔다. VACUUM·REINDEX는 해결책이 아니다. 해결은 [007](007-multicolumn-gin-not-combined-array.md) ([sweep-ko.md](../../bench/results/2026-09-27-standard-next-sqlplan/sweep-ko.md)).
- **정확성(V1):** 시드 고정 무작위 질의 1,000개(실제 값의 2–6글자 부분 문자열, AND/OR 조합)에서 거짓 음성·거짓 양성·커서 중복·누락 0건. 넓은 결과 16,574행·30,101행을 200행 페이지로 끝까지 순회해 평문과 ID 순서 SHA-256이 같았다. count가 평문과 같고 예산 초과는 `LIMIT_EXCEEDED`였다 ([V1](../../bench/results/2026-09-27-core-verification/v1/report-ko.md)).
- **성능(V3, 평문 대비):** C 로캘 전체 스캔 7건을 뺀 14건에서 SQL 시간은 평균 약 **1.9배**(1.25–3.3배, 보고서 표에서 계산)였다. 전체 시간은 20행 페이지에서 5.3–12.9배(대부분 10–13배), 14건 평균 약 8.7배로 목표 "약 2배"를 넘었다. 20행 페이지는 후보 27행에서 조건 27개 + 반환 약 120개, 모두 **127개 필드를 인증 복호화**하며 복호화 wall 약 3.6 ms, 재확인 등 잔여 약 2.5 ms, SQL 약 1 ms다. 주 비용은 SQL이 아니라 복호화·재확인이다 ([V3](../../bench/results/2026-09-27-core-verification/v3/report-ko.md)).
- Workers는 요청이 단일 스레드라 이 CPU 비용을 동시 실행으로 숨기기 어렵다(추정, 호스티드 Workers는 측정하지 않음).
- 사용자의 쿼리 작성에 새 래퍼 타입이나 제약을 강제하지 않는다. 정확성을 위한 내부 상태(`exact`, `atLeast` 같은 필드)는 공개 타입에 노출하지 않는다.

## 기각안

| 안 | 기각 이유 |
|---|---|
| 상관 `EXISTS … OR EXISTS …` | 부모 전체 스캔(OR 3개 343 ms) |
| 후보 묶음을 `maxBytes` 최악치로 계산 | 묶음이 10행이 되어 20행 페이지에 SQL 2회 |
| `{ count, exact }`나 `atLeast`를 반환하는 count, 근사 count | 공개 타입에 불확실성 노출. 예산 초과는 오류로 |
| 오프셋 페이지네이션 | 재확인 때문에 정확한 건너뛰기가 불가 |
| 한쪽 계획 고정, 계획 힌트 옵션 | 흔한·드문 검색어 중 하나를 희생한다. 사용자에게 힌트를 요구하는 공개 API 금지 |
| 조각·토큰 빈도를 DB나 서버 캐시에 저장 | 누출 증가, 서버 캐시 원칙 위반 |
| 1024행 이상 prefix, 테이블 크기에 따른 prefix 조정 | 최악값이 256행보다 컸다. 규모별 근거가 한 규모뿐 |
| `LIMIT`을 companion 안으로 내림 | 중간 선택도 10.5 → 2.8 ms지만 조밀한 조건 0.7 → 11.9 ms로 악화 |
| 긴 검색어 토큰을 8개로 제한 | 보류. 메모리 시뮬레이션에서 DB 작업량 3.3–5.9배 감소, 오탐 ×1.01 → ×1.04–1.08. PostgreSQL 실측은 없다 |

## 대체 관계

- 대체하는 것: 정책 조회·SQL 4회·상관 EXISTS 엔진(원 기록 삭제).
- 관련: [005](005-skip-grams-default-on.md), [007](007-multicolumn-gin-not-combined-array.md), [009](009-scope-and-non-goals.md).

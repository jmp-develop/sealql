# 검색 표 판정·연속 quick 채택 검증

순수 암호화 조건의 count는 companion만 읽고, 부모 조건·무조건 count는 부모를 유지한다. 양의 Boolean WHERE의 불필요한 coalesce를 제거했다. 목록은 연산자나 최상위 OR 구분 없이 후보→판정→LIMIT이며, quick가 부족하면 완전한 ID 앞부분에서 찾은 결과를 보존하고 그 마지막 ID 뒤부터 남은 개수만 찾는다. 기본 ID순과 명시 ID 오름차순은 같은 SQL이다.

위치 함수는 손상 검사를 제거하고 순번을 정규화 길이로 제한한다. 첫 후보에서 성공하면 커서 배열을 만들지 않으며, 첫 실패 이후에는 전진 커서와 이진 탐색을 유지한다. SET search_path·MAIN·꼬리 키 색인은 유지한다. 저장 형식과 토큰은 바꾸지 않았으므로 기존 compact-only 데이터는 extraMigrationSql 함수 재적용만 필요하다.

SQL 수치는 동일 세션·동일 fixture·2회 예열/7회 교차 중앙값(ms)이다. 제품 경로는 현재 소스의 함수를 별도 일회용 스키마에 설치해 기존 제품 표를 읽었고 원래 표·함수를 수정하지 않았다. 매 실행 count와 목록 ID/평문을 대조했다. 독립 검증자의 최종 3경로·전체 조건 판정은 별도다. 출처: [adopt-check.json](adopt-check.json).

| 조건 | 연구 SQL | 제품 SQL | 연구 전체 | 제품 전체 | SQL 배율 |
|---|---:|---:|---:|---:|---:|
| sub_common_memo count | 355.35 | 186.68 | 355.41 | 187.61 | 0.53 |
| sub_mid count | 149.57 | 165.15 | 149.63 | 166.36 | 1.10 |
| word_boundary count | 366.89 | 395.61 | 366.96 | 397.38 | 1.08 |
| ends count | 561.01 | 442.61 | 561.08 | 444.14 | 0.79 |
| starts count | 98.86 | 89.80 | 98.93 | 90.60 | 0.91 |
| zero_and_common2 count | 6.51 | 25.39 | 6.55 | 26.41 | 3.90 |
| sub_rare count | 1.21 | 1.39 | 1.23 | 2.19 | 1.15 |
| sub_zero count | 0.33 | 0.35 | 0.35 | 1.01 | 1.07 |
| and2_or_and2 list300 | 98.63 | 11.62 | 98.71 | 71.87 | 0.12 |
| or_and_mix list300 | 85.18 | 119.05 | 85.24 | 177.79 | 1.40 |
| and4 list300 | 9.84 | 13.14 | 9.90 | 27.72 | 1.34 |
| exact_common list300 | 3.89 | 4.67 | 3.96 | 60.98 | 1.20 |

연구 목록의 전체 시간은 이 국소 스크립트에서 ciphertext를 열지 않으므로 제품 전체와 성능 배율로 비교하지 않는다. 연구/제품의 SQL은 같은 투영 열을 요청한다. SQL 요청~응답과 EXPLAIN 실행 시간도 서로 다른 지표다.

COST 산출은 [calibrate-cost.json](calibrate-cost.json)에 있다: 같은 세션의 PostgreSQL int4 덧셈(COST 1) 250,000행×32회 증분 `(80.4111−47.7475)ms/8,000,000=0.00408295µs`, 같은 배열 판정 `7.724316µs`, 비율 `1891.85`를 사전 규칙인 100단위 올림으로 **1900**에 고정했다. JIT는 기본 연산자와 PL/pgSQL 표현 비교에서 끄고, 질의 성능을 본 뒤 값을 고르지 않았다. 탐색한 125는 채택하지 않았다.

COST100 대비 1900은 memo count 388.54→186.68ms, starts count 111.67→89.80ms였다. zero_and_common2는 7.63→25.39ms로 느려졌다. 2비트 coarse 후보 약 5.7만과 실제 0건의 차이 때문에 병렬 시작 비용을 내는 추정 문제이며, 코디네이터가 대량 count의 이득을 우선하여 이 절대 증가를 승인했다. 조건별 COST·분기·가드는 추가하지 않았다.

[희귀 조건 확인](adopt-rare-check.json): 메모 푸른달, email startsWith iae, 0건 조각, 거의 없는 OR3의 count와 목록 총 8개 계획 모두 Gather 없음·병렬 작업자 0이었다. COST1900의 count SQL은 각각 1.29/0.68/0.38/0.57ms였다. 목록은 quick 앞부분을 읽는 비용이 남아 연구보다 약 2–3ms 느리다.

[같은 배열 함수 비용](function-cost.json)은 10개 입력에서 연구 대비 1.066–1.107배였다. 약 40% 차이에서 약 7–11%로 줄었지만, 영어 service는 10.71%로 10% 목표를 소폭 넘었다. 첫 함수 비용 스크립트가 누적 통계를 분리하지 못한 [초기 기록](function-cost-initial-cumulative.json)은 채택 근거에서 제외하고 호출 수 차이가 정확히 입력 행 수인지 단언한 결과만 사용했다.

남은 미달: sub_mid count는 함수와 행 읽기 차이, word_boundary count는 함수 비용, or_and_mix 목록은 quick에서 부족한 34건을 위해 coarse 후보를 정렬하는 비용과 회사명 2비트 충돌 집합 차이, and4 목록은 부족한 quick 앞부분 읽기 비용이 남는다. 2비트 충돌 집합을 연구와 맞추려고 키나 비트를 바꾸지 않았다. 전체 ≤1.10 통과라고 주장하지 않는다.

검증: build/check, 공개 DB 회귀(4,002자 contains·LIKE 근접 불일치, limit 201 이상, root OR, keyset), benchmark 회귀(중첩 AND/OR, NULL, 두 scope의 같은 ID, rollback, 병렬 관리형 수정, delete cascade, reindex)를 실행했다. 최종 게이트 결과는 아래에 추가한다. 저장 형식·암호화·누출 채널은 변경하지 않았으며, 앞선 compact-only 기계적 공격 시험의 범위는 그대로다. 로컬 fixture 결과이며 운영 성능이나 보안 인증이 아니다.

최종 게이트: npm run build / npm run check / npm test / npm run docs:check / npm run test:install 모두 exit 0. 전체 테스트 실제 출력은 tests 37, pass 37, fail 0, duration_ms 101113.0077이며 Node pg·postgres-js·workerd pg 흐름은 모두 ok:true였다. 설치 검증은 drizzle-orm 0.45.3과 0.45.2에서 성공했고 기존 upstream 선언 진단 70건은 각 버전에서 무시했다. 중첩 OR/AND·두 scope·keyset benchmark 시험도 tests 1, pass 1, fail 0(duration_ms 1608.9707), 별도 benchmark TypeScript 검사도 exit 0이다. 실제 로그는 gate-adopt-*.log에 보존했다.

전체 시험 최초 실패는 exact 목록 SQL을 옛 in(select 문자열에만 맞춘 assertion 1개였고, 새 공통 CTE도 허용하도록 고친 뒤 전체를 다시 통과했다. 최초 실패 로그 gate-adopt-test-initial.log도 보존했다. 호스팅 Workers/Hyperdrive와 최종 전체 3경로 성능·용량·쓰기는 독립 검증에서 아직 미검증이다.

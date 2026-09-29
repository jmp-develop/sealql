# 015 — DB 안에서 검색 판정 완료

상태: 채택, 2026-09-29. [001](001-search-hmac-pieces-gin-verify.md)의 앱 재확인, [006](006-query-engine.md)의 후보 복호화·증가 배치, [014](014-unbounded-query-work.md)의 후보 예산을 대체한다. [012](012-drizzle-companion-and-column-options.md)·[013](013-drizzle-native-api-implemented.md)의 공개 Drizzle 통합은 유지한다.

구현 보완: [017](017-search-proof-review.md)의 전진 위치 탐색·LIKE 정수 배열과 검토 결과, [018](018-identity-order-page-plans.md)의 ID순 일반 페이지 계획을 함께 적용한다.

검토 뒤 선택한 트레이드오프(긴 값은 함수 호출당 1행, 대표 질의는 같은 10만 행; 예열 2회·교차 7회, SQL 왕복 중앙값):

| 조건 | 검토 전 → 최종 | 판단 |
|---|---:|---|
| 긴 contains 근접 불일치 | >1500 → 33.5ms | 이전은 시험 제한으로 중단, 최악 반복 비용 수정 |
| 2050글자 LIKE 근접 불일치 | 654 → 27ms | JSON 제거·공유 위치 목록 |
| 메모 목록300 | 129 → 109ms | 디스크 정렬14.6MB → 메모리1.5MB, temp I/O 제거 |
| 이메일 count | 523 → 674ms (1.29배) | 위치 검증·전진 상태의 비용을 수용 |
| AND6 count | 30.7 → 37.1ms (1.21배) | 같은 검증 비용을 수용 |
| 45글자 count / 목록 | 17.8 → 22.7ms / 24.1 → 34.8ms | 판정 검증과 proof 재조회 비용, 1.27배 / 1.44배 수용 |

최악 경우 해결과 목록 디스크 정렬 제거를 우선해 확정했고 추가 튜닝은 하지 않는다. `SET search_path=pg_catalog` 제거는 일부 count 이득이 있지만 목록·OR에 일관된 이득이 없어 유지한다. [원본 측정과 전체 표](../../bench/results/2026-09-29-r9-review/report-ko.md)를 따른다.

## 변경

| 항목 | 이전 | 현재 |
|---|---|---|
| 판정 | HMAC 후보를 앱에서 인증 복호화·재확인 | 같은 후보 토큰 + 행별 salt 도장을 DB에서 판정 |
| count | 후보 행·조건 칸을 앱으로 전송 | 부모 scope/where와 semi-join 후 스칼라 1개, 복호화 0 |
| 목록 | 조건 칸 먼저, 정답의 선택 칸 나중에 복호화 | DB가 정답만 반환, 선택된 암호 칸만 인증 복호화 |
| 예산 | maxCandidates, count 후보/바이트/배치 예산 | maxCandidates 제거, count는 deadlineMs와 signal만 |
| 저장·쓰기 | 필드별 토큰 | 토큰·도장을 관리형 쓰기와 reindex에서 원자적 갱신 |

AES-256-GCM, 기존 AAD 행 결속, HMAC 토큰 유도는 바꾸지 않는다. 새 HKDF-SHA384 라벨 `sealql/search-stamp/v1`로 고정 필드/스트림 키를 분리하고 HMAC-SHA256으로 scope와 값/조각 키를 만든다. 서버 수명 캐시는 고정 파생 키만 보관한다. 값·조각 키와 행 데이터는 요청 밖에 보관하지 않는다.

정확 일치는 무작위 16B salt와 `SHA256(valueKey || salt)[:8]`이다. 위치 스트림은 `SHA256(pieceKey || salt || uint32BE(등장순번))[:8]` 도장을 signed bigint로 정렬하고 대응하는 0기반 위치 배열을 보관한다. 같은 칸 내부 도장 충돌은 salt를 다시 뽑아 쓴다. compact2는 2글자 창 전체, words2는 `wordBoundary` 필드에서만 공백을 한 칸으로 접은 창 전체, single1은 LIKE의 분리된 singleton literal 판정용이다. 일반 1글자 부분 검색은 계속 금지한다. 비텍스트 exact는 기존 `encodeField` 바이트를 쓴다.

contains/starts/ends는 2칸 간격과 마지막 창으로 검사한다. 첫 창의 위치부터 찾고 나머지 창은 필요한 등장순번까지만 확인해 첫 일치에서 끝난다. 연구 함수도 후속 창의 등장순번을 순회한다; 목표 위치만으로 등장순번 도장을 한 번에 계산할 수는 없다. LIKE는 필요한 조각별 위치 목록을 호출 안에서 한 번 만들고 literal run과 `%`/`_`의 도달 가능한 위치를 계산한다. 긴 반복 값에서 비용이 커질 수 있으므로 별도 회귀 시험을 유지한다.

## SQL·저장 선택과 게이트

- 목록은 ID순 후보 서브쿼리의 `OFFSET 0` 뒤에서 판정하고 `LIMIT`에서 멈춘다. 최상위 OR는 같은 층 WHERE를 유지한다: 순서 장벽을 강제하면 전체 스캔/정렬 계획이 느려졌다. 200행 이하 요청의 256행 prefix에도 최종 판정을 적용한다.
- 부모 scope는 항상 유지한다. X5(전역 unique row의 내부 scope 생략)는 미채택: 결과 일치 단언 후 EXPLAIN 3회에서 exact 목록 실행시간 중앙값 1.103→1.484ms, 다른 조건의 일관된 이득도 없었다. 초기에 보고한 105→498ms는 저장 JSON의 bytea를 복원하지 않은 진단 오류라 폐기했다.
- 후보 토큰과 compact 도장/위치 배열은 MAIN, words/single은 기본 저장을 쓴다. 전역 unique row는 companion에도 일반 unique row_id 색인을 선언한다. exact B-tree는 기존 `(scope_id, tokens[1], row_id)` 뒤에 salt/stamp/단일 토큰 배열을 넣는다. 꼬리 키는 고정 길이 UUID row와 UUID 또는 무scope에만 적용해 text ID의 기존 최대 색인 항목 크기를 줄이지 않는다. exact 토큰은 1차원 1개 원소 CHECK를 둔다.
- 모두 Drizzle 선언 또는 `extraMigrationSql`로 설치한다. 함수를 포함한 추가 SQL 2회 적용 후 generate/migrate/push 2회가 변경 없이 통과했다. 별도 숨은 색인 설치 경로는 없다.
- 10만 행 ID-물리 순서 상관 1과 약 0 양쪽에서 8조건 count/목록300을 확인했다. 초기 연구 대비 1.2배 초과는 주소 count(부모 scope 결합·큰 heap), AND6 count(같은 추가 결합·proof payload), 메모 목록(큰 heap의 후보 접근·정렬)로 기록하고 추가 튜닝은 중단했다. AND6 연구 함수를 현재 환경에서 재측정하면 제품 SQL과 비슷했다. [측정·시험 보고](../../bench/results/2026-09-29-r9/report-ko.md)는 반복 측정과 용량·쓰기 비용을 별도로 기록한다.

## 누출과 설치

DB는 루트·암호화 키를 받지 않지만 질의의 값/조각 키를 받는다. 관찰된 조각 키는 접근 가능한 salt/도장에서 해당 조각의 위치를 복원한다. 길이, 위치의 순열, words 길이 차이(일반 텍스트는 정규화된 공백 수, phone 프로필은 제거된 구두점도 포함), 기존 토큰 빈도/동시출현이 노출된다. 기계적 시험의 중복 0건은 안전 증명이 아니다. 64비트 도장의 우연한 충돌 가능성은 0이 아니며, 적대적 DB의 누락·거짓 조건 판정도 탐지하지 못한다. 반환 암호문 인증은 SQL 실행의 증명이 아니다. [위협 모델](../threat-model.md)의 로그 조건을 적용한다.

설치 순서는 스키마 마이그레이션 → `extraMigrationSql` → 전체 `sealed.reindex` → 새 검색 코드다. reindex가 기존 companion 값을 다시 써야 MAIN도 적용된다. 버전/정책 테이블은 추가하지 않는다. 공개 API 흐름은 그대로이며 조건 칸을 JOIN 선택에 포함할 필요가 없어졌다. Node pg·postgres-js·local workerd+pg에서 insert/update/count/findMany/search/reindex/delete를 확인했다. 실제 Workers/Hyperdrive 배포는 미검증이다.

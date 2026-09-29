# 결정 기록

확정된 설계 결정과 그 근거를 둔다. 진행 중인 계획은 [`plan/`](../../plan/README.md), 현재 제품 상태는 [`current-state.md`](../current-state.md)에 있다.

## 형식

각 기록은 1–2쪽 이내로, 아래 네 절을 둔다.

- **결정**: 무엇을 하기로 했는가. 현재 코드와 같아야 한다.
- **근거**: 수치와 출처. 수치에는 `bench/results/`의 보존 파일 링크를 붙인다. 원 측정 파일이 없으면 "원 기록 삭제, 수치만 보존"이라고 적는다. 측정하지 않은 값은 "추정"이라고 적는다.
- **기각안**: 검토했다가 버린 안과 이유. 같은 논의를 반복하지 않기 위해 남긴다.
- **대체 관계**: 이 기록이 대체하는 기록, 이 기록을 대체한 기록, 관련 기록.

결정이 바뀌면 기존 기록을 지우지 않고 새 번호를 추가한 뒤, 양쪽의 대체 관계를 갱신한다. 모든 측정은 로컬 일회용 DB와 합성 fixture 또는 공개 말뭉치의 결과이며 운영 성능 보장이나 보안 인증이 아니다. 전체 검증 흐름은 [`verification.md`](../verification.md), 측정 규칙은 [`measurement.md`](../measurement.md), 보안 판단 방법은 [`attack-simulation.md`](../attack-simulation.md)에 있다.

## 목록

| 번호 | 결정 |
|---|---|
| [001](001-search-hmac-pieces-gin-verify.md) | 검색은 HMAC 조각 토큰 + GIN + 라이브러리 내부 재확인 |
| [002](002-fixed-keys-no-db-policy.md) | 고정 키(전역 또는 모델), DB 정책 테이블 없음 |
| [003](003-field-cipher-key-cache-aad.md) | 필드 키 캐시 + 256 shard + AAD 결속 |
| [004](004-token-layout-16bit.md) | 조각 토큰 16비트, 조각 구성, 정규화 |
| [005](005-skip-grams-default-on.md) | 건너뛴 조각 기본 켬 |
| [006](006-query-engine.md) | 쿼리 엔진: SQL 1회, semi-join, 2단계 복호화, prefix, 배치 |
| [007](007-multicolumn-gin-not-combined-array.md) | 부분 검색 색인은 다중 컬럼 GIN, 통합 배열 기각 |
| [008](008-drizzle-integration.md) | Drizzle 통합 방식(채택 부분은 [013](013-drizzle-native-api-implemented.md)로 구현 완료) |
| [009](009-scope-and-non-goals.md) | 범위와 비목표 |
| [010](010-security-claim-limits.md) | 보안 주장의 한계 |
| [011](011-rejected-research-lines.md) | 기각된 연구 방향 |
| [012](012-drizzle-companion-and-column-options.md) | Drizzle 통합: 보조 테이블 유지, 칸마다 옵션 (008 일부 대체) |
| [013](013-drizzle-native-api-implemented.md) | Drizzle 네이티브 API 구현 완료 (008·012 구현 확정) |
| [014](014-unbounded-query-work.md) | 호출자 선택 예산, count 단일 후보 흐름, 커서 결속 정리 |
| [015](015-database-search-proofs.md) | DB 도장 판정, 스칼라 count, 선택 칸만 복호화 (001·006·014 일부 대체) |
| [017](017-search-proof-review.md) | 전진 위치 탐색·LIKE 정수 배열·검토 비용 및 회귀 시험 |
| [016](016-coarse-exact-bits.md) | 저카디널리티 exact의 명시적 2비트 허용 (004 일부 대체) |
| [018](018-identity-order-page-plans.md) | ID 정렬 표현 통일과 연산자에 독립적인 페이지 quick/fallback |

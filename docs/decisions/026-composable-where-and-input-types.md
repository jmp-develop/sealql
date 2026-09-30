# 026. 조합 가능한 암호 검색 조건과 관리형 입력 타입

- 상태: 확정 (2026-09-30). 관련: [013](013-drizzle-native-api-implemented.md), [020](020-companion-predicate-plans.md), [027](027-drizzle-surface-and-prepare-gate.md).

## 결정

1. `sealed.where(seal, { scope, match })`는 암호 검색 조건을 보통의 Drizzle `SQL` 조건으로 돌려준다. 사용자는 이를 자기 쿼리의 `where`(JOIN, LEFT JOIN, 서브쿼리, `count()`, 정렬·limit 유무 자유)에 넣고, 결과는 `sealed.open`/`openRaw`로 연다. 생성 경로는 `sealed.search`가 콜백에 주던 `where`와 같다(scope 조건 + 기존 후보·도장 판정). 새 SQL 형식·판정·저장 형식은 없다.
2. `sealed.search`는 SealQL이 커서 페이지 넘김·예산을 관리할 때만 쓰는 선택 도우미로 남는다.
3. 관리형 쓰기 입력 타입 `InferSealedInsert`·`InferSealedIdentity`·`InferSealedPatch`를 공개한다. 런타임 규칙과 같게 UUID row만 생략 가능, 텍스트 row·scope는 필수, update patch에는 row·scope가 없다.

## 근거

- JOIN에 암호 조건을 쓰려면 `sealed.search` 콜백 계약(정렬·위치 값·after 적용)을 따라야 했다. 이는 페이지 관리 기능의 요구이지 조회 자체의 요구가 아니어서, 보통의 DB·Drizzle 사용 방식에 없는 제약이었다.
- 평문 SQL 대조 시험: 단일·다중 JOIN, LEFT JOIN, 서브쿼리, count, 평문 칼럼 update, 두 드라이버(`test/standard-drizzle-where.test.ts`, `test/standard-drizzle-complex-join.test.ts`).
- 입력 타입: 텍스트 row ID 누락이 타입을 통과하고 실행에서만 실패하던 문제를 컴파일 단계로 옮겼다(`test/standard-types.ts`).

## 기각안

| 안 | 이유 |
|---|---|
| `sealed.search` 콜백 규칙 완화 | 커서 페이지 넘김의 정확성 검사가 사라진다. 조건을 분리하는 편이 근본적이다 |
| JOIN 도우미·AST 검사·검증 표시 | 표현력을 가리거나 누락을 증명하지 못한다(계획 002 검토, 원본은 로컬 기록) |
| DB 타입으로 암호 칼럼의 LIKE·정렬 차단 | 관리형 DB 권한·드라이버 문제로 불가(실측) |

## 대체 관계

- 대체하는 것: 없음. 013의 공개 API에 추가한다.

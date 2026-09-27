# 013. Drizzle 네이티브 API 구현 완료

- 상태: 구현 완료 (2026-09-27). 이전 계획 문서(§10 실행 가능성 점검 포함)를 이 기록으로 요약하고 `plan/`에서 지운다.
- 코드: [`src/adapters/drizzle/v0.45/`](../../src/adapters/drizzle/v0.45/). 사용법: [`docs/llm-integration.md`](../llm-integration.md), [`examples/`](../../examples/).

## 결정

공개 API는 다음으로 출시됐다: `createSealed({ sealer })`, 칸마다 옵션을 붙이는 필드 빌더(`sealed.text/integer/bigint/decimal/boolean/instant/json/bytes`), 테이블 등록 `sealed.register(table, { row, scope?, model? })`(반환값은 companion `pgTable`이며 부모와 함께 drizzle-kit에 export), 관리형 쓰기 `sealed.insert/update/upsert`, 읽기 `sealed.open/openRaw`, 검색·집계 `sealed.findMany/count/search`, 관리 도구 `sealed.reindex`. 조회·조건·JOIN·관계형 조회·트랜잭션·삭제·일반 칸 수정은 평범한 Drizzle 그대로다. 암호문 형식, AAD 결속, 토큰 계산(16비트, 건너뛴 조각 기본 켬), 재확인 필수는 그대로 유지됐다.

구현 중 이전 계획 문서의 초안과 다르거나 더 구체화된 결정은 다음과 같다.

1. **Companion 테이블은 `(scope_id, row_id)` 복합 기본키 대신 unique index**를 쓴다(`native.ts`의 `<companion>_scope_row_uq`). drizzle-kit 0.31이 `push`마다 복합 PK의 칸 순서를 다르게 읽어 매번 PK를 재생성했다. unique index는 조회·충돌 대상 면에서 물리적으로 동일하고 push가 안정적이다.
2. **`sealed.search`는 최상위 `columns` 매핑(옵션)을 match 키마다 받는다.** 원시 `db.execute` 행을 위한 것으로 `openRaw`와 같은 규칙(행 식별·scope·암호 칸 이름 매핑)을 따른다. `findMany`의 `columns`(투영, Boolean 선택)와는 뜻이 다르다.
3. **옛 API 삭제는 한 번에 했다.** `defineSealed`/`bindSealed`/`forScope`/`searchWithQuery`, `revision` 칸, raw PostgreSQL 진입점(`sealql/postgres`)은 새 경로가 기존 기능을 완전히 대체할 수 있게 된 시점에 함께 삭제했다(단계적 병행 없음).
4. **`package.json`의 `exports`에 `require`/`default` 조건, `engines.node >= 22.12`를 추가했다.** drizzle-kit이 사용자 스키마 파일을 CommonJS 로더로 읽기 때문에 필요했다.
5. **관리형 쓰기 입력은 `undefined` 속성을 생략된 것으로 취급한다**(Drizzle과 동일한 동작).
6. **Text 행 ID(`sealed.textId`)는 평범한 `text` 칸으로 선언한다.** 정렬·keyset은 DB 칸의 collation을 그대로 따르고, SQL에는 `COLLATE`를 붙이지 않는다. 비교·정렬 SQL에 `COLLATE "C"`를 붙이는 초기 접근은 색인 미사용(Seq Scan/전체 Sort, 아래 근거)이 확인되어 되돌렸다. JS 쪽 "위치 엄격 증가" 검사는 uuid·integer 위치에 그대로 적용하고, text 위치는 "호출 안에서 위치 반복 없음" 검사로 바꿨다(DB collation을 JS가 재현할 수 없으므로).
7. **`sealed.search`의 커서 위치 순서 = match에 사용자가 적은 키의 순서**(그 다음 keyset 칸). 이전 계획 초안은 "키 이름순"을 정했으나, 이는 JOIN 결과 전체를 정렬시켰다(아래 근거). 사용자는 주 테이블(행이 늘어나는 쪽/페이지 기준 테이블)을 먼저 적어야 한다.
8. **한 `search` 호출에서 scope 있는 테이블과 scope 없는(고정 `_`) 테이블을 섞어 매칭하는 것은 지원하지 않는다**(문서화, `docs/llm-integration.md`).

## 근거

- **V1 정확성** ([보고서](../../bench/results/2026-09-27-native-verification/v1/report-ko.md)): 시드 21027, 원본 10만 행 대상 무작위 검색·count 2,664회 시도 중 1,000개 검증 통과. 넓은 커서 전체 순회 `address.contains('세종대로')` 16,574행/448페이지, `company.contains('서울서비스')` 30,101행/814페이지가 끝까지 평문과 일치했다. 관리형 쓰기와 동시 수정(같은 행 같은/다른 필드 update, update 대 delete, reindex 대 update)에서 재계산 토큰과 보조 테이블 토큰 배열 차이 0건.
- **V2 보안** ([보고서](../../bench/results/2026-09-27-native-verification/v2/report-ko.md)): 고객 10,000행 × 6개 필드 × exact/substring 프로필의 보조 토큰을 공개 `searchPieces`/`searchTokens`로 재계산해 누락 0개·추가 0개(토큰 동일성). 상수 scope(`_`) 메모 40,000행 덤프의 기계적 공격은 원문 10%+일관성 조건에서 조각 해독 48.31%, "모르는 행 80%+" 19.30%로, 옛 엔진 기록(48.92%)과 같은 수준의 누출을 재현했다(모델 ID·scope·HMAC 충돌 배치가 달라 개선·악화로 분리 불가).
- **V3 성능** ([보고서](../../bench/results/2026-09-27-native-verification/v3/report-ko.md)): 21개 검색 중 판정 대상 14개 중 7개가 평문 SQL 대비 2배 이내, 7개는 초과했다(C 로캘 평문 전체 스캔·단어 필터가 낀 7개는 판정에서 제외). 총 시간은 인증 복호화·재확인 비용으로 판정 대상 사례 대부분에서 평문 대비 약 8~13배였다(사례별 범위 3.06~14.39배). GIN pending list가 425→0(VACUUM 후)로 바뀌며 다섯 사례 시간이 개선됐다(예: `sub_name_suffix` 2.09→1.16ms). 쓰기는 SQL 경계(BEGIN/COMMIT 포함 여부)를 옛 엔진과 맞추면 동급이다(데이터 SQL 중앙값 insert 657.97ms 대 옛 엔진 664.63ms, update 566.48ms 대 547.73ms).
- **JOIN 위치 순서 수정** (V3 보고서 "JOIN 결함과 재검증"): `join_broad`는 수정 전 네이티브 SQL 중앙값 56.26ms(tickets 10만 행 Seq Scan→Sort→Merge Join), 수정 후 2.30ms(전체 15.31ms), 옛 엔진 기록값은 SQL 2.47ms(전체 28.45ms)다. 수정 커밋은 `f0d28e1`(match 기재 순서로 정렬 위치 변경).
- **text COLLATE 되돌림**: 20만 행 text PK EXPLAIN 실측에서 `COLLATE "C"` 없이는 `id = $1`, `id > $1 order by id limit 20`이 Index Scan이던 것이 `COLLATE "C"`를 붙이면 각각 Seq Scan, 전체 Sort로 바뀜을 확인했다(원 측정 파일은 커밋되지 않는 로컬 작업 파일이라 수치만 보존).
- exports/engines 변경(`43e5836`)은 drizzle-kit 0.31의 CommonJS 스키마 로더 실패를 고친 동작 확인이며 별도 수치 측정은 없다.

## 기각안

| 안 | 기각 이유 |
|---|---|
| Companion `(scope_id,row_id)` 복합 기본키 | drizzle-kit 0.31 `push`가 칸 순서를 비결정적으로 읽어 매번 PK를 재생성함. unique index로 대체 |
| 비교·정렬 SQL에 `COLLATE "C"` 강제 | 식 collation과 색인 collation 불일치로 색인 미사용(Seq Scan/전체 Sort 확인). DB 칸 collation을 그대로 따르는 안으로 되돌림 |
| `search` 위치 순서 = match 키 이름순 | JOIN 결과 전체를 Sort시킴(56.26ms → 2.30ms로 개선). 사용자가 적은 키 순서로 변경 |
| Companion 기본키를 유지하고 drizzle-kit push 드리프트를 알려진 한계로만 문서화 | 원인(복합 PK 자체)을 없앨 수 있었다. 사용자 원칙("원인을 없애면 장치도 없앤다")에 따라 임시 봉합 대신 근본 수정을 택함 |

## 대체 관계

- [012](012-drizzle-companion-and-column-options.md)의 "구현 전" 상태를 이 기록으로 구현 완료로 확정한다.
- [008](008-drizzle-integration.md)의 채택 부분(현재 `sealql/drizzle/v0.45`의 companion 테이블 설계, 옛 `defineSealed`/`bindSealed`/`forScope`/`searchWithQuery` 대체)을 이 기록으로 구현 완료로 확정한다.
- 대체하는 계획: 옛 Drizzle 네이티브 API 계획 001(§10 실행 가능성 점검 포함) 전체. 계획 문서는 이 기록 발행 후 삭제됐다.
- 관련: [003](003-field-cipher-key-cache-aad.md), [006](006-query-engine.md), [007](007-multicolumn-gin-not-combined-array.md), [009](009-scope-and-non-goals.md), [010](010-security-claim-limits.md).

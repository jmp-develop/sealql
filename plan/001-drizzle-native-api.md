# 001. Drizzle 네이티브 API 구현 지시서 (방향 1, 개정 3)

- 작성일: 2026-09-27 (개정 2: 설계 재검증과 G0 실측 반영, 개정 3: 게이트 X1·X2 반영)
- 상태: 설계 확정, 구현 전 (게이트 X1·X2 `bench/results/2026-09-27-gate-x1x2/`). 구현자용 지시서. 결정 요약은 [decisions/008](../docs/decisions/008-drizzle-integration.md).
- 대체 (구현 후):
  - 현재 `sealql/drizzle/v0.45` API(`defineSealed`/`bindSealed`/`forScope`/`searchWithQuery`)
  - companion 테이블
- 근거:
  - [decisions/008](../docs/decisions/008-drizzle-integration.md): 연구 가설 H1–H7과 반증 실험 E1–E7
  - `bench/results/2026-09-27-g0-token-placement/`: 선언된 부모 토큰 칸은 `select *` +616%
  - 설계 재검증 실험: [`bench/drizzle-design/`](../bench/drizzle-design/)의 tsc 타입 실험(`proto.ts`, `use.ts`, `tsc -p bench/drizzle-design`), drizzle-kit generate 실험(`kit*.ts`, `cfg*.ts`), 트리거 초안(`b-trigger-sketch.sql`)

## 0. 목표와 사용자 요구 (재논의 금지)

1. **Drizzle 문법을 그대로 쓴다.** 앱은 `db.insert/update/select/query/transaction/execute`를 평소처럼 쓴다.
   - SealQL은 데이터가 들어가는 지점(`seal`, `patch`)과 나오는 지점(`open`)에만 비동기 도우미 한 겹을 제공한다.
   - 암호화 필드 검색과 count만 전용 호출(`findMany`, `count`, `search`)로 한다.
2. **보안은 지금과 같거나 더 강해야 한다.** 편의를 위해 보안을 낮추는 선택은 금지다.
   - 암호문 형식, AAD(모델, 필드, 코덱, 키 범위, scope, 행 식별값), 토큰 값 계산, 16비트, 건너뛴 조각 기본 켬, 재확인 필수는 **바꾸지 않는다.**
3. **암호화는 일부 테이블의 일부 필드에만 적용된다.**
   - 암호화 테이블이 아닌 테이블과 쿼리에는 제약, 부가 비용, 래핑이 없어야 한다.
   - `drizzle()` 인스턴스와 드라이버를 감싸지 않는다.
4. 원시 SQL과 복잡한 JOIN을 지원한다.
5. **출시 후 공개 사용 방식이 바뀌지 않아야 한다.** §2가 계약이다. 이후 변경은 내부 구현이나 추가만 허용한다. 옵션 인자는 처음부터 객체로 둔다.
6. Drizzle 버전 민감도를 낮춘다. §6의 의존 목록 밖의 Drizzle API는 쓰지 않는다. 버전별 코드는 `src/adapters/drizzle/v0.45/` 안에만 둔다.
7. Node와 Cloudflare Workers에서 동작해야 한다(WebCrypto).

## 1. 확정된 사실 (다시 조사하지 말 것)

| 사실 | 근거 |
|---|---|
| Drizzle 공식 훅 없음. `customType`은 동기이고 값 하나만 받음 | 소스 대조, 문서 전수 조사 |
| `customType` 변환은 insert, update, where, returning, select, 부분 선택, join, 관계형 중첩, prepared, 트랜잭션에 적용되고 `db.execute` 원시 결과에는 적용 안 됨 | 소스, E2 |
| `like`/`ilike`는 `toDriver`와 타입 검사를 모두 통과함(bytea LIKE는 조용히 0건) | 소스, tsc 실험 |
| Drizzle `select()`와 관계형 쿼리는 **선언된 칸만** 명시 목록으로 조회함 | 설계 재검증 실험 |
| 선언된 부모 토큰 칸은 `select *`를 0.51 → 3.67 ms로 만듦. 부모 토큰 검색 SQL은 companion보다 30~40% 빠르고, 쓰기도 더 빠름(insert 630 → 445 ms/1,000건) | G0 |
| companion + 트리거는 `ON CONFLICT DO NOTHING`에서 조용한 불일치가 남음 | 설계 재검증 분석 |
| drizzle-kit: 같은 이름 `pgTable` 두 개는 경고 없이 하나로 덮어씀. 선언 안 된 칸을 커스텀 마이그레이션으로 만든 뒤 `generate`는 "변경 없음"으로 안전함. `push`는 선언 안 된 칸과 색인을 지우려 함(빈 테이블이나 `--force`면 확인 없이). 트리거와 함수는 만들지도 지우지도 않음 | kit generate 실험, `pgSuggestions` 소스 |
| 브랜드 타입 `Sealed<T>`로 평문 insert, 암호 칸 `eq`, `open` 누락이 컴파일 오류가 됨. `seal` 결과는 `values`, 배열 `values`, `onConflictDoUpdate({ set })`, `update().set()`에 들어감 | tsc 실험 (`bench/drizzle-design/proto.ts`, `use.ts`) |
| 구조 기반 `Opened<R>` 타입이 전체·부분 선택, `{c,o}` JOIN, LEFT JOIN, 관계형 `with`(단수·복수) 결과 모두에서 맞음 | tsc 실험 |

## 2. 공개 API 계약

### 2.1 선언

```ts
import { createSealer } from 'sealql';
import { sealedTable, sealTextId, createSealed } from 'sealql/drizzle/v0.45';

export const customerSeal = sealedTable('customers', {  // 모델 ID: AAD·키 범위에 쓰이며 불변. 한 모델 ID는 한 테이블에만 등록 가능
  row:   { key: 'id', column: 'id' },                  // 행 식별 칸: 속성명과 DB 칸 이름을 명시. uuid 또는 sealTextId(text COLLATE "C")
  scope: { key: 'tenantId', column: 'tenant_id' },     // 선택. 없으면 테이블 전역 상수 scope
  fields: {
    name:  { type: 'text', search: { exact: true, substring: true } },   // DB 칸 이름 기본값은 '<key>_ct'. column으로 바꿀 수 있음
    memo:  { type: 'text', nullable: true, search: { substring: true } },
    birth: { type: 'text' },
    score: { type: 'integer', search: { exact: true } },
  },
});

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  status: text('status').notNull(),
  ...customerSeal.columns,              // 암호문 칸만(bytea). 토큰 칸은 Drizzle에 선언하지 않음
}, t => [...customerSeal.indexes(t)]);  // unique(scope, row)만. 토큰 칸 색인은 마이그레이션 SQL로 만듦

const sealer = createSealer({ key: rootKey, models: { customers: { key: tableKey } } });
export const sealed = createSealed({ sealer });
```

- `customerSeal.migrationSql()`는 커스텀 마이그레이션 SQL을 돌려준다. 포함 내용:
  - 숨은 토큰 칸
  - 부분 검색 칸 전체의 다중 컬럼 GIN
  - 정확 일치 B-tree
  - 통계 목표
  - 쓰기 트리거와 함수(§3)
  - 함수 COMMENT의 정의 지문

  문서화할 절차: `drizzle-kit generate` → `drizzle-kit generate --custom`에 이 SQL을 붙임 → `migrate`.
- **암호화 테이블이 있는 데이터베이스에는 drizzle-kit `push`/`pull`을 쓰지 않는다.** `generate` + `migrate`만 지원한다. X1에서 `tablesFilter`와 `schemaFilter`로 제외해도 `push --force`가 스키마 삭제를 시도했으므로 제외 설정을 안내하지 않는다. 문서에 명시한다.
- 암호문 칸의 Drizzle 데이터 타입은 **불투명 클래스 `Sealed<T>`**다. `Uint8Array`가 아니다.
  - `toDriver`는 `Sealed`의 쓰기 봉투만 받고 그 밖에는 `SEAL_REQUIRED` 예외를 낸다.
  - `fromDriver`는 bytea와 관계형 JSON의 hex 문자열을 모두 받아 `Sealed`를 만든다. 값에 (정의, 필드)가 붙어 있다.
  - `toJSON`은 예외를 낸다(평문처럼 직렬화되는 실수 방지).
- 정수 자동 증가 PK만 있는 테이블은 uuid 칸을 추가해 `row`로 지정한다(문서 예시).
  - 앱이 만드는 bigint 행 식별값 허용은 추후 추가 기능으로 둔다.
  - `publicBounds`, `orderable` 설정은 없앤다. 런타임 타입 검사와 `resultBytes` 예산으로 대신한다.

### 2.2 쓰기

```ts
await db.insert(customers).values(await sealed.seal(customers, { id, tenantId, status: 'active', name: '김민수', memo: '배송 요청' }));
await db.insert(customers).values(await sealed.seal(customers, rows));        // 배열
const v = await sealed.seal(customers, row);
await db.insert(customers).values(v).onConflictDoUpdate({ target: [customers.tenantId, customers.id], set: v }); // 단건 upsert. target은 반드시 (scope,row)
await db.update(customers)
  .set(await sealed.patch(customers, { memo: '반품 요청', status: 'hold' }, { id, tenantId }))
  .where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)));
await db.transaction(async tx => { await tx.insert(customers).values(await sealed.seal(customers, row)); });
```

- `seal`: `row` 값이 없으면 uuid(또는 같은 형식의 무작위 text)를 만들어 채운다. 암호화 필드는 **쓰기 봉투**(§3)를 담은 `Sealed`로 바꾸고, 일반 칸은 그대로 둔다.
- `patch`: 바뀐 암호화 필드만 쓰기 봉투로 만든다. 일반 칸은 통과시킨다. null이면 null이다. 행 식별 칸과 scope 칸의 변경은 거부한다.
- 한 문장으로 끝나므로 원자적이다. 행 불일치(where가 봉투와 다른 행을 맞춤), 여러 행에 대한 update, 봉투 없는 값은 트리거가 오류로 거부한다(§3). where가 아무 행도 맞추지 않으면 트리거가 돌지 않고 0행 수정으로 끝난다. 평범한 Drizzle update와 같은 동작이며 쓰인 것이 없으므로 불일치도 없다(X1). 문서화한다.
- 배치 upsert에서 `set: { col: sql\`excluded.col\` }` 형태는 v1에서 지원하지 않는다. 트리거가 SQL02로 거부한다. 문서화한다.

### 2.3 읽기

```ts
const rows   = await sealed.open(await db.select().from(customers).where(eq(customers.status, 'active')));
const part   = await sealed.open(await db.select({ id: customers.id, tenantId: customers.tenantId, memo: customers.memo }).from(customers));
const joined = await sealed.open(await db.select({ c: customers, o: orders }).from(customers).leftJoin(orders, eq(orders.customerId, customers.id)));
const nested = await sealed.open(await db.query.customers.findMany({ with: { orders: true } }));
const raw    = await sealed.openRaw(customers, (await db.execute(sql`select id, tenant_id, memo_ct from customers ...`)).rows,
  { columns: { id: 'id', tenantId: 'tenant_id', memo: 'memo_ct' } });
// 선택 옵션(처음부터 객체): sealed.open(rows, { scope?: 기대 scope, budgets?: { maxRows, maxBytes, deadlineMs, concurrency } })
```

- `open`은 **결과 구조를 훑는다.** 배열과 일반 객체만 재귀한다.
  - `Sealed` 값을 만나면, 그 값을 담은 객체에서 정의의 `row.key`와 `scope.key` 값을 읽어 AAD를 검증한 뒤 복호화한다.
  - 행 식별값이나 scope가 없으면 `ROW_CONTEXT_MISSING`으로 실패한다. 값이 틀리면 AAD 실패다. 잘못된 행으로 복호화되는 일은 없다.
  - `options.scope`가 있으면 결과 행의 scope가 일치하는지도 검사한다.
- 관계 설정(`relations()`) 메타데이터는 쓰지 않는다.
- 반환 타입은 `Opened<R>`다(`Sealed<T>`를 `T`로 바꿈). `open`을 빼먹으면 컴파일 오류가 난다.
- 예산: 현재 `decryptRows`의 행 수, 바이트, 시간 상한을 옵션으로 둔다. Workers의 CPU 한도 관리에 쓴다.

### 2.4 검색·count

```ts
const page = await sealed.findMany(db, customers, {
  scope: tenantId,                                  // scope 있는 테이블은 필수. 토큰이 scope마다 다름
  match: m => m.and(m.memo.contains('배송'), m.or(m.name.startsWith('김'), m.sql(eq(customers.status, 'vip')))),
  where: eq(customers.status, 'active'),            // 선택: 일반 칸 AND 조건
  columns: { id: true, name: true, memo: true },    // 선택
  orderBy: { column: customers.createdAt, direction: 'desc' },   // 선택: 기본은 행 식별값 오름차순 keyset. 일반 칸만 가능
  limit: 20, cursor,
});   // → { items: Opened 행[], nextCursor: string | null }

const total = await sealed.count(db, customers, { scope: tenantId, match, where, maxCandidates: 20000 });

const page2 = await sealed.search(db, {
  scope: tenantId,
  match: { c: [customers, m => m.memo.contains('배송')], o: [orders, m => m.note.contains('파손')] },
  limit: 20, cursor,
  query: ({ where, after, orderBy, flags, limit }) =>
    db.select({ c: customers, o: orders, ...flags }).from(customers)
      .innerJoin(orders, eq(orders.customerId, customers.id))
      .where(and(where, after)).orderBy(...orderBy).limit(limit),
});
```

- `match` 연산: `eq`, `contains`, `startsWith`, `endsWith`, `like`, `contains(v, { respectWords: true })`, `and`, `or`, `m.sql(cond)`. `not`은 제공하지 않는다.
- `m.sql`:
  - AND로만 쓰이면 플래그 없이 WHERE로 내려보낸다.
  - OR 안에 있으면 후보 SQL에 OR로 넣고, `coalesce((cond), false)`를 불리언 플래그 칸으로 받아 재확인에 쓴다.
  - OR이 있으면 256행 prefix 경로를 끈다.
  - OR 속 일반 조건에 색인이 없으면 scope 전체를 훑을 수 있다. 문서화한다.
- `search`:
  - keyset은 **match에 쓴 모든 테이블의 행 식별값 튜플**이다. 라이브러리가 `after`, `orderBy`, `flags` 조각을 제공하고, 앱은 그대로 넣는다.
  - 결과를 검증한다: 행 수가 limit 이하인지, 위치가 엄격히 증가하는지, 각 match 키 객체에 행 식별값·scope(= 요청 scope)·조건 필드가 있는지. 어긋나면 `INVALID_CANDIDATE_SHAPE`다.
  - `where`를 빠뜨리면 느려질 뿐 결과는 정확하다.
  - 여러 테이블 조건은 AND다. 테이블을 넘나드는 OR이 필요하면 구현 전에 사용자에게 묻는다.
  - 원시 SQL도 받는다. 결과 칸 매핑은 `openRaw`와 같은 형식이다.
- 결과는 항상 재확인 후이고, 페이지가 모자라면 채운다. count는 정확한 `number`이고 예산을 넘으면 오류다.

## 3. 저장 구조: 부모 테이블의 미선언 토큰 칸 + 쓰기 트리거

- 검색 토큰은 **암호화 테이블 자신의 칸**에 두되, **Drizzle 테이블 정의에는 선언하지 않는다.** 그래서 Drizzle 조회에 딸려 오지 않는다. companion 테이블은 없앤다.
- **쓰기 봉투** (`seal`/`patch`가 만드는 값): `[0x84][u16 scope 길이][scope utf8][u16 row 길이][row utf8][u8 필드 번호][프로필별: u32 길이 + '{t1,t2,…}' 배열 리터럴][저장용 v3 봉투]`
  - 저장용 v3 봉투의 형식과 AAD는 지금과 같다.
- **BEFORE 트리거 규칙** (테이블마다 생성, 초안 `bench/drizzle-design/b-trigger-sketch.sql`):
  1. scope나 row 값이 바뀌면 `SQL01`.
  2. 암호문 칸이 바뀌었는데 봉투가 없으면 `SQL02`.
     - 허용 예외 1: INSERT에 토큰이 함께 실려 오는 경우(COPY·데이터 복원).
     - 허용 예외 2: UPDATE에서 토큰 칸이 함께 바뀌는 경우(명시적 재색인).
     - 두 예외는 트랜잭션·세션 설정 `sealql.allow_raw_tokens = on`일 때만 허용한다(`set_config(..., true)` 또는 `PGOPTIONS`). 설정이 없으면 `SQL02`다. 실수로 우회하는 경로를 막기 위해서다. `reindex` 도구와 데이터 전용 복원 절차가 이 설정을 쓴다.
  3. 봉투의 scope, row, 필드 번호가 `NEW`와 다르면 `SQL03`.
  4. 맞으면 토큰 칸을 채우고, 암호문 칸에는 v3 봉투만 남긴다.
  5. 트리거는 `BEFORE INSERT OR UPDATE OF <암호문 칸들>, scope, row`로 건다. 일반 칸만 바꾸는 update에는 트리거 비용이 없다.
  6. 전체 복원(pg_restore)은 트리거가 데이터 적재 뒤에 만들어지므로 영향이 없다.
- 오류 코드(SealError 코드와 SQLSTATE `SQL01`~`SQL03`)를 문서화한다.
- 검색 엔진은 companion semi-join 대신 부모 테이블의 토큰 칸을 직접 조건으로 쓴다.
  - 경로 선택: 정확 일치만 있는 조건은 토큰 칸 직접 조회(X2: 0.28~0.32 ms). 부분 검색이 있는 조건은 기존 정책대로 256행 prefix 후 GIN fallback(X2: 직접 조회는 `sub_mid`, `ends`, `word_boundary`류에서 38~66 ms로 나빠지고, prefix는 0.54~2.13 ms). 후보 묶음 확대, count 배치는 유지한다. prefix 경로에는 unique(scope,row) 색인을 쓴다.
  - SQL의 칸 이름은 정의에 명시한 DB 이름만 쓴다(`casing` 옵션과 무관하게).
- `revision` 칸 요구를 없앤다(AAD에 없었음). scope가 없는 테이블은 고정 상수 scope를 쓴다.
- **재색인·백필 도구**를 제공한다(`sealed.reindex(db, table, { scope?, batch })`). 토큰 칸이 사라지거나 새 검색 필드를 추가했을 때 복구하는 데 쓴다.
- `sealed.checkSchema(db, table)`: 트리거 함수 COMMENT의 정의 지문을 대조해, 코드와 DB 트리거가 어긋났는지 알려 준다(시작 시 1회, 선택).

### 게이트 결과 (2026-09-27, `bench/results/2026-09-27-gate-x1x2/report-ko.md`)

- X1: 쓰기·upsert 5종·롤백·savepoint·행/scope 변경 거부 확인. 0행 patch는 무동작(위 규칙). `excluded` upsert는 SQL02. `generate` 안전, `push` 제외 설정은 반박(위 규칙). 실제 COPY 프로토콜은 P6에서 `sealql.allow_raw_tokens`와 함께 확인한다.
- X2: 1,000건 insert 0.84×, patch 0.62×, delete 0.56×(companion 대비). 검색은 위 경로 선택 기준으로 V3와 같거나 빠르고, `sub_long`(4.90 vs 4.66 ms)과 `and6`(9.33 vs 8.98 ms)만 약 5% 느리다. 이 수치는 후보 SQL만 잰 것이므로 P6에서 제품 전체 경로로 다시 판정한다.

### 게이트 항목 (기록)

- **X1 정합성:**
  - 단건 insert, 배열 insert, patch(값 / null)
  - 봉투 없는 쓰기 → SQL02. patch의 where가 다른 행이거나 여러 행 update → SQL03. id·tenant 변경 → SQL01
  - upsert: target (tenant,id)의 `set: v`, `DO NOTHING`, 조건 거짓 `DO UPDATE`, `excluded` 사용, id만 target으로 한 교차 테넌트 경우
  - `UPDATE OF`가 upsert의 SET에도 적용되는지
  - 일반 칸 update에서 트리거 호출이 0회인지(`pg_stat_user_functions`)
  - COPY 복원, 롤백, savepoint
  - drizzle-kit: 선언 안 된 칸이 있는 상태에서 `generate`
- **X2 성능:** G0와 같은 조건(10만 행 fixture에서 파생, 예열 2회, 교차 7회).
  - 1,000건 insert, patch, delete를 트리거 있음·없음으로 비교
  - 100행 배열 insert
  - 21개 검색 케이스를 부모 토큰 칸 기준으로 측정(prefix 경로 포함)
  - `select *`와 일반 조회가 암호화 없는 같은 테이블과 차이 없는지
  - 기준: 검색 SQL은 V3 이하. 쓰기는 현재 구조(companion) 이하 목표. 넘으면 보고한다.

## 4. 작업 순서 (단계마다 커밋)

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| P1 | 트리거와 쓰기 봉투, 저장 구조 전환, 엔진이 부모 토큰 칸을 쓰도록 변경, `revision` 제거, scope 선택화, 명시 칸 이름 | 엔진 테스트를 새 구조로 옮겨 통과 |
| P2 | `sealedTable`, `createSealed`, `seal`, `patch`, `open`(구조 기반), `openRaw`, `Sealed` 클래스, 타입 | 타입 테스트: 평문 insert, 암호 칸 `eq`, `open` 누락이 컴파일 오류(`@ts-expect-error` 목록). `like` 구멍은 문서화. §2.2와 §2.3 예제가 통합 테스트로 통과 |
| P3 | `findMany`, `count`, `search`, `m.sql` | 평문과 결과 일치. 일반 칸 OR과 1:N JOIN을 포함한 통합 테스트 |
| P4 | `migrationSql`, `checkSchema`, `reindex`, 옛 API와 companion 코드 삭제, raw PostgreSQL 진입점(`sealql/postgres`)을 같은 개념으로 최소 제공 | `check`, 설치 검사 통과 |
| P5 | 문서: API 계약, 실수 방지, `like` 주의, 마이그레이션 절차, push/pull 미지원과 `tablesFilter`, 행 식별·scope 규칙, upsert 규칙, 오류 코드, 어휘가 적은 필드는 부분 검색 비권장 ([V2 결과](../bench/results/2026-09-27-core-verification/v2/report-ko.md)) | `docs:check` 통과 |
| P6 | 검증(§5) | |

## 5. 검증 기준

- **정확성:** `bench/verify-core/` 방식으로 새 구조의 10만 행 fixture를 검증한다(원본에서 파생, 새 데이터 생성 없음). 무작위 질의 1,000개, 넓은 검색의 전체 커서 순회, count, `m.sql` OR, JOIN `search`, 관계형 `open`이 평문과 일치해야 한다.
- **무결성:**
  - 다른 행·scope로 옮긴 암호문, 변조, 틀린 키 → `open`과 검색에서 거부
  - 행 식별 칸이 빠진 결과 → 오류
  - X1 항목 전부
- **쓰기:** insert, 배열, upsert, patch, 트랜잭션 롤백 뒤 검색 정합성
- **성능:** [V3](../bench/results/2026-09-27-core-verification/v3/report-ko.md)와 같은 조건으로, 평문과 V3 대비 검색 SQL과 전체 시간을 잰다. 암호화 없는 테이블과 쿼리에 부가 비용이 없는지 확인한다.
- **보안:** 토큰 값이 바뀌지 않았음을 확인한다(같은 행의 토큰 배열 동일). 공격 시뮬레이션은 기존 결과를 인용한다.
- `build`, `check`, `test`, `docs:check`.

## 6. Drizzle 의존 목록 (이 밖은 쓰지 않음)

| API | 상태 |
|---|---|
| `customType`의 `toDriver`/`fromDriver` | 공개·안정. 1.0에서는 `fromJson` 추가 필요 |
| `getTableColumns`, `getTableName`, `getTableConfig`, `sql`, `and`, `eq`, `is(x, SQL)`, `uniqueIndex().on` | 공개 |
| 쿼리 빌더(select/from/where/orderBy/limit), `db.execute`(드라이버별 반환 형태 정규화) | 공개 |
| `InferInsertModel`, `InferSelectModel`, `PgTable`, `PgColumn` 타입 | 공개 |
| `PgDialect.sqlToQuery`(where 지문) | 반쯤 내부. 실패하면 커서 결속만 약해지도록 격리 |

1.0 대응 때 버전별로 달라지는 부분: 칸 팩토리, 정의 조회, `db` 구조 타입, `fromJson`. 봉투, 트리거 SQL, 엔진은 버전과 무관하다.

## 7. 작업 원칙

- 일회용 DB `127.0.0.1:56439`만 쓴다. `assertDisposable`을 호출한다. 원본 fixture는 읽기만 한다. 커밋은 `git commit -- <자기 경로>`로 자기 파일만 한다.
- 최소 코드로 구현한다. 대체된 코드는 삭제한다. 가상의 확장점을 만들지 않는다.
- §2의 모양을 바꾸거나, §0-2(보안)에 영향이 있거나, 게이트 기준에 걸리면 **구현 전에** 사용자에게 묻는다. 그 밖의 내부 결정은 구현자가 한다.

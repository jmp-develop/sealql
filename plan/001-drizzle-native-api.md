# 001. Drizzle 네이티브 API 구현 계획

- 작성일: 2026-09-27 (개정 4: 사용자 결정 반영. 검색 목록은 별도 보조 테이블 유지, 스키마는 칸마다 옵션)
- 상태: 확정 계획. 구현자가 이 문서만 보고 구현할 수 있어야 한다.
- 근거:
  - [결정 008](../docs/decisions/008-drizzle-integration.md): Drizzle 연구, 반증 실험, 부모 테이블 토큰 안의 G0·X1·X2 실측
  - `bench/drizzle-design/`: 브랜드 타입과 `open` 결과 타입 실험
  - `.local/schema-shape/`: 칸마다 옵션 모양의 타입 실험. 결과는 §8에 적는다
- 대체: 현재 `sealql/drizzle/v0.45` API(`defineSealed`/`bindSealed`/`forScope`/`searchWithQuery`)

## 0. 사용자 요구 (재논의 금지)

1. **Drizzle 문법을 그대로 쓴다.** 조회, 조건, 정렬, JOIN, 관계형 조회, 트랜잭션, 삭제, 일반 칸 수정은 평범한 Drizzle과 똑같다. 암호화 필드가 끼는 **저장·수정**과 **결과 열기**, **암호화 필드 검색**에만 SealQL 함수를 쓴다.
2. **보안은 지금과 같다.** 암호문 형식, AAD(모델, 필드, 코덱, 키 범위, scope, 행 식별값), 토큰 계산(16비트, 건너뛴 조각 기본 켬), 재확인 필수를 바꾸지 않는다. 편의를 위해 보안을 낮추지 않는다.
3. **암호화는 일부 테이블의 일부 필드에만 적용된다.** 다른 테이블과 쿼리에는 제약, 부가 비용, 래핑이 없다. `drizzle()` 인스턴스와 드라이버를 감싸지 않는다.
4. **스키마는 칸마다 옵션을 붙이는 모양**이다. 테이블 단위로 추가하는 것은 등록 한 줄뿐이다.
5. 원시 SQL과 복잡한 JOIN을 지원한다.
6. **출시 후 공개 사용 방식이 바뀌지 않는다.** §2가 계약이다. 이후에는 추가만 허용한다. 옵션 인자는 처음부터 객체로 둔다.
7. Drizzle 공개 API만 쓴다(§7). 버전별 코드는 `src/adapters/drizzle/v0.45/`에만 둔다.
8. Node와 Cloudflare Workers(WebCrypto).
9. **검색 목록(토큰)은 지금처럼 별도 보조 테이블(companion)에 둔다.** DB 트리거는 쓰지 않는다. drizzle-kit `generate`/`migrate`와 `push`를 모두 지원한다(사용자 결정, 부모 테이블 숨은 칸 안은 기각).

## 1. 확정된 사실

| 사실 | 근거 |
|---|---|
| Drizzle 공식 훅 없음. `customType`은 동기이고 값 하나만 받음 | 결정 008 |
| `customType` 변환은 insert, update, where, returning, select, 부분 선택, join, 관계형 중첩, 트랜잭션에 적용. `db.execute` 원시 결과에는 미적용 | 결정 008 E2 |
| `like`/`ilike`는 변환과 타입 검사를 모두 통과함(bytea LIKE는 조용히 0건) | 결정 008 |
| Drizzle 조회는 스키마에 선언된 칸 목록으로 SQL을 만든다. 사용자는 칸을 적지 않는다 | 실험 |
| 브랜드 타입 `Sealed<T>`로 평문 insert, 암호 칸 `eq`, `open` 누락을 컴파일 오류로 만들 수 있음. 구조 기반 `Opened<R>` 타입이 전체·부분·JOIN·LEFT JOIN·관계형 결과 모두에서 맞음 | `bench/drizzle-design/` |
| 보조 테이블은 Drizzle 스키마에 선언하면 drizzle-kit이 칸, FK, 색인을 모두 만든다 | 실험 |

## 2. 공개 API 계약

### 2.1 스키마 선언

```ts
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

export const sealed = createSealed({ sealer: createSealer({ key: rootKey, models: { customers: { key: tableKey } } }) });

export const customers = pgTable('customers', {
  id:        uuid('id').primaryKey(),
  tenantId:  uuid('tenant_id').notNull(),
  status:    text('status').notNull(),
  name:      sealed.text('name',  { search: { exact: true, substring: true } }),   // DB 칸 이름 기본값 'name_ct', { column: '...' }로 변경 가능
  phone:     sealed.text('phone', { search: { exact: true } }),
  memo:      sealed.text('memo',  { nullable: true, search: { substring: true } }),  // 부분 검색은 건너뛴 조각 기본 켬
  birth:     sealed.text('birth'),                                                  // 암호화만
  score:     sealed.integer('score', { search: { exact: true } }),
});

// 테이블 등록 한 줄: 행 식별 칸과 테넌트 칸(선택)을 알려 주고, 보조 테이블 정의 겸 "봉인 테이블 핸들"을 돌려받아 export
// 쓰기·검색·재색인 함수에는 이 핸들(customersSeal)을 넘긴다. 조회(select/query)와 삭제·일반 칸 수정은 원래 테이블(customers)을 쓴다.
export const customersSeal = sealed.register(customers, { row: 'id', scope: 'tenantId' });
```

- 필드 빌더: `sealed.text`, `sealed.integer`, `sealed.json` 등 현재 코덱 전부를 지원한다.
  - 옵션: `nullable`, `search`, `column`, `maxBytes`, `id`(AAD용 불변 필드 ID, 기본은 속성명)
- `register(table, { row, scope?, model? })`
  - `row`, `scope`는 그 테이블의 칸 속성명으로 타입이 제한된다.
  - `row` 칸은 uuid 또는 text(`COLLATE "C"`)이고, 앱이 insert 전에 알 수 있어야 한다. 값이 없으면 `sealed.insert`가 uuid를 채운다.
  - `model`은 AAD와 키 범위에 쓰는 모델 ID이고 기본값은 테이블 이름이다. 한 모델 ID는 한 테이블에만 등록할 수 있다.
  - 반환값은 **보조 테이블 `pgTable`**이다. 사용자가 export하면 drizzle-kit이 다음을 모두 생성한다.
    - 칸: `scope_id`, `row_id`, 검색 프로필마다 `bigint[]` 하나
    - `(scope,row)` → 부모 FK, `ON DELETE CASCADE`
    - 부분 검색 칸 전체에 다중 컬럼 GIN 1개
    - 정확 일치 B-tree
  - 통계 목표 상향만 선택적 커스텀 SQL(`sealed.extraMigrationSql(table)`)로 제공한다.
- 암호 칸의 Drizzle 데이터 타입은 **불투명 클래스 `Sealed<T>`**다.
  - `toDriver`는 SealQL 쓰기 함수가 만든 값만 받고, 그 밖에는 `SEAL_REQUIRED` 예외를 낸다.
  - `fromDriver`는 bytea와 관계형 JSON의 hex 문자열을 모두 받아 `Sealed`를 만들고, (등록, 필드)를 기억한다.
  - `toJSON`은 예외를 낸다.
- 정수 자동 증가 PK만 있는 테이블은 uuid 칸을 추가해 `row`로 지정한다. 문서에 예시를 둔다.

### 2.2 쓰기 (암호화 필드가 끼는 경우만 SealQL 함수)

```ts
await sealed.insert(db, customersSeal, { tenantId, status: 'active', name: '김민수', phone: '010-1234-5678', memo: '배송 요청' });
await sealed.insert(db, customersSeal, [row1, row2, row3]);
await sealed.update(db, customersSeal, { id, tenantId }, { memo: '반품 요청', status: 'hold' });   // 암호 칸 + 일반 칸 함께
await sealed.upsert(db, customersSeal, row);            // 충돌 대상은 (scope,row) 고정
await db.transaction(async tx => {
  await sealed.insert(tx, customersSeal, row);
  await tx.insert(orders).values({ customerId: row.id, amount: 3000 });
});

await db.update(customers).set({ status: 'closed' }).where(eq(customers.id, id));   // 일반 칸만: Drizzle 그대로
await db.delete(customers).where(eq(customers.id, id));                             // 삭제: Drizzle 그대로 (보조 테이블은 FK로 함께 삭제)
```

- `insert`, `update`, `upsert`는 부모 행과 보조 테이블 행을 **한 트랜잭션으로** 쓴다. 트랜잭션 안에서 부르면(`tx`) 그 트랜잭션을 쓴다.
  - 반환값: 쓴 행의 `{ id }` 목록. 옵션 `{ returning: true }`면 연 행을 돌려준다.
- `update`는 첫 인자로 행을 지정한다(행 식별값, 테넌트). 바꾼 암호 필드만 재암호화하고, 그 필드의 보조 칸만 갱신한다.
  - 행 식별 칸과 테넌트 칸은 바꿀 수 없다(AAD 결속).
  - 0행이면 `NOT_FOUND`를 던진다.
- 여러 행의 암호 칸을 한 번에 바꾸는 함수는 v1에 두지 않는다(행마다 암호문이 다름). 행별 `update`로 안내하고, 필요하면 추후 추가 함수로 둔다.
- 암호 칸을 원시 SQL로 직접 쓰면 보조 테이블과 어긋날 수 있다(트리거가 없으므로). 문서에 금지로 적고, 재색인 도구(§2.5)로 복구할 수 있게 한다.

### 2.3 읽기 (조회는 Drizzle 그대로, 결과만 연다)

```ts
const list   = await sealed.open(await db.select().from(customers).where(eq(customers.status, 'active')).orderBy(desc(customers.createdAt)).limit(20));
const brief  = await sealed.open(await db.select({ id: customers.id, tenantId: customers.tenantId, name: customers.name }).from(customers));
const joined = await sealed.open(await db.select({ c: customers, o: orders }).from(customers).leftJoin(orders, eq(orders.customerId, customers.id)));
const nested = await sealed.open(await db.query.customers.findMany({ with: { orders: true } }));
const raw    = await sealed.openRaw(customersSeal, (await db.execute(sql`select id, tenant_id, name_ct from customers`)).rows,
                                    { columns: { id: 'id', tenantId: 'tenant_id', name: 'name_ct' } });
// 옵션(처음부터 객체): sealed.open(rows, { scope?, budgets?: { maxRows, maxBytes, deadlineMs, concurrency } })
```

- `open`은 결과 구조를 훑는다(배열과 일반 객체만 재귀). `Sealed` 값을 만나면 그 값을 담은 객체에서 등록된 행 식별 칸과 테넌트 칸 값을 읽어 AAD를 검증하고 복호화한다.
  - 두 칸이 결과에 없으면 `ROW_CONTEXT_MISSING`이다. 부분 선택에서는 이 두 칸을 함께 골라야 한다고 문서화한다.
  - 관계 설정 메타데이터는 쓰지 않는다.
- 반환 타입은 `Opened<R>`(`Sealed<T>`를 `T`로 바꿈)다.
- 보조 테이블은 조회 결과에 섞이지 않는다(별도 테이블).

### 2.4 암호화 필드 검색·count

```ts
const page = await sealed.findMany(db, customersSeal, {
  scope: tenantId,                                   // 테넌트가 있는 테이블은 필수
  match: m => m.and(m.name.startsWith('김'), m.or(m.memo.contains('배송'), m.sql(eq(customers.status, 'vip')))),
  where: eq(customers.status, 'active'),             // 선택: 일반 칸 AND
  columns: { id: true, name: true, memo: true },     // 선택
  orderBy: { column: customers.createdAt, direction: 'desc' },   // 선택, 일반 칸만. 기본은 행 식별값 keyset
  limit: 20, cursor,
});   // { items: 연 행[], nextCursor }
const n = await sealed.count(db, customersSeal, { scope: tenantId, match: m => m.phone.eq('010-1234-5678'), maxCandidates: 20000 });
const page3 = await sealed.search(db, {
  scope: tenantId,
  match: { c: [customersSeal, m => m.memo.contains('파손')] },
  limit: 20, cursor,
  query: ({ where, after, orderBy, flags, limit }) =>
    db.select({ c: customers, o: orders, ...flags }).from(customers)
      .innerJoin(orders, eq(orders.customerId, customers.id))
      .where(and(where, after, gt(orders.amount, 50000))).orderBy(...orderBy).limit(limit),
});
```

- `match` 연산: `eq`, `contains`, `startsWith`, `endsWith`, `like`, `contains(v, { respectWords: true })`, `and`, `or`, `m.sql(cond)`. `not`은 없다.
- `m.sql`:
  - AND로만 쓰이면 WHERE로 내려보낸다.
  - OR 안에 있으면 후보 SQL에 OR로 넣고, `coalesce((cond), false)` 플래그 칸으로 재확인한다. 이때 256행 prefix 경로는 끈다.
  - OR 속 일반 조건에 색인이 없으면 느릴 수 있다. 문서화한다.
- 후보 SQL은 현재 엔진과 같다: 보조 테이블 단일 semi-join, 다중 컬럼 GIN, 256행 prefix, 후보 묶음 확대, count 배치.
- `search`:
  - keyset은 match에 쓴 모든 테이블의 행 식별값 튜플이다. 라이브러리가 `after`, `orderBy`, `flags` 조각을 준다.
  - 결과 검증: limit 이하, 위치 엄격 증가, 각 match 키 객체에 행 식별값·scope(= 요청 scope)·조건 필드가 있는지. 어긋나면 `INVALID_CANDIDATE_SHAPE`.
  - 여러 테이블 조건은 AND다. 원시 SQL 결과도 `openRaw`와 같은 `columns` 매핑으로 받는다.
- 결과는 항상 재확인 후다. 페이지가 모자라면 채운다. count는 정확한 `number`이고 예산을 넘으면 오류다.

### 2.5 관리 도구

- `sealed.reindex(db, table, { scope?, batch })`: 보조 테이블 재생성. 새 검색 필드 추가, 원시 SQL 쓰기 사고 복구, 백필에 쓴다.
- `sealed.verifyIndex(db, table, { sample })`: 보조 테이블이 암호문과 맞는지 표본 점검(선택).

## 3. 엔진 변경 범위

- **유지:** 암호문·AAD·토큰 계산, 보조 테이블 구조(한 행당 한 줄, 칸별 토큰, 다중 컬럼 GIN), 검색 SQL과 최적화, 재확인, count, 커서.
- **변경:**
  - Drizzle 어댑터 전체를 §2로 교체한다.
  - 테이블 요구에서 `revision` 칸을 없앤다. 쓰기는 트랜잭션으로 원자성을 보장한다.
  - scope는 선택으로 바꾼다. 없는 테이블은 고정 상수 scope를 쓴다.
  - SQL에는 등록에 명시된 DB 칸 이름만 쓴다(`casing` 옵션과 무관하게).
  - 옛 API(`defineSealed`, `bindSealed`, `forScope`, `searchWithQuery`, `publicBounds`, `orderable`)를 삭제한다.
  - raw PostgreSQL 진입점(`sealql/postgres`)은 같은 개념(insert/update/open/search 함수와 SQL 조각)으로 최소 제공한다.

## 4. 작업 순서 (단계마다 커밋, 셸은 `rtk`)

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| P1 | 필드 빌더, `register`, `Sealed` 클래스, 타입(§8 실험 결과 반영). 보조 테이블 정의와 drizzle-kit generate | 타입 테스트(`@ts-expect-error` 목록) 통과. kit generate DDL 확인 |
| P2 | `insert`, `update`, `upsert`, `open`, `openRaw`. 엔진의 `revision` 제거, scope 선택화 | §2.2와 §2.3 예제가 통합 테스트로 통과. 트랜잭션 롤백 정합성 |
| P3 | `findMany`, `count`, `search`, `m.sql` | 평문과 결과 일치. 일반 칸 OR과 1:N JOIN 포함 |
| P4 | `reindex`, 옛 API 삭제, `sealql/postgres` 최소 제공 | `check`, 설치 검사 |
| P5 | 문서: `README.md`, `llms.txt`, `docs/llm-integration.md`(API 계약, 실수 방지, `like` 주의, 원시 SQL 쓰기 금지, 부분 선택 시 행 식별·테넌트 칸 포함, 어휘가 적은 필드의 부분 검색 비권장), `docs/current-state.md`, `examples/`. 끝나면 이 계획을 결정 기록으로 요약 | `docs:check` |
| P6 | 검증 V1·V2·V3 ([docs/verification.md](../docs/verification.md)) | 아래 §5 |

## 5. 검증 기준

- **V1 정확성·무결성**
  - 10만 행 fixture를 원본에서 파생해 쓴다.
  - 무작위 질의 1,000개, 넓은 검색의 전체 커서 순회, count, `m.sql` OR, JOIN `search`, 관계형 `open`이 평문과 일치해야 한다.
  - 다른 행·테넌트로 옮긴 암호문, 변조, 틀린 키, 행 식별 칸이 빠진 결과는 거부돼야 한다.
  - insert, 배열, upsert, update(값·null), 트랜잭션 롤백 뒤 검색이 정합해야 한다.
- **V2 보안:** 토큰 값이 바뀌지 않았음을 확인한다(같은 행의 토큰 배열 동일). 공격 시뮬레이션은 기존 결과를 인용한다.
- **V3 성능:** 평문과 V3 기준선 대비 검색 SQL과 전체 시간을 잰다. 암호화 없는 테이블과 쿼리에 부가 비용이 없는지 확인한다.

## 6. 사용자 요구 대조표 (계획 확정 전 점검)

| 요구 | 이 계획 | 판정 |
|---|---|---|
| Drizzle 문법 그대로 | 조회·조건·JOIN·관계형·트랜잭션·삭제·일반 칸 수정은 그대로. 암호 필드 쓰기, 결과 열기, 검색만 함수 | 충족 (함수가 필요한 이유: 보안상 행 전체가 필요하고, 보조 테이블 쓰기가 필요함) |
| 코어 불변 | 암호·토큰·재확인·보조 테이블·검색 SQL 유지 | 충족 |
| 일부 테이블만, 다른 쿼리 제약 없음 | 래핑 없음. 일반 테이블 영향 0 | 충족 |
| 스키마는 칸마다 옵션 | `sealed.text(...)` + 등록 한 줄 | 충족 |
| 원시 SQL·복잡한 JOIN | `openRaw`, `search` 콜백 | 충족 |
| 쿼리 작성에 새 제약 금지 | 부분 선택 시 행 식별·테넌트 칸을 함께 골라야 함 | **제약 1개** (보안상 필수, 문서화) |
| drizzle-kit | generate·migrate·push 모두 가능 | 충족 |
| 보안 유지 | 동일 | 충족 |
| 알려진 구멍 | `like`는 타입 검사 통과, 원시 SQL로 암호 칸을 쓰면 어긋남 | 문서화, 재색인 도구 |

## 7. Drizzle 의존 목록 (이 밖은 쓰지 않음)

- `customType`, `pgTable`, `index().using('gin', …)`, `foreignKey`, `uniqueIndex`
- `getTableColumns`, `getTableName`, `getTableConfig`, `sql`, `and`, `eq`, `is(x, SQL)`
- 쿼리 빌더, `db.transaction`, `db.execute`(드라이버별 결과 형태 정규화)
- 타입: `InferInsertModel`, `InferSelectModel`, `PgTable`, `PgColumn`
- `PgDialect.sqlToQuery`: 반쯤 내부. 실패해도 커서 결속만 약해지게 격리
- 1.0 대응 시 바뀌는 곳: 필드 빌더, 등록 조회, `db` 구조 타입, `fromJson`

## 8. 스키마 모양 타입 실험 결과 (`.local/schema-shape/`, tsc exit 0, drizzle-kit generate 성공)

- **확인됨:**
  - 칸마다 `sealed.text/integer`(브랜드 `Sealed<T>`), `nullable` 제어
  - `register`의 `row`/`scope`를 uuid·text 일반 칸 키로만 제한(암호 칸·없는 키는 컴파일 오류)
  - 평문 `db.insert(customers).values({ name })`와 `eq(customers.name, 'x')`는 컴파일 오류
  - 일반 칸만 쓰는 `db.update(customers).set({ status })`는 허용
  - `open`이 전체·부분·JOIN·관계형(양방향) 결과를 평문 타입으로 바꿈
  - `insert/update/upsert`가 잘못된 타입, 알 수 없는 필드, 필수 필드 누락, patch의 행·테넌트 칸 변경을 컴파일 오류로 잡음
  - drizzle-kit이 보조 테이블(PK, 정확 일치 B-tree, 다중 컬럼 GIN, `(scope,row)` → 부모 FK `ON DELETE CASCADE`)을 생성함
  - 봉인되지 않은 값은 런타임에서 `SEAL_REQUIRED`
- **조정 1:** 쓰기·검색 함수의 테이블 인자는 `register`의 반환값(`customersSeal`)이다. `pgTable`로 확정된 `customers` 타입에 나중에 등록한 행·테넌트 정보를 거슬러 붙일 수 없기 때문이다. 반환 타입에 `{ parent, row, scope }`를 판텀 타입으로 싣고, 런타임은 WeakMap으로 부모 테이블을 찾는다.
- **조정 2 (구현 주의):** `ParentOf<C>`처럼 조건부 타입으로 사후 추출하면 **함수 인자 검사가 조용히 무력화**된다(잘못된 값이 통과). `T`, `R`, `S`를 함수 제네릭으로 두는 방식(`seal: SealMeta<T,R,S> & object`)을 쓴다. 참고 구현: `.local/schema-shape/sealed.ts` 193~229행. 구현자는 이 실험 파일들을 `bench/drizzle-design/schema-shape/`로 옮겨 근거로 남긴다.
- **참고:**
  - 보조 테이블 칸의 TS 타입은 느슨하다(`any` 계열). 사용자가 직접 조회하지 않으므로 허용한다.
  - 생성 DDL에서 bytea 타입명이 `"bytea"`로 따옴표 처리된다. PostgreSQL에서는 유효한지 P1에서 migrate로 확인한다.

## 9. 작업 원칙

- 일회용 DB `127.0.0.1:56439`만 쓰고 `assertDisposable`을 호출한다. 원본 fixture는 읽기만 한다. 커밋은 `git commit -- <자기 경로>`로 자기 파일만 한다.
- 최소 코드. 대체된 코드는 삭제한다. 가상의 확장점을 만들지 않는다.
- §2의 모양을 바꾸거나, 보안에 영향이 있거나, 기준에 걸리면 **구현 전에** 코디네이터에게 묻는다.

## 10. 실행 가능성 점검 반영 (2026-09-27, 앞 절과 충돌하면 이 절이 우선)

코드와 Drizzle 0.45.3을 대조해 모든 항목이 구현 가능함을 확인했다. 아래는 구현자가 새로 정할 것이 없도록 확정한 규칙이다.

1. **부모 제약:** row 칸(scope 없는 테이블) 또는 `(scope,row)`에 이미 PK·unique가 있어야 한다(보통 `id` PK로 충족). 없으면 `INVALID_SCHEMA`.
   - 보조 테이블 FK는 **`row_id → 부모 row`**(`ON DELETE CASCADE`)다. row가 테넌트 안에서만 유일해 부모 PK가 `(scope,row)` 복합이면 복합 FK를 쓴다.
   - `upsert`의 충돌 대상은 row(또는 `(scope,row)`)이고, DO UPDATE에 `where 부모.scope = excluded.scope` 조건을 둔다. 다른 테넌트 행과 충돌해 갱신이 0행이면 `SCOPE_CONFLICT`를 던진다.
   - 사용자가 unique를 추가할 필요는 없다.
2. **search keyset:**
   - 옵션 `keyset?: PgColumn[]`(NOT NULL, uuid·`text COLLATE "C"`·integer·bigint).
   - 위치 = (match 키 이름순 행 식별값…, keyset 칸…).
   - 1:N JOIN은 늘어나는 쪽 테이블의 유일 칸을 keyset에 넣는다. 위치가 반복되면 `INVALID_CANDIDATE_SHAPE`.
   - 커서 payload의 `lastId`는 위치 튜플의 JSON 배열 문자열이다.
   - 커서 `modelId`는 `search:` 뒤에 정렬한 모델 ID들을 `,`로 이은 값이다. 봉인에는 키 이름순 첫 모델의 ring을 쓴다.
   - digest는 scope, match 키와 AST, keyset 칸 이름, limit을 포함한다. 콜백 SQL은 결속하지 않는다(문서화).
3. **scope 없는 테이블:**
   - 상수 scope `'_'`(text)를 AAD, 토큰, 커서에 쓴다.
   - 보조 테이블은 `scope_id text COLLATE "C" NOT NULL DEFAULT '_'`를 유지해 검색 SQL과 색인을 바꾸지 않는다.
   - 이 테이블에 `scope` 옵션을 넘기면 `INVALID_VALUE`.
   - 나중에 scope를 추가하려면 전체를 재암호화·재색인해야 한다(문서화). 이런 테이블은 모든 행이 한 토큰 공간을 쓰므로 V2 공격 시뮬레이션 대상에 넣는다.
4. **키 없이 스키마 로드:** `createSealed({ sealer })`의 `sealer`는 `Sealer | (() => Sealer)`다. 함수면 첫 암호 연산 때 한 번 호출한다. drizzle-kit이 키 없이 스키마 파일을 읽을 수 있어야 한다.
5. **보조 테이블 물리 구조:**
   - 이름은 `<부모>_seal_index`이고 부모와 같은 pg schema에 둔다.
   - 토큰 칸과 색인 이름은 현 `companionProfiles`와 `companionIndexName`을 따른다.
   - 정확 일치 색인은 `(scope_id, (tokens)[1], row_id)` 식 색인이다(현 `sealed-schema.ts`).
   - 부분 검색 칸 전체에 다중 컬럼 GIN 1개를 둔다.
   - `extraMigrationSql(seal): string[]`는 부분 검색 칸의 `set statistics 1000`을 돌려준다.
6. **단계 재배치:**
   - P2에서 옛 API, 옛 테스트, `examples/`를 새 API로 한꺼번에 바꿔 커밋마다 `check`·`test`가 통과하게 한다.
   - P4에서 `scripts/docs-check.mjs`와 `scripts/install-smoke.mjs`의 옛 이름 검사를 새 export로 바꾼다.
   - P6 전에 `bench/verify-core/{boundary-db,join,mixed}.ts`를 새 API로 옮긴다. `bench/standard-next`와 `standard-review`는 기록으로 두고 "옛 API라 실행 불가"라고 README에 적는다.
   - 옮길 테스트: `standard-drizzle`, `standard-types`, `standard-kit-schema`는 새로 작성한다. `standard-postgres`의 세 테스트는 포팅한다(배치 증가, 다중 GIN, OR semi-join, 한도 있는 count 유지, `WRITE_CONFLICT`는 `NOT_FOUND`로 교체).
7. **raw 진입점:** `sealql/postgres`는 v1에서 제거한다(exports, docs-check, install-smoke 포함). 원시 SQL은 Drizzle `db.execute` + `openRaw`/`search`로 지원한다. 이후 추가만 한다.
8. **트랜잭션:**
   - 쓰기 함수는 항상 `db.transaction(fn)`을 호출한다. `PgDatabase`면 BEGIN, `PgTransaction`이면 SAVEPOINT다. 격리 수준은 지정하지 않는다.
   - 암호화와 토큰 계산은 트랜잭션 전에 끝낸다.
   - `transaction`이 없는 드라이버는 `UNSUPPORTED_DRIVER`, 최상위 COMMIT 실패는 `WRITE_OUTCOME_UNKNOWN`.
9. **쓰기 의미:**
   - 반환은 항상 배열이고, 원소는 row·scope 속성만 담는다. 마지막 인자 `options = { returning?: true }`를 주면 연 행 배열을 반환한다.
   - 배열 insert는 1–1000행이다. 초과하면 `LIMIT_EXCEEDED`, 빈 배열은 `INVALID_VALUE`. 부모는 다행 insert 1회, 보조 테이블은 다행 upsert 1회로 쓴다.
   - row 값이 없으면 uuid 칸은 `crypto.randomUUID()`로 채우고, text 칸은 `INVALID_VALUE`.
   - update: patch에 없는 필드는 읽지도 쓰지도 않는다. 빈 patch는 `INVALID_VALUE`, 0행이면 `NOT_FOUND`(보조 테이블은 쓰지 않음).
   - upsert: 충돌하면 넘긴 칸만 갱신하고, 넘긴 암호 필드의 토큰 칸만 교체한다.
   - 낙관적 잠금은 없다. 같은 행의 동시 수정은 나중에 커밋한 쪽이 이긴다(부모 행 잠금 순서로 보조 테이블도 정합).
10. **open 명세:**
    - `Sealed`를 직접 담은 객체에서, 등록한 row·scope **속성명과 같은 키**만 찾는다. 별칭이나 다른 깊이는 `ROW_CONTEXT_MISSING`.
    - 평면 선택에서 두 봉인 테이블의 `id`가 겹치면 인증 실패다. 중첩 선택(`{ c: customers, o: orders }`)을 권장한다고 문서화한다.
    - `scope` 옵션이 있으면 모든 행의 scope가 같아야 하고, 다르면 `SCOPE_MISMATCH`.
    - 입력은 바꾸지 않고 새 객체를 반환한다.
    - 예산 기본값: maxRows 500, maxBytes 4 MiB, deadlineMs 2000, concurrency 64. 인증 캐시 키는 (모델, 행, 필드).
    - `openRaw`는 입력 키를 유지하고 매핑된 암호 칸만 평문으로 바꾼다(`Uint8Array` 또는 `\x` hex). `columns`에 row·scope가 없으면 `INVALID_VALUE`.
11. **빌더:**
    - `sealed.<codec>(name, options)`의 `name`이 필드 ID 기본값이자 DB 칸 이름(`${name}_ct`)의 줄기다. 속성명은 AAD에 쓰지 않으므로, 속성 이름을 바꿔도 복호화가 깨지지 않는다.
    - 옵션: `nullable, column, maxBytes, id, validate, search`. `sealed.decimal`은 `precision`과 `scale`이 필수다.
    - 봉인 칸에 `default/$defaultFn/unique/primaryKey/generated`가 있으면 `INVALID_SCHEMA`.
    - row 칸은 uuid 또는 `sealed.textId(name)`(`text COLLATE "C"`)만 허용한다. scope 칸은 uuid나 text다.
    - row·scope 칸은 DB 이름을 명시해야 한다(`keyAsName`이면 `INVALID_SCHEMA`).
12. **m.sql 조합:**
    - 루트에서 AND만 거친 `m.sql`은 WHERE에 AND로 넣는다.
    - 그 밖은 `__seal_flag_<n>` = `coalesce((cond), false)`를 선택해, 재확인 때 그 잎을 플래그로 평가한다.
    - 후보 SQL은 `m.sql` 없는 최대 부분 트리마다 semi-join 1개(`candidatePredicate` 재사용)를 두고 `and/or`로 조합한다.
    - `m.sql`이 있으면 256행 prefix를 끈다. `m.sql`도 잎 8개 제한에 센다.
    - digest에는 `PgDialect.sqlToQuery` 결과를 넣는다.
13. **findMany/count:**
    - 반환은 `{ items, nextCursor }`다. 검사한 행이 있는데 예산을 넘으면 짧은 페이지와 nextCursor, 하나도 없으면 `LIMIT_EXCEEDED`.
    - items에는 항상 row·scope 속성이 들어간다. `columns`를 생략하면 부모 전체 칸이다.
    - `limit` 1–200(기본 50). `budgets`와 `signal`은 현 `SearchBudgets`와 같다.
    - orderBy는 부모의 NOT NULL 일반 칸 중 integer·bigint·uuid·timestamptz만 허용한다.
    - `UNBOUNDED_PROJECTION` 검사는 삭제하고, 일반 칸의 실제 바이트를 예산에 센다.
14. **search 콜백:**
    - 인자는 `{ where, after, orderBy, flags, flagsSql, limit }`다(`flagsSql`은 `db.execute`용).
    - 반환은 행 배열 또는 `{ rows }`다. 원시 결과면 match 키마다 `columns`를 준다.
    - 봉인 테이블에는 `alias()`를 쓸 수 없고, 같은 테이블을 자기 자신과 JOIN할 수 없다.
15. **reindex:** `reindex(db, seal, { scope?, batch = 500 })`는 row keyset 배치마다 트랜잭션 안에서 `select … for update`로 부모 행을 잠근 뒤, 복호화 → 토큰 계산 → 보조 행 upsert를 한다. 토큰이 모두 null이면 보조 행을 삭제한다. 반환은 `{ rows }`다. `verifyIndex`는 v1에서 뺀다.
16. **타입:** 칸 데이터 타입은 `Sealed<T, S>`다(S = search 옵션). `m`의 연산 가용성은 S로 정하고, 현 `standard-types.ts`의 연산 `@ts-expect-error` 5건을 유지한다.
17. **의존 목록 추가:** `or, asc, desc, gt, unique, .returning(), .onConflictDoUpdate({ target, set, setWhere }), .for('update'), is(x, PgTransaction), Column.defaultFn(봉인 표식), Column.keyAsName(검사)`.
18. **검증 보강:**
    - P1: 일회용 DB에서 kit `generate`+`migrate`와 `push`가 모두 성공해야 한다.
    - V1 추가: 같은 행 동시 update(같은 필드·다른 필드), update 대 delete, reindex 대 update 뒤, 보조 테이블이 암호문에서 다시 계산한 토큰과 같아야 한다.
    - V2: 상수 scope 테이블에 공격 시뮬레이션을 실행한다.
    - Workers: 새 어댑터를 번들한 workerd 테스트를 추가한다.
    - P5 끝: 결정 013 추가, 이 계획 삭제, `plan/README` 갱신.
19. **Sealed와 export:**
    - `toDriver`는 이번 쓰기 호출이 만든 `Sealed`(내부 WeakSet)만 받는다. 읽은 값을 다시 쓰면 `SEAL_REQUIRED`.
    - export는 `createSealed`와 타입 `Sealed`, `Opened`다. 엔진의 `ScopedRepository`는 내부로 둔다.

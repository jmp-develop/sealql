# Drizzle ORM 0.45 adapter

This guide owns the `sealql/drizzle/v0.45` API. Read the ORM-neutral [core concepts](../core-concepts.md) first.

## Install and verify the driver

Install the prebuilt release package with npm or pnpm, plus `drizzle-orm >=0.45.2 <0.46`:

```sh
npm install https://github.com/jmp-develop/sealql/releases/download/v1.1.0/sealql-1.1.0.tgz drizzle-orm@0.45
pnpm add https://github.com/jmp-develop/sealql/releases/download/v1.1.0/sealql-1.1.0.tgz drizzle-orm@0.45
```

Use Node `>=22.12` or another runtime with compatible WebCrypto (Cloudflare Workers with `nodejs_compat` works). Verified on PostgreSQL 18.

Managed writes (`insert`, `update`, `upsert`) and `reindex` open a database transaction, so they need a driver with transaction support, such as node-postgres (`pg`) or postgres-js. This applies wherever those calls run, including request handlers. A driver without transactions (for example `neon-http`) raises `UNSUPPORTED_DRIVER`. Reads, searches, and counts do not need a transaction.

The [injected integration flow](../../examples/drizzle/v0.45/app.ts) demonstrates connection, migration, `extraMigrationSql`, insert, search, count, and cleanup. It is run by the repository [example runner](../../scripts/run-drizzle-v0.45-example.ts), which injects the disposable-database guard and example root key; it is not a standalone application entry point. With the read-only `bench_realistic_100k` fixture already present, prepare and run it with:

```sh
pg_ctl -D .local/pg-test -o "-h 127.0.0.1 -p 56439" -l .local/pg-test.log start -w -t 60
npm run example:drizzle-v0.45
```

Additional examples cover [managed writes](../../examples/drizzle/v0.45/managed-writes.ts), [search and errors](../../examples/drizzle/v0.45/search.ts), [raw SQL and a JOIN callback](../../examples/drizzle/v0.45/raw-sql.ts), [integer primary keys](../../examples/drizzle/v0.45/integer-primary-key.ts), and a [fixed model key with tenant scopes](../../examples/drizzle/v0.45/model-key-tenant-scope.ts).

## Create and register a schema

`sealql` exports `createSealer`, core codecs/types, and `SealError`. `sealql/drizzle/v0.45` exports `createSealed` and the `Sealed`, `Opened`, `PlainShape`, `InferSealedInsert`, `InferSealedIdentity`, and `InferSealedPatch` types.

```ts
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

const sealed = createSealed({ sealer: createSealer({ key: rootKey }) });
export const notes = pgTable('notes', {
  id: uuid('id').primaryKey(),
  scopeId: uuid('scope_id').notNull(),
  status: text('status').notNull(),
  body: sealed.text('body', { search: { exact: true, substring: true } }),
});
export const notesSeal = sealed.register(notes, { row: 'id', scope: 'scopeId' });
```

Export both the parent and returned companion table in the schema read by drizzle-kit. A lazy `createSealed({ sealer: () => sealer })` lets drizzle-kit import schema without secret access; data operations still require the configured key.

Builders are `sealed.text`, `integer`, `bigint`, `decimal`, `boolean`, `instant`, `json`, and `bytes`. Options include `nullable`, physical `column`, caller limit `maxBytes`, stable field `id`, `validate`, and eligible `search`; decimal also requires `precision` and `scale`. The first builder argument is the default field ID and physical ciphertext column prefix, not the JavaScript property name. Preserve that ID across a property rename to preserve cipher context.

Rows use UUID or `sealed.textId`; scopes use UUID or text. A parent row must be unique, primary, or unique together with scope. Integer auto-increment primary keys need a separate unique UUID row identity as shown in the [integer-key example](../../examples/drizzle/v0.45/integer-primary-key.ts). `sealed.textId` is a database-collated text column: empty IDs are allowed, NUL is not, and parent and companion identities must keep the same collation.

Text-ID keyset ordering follows the database collation. For text positions, SealQL checks each candidate batch against database order with one extra SQL request per batch and raises `INVALID_CANDIDATE_SHAPE` if the callback returns an out-of-order batch.

The generated companion has one row per parent identity, a unique scope/row B-tree, exact expression indexes, and a multicolumn GIN index for substring profiles. The business table has no token columns or trigger. Parent deletion through Drizzle cascades to the companion.

## Migrate and rebuild

After `drizzle-kit generate`, create a custom migration and place every statement returned by `sealed.extraMigrationSql(notesSeal)` in it:

```sh
drizzle-kit generate
drizzle-kit generate --custom --name seal_search
drizzle-kit migrate
```

The integration flow applies the same returned SQL directly; copy the resulting statements into the custom migration rather than relying on application startup:

```ts
for (const statement of sealed.extraMigrationSql(notesSeal)) {
  await pool.query(statement);
}
```

With `drizzle-kit push`, execute those statements after the push. They install schema-qualified predicate functions, substring statistics targets, and `MAIN` storage settings. They are idempotent and require no PostgreSQL extension. `MAIN` affects newly written values; `sealed.reindex` rewrites existing companion values, whereas PostgreSQL `REINDEX` does not.

Package-name schema imports with UUID or `sealed.textId` rows, text scopes, and scope-free tables support drizzle-kit `generate`, `migrate`, and repeated `push` without schema drift.

For a dedicated schema, keep `schemaFilter`, `migrations.schema`, and `tablesFilter` consistent:

```ts
export default defineConfig({
  dialect: 'postgresql', schema: './src/schema.ts', out: './drizzle',
  schemaFilter: ['app'], migrations: { schema: 'app' },
  tablesFilter: ['!__drizzle_migrations'],
});
```

Import `defineConfig` from `drizzle-kit`. Verify where the migration journal is created: moving it into an application schema can conflict with an existing `CREATE SCHEMA`, and `push` may propose deleting it unless excluded.

For profile additions or changes, follow the [rebuild invariant](../core-concepts.md#rebuild-invariant). Generated migrations may rebuild a GIN index without `CONCURRENTLY`; plan for locking and rebuild time. Changes limited to installed LIKE predicate functions require `extraMigrationSql` again but no row rewrite when rows already use the compact-only profile.

## Managed writes, deletion, and reindex

Derive application inputs from the registered companion instead of duplicating the schema by hand:

```ts
import type {
  InferSealedIdentity, InferSealedInsert, InferSealedPatch,
} from 'sealql/drizzle/v0.45';

type NoteInput = InferSealedInsert<typeof notesSeal>;
type NoteIdentity = InferSealedIdentity<typeof notesSeal>;
type NotePatch = InferSealedPatch<typeof notesSeal>;
```

`InferSealedInsert` is shared by `insert` and `upsert`. Only a registered UUID row may be omitted for generation; a text row and every registered scope are required even when the database column has a default. `InferSealedIdentity` requires the registered row and scope names, while `InferSealedPatch` excludes both so an update cannot move identity. A scope-free registration adds no scope property. These types follow the property names supplied to `register`; they do not assume names such as `id` or `scopeId`.

```ts
await sealed.insert(db, notesSeal, { id, scopeId, status: 'draft', body: 'Ada' });
await sealed.update(db, notesSeal, { id, scopeId }, { body: 'Ada Lovelace' });
await sealed.upsert(db, notesSeal, { id, scopeId, status: 'active', body: 'Ada' });
await db.delete(notes).where(eq(notes.id, id));
```

`insert`, `update`, and `upsert` use `db.transaction`; inside an existing Drizzle transaction they use a savepoint. Ciphertext and changed companion proof/token columns commit together. The helpers return row/scope identities, or opened rows with `{ returning: true }`. A UUID row ID may be generated; a text row ID must be supplied.

Pass an existing transaction to a managed helper when encrypted and ordinary writes must share the caller's transaction:

```ts
await db.transaction(async tx => {
  await updateCustomer(tx, tenantId, id, name);
  await tx.update(audit).set({ changed: true }).where(eq(audit.id, id));
});
```

The [managed-write example](../../examples/drizzle/v0.45/managed-writes.ts) contains the helper signatures used by this pattern.

`undefined` omits a property. An omitted nullable encrypted field inserts null; an omitted required encrypted field, an update with no remaining fields, or an unknown property is `INVALID_VALUE`. Plain Drizzle encrypted writes raise `SEAL_REQUIRED`. Raw SQL ciphertext writes bypass companion maintenance and can silently omit search results.

`sealed.reindex(db, notesSeal, { scope?, batch? })` locks parent rows in keyset batches, authenticates ciphertext, and rebuilds companion data without changing ciphertext; it returns `{ rows }`. Its default batch is 1,000 and callers may override it without a library maximum. If all searchable fields are null it removes the companion row. It repairs raw-write drift but does not rotate keys.

When to run it: only when existing rows need new search data, for example after enabling or changing search options on an encrypted field or adding a searchable encrypted field to a table that already has rows. New tables and rows written through managed writes need no reindex. Run it where you run migrations (a deployment or maintenance script with a transactional driver), after the migration and `extraMigrationSql`, and before deploying code that searches with the new options. Omit `scope` to rebuild the whole table; `scope` exists only to rebuild one scope of a scoped model. If it stops midway, run it again; it is safe to repeat.

For a deployment profile change, prefer the all-model gate after applying the migration and every `extraMigrationSql` statement:

```ts
const receipt = await sealed.prepareAllSearch(db, { batchSize: 1_000, signal });
```

`prepareAllSearch` snapshots every model already registered on that `createSealed` instance, rejects a transaction handle, and performs a read-only catalog preflight. It requires the companion columns, validated foreign key/check constraints, valid and ready indexes, installed predicate functions with their expected signatures and attributes, statistics target, and `MAIN` storage settings; it never runs DDL. A mismatch raises `INVALID_SCHEMA` with an `extraMigrationSql` hint. It then reuses the authenticated full-table reindex path and requires the parent count at start and end, unique rows visited in database identity order, and verified rows to agree. A skipped row or concurrent count change raises `REBUILD_INCOMPLETE`.

The receipt contains exact safe `number` counts per model (`parentRowsAtStart`, `visitedRows`, `verifiedRows`, `parentRowsAtEnd`, and `rebuiltFields`) plus `totalRows` and `totalFields`; overflow raises `LIMIT_EXCEEDED`. Cancellation raises `CANCELLED` at checkpoints, leaves already committed batches in place, and produces no receipt. Drain old application reads and writes before the migration, run `extraMigrationSql`, await this gate, and deploy new searches only after success. There is no persisted completion marker or online-transition guarantee, so a failed run must be restarted from the beginning. Registrations created during a run belong to the next run.

Empty and one-character searchable values retain exact/positional proofs even when no substring candidate tokens exist.

A top-level commit failure after the helper callback finishes raises `WRITE_OUTCOME_UNKNOWN`; reconcile the row before retrying.

## Open Drizzle and raw results

Await a Drizzle query before opening it:

```ts
const rows = await sealed.open(await db.select().from(notes), { scope: scopeId });
```

`sealed.open` returns decrypted copies of whole, partial, or nested result objects. Whenever an encrypted projection is present, select its registered row and scope properties under the registered names. Missing context raises `ROW_CONTEXT_MISSING`; nested selections avoid same-name collisions in joins. `{ scope }` requires every opened row to match the caller-authorized scope. Unopened encrypted handles reject string/JSON conversion with `SEAL_REQUIRED` and must not be logged.

For `db.execute`, use `openRaw` with an explicit property-to-result-column map. Values may be `Uint8Array` or PostgreSQL `\\x` hex text, and input rows are not mutated. See the [raw SQL example](../../examples/drizzle/v0.45/raw-sql.ts). The optional fourth argument is internal; application code omits it.

Passing a Promise or thenable instead of an awaited result raises `INVALID_VALUE` with an await-query hint.

## Find, count, and page

Search encrypted columns only with SealQL match builders (`m.field.eq`, `contains`, `startsWith`, `endsWith`, `like`, `m.and`, `m.or`). Drizzle `eq`/`ne`/`inArray` on an encrypted column raise `SEAL_REQUIRED`, but SealQL cannot intercept Drizzle `like`, `ilike`, `orderBy`, or raw `sql` comparisons on encrypted columns: those run against ciphertext and return wrong results without an error (usually zero rows, or rows sorted by ciphertext). Blocking them would require patching Drizzle internals, which would break on Drizzle updates, so this is the developer's responsibility. Sort only by unencrypted columns; combine ordinary Drizzle predicates with a condition from `sealed.where`, or place them in `m.sql`.

### Search inside your own queries (JOIN, custom order)

`sealed.where` is the default way to put encrypted search inside a caller-owned Drizzle query. It performs no database access and returns a `Promise<SQL>` condition containing the scope, candidate-token, and database-proof checks. Combine that condition with ordinary predicates, JOINs, subqueries, ordering, limits, and `count()` as usual, then pass selected encrypted rows to `sealed.open`:

```ts
const condition = await sealed.where(notesSeal, {
  scope: scopeId,
  match: m => m.body.contains('Ada'),
});
const selected = await db.select({ note: notes, tag: tags.label }).from(notes)
  .innerJoin(tags, eq(tags.noteId, notes.id))
  .where(and(condition, eq(tags.active, true)))
  .orderBy(desc(tags.createdAt));
const opened = await sealed.open(selected, { scope: scopeId });
const [{ value }] = await db.select({ value: count() }).from(notes).where(condition);
```

The returned value has the same SQL meaning as an ordinary Drizzle condition that references columns of the registered table. Use it only when that original parent table (not an alias) is present at the applicable query level; SQL correlation rules apply unchanged when the table is inside a subquery. Sealed aliases and self-JOINs remain unsupported. For multiple registered sealed tables, call `sealed.where` once per table and combine the returned conditions. `scope` has exactly the same type and runtime rules as `findMany`: omitting it for a scoped registration, or supplying it for a scope-free registration, raises `INVALID_VALUE`. The same match validation applies, including `QUERY_TOO_BROAD` for a standalone one-character substring.

Create the condition afresh for each query. It captures key-derived search values at preparation time, so a condition created before an application key change does not match data under the new key. `db.update(...).set({ ordinaryColumn: value }).where(condition)` and similarly filtered deletes have ordinary SQL semantics; direct encrypted-column updates remain blocked by `SEAL_REQUIRED`. Nested table-shaped selections such as `db.select({ c: customers, o: orders })` can be passed directly to `sealed.open` as long as each shape contains its row and scope fields. For flattened or renamed raw result columns, use `openRaw` with an explicit column map, as shown in the [raw SQL example](../../examples/drizzle/v0.45/raw-sql.ts).

`sealed.findMany` accepts `scope`, `match`, `where`, `columns`, `orderBy`, `limit`, `cursor`, `budgets`, and `signal`. It returns:

```ts
type Page<T> = { items: T[]; nextCursor: string | null };
```

When `limit` is omitted, all matches are returned. `columns` controls the parent projection while row/scope identity is included for authentication. Ordering accepts unencrypted columns and adds row identity as a final tie breaker. PostgreSQL null ordering applies. Continue with `cursor: page.nextCursor`; the current cursor format has no expiry and does not create a snapshot, and it binds scope, match, ordinary filter, and ordering.

`sealed.count` accepts `scope`, optional `match`, optional ordinary `where`, `budgets: { deadlineMs }`, and `signal`. If both predicates are absent, it returns the exact count of every parent row in the supplied scope (or every row for a scope-free model). Its exact-result and failure contract is owned by [core concepts](../core-concepts.md#exact-count-and-caller-budgets).

Match builders compose exact equality, substring operations, LIKE, AND/OR, and parameterized ordinary SQL via `m.sql`. The [search example](../../examples/drizzle/v0.45/search.ts) shows exact and Boolean predicates, LIKE, cursor iteration, `m.sql`, encrypted-field projection, caller-supplied budgets, and a typed `QUERY_TOO_BROAD` response that is distinct from an empty result. Search normalization and unsupported operations are defined in [standard search](../core-concepts.md#standard-search).

## Cursor-managed custom JOIN search

Use `sealed.search` instead when SealQL must manage cursor pages, result-byte budgets, and candidate-shape checks around a custom Drizzle or raw `db.execute` query. The first table in `match` controls page order. Its callback receives `{ where, after, orderBy, flags, flagsSql, limit }` and must:

- apply `where`, optional `after`, and `orderBy`;
- apply a defined `limit`, but omit SQL LIMIT when it is undefined;
- select `flags` for Drizzle or `flagsSql` for raw SQL.

Why: your callback writes the SQL, so SealQL cannot see or change it. SealQL hands over each piece it needs in the query, and each missing piece has a concrete symptom:

| Piece | What it does | If you leave it out |
|---|---|---|
| `where` | The encrypted-search condition (scope, candidate tokens, and the database proof check) | Rows that do not match the search are returned as if they matched. SealQL cannot detect this |
| `after` | Starts this page after the previous page's last row | The next page returns earlier rows again; SealQL detects the repeat or backward order and raises `INVALID_CANDIDATE_SHAPE` |
| `orderBy` | The row order SealQL pages in | Out-of-order rows raise `INVALID_CANDIDATE_SHAPE` |
| `limit` | Page size SealQL expects | Returning more rows than the limit raises `INVALID_CANDIDATE_SHAPE` |
| `flags` / `flagsSql` | Row position values SealQL uses to build the next cursor | SealQL cannot position the rows and raises `INVALID_CANDIDATE_SHAPE` |

Only a missing `where` produces silently wrong results; the other omissions fail loudly. Your own JOINs and filters are applied as written. An INNER JOIN or an extra WHERE that removes a row also removes it from the search result; that is ordinary SQL behavior, not an error.

The [raw SQL example](../../examples/drizzle/v0.45/raw-sql.ts) provides a complete callback that selects mapped ciphertext columns and `flagsSql`, applies `where`/`after`, reuses `orderBy`, and honors the numeric limit around a JOIN.

A numeric caller limit makes callback `limit` a `number`; omitted or optional limits use `number | undefined`. A one-to-many join needs a unique many-side keyset column. Raw flat results map registered properties through the top-level `columns` option. SealQL removes internal flag and keyset aliases from returned items.

All matched sealed tables must be scoped or all scope-free. Sealed aliases and self-joins are unsupported. Cursor paging must reuse the same callback SQL because a custom cursor binds scope, match, and keyset, not the callback body. Malformed, duplicated, or out-of-order positions raise `INVALID_CANDIDATE_SHAPE`.

Multiple sealed matches and ordinary tables can share one callback. Put a unique many-side column first in `keyset` so one-to-many rows remain independently pageable:

```ts
const page = await sealed.search(db, {
  scope: scopeId,
  match: {
    o: [ordersSeal, m => m.or(m.label.eq('urgent'), m.label.eq('normal'))],
    c: [customersSeal, m => m.and(m.name.eq(name), m.note.contains(fragment))],
  },
  keyset: [orders.id],
  limit: 50,
  query: ({ where, after, orderBy, flags, limit }) => db
    .select({ o: orders, c: customers, team: teams, region: regions, ...flags })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .innerJoin(teams, eq(teams.customerId, customers.id))
    .innerJoin(regions, eq(regions.orderId, orders.id))
    .where(and(where, after))
    .orderBy(...orderBy)
    .limit(limit),
});
```

An unmatched sealed table selected through `leftJoin` is returned as nested `null` when it is not itself a match target. Custom JOIN search has no separate count shortcut: for an exact result-row count, traverse every cursor page with the identical callback and add `items.length`. This counts one-to-many duplicates as separate result rows. Do not count the callback's candidate SQL directly because only returned search items have completed proof and authenticated-plaintext verification; `sealed.count` owns the single-registration path, not arbitrary JOIN multiplicity. Cursor traversal is not a snapshot, so use the same quiescence/consistency assumptions as any multi-page result.

The supplied `query` callback, not SealQL, owns and executes the database handle. An OR branch containing `m.sql` may be slow when its ordinary SQL condition lacks an index. Limited pages fetch final database matches in finite batches and apply proofs before SQL `LIMIT`; internal probes do not cap total work. Date/timestamp keyset positions use database-DateStyle-independent text. Use the caller-budget procedure in [core concepts](../core-concepts.md#exact-count-and-caller-budgets).

## Handle errors by code

Catch `SealError` and branch on stable `error.code`, not message text. Database errors expose a sanitized driver summary in `cause`; logging `code`, `message`, and safe `cause.code`/`cause.constraint` is sufficient. Never log SQL parameters or unopened encrypted values.

| Code | Common response |
|---|---|
| `SEAL_REQUIRED` | Route encrypted writes through managed helpers; do not serialize unopened values. |
| `INVALID_VALUE`, `INVALID_SCHEMA`, `INVALID_QUERY`, `INVALID_ID` | Reject caller/configuration input and fix the schema or query. |
| `INVALID_TRANSACTION_CONTEXT`, `REBUILD_INCOMPLETE` | Run `prepareAllSearch` on a top-level deployment database after quiescing traffic; apply the missing migration SQL or rerun the full gate. |
| `NOT_FOUND`, `SCOPE_CONFLICT`, `SCOPE_MISMATCH`, `ROW_CONTEXT_MISSING` | Reconcile identity, authorization, or selected row/scope context. |
| `LIMIT_EXCEEDED`, `CANCELLED`, `DB_TIMEOUT` | Apply the application's timeout/budget response; do not return an uncertain count. |
| `QUERY_TOO_BROAD`, `UNSUPPORTED_SEARCH` | Require a supported profile and at least two usable normalized substring characters. |
| `CURSOR_INVALID`, `CURSOR_EXPIRED` | Restart paging. The current implementation has no cursor expiry and emits `CURSOR_INVALID` for invalid cursors; handling `CURSOR_EXPIRED` remains a defensive future/legacy branch. |
| `VALIDATION_FAILED`, `INVALID_CIPHERTEXT`, `AUTHENTICATION_FAILED` | Reject the value and investigate data integrity or context mismatch. |
| `KEY_NOT_FOUND`, `KEY_SCOPE_MISMATCH` | Stop the operation and fix secret/model-key configuration. |
| `UNSUPPORTED_DRIVER` | Use a driver with the required transaction callback. |
| `INVALID_CANDIDATE_SHAPE` | Fix the custom callback's projection, ordering, flags, and keyset. |
| `WRITE_OUTCOME_UNKNOWN` | Reconcile the row before retrying. |
| `DATABASE_ERROR`, `CONSTRAINT_VIOLATION`, `TRANSACTION_CONFLICT` | Inspect the sanitized cause and apply normal database retry/conflict policy. |

The [current state](../current-state.md) describes execution/storage internals; the [threat model](../threat-model.md) owns security claims.

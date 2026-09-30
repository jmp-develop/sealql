# Drizzle ORM 0.45 adapter

This guide owns the `sealql/drizzle/v0.45` API. Read the ORM-neutral [core concepts](../core-concepts.md) first.

## Install and verify the driver

SealQL is not published to the npm registry. Run `npm pack` in a checkout and install the resulting `.tgz`, plus `drizzle-orm >=0.45.2 <0.46`. Use Node `>=22.12` or another runtime with compatible WebCrypto.

Managed writes and `reindex` require a transactional PostgreSQL driver. Node pg, postgres-js, and local workerd with pg passed the repository database flow. Hosted Workers/Hyperdrive remains unverified. `neon-http` cannot run managed writes or `reindex` because it lacks the required transaction callback. These are verification results, not deployment guarantees.

The [injected integration flow](../../examples/drizzle/v0.45/app.ts) demonstrates connection, migration, `extraMigrationSql`, insert, search, count, and cleanup. It is run by the repository [example runner](../../scripts/run-drizzle-v0.45-example.ts), which injects the disposable-database guard and example root key; it is not a standalone application entry point. With the read-only `bench_realistic_100k` fixture already present, prepare and run it with:

```sh
pg_ctl -D .local/pg-test -o "-h 127.0.0.1 -p 56439" -l .local/pg-test.log start -w -t 60
npm run example:drizzle-v0.45
```

Additional examples cover [managed writes](../../examples/drizzle/v0.45/managed-writes.ts), [search and errors](../../examples/drizzle/v0.45/search.ts), [raw SQL and a JOIN callback](../../examples/drizzle/v0.45/raw-sql.ts), [integer primary keys](../../examples/drizzle/v0.45/integer-primary-key.ts), and a [fixed model key with tenant scopes](../../examples/drizzle/v0.45/model-key-tenant-scope.ts).

## Create and register a schema

`sealql` exports `createSealer`, core codecs/types, and `SealError`. `sealql/drizzle/v0.45` exports `createSealed` and the `Sealed`/`Opened` types.

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

Use SealQL match builders, not Drizzle `eq`/`like`/`ilike` or ordering on encrypted columns. Ordinary Drizzle equality raises `SEAL_REQUIRED`; LIKE can silently return zero and encrypted ordering sorts meaningless ciphertext.

`sealed.findMany` accepts `scope`, `match`, `where`, `columns`, `orderBy`, `limit`, `cursor`, `budgets`, and `signal`. It returns:

```ts
type Page<T> = { items: T[]; nextCursor: string | null };
```

When `limit` is omitted, all matches are returned. `columns` controls the parent projection while row/scope identity is included for authentication. Ordering accepts unencrypted columns and adds row identity as a final tie breaker. PostgreSQL null ordering applies. Continue with `cursor: page.nextCursor`; the current cursor format has no expiry and does not create a snapshot, and it binds scope, match, ordinary filter, and ordering.

`sealed.count` accepts `scope`, optional `match`, optional ordinary `where`, `budgets: { deadlineMs }`, and `signal`. If both predicates are absent, it returns the exact count of every parent row in the supplied scope (or every row for a scope-free model). Its exact-result and failure contract is owned by [core concepts](../core-concepts.md#exact-count-and-caller-budgets).

Match builders compose exact equality, substring operations, LIKE, AND/OR, and parameterized ordinary SQL via `m.sql`. The [search example](../../examples/drizzle/v0.45/search.ts) shows exact and Boolean predicates, LIKE, cursor iteration, `m.sql`, encrypted-field projection, caller-supplied budgets, and a typed `QUERY_TOO_BROAD` response that is distinct from an empty result. Search normalization and unsupported operations are defined in [standard search](../core-concepts.md#standard-search).

## Custom JOIN search

`sealed.search` accepts a custom Drizzle or raw `db.execute` candidate query. The first table in `match` controls page order. Its callback receives `{ where, after, orderBy, flags, flagsSql, limit }` and must:

- apply `where`, optional `after`, and `orderBy`;
- apply a defined `limit`, but omit SQL LIMIT when it is undefined;
- select `flags` for Drizzle or `flagsSql` for raw SQL.

The [raw SQL example](../../examples/drizzle/v0.45/raw-sql.ts) provides a complete callback that selects mapped ciphertext columns and `flagsSql`, applies `where`/`after`, reuses `orderBy`, and honors the numeric limit around a JOIN.

A numeric caller limit makes callback `limit` a `number`; omitted or optional limits use `number | undefined`. A one-to-many join needs a unique many-side keyset column. Raw flat results map registered properties through the top-level `columns` option. SealQL removes internal flag and keyset aliases from returned items.

All matched sealed tables must be scoped or all scope-free. Sealed aliases and self-joins are unsupported. Cursor paging must reuse the same callback SQL because a custom cursor binds scope, match, and keyset, not the callback body. Malformed, duplicated, or out-of-order positions raise `INVALID_CANDIDATE_SHAPE`.

The supplied `query` callback, not SealQL, owns and executes the database handle. An OR branch containing `m.sql` may be slow when its ordinary SQL condition lacks an index. Limited pages fetch final database matches in finite batches and apply proofs before SQL `LIMIT`; internal probes do not cap total work. Date/timestamp keyset positions use database-DateStyle-independent text. Use the caller-budget procedure in [core concepts](../core-concepts.md#exact-count-and-caller-budgets).

## Handle errors by code

Catch `SealError` and branch on stable `error.code`, not message text. Database errors expose a sanitized driver summary in `cause`; logging `code`, `message`, and safe `cause.code`/`cause.constraint` is sufficient. Never log SQL parameters or unopened encrypted values.

| Code | Common response |
|---|---|
| `SEAL_REQUIRED` | Route encrypted writes through managed helpers; do not serialize unopened values. |
| `INVALID_VALUE`, `INVALID_SCHEMA`, `INVALID_QUERY`, `INVALID_ID` | Reject caller/configuration input and fix the schema or query. |
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

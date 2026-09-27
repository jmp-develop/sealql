# SealQL integration

This guide describes the experimental Drizzle ORM 0.45 API. The compilable [schema and key example](../examples/standard-consumer.ts), [managed operations](../examples/standard-operations.ts), [raw SQL example](../examples/standard-raw.ts), and [key loader](../examples/key-loader.ts) show the calls in context.

## Schema and key

`sealql` exports `createSealer`, codecs, and `SealError`. `sealql/drizzle/v0.45` exports `createSealed` and the `Sealed`/`Opened` types. The app loads a fixed 32-byte root key; it may configure a separate fixed key for a model with `createSealer({ key, models: { modelName: { key: modelKey } } })`. There is no key version, DB policy table, or user/group key. The app authorizes scope values. Changing a key requires full application-managed re-encryption and index rebuild.

```ts
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

const sealed = createSealed({ sealer: createSealer({ key: rootKey }) });
export const notes = pgTable('notes', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  status: text('status').notNull(),
  body: sealed.text('body', { search: { exact: true, substring: true } }),
});
export const notesSeal = sealed.register(notes, { row: 'id', scope: 'scopeId' });
```

Export both the parent and returned companion table in the schema read by drizzle-kit. The key can load lazily through `createSealed({ sealer: () => sealer })`, allowing drizzle-kit to import the schema without secret access; data operations still require the key. `sealed.text`, `integer`, `bigint`, `decimal`, `boolean`, `instant`, `json`, and `bytes` build encrypted columns. They accept field options such as `nullable`, physical `column`, `maxBytes`, stable field `id`, `validate`, and eligible `search` profiles. `decimal` also requires `precision` and `scale`. The property name is not the field ID: the builder's first argument sets the default field ID and physical column name (`body_ct`). A renamed property can therefore keep its cipher context by retaining that first argument. Row IDs use UUID or `sealed.textId` (`text` ordered by the database column's collation); scope IDs use UUID or text. A scope-free table uses the constant scope `_` in AAD, tokens, and cursors. Adding a scope to one later requires re-encryption and reindexing all rows, and puts them in a new token space.

The parent row ID must already be unique or primary, or its `(scope,row)` pair must be unique. The companion foreign key refers to the parent row ID when it is unique, otherwise the pair. No extra parent unique constraint is needed for a normal `id` primary key. For an integer auto-increment primary key, add a unique UUID row column as shown in the [example](../examples/integer-primary-key.ts). The companion has a unique `(scope_id,row_id)` B-tree index, one row per parent row, exact B-tree expression indexes, and one multicolumn GIN index across substring token columns. The unique index is used instead of a composite primary key because repeated drizzle-kit 0.31 `push` changed the apparent PK column order; the unique index generated and pushed without drift while preserving the same lookup and conflict target. `sealed.extraMigrationSql(notesSeal)` returns the `SET STATISTICS 1000` statements for substring columns; apply them after the schema migration. The business table has no token columns and no trigger. Package-name schema imports with UUID or `textId` rows, text scopes, and scope-free tables support drizzle-kit `generate`, `migrate`, and repeated `push` without schema drift.

`sealed.textId` declares a `text` column. Row comparisons and keyset ordering follow that column's database collation, including on non-C databases; the parent primary or unique index and companion `(scope_id,row_id)` index remain usable. The `row_id` and `scope_id` named here are companion columns; parent columns keep their application-defined names. Search callbacks must apply the supplied `after` and `orderBy` expressions so cursor pages follow the same database order.

## Writes and reads

```ts
await sealed.insert(db, notesSeal, { id, scopeId, status: 'draft', body: 'Ada' });
await sealed.update(db, notesSeal, { id, scopeId }, { body: 'Ada Lovelace' });
await sealed.upsert(db, notesSeal, { id, scopeId, status: 'active', body: 'Ada' });
const rows = await sealed.open(await db.select().from(notes));
```

The three write helpers use `db.transaction`, so parent and token changes commit together; they also work inside a Drizzle transaction as a savepoint. They return row/scope identities in an array, or decrypted rows when passed `{ returning: true }`. A UUID row ID can be omitted and will be generated; omitting a text row ID is invalid. An `undefined` property is omitted in insert, upsert, or update, matching Drizzle's write behavior. An omitted nullable encrypted field inserts null; an omitted required encrypted field, an update with no remaining fields, or an unknown property is `INVALID_VALUE`. The app may delete through Drizzle; the companion foreign key cascades. Plain Drizzle rejects encrypted-column writes with `SEAL_REQUIRED`, including plaintext and previously read ciphertext handles. Raw SQL encrypted-column writes bypass companion maintenance and can cause search omissions; `reindex` repairs the companion from authenticated parent values. A partial managed update changes only token columns for patched encrypted fields. `reindex(db, notesSeal, { scope?, batch? })` locks parent rows in keyset batches, decrypts them, and rebuilds companion tokens; its result is `{ rows }`. It deletes a companion row when every searchable token column is null. It does not change ciphertext or replace a key rotation. If a top-level transaction reports a commit failure after the write callback completed, the helper raises `WRITE_OUTCOME_UNKNOWN`; the application must reconcile the row before retrying.

`sealed.open` accepts whole, partial, or nested Drizzle result objects and returns decrypted copies. Select the row ID and scope ID under the same property names as the registered table whenever selecting ciphertext. A partial selection or join that omits them fails with `ROW_CONTEXT_MISSING`; if joined tables share names such as `id`, use nested selections (for example `{ n: notes, o: orders }`). The optional `{ scope }` requires every opened row to match the caller's authorized scope. A normal `db.select()` returns ciphertext handles until opened.

For raw `db.execute`, call `sealed.openRaw(notesSeal, result.rows, { columns: { id: 'n_id', scopeId: 'n_scope', body: 'n_body_ct' }, scope })`. The mapping names result columns for row, scope, and encrypted fields. Raw bytea values may be `Uint8Array` or PostgreSQL `\\x` hex text. `openRaw` never mutates its input. The scope and row entries are required; see the [raw example](../examples/standard-raw.ts).

## Search

```ts
const page = await sealed.findMany(db, notesSeal, {
  scope: scopeId,
  match: m => m.or(m.body.contains('Ada'), m.sql(eq(notes.status, 'draft'))),
  columns: { body: true, status: true }, limit: 20,
});
const total = await sealed.count(db, notesSeal, {
  scope: scopeId, match: m => m.body.contains('Ada'), maxCandidates: 10000,
});
```

The result is `{ items, nextCursor }`. In `findMany`, `columns` is a Boolean selection of parent table properties; the result type contains only selected properties plus row and scope IDs. `count` returns an exact `number`; if the candidate or time budget prevents proof, it throws `LIMIT_EXCEEDED`. When a page budget stops verification after at least one row, `findMany` returns a short page and a cursor pointing after the last fully processed row. A cursor must resume the same scope, match, `where`, selection, order, and limit. Separate pages are not a database snapshot. `m.sql` composes ordinary SQL with encrypted conditions, including OR; the SQL expression is evaluated by the DB and its Boolean result is carried as a flag for final verification. The caller must pass safe parameterized Drizzle SQL. Plain `where` is ANDed with the match. An encrypted condition is always authenticated and rechecked inside SealQL.

`sealed.search(db, { scope, match: { n: [notesSeal, m => m.body.contains('Ad')] }, keyset, query })` handles a custom Drizzle JOIN or raw `db.execute` query. The first table listed in `match` sets the page order; list the main table first. The callback receives `{ where, after, orderBy, flags, flagsSql, limit }` and must apply `where`, optional `after`, `orderBy`, and `limit`, plus select `flags` for Drizzle or `flagsSql` for raw SQL. A one-to-many JOIN needs a NOT NULL unique many-side column in `keyset` so each candidate has a distinct position. In `search`, top-level `columns: { n: { id: 'n_id', scopeId: 'n_scope', body: 'n_body_ct' } }` maps registered properties to raw flat result names; it is not the `findMany` projection option. Internal `__seal_` flags and keyset aliases are removed from returned items. A malformed or repeated candidate position raises `INVALID_CANDIDATE_SHAPE`. See the [raw JOIN example](../examples/standard-raw.ts).

Matched sealed tables in one `search` call must either all have a scope or all be scope-free. `alias()` and a self-JOIN of a sealed table are unsupported. An OR branch with `m.sql` can be slow if the ordinary SQL condition lacks an index. The search cursor binds the scope, match, keyset, and limit; it does not bind the callback's SQL, so use the same callback query while paging.

The `db` argument keeps `search` calls consistent with `findMany` and `count`; the supplied `query` callback actually executes the candidate SQL through the caller's database handle. SealQL does not wrap or own that handle.

Search defaults to at most 2,000 candidates, 4 MiB each of fetched, decrypted, and result bytes, a 2-second deadline, and 64 concurrent field authentications. The per-call `budgets` option can raise these only to 20,000 candidates, 32 MiB for each byte budget, a 30-second deadline, and 64 concurrent authentications; `batch` is capped at 500 for pages and 2,000 for count. `count` may scan more than 20,000 candidates through bounded internal pages when its explicit `maxCandidates` permits it. An invalid budget is `INVALID_VALUE`. A page that cannot process even one candidate raises `LIMIT_EXCEEDED`. Candidate fields are authenticated first; remaining selected fields are opened only for matches. A call-scoped cache reuses authentication of the same model, row, and field in a 1:N JOIN.

Searchable text folds NFC, full-width ASCII, ASCII case, and whitespace as specified by the token profile. `contains`, `startsWith`, `endsWith`, and `like` require at least two normalized characters. `like` follows SealQL's supported substring pattern semantics, not arbitrary PostgreSQL `LIKE` syntax; confirm the pattern before replacing a SQL `LIKE` predicate. Drizzle's `like`/`ilike` on a sealed column can pass type checking and silently return no rows; use the match builder for encrypted fields. Substring profiles include one-character-gap pieces by default; `substring: { skipGrams: false }` disables them. Changing search profile options requires rebuilding stored tokens. Exact tokens may use 8–32 bits; substring tokens remain 16 bits. Token matches are candidates only, so collisions may increase decrypted rows but cannot authorize a false result.

## Limits and security

The database sees deterministic token frequency and co-occurrence, ciphertext length, query and update patterns, and result volume. A hostile database can omit rows; complete answers are not guaranteed under that attacker. Avoid substring search on low-vocabulary fields such as status values or short choice lists: known plaintext can reveal far more than for varied prose. Encrypted fields cannot be used for range queries, sorting, or SUM/AVG/GROUP BY. There is no one-character search or stateful mode. The [threat model](threat-model.md), [claim limits](decisions/010-security-claim-limits.md), and [mechanical attack method](attack-simulation.md) delimit security claims. Historical fixture [measurements](../bench/README.md) are experimental and do not establish deployment performance.

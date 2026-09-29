# SealQL integration

SealQL keeps selected PostgreSQL fields encrypted while supporting exact and substring filters through ordinary Drizzle tables. AES-GCM authenticates returned field values with row/scope binding; HMAC candidates and salted proofs let PostgreSQL finish predicates without receiving the root key or decrypting fields. This guide describes the experimental Drizzle ORM 0.45 API. The compilable [schema and key example](../examples/standard-consumer.ts), [managed operations](../examples/standard-operations.ts), [raw SQL example](../examples/standard-raw.ts), and [key loader](../examples/key-loader.ts) show the calls in context.

## Install and driver

SealQL is not published to the npm registry. Run `npm pack` in a checkout and install the resulting `.tgz` in the application. It requires `drizzle-orm >=0.45.2 <0.46` and Node `>=22.12` or a compatible WebCrypto runtime. For Cloudflare Workers, choose a transactional PostgreSQL driver. Node pg and postgres-js, plus local workerd with pg, passed [the same real database flow](../bench/results/2026-09-29-r9/report-ko.md); actual Cloudflare deployment, including Hyperdrive, remains unverified. `neon-http` cannot perform managed writes or `reindex` because it lacks the required transaction callback. Keep the fixed key in application secret storage and configure it once at startup, before data operations.

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

Export both the parent and returned companion table in the schema read by drizzle-kit. The key can load lazily through `createSealed({ sealer: () => sealer })`, allowing drizzle-kit to import the schema without secret access; data operations still require the key. `sealed.text`, `integer`, `bigint`, `decimal`, `boolean`, `instant`, `json`, and `bytes` build encrypted columns. They accept field options such as `nullable`, physical `column`, `maxBytes` (optional caller limit, with no library default or maximum), stable field `id`, `validate`, and eligible `search` profiles. `decimal` also requires `precision` and `scale`. The property name is not the field ID: the builder's first argument sets the default field ID and physical column name (`body_ct`). A renamed property can therefore keep its cipher context by retaining that first argument. Row IDs use UUID or `sealed.textId` (`text` ordered by the database column's collation); scope IDs use UUID or text. A scope-free table uses the constant scope `_` in AAD, tokens, and cursors. Adding a scope to one later requires re-encryption and reindexing all rows, and puts them in a new token space.

The parent row ID must already be unique or primary, or its `(scope,row)` pair must be unique. The companion foreign key refers to the parent row ID when it is unique, otherwise the pair. No extra parent unique constraint is needed for a normal `id` primary key. For an integer auto-increment primary key, add a unique UUID row column as shown in the [example](../examples/integer-primary-key.ts). The companion has a unique `(scope_id,row_id)` B-tree index, one row per parent row, exact B-tree expression indexes, and one multicolumn GIN index across substring token columns. The unique index is used instead of a composite primary key because repeated drizzle-kit 0.31 `push` changed the apparent PK column order; the unique index generated and pushed without drift while preserving the same lookup and conflict target. `sealed.extraMigrationSql(notesSeal)` returns DB predicate functions, substring statistics, and MAIN storage statements; apply them after the schema migration. The business table has no token columns and no trigger. Package-name schema imports with UUID or `textId` rows, text scopes, and scope-free tables support drizzle-kit `generate`, `migrate`, and repeated `push` without schema drift.

`sealed.textId` declares a `text` column. Empty text IDs are allowed; NUL remains forbidden. Row comparisons and keyset ordering follow that column's database collation, including on non-C databases; the parent primary or unique index and companion `(scope_id,row_id)` index remain usable. The `row_id` and `scope_id` named here are companion columns; parent columns keep their application-defined names. Search callbacks must apply the supplied `after` and `orderBy` expressions so cursor pages follow the same database order.
The parent row and scope columns must use the same collation as their companion columns; using `sealed.textId` and the generated companion table without manual collation changes satisfies this. For `search` positions containing text, SealQL checks each candidate batch against the database column order with one additional SQL request per batch; an out-of-order batch raises `INVALID_CANDIDATE_SHAPE`.

## Writes and reads

```ts
await sealed.insert(db, notesSeal, { id, scopeId, status: 'draft', body: 'Ada' });
await sealed.update(db, notesSeal, { id, scopeId }, { body: 'Ada Lovelace' });
await sealed.upsert(db, notesSeal, { id, scopeId, status: 'active', body: 'Ada' });
const rows = await sealed.open(await db.select().from(notes));
```

The three write helpers use `db.transaction`, so parent, token, and proof changes commit together; they also work inside a Drizzle transaction as a savepoint. They return row/scope identities in an array, or decrypted rows when passed `{ returning: true }`. A UUID row ID can be omitted and will be generated; omitting a text row ID is invalid. An `undefined` property is omitted in insert, upsert, or update, matching Drizzle's write behavior. An omitted nullable encrypted field inserts null; an omitted required encrypted field, an update with no remaining fields, or an unknown property is `INVALID_VALUE`. The app may delete through Drizzle; the companion foreign key cascades. Plain Drizzle rejects encrypted-column writes with `SEAL_REQUIRED`, including plaintext and previously read ciphertext handles. Raw SQL encrypted-column writes bypass companion maintenance and can cause search omissions; `reindex` repairs the companion from authenticated parent values. A partial managed update changes only token/proof columns for patched encrypted fields. `reindex(db, notesSeal, { scope?, batch? })` (batch is optional and has no library maximum) locks parent rows in keyset batches, decrypts them, and rebuilds companion tokens and proofs; its result is `{ rows }`. It deletes a companion row when every searchable token column is null. It does not change ciphertext or replace a key rotation. If a top-level transaction reports a commit failure after the write callback completed, the helper raises `WRITE_OUTCOME_UNKNOWN`; the application must reconcile the row before retrying.

`sealed.open` accepts whole, partial, or nested Drizzle result objects and returns decrypted copies. Select the row ID and scope ID under the same property names as the registered table whenever selecting ciphertext. A partial selection or join that omits them fails with `ROW_CONTEXT_MISSING`; if joined tables share names such as `id`, use nested selections (for example `{ n: notes, o: orders }`). The optional `{ scope }` requires every opened row to match the caller's authorized scope. A normal `db.select()` returns ciphertext handles until opened.

For raw `db.execute`, call `sealed.openRaw(notesSeal, result.rows, { columns: { id: 'n_id', scopeId: 'n_scope', body: 'n_body_ct' }, scope })`. The mapping names result columns for row, scope, and encrypted fields. Raw bytea values may be `Uint8Array` or PostgreSQL `\\x` hex text. `openRaw` never mutates its input. The scope and row entries are required; see the [raw example](../examples/standard-raw.ts).

A driver without a transaction callback, or one that explicitly reports unsupported transactions before entering the callback without a server SQLSTATE, raises `UNSUPPORTED_DRIVER` for managed writes and `reindex`. Server errors with SQLSTATE are classified as database errors.

Await a Drizzle query before passing its result to `sealed.open` or `sealed.openRaw`; Promise and thenable inputs raise `INVALID_VALUE` with “await the query”. The optional fourth `openRaw` argument is an internal per-call authentication cache used by `search`; application calls should omit it.

`reindex` processes 1,000 rows per batch by default. Callers may supply another batch size with no library maximum; the batch size does not limit the total number of rows rebuilt.

## Search

```ts
const page = await sealed.findMany(db, notesSeal, {
  scope: scopeId,
  match: m => m.or(m.body.contains('Ada'), m.sql(eq(notes.status, 'draft'))),
  columns: { body: true, status: true }, limit: 20,
});
const total = await sealed.count(db, notesSeal, {
  scope: scopeId, match: m => m.body.contains('Ada'),
});
```

The result is `{ items, nextCursor }`. In `findMany`, `columns` selects parent properties; row and scope IDs are always included. Omitting `limit` returns all matches. `count` executes one scalar SQL query, opens no fields, and returns an exact `number`; caller deadline exhaustion or a result above `Number.MAX_SAFE_INTEGER` raises `LIMIT_EXCEEDED`. There is no default work limit. A projection budget can return a short page with a cursor after the last fully processed row; no processed row means `LIMIT_EXCEEDED`. Cursors bind scope, match, `where`, and order; selection and limit may change. They do not expire and are not snapshots. `m.sql` composes safe parameterized ordinary SQL, including OR, directly into the DB predicate. Plain `where` is ANDed with it. Condition fields need not be projected or decrypted.

`sealed.search(db, { scope, match: { n: [notesSeal, m => m.body.contains('Ad')] }, keyset, query })` handles a custom Drizzle JOIN or raw `db.execute` query. The first table listed in `match` sets the page order; list the main table first. The callback receives `{ where, after, orderBy, flags, flagsSql, limit }` and must apply `where`, optional `after`, `orderBy`, and a defined `limit`, plus select `flags` for Drizzle or `flagsSql` for raw SQL. When `limit` is undefined, omit SQL LIMIT and return all final matching rows. A one-to-many JOIN needs a unique many-side column in `keyset` so each candidate has a distinct position. In `search`, top-level `columns: { n: { id: 'n_id', scopeId: 'n_scope', body: 'n_body_ct' } }` maps registered properties to raw flat result names; it is not the `findMany` projection option. Internal `__seal_` flags and keyset aliases are removed from returned items. A malformed or repeated candidate position raises `INVALID_CANDIDATE_SHAPE`. See the [raw JOIN example](../examples/standard-raw.ts).

Matched sealed tables in one `search` call must either all have a scope or all be scope-free. `alias()` and a self-JOIN of a sealed table are unsupported. An OR branch with `m.sql` can be slow if the ordinary SQL condition lacks an index. The search cursor binds the scope, match, and keyset; it does not bind the callback's SQL, so use the same callback query while paging.

The `db` argument keeps `search` calls consistent with `findMany` and `count`; the supplied `query` callback actually executes the candidate SQL through the caller's database handle. SealQL does not wrap or own that handle.

Search has no default byte or time budget and no library maximum. List `budgets` accepts `batch` (number of final DB matches fetched per request), `fetchBytes`, `decryptedBytes`, `resultBytes`, `deadlineMs`, and `decryptConcurrency` (default 64). A finite page defaults to its requested limit per batch. Only projected encrypted values are authenticated; a call-scoped cache reuses that authentication across duplicate 1:N JOIN rows. `count` accepts only `budgets: { deadlineMs }` and `signal`; `maxCandidates` and count byte/batch/decryption budgets were removed. Invalid budget keys or values raise `INVALID_VALUE`. Deadline/signal checks surround asynchronous work; use the driver/database statement timeout to interrupt a running SQL statement.

Searchable text folds NFC, full-width ASCII, ASCII case, and whitespace according to its profile. `contains`, `startsWith`, and `endsWith` require at least two normalized characters; `eq` also accepts empty and one-character values. Substring profiles include one-character-gap candidate pieces by default; `substring: { skipGrams: false }` disables those pieces. Exact token widths accept 2–32 bits, default 16; substring tokens stay 16 bits. For low-cardinality choices where substring search is unnecessary, explicitly use `search: { exact: { bits: 2 } }`: more values share candidate buckets, and row proofs still decide equality. This does not hide lengths, frequencies, or query keys. `exactBitsForPopulation` is unchanged (minimum population 512, recommended width at least 8). Profile changes require rebuilding tokens and proofs. Token collisions increase DB work; the independent 64-bit proof collision probability is small but nonzero.

`findMany` accepts `scope` (required for a scoped table), `match`, `where`, `columns`, `orderBy`, `limit`, `cursor`, `budgets`, and `signal`. Use `orderBy: { column, direction: 'asc' | 'desc' }` or an array of those entries with unencrypted sortable columns, including nullable columns. PostgreSQL NULL order applies, and SealQL adds the row ID as a final tie breaker. Continue with `cursor: page.nextCursor`; `columns` selects returned properties, `budgets` bounds work, and `signal` cancels it. `contains(value, { respectWords: true })` requires `search: { substring: { wordBoundary: true } }`, otherwise it raises `UNSUPPORTED_SEARCH`. `m.like` supports `%` for zero or more characters, `_` for one character, and backslash escapes for `%`, `_`, and `\`; at least one literal run needs two normalized characters.

Drizzle's `eq` on a sealed column raises `SEAL_REQUIRED`; `like`/`ilike` can silently return zero; `orderBy(asc(sealedColumn))` can silently sort ciphertext into a meaningless order. Never use ordinary Drizzle predicates or ordering on encrypted columns. String conversion or JSON serialization of an unopened encrypted handle raises `SEAL_REQUIRED`; do not log such handles.

Limited pages fetch final DB matches in finite batches. The small-page path tests a 256-row prefix with the final predicate before LIMIT; fallback also judges before LIMIT. There is no candidate growth/retry engine. Custom JOIN callbacks still apply the supplied flags/keysets; these carry DB results and cursor data, not app predicate verification. Date/timestamp positions use DateStyle-independent database text.

## Migrations and searchable field changes

After `drizzle-kit generate`, run `drizzle-kit generate --custom --name seal_search`, paste every statement returned by `sealed.extraMigrationSql(notesSeal)` into that custom migration, then migrate. With `push`, execute those statements after the push. They install schema-qualified immutable, parallel-safe invoker functions, statistics targets, and MAIN storage for candidate tokens and compact proof arrays. No extension is needed; PostgreSQL built-in SHA-256 is used. The statements are idempotent and repeated kit push preserves the settings. Reapply them for changed fields/profiles. MAIN affects newly written values; completing `sealed.reindex` rewrites existing companion values (PostgreSQL `REINDEX` alone does not). A config for a dedicated schema can set `schemaFilter`, `migrations.schema`, and `tablesFilter` together:

```ts
export default defineConfig({
  dialect: 'postgresql', schema: './src/schema.ts', out: './drizzle',
  schemaFilter: ['app'], migrations: { schema: 'app' },
  tablesFilter: ['!__drizzle_migrations'],
});
```

Import `defineConfig` from `drizzle-kit`. When using `pgSchema`, check where the migration journal is created; moving the journal into the application schema can make an existing `CREATE SCHEMA` migration conflict. `push` may propose deleting the journal table unless excluded with `tablesFilter` as above.

When adding `search` to an existing encrypted field or changing its profile, deploy in this order: **(1) schema migration, (2) `extraMigrationSql` statements, (3) complete `reindex`, (4) deploy code that searches the new field**. **Before step 4, searching or counting on the new profile silently omits existing rows, possibly returning zero.** The companion has token and proof columns but no persisted profile version or completion marker, so a query cannot cheaply tell whether all old rows were rebuilt. A per-query parent scan would be expensive. Generated migrations may drop and recreate the GIN index without `CONCURRENTLY`; on a large table, allow for locking and rebuild time (estimate, not measured here).

## Error codes

`SealError.code` is stable for handling errors; `message` gives short context. Database errors expose only a sanitized driver summary in `cause`, without SQL parameters or server detail. Logging `code`, `message`, and `cause.code`/`cause.constraint` is sufficient for diagnosis.

| Code | Meaning and common cause |
|---|---|
| `SEAL_REQUIRED` | Plain Drizzle write or string/JSON serialization of an unopened encrypted handle. Avoid logging unopened handles. |
| `INVALID_VALUE` | Invalid value, option, budget, or an unawaited query passed to `open`/`openRaw`. |
| `INVALID_SCHEMA` | Registration, column, or companion metadata does not match requirements. |
| `NOT_FOUND` | Managed update target is absent. |
| `SCOPE_CONFLICT` | Upsert conflicts with a row in another scope. |
| `SCOPE_MISMATCH` | Opened row differs from the authorized scope. |
| `ROW_CONTEXT_MISSING` | Selected encrypted field lacks its registered row or scope property. |
| `LIMIT_EXCEEDED` | Caller byte/time budget was exceeded, or count exceeds the safe integer range. |
| `QUERY_TOO_BROAD` | Search lacks at least two usable normalized characters. |
| `CURSOR_INVALID` | Cursor is malformed or does not match the query. |
| `CURSOR_EXPIRED` | Reserved for earlier cursor formats; current cursors do not expire. |
| `INVALID_QUERY` | Invalid SQL fragment template. |
| `VALIDATION_FAILED` | Application field validator rejected a value. |
| `INVALID_CIPHERTEXT` | Decrypted field bytes are malformed or noncanonical. |
| `KEY_NOT_FOUND` | The configured key is unavailable. |
| `KEY_SCOPE_MISMATCH` | Key scope does not match the field or cursor context. |
| `UNSUPPORTED_SEARCH` | Field lacks the selected search profile; `respectWords` needs `substring: { wordBoundary: true }`. |
| `UNSUPPORTED_DRIVER` | Driver lacks a transaction callback or explicitly rejects transactions before the callback without a server SQLSTATE. |
| `INVALID_CANDIDATE_SHAPE` | Candidate query omitted, duplicated, or misordered keyset data. |
| `AUTHENTICATION_FAILED` | Ciphertext could not be authenticated in its row context. |
| `WRITE_OUTCOME_UNKNOWN` | Commit failed after a managed write callback; reconcile before retry. |
| `DATABASE_ERROR` | Other database failure; inspect `cause`. |
| `CONSTRAINT_VIOLATION` | Database unique, foreign key, null, or check constraint failed. |
| `TRANSACTION_CONFLICT` | Serialization failure or deadlock. |
| `DB_TIMEOUT` | Database cancelled or timed out a statement. |
| `CANCELLED` | Search `signal` was aborted. |
| `INVALID_ID` | Row or scope ID has an invalid form (including NUL). |

## Limits and security

The database sees deterministic token frequency/co-occurrence, ciphertext and normalized text lengths, shuffled positions, query/update patterns, and result volume. Optional words proofs also disclose the normalized-space count through length differences (phone normalization also removes punctuation); singleton LIKE proofs disclose every compact position. Query value/piece keys are sent to PostgreSQL and can reveal every occurrence of an observed piece across accessible rows. Disable bind-parameter logging in PostgreSQL, drivers, proxies, and telemetry, including error paths. The root and encryption keys remain in the app. A hostile DB can omit matches or falsify predicate results even while returning authentic ciphertext; there is no cryptographic proof of SQL execution or completeness. Avoid substring search on low-vocabulary fields. Range queries, encrypted sorting, SUM/AVG/GROUP BY, and standalone one-character substring queries are unsupported. The [threat model](threat-model.md), [claim limits](decisions/010-security-claim-limits.md), and [mechanical attack method](attack-simulation.md) delimit claims. Fixture [measurements](../bench/README.md) are not deployment guarantees.

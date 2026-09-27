# SealQL integration

This guide describes the current experimental implementation. Use the compilable [Drizzle consumer](../examples/standard-consumer.ts), [raw PostgreSQL consumer](../examples/standard-raw.ts), [key loader](../examples/key-loader.ts), and [operations example](../examples/standard-operations.ts) as references.

## Imports and schema

The root `sealql` export supplies `createSealer`, codecs, search helpers, and `SealError`. `sealql/drizzle/v0.45` supplies `ciphertext`, `defineSealed`, `defineSealStorage`, `drizzleExecutor`, and `bindSealed`. `sealql/postgres` supplies `defineSealedModel`, `definePostgresStorage`, `postgresExecutor`, `pgSql`, and `bindSealed`.

Declare a business table with a scope ID, row ID, non-null bigint revision, and `ciphertext` bytea columns. Make `(scope,row)` unique. The Drizzle definition supplies logical model and field IDs. `defineSealStorage(definition)` returns the companion table to export to Drizzle Kit. The raw builder returns a DDL manifest for explicit review and application. Each companion row has `scope_id`, `row_id`, and nullable token columns for configured profiles. Exact profiles use separate B-tree expression indexes. All substring token columns share one multicolumn GIN index (a single-column GIN if there is only one substring field); raw DDL keeps the elevated statistics target on each substring column. The business table has no token columns. Only `companion-v1` is supported.

Adding a searchable field to an existing companion needs a staged database change. Add its nullable token column first, arrange for new writes to populate it, then backfill existing rows by authenticated decryption and token generation. Keep searches on that field closed until backfill is complete: opening them earlier can omit rows. Build a replacement GIN including the new column with `CREATE INDEX CONCURRENTLY` outside a transaction, then drop the old GIN. To remove a field, build a replacement GIN excluding its column concurrently, drop the old GIN, then drop the column. PostgreSQL drops an index containing a column when that column is dropped, so the replacement must exist first. The field's exact B-tree index and application model/DDL must be updated as applicable. Coordinate application writes and schema deployment so every live writer uses the matching field definition throughout the transition.

```ts
const [key, sensitiveKey] = await Promise.all([
  secretManager.load('sealql/global'), secretManager.load('sealql/sensitiveNote'),
]);
const sealer = createSealer({ key, models: { sensitiveNote: { key: sensitiveKey } } });
const notes = bindSealed({ sealer, definition, storage, executor });
const scoped = notes.forScope({ scopeId });
```

The fixed global key is the default. The `models` map selects a distinct fixed key for a logical model. Load keys from a secret manager before creating the sealer. Data scope remains the SQL isolation boundary and is supplied by `forScope`; authorize it in the application. There is no database key registration, canary, policy generation, or admin provisioning. A model key configuration cannot search across unrelated key configurations. If a key must change, the application must re-encrypt and reindex all data.

## Writes and reads

```ts
await scoped.insert({ id, data: { body: 'Ada', status: 'open' } });
const row = await scoped.get({ id });
await scoped.update({ id, expectedRevision: 1n, patch: { body: 'Ada Lovelace' } });
await scoped.delete({ id, expectedRevision: 2n });
const page = await scoped.findMany({
  match: f => f.body.contains('Ada'), select: { body: true }, limit: 20,
});
const next = page.nextCursor
  ? await scoped.findMany({ match: f => f.body.contains('Ada'), select: { body: true }, limit: 20, cursor: page.nextCursor })
  : null;
const total = await scoped.count({ match: f => f.body.contains('Ada'), maxCandidates: 10000 });
```

Managed writes use a transaction for the parent row compare and swap and companion update. A partial update changes only affected token columns in the single companion row, preserving mixed-field AND search. Delete cascades through the parent foreign key. Native SQL or Drizzle updates of ciphertext do not maintain the companion. A `findMany` page returns `items`, `nextCursor`, and `stopReason` (`page-full`, `exhausted`, or `budget-exceeded`). Keep match, public filter, selection, order, and limit stable when resuming. There is no offset pagination. `budgets.decryptConcurrency` limits concurrent authenticated field decryptions (default and maximum 64). `count` checks all candidates and returns an exact number; a `maxCandidates` or deadline bound throws `LIMIT_EXCEEDED`.

Searchable text is normalized to NFC, full-width ASCII is folded, ASCII capitals are lowered, and whitespace is removed for substring pieces. `contains`, `startsWith`, `endsWith`, and `like` require at least two normalized characters. Each stored value has adjacent two-character pieces and structurally separate start/end markers. `substring: true` and substring objects that omit `skipGrams` also store one-character-gap pieces by default. Set `substring: { skipGrams: false }` to omit them. `substring: { wordBoundary: true }` adds word markers; `contains(value, { respectWords: true })` enforces spacing. These options affect the stored index and require rebuilding it if changed. Substring tokens stay at 16 bits. Exact tokens default to 16 bits, accept 8–32 bits, and `exactBitsForPopulation(P)` returns a width from the expected maximum distinct values.

In an earlier local 100,000-row comparison using per-field GIN indexes, the companion occupied 211 MB with skip grams off and 305 MB with them on ([storage measurement](../bench/results/2026-09-27-combined-gin/storage.json)); median single-row insert time was 4.65 ms versus 6.16 ms ([write measurement](../bench/results/2026-09-27-skip-write-cost/report-ko.md)). These historical fixture measurements describe the storage and write cost of skip grams in that layout; they are not deployment guarantees. A [new DDL check](../bench/results/2026-09-27-product-multicolumn-gin/report-ko.md) measures the current multicolumn GIN layout.

`searchWithQuery` supports a custom Drizzle query or raw SQL JOIN, and `decryptRows` handles already fetched joined rows. These paths still authenticate ciphertext; `searchWithQuery` verifies match predicates. `decryptRows` accepts `budgets.decryptConcurrency` (default and maximum 64) across all supplied rows and fields. Bound extra projections with `maxBytes`. Ordinary `db.select()` returns ciphertext.

## Limits and security

The database sees deterministic token frequency, co-occurrence, result volume, and timing. Token collisions can add candidates; SealQL decrypts and verifies results before returning them. A malicious database can omit rows, so completeness is not guaranteed. A cursor spans separate SQL requests and does not create a snapshot. Search has candidate, byte, deadline, and cancellation budgets. Encrypted fields cannot serve database range queries, sort keys, or SUM/AVG/GROUP BY calculations. Store fields requiring exact database calculations unencrypted. Avoid substring search on low-vocabulary fields (status values, short choice lists): their tokens leak far more under known-plaintext attacks. `findMany` cannot yet express OR between a plain column and an encrypted condition. There is no stateful search mode. See the [threat model](threat-model.md), [security claim limits](decisions/010-security-claim-limits.md), and the [attack simulation method](attack-simulation.md).

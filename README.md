# SealQL (experimental)

SealQL encrypts selected PostgreSQL fields while keeping ordinary SQL and Drizzle integration. The `standard` path uses HMAC tokens and GIN/B-tree indexes to narrow candidates, then per-row salted proofs finish predicates inside PostgreSQL. Count returns one exact number; lists authenticate and decrypt only projected fields. AES-256-GCM still binds ciphertext to its row, field, and scope. Read the [integration guide](docs/llm-integration.md), [current state](docs/current-state.md), and [schema example](examples/standard-consumer.ts).

The package is not on the npm registry. For an application, install a tarball made with `npm pack`; use `npm ci && npm run build` when developing this repository. Peer dependency: `drizzle-orm >=0.45.2 <0.46`; runtime: Node `>=22.12` or compatible WebCrypto. In Workers, use a PostgreSQL driver with transactions. Node pg and postgres-js, plus local workerd with pg, passed [the same real database flow](bench/results/2026-09-29-r9/report-ko.md); actual Cloudflare deployment, including Hyperdrive, remains unverified. `neon-http` cannot run managed writes because it has no transaction callback. Public exports are `sealql` and `sealql/drizzle/v0.45`.

```ts
import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

const rootKey = await loadFixedKey(); // app-supplied 32-byte Uint8Array
const sealed = createSealed({ sealer: createSealer({ key: rootKey }) });
export const notes = pgTable('notes', {
  id: uuid('id').primaryKey(),
  body: sealed.text('body', { search: { exact: true, substring: true } }),
});
export const notesSeal = sealed.register(notes, { row: 'id' });
// Export both notes and notesSeal to drizzle-kit.
// Migrate, execute sealed.extraMigrationSql(notesSeal), then reindex existing rows.

await sealed.insert(db, notesSeal, { id: crypto.randomUUID(), body: 'Ada' });
const page = await sealed.findMany(db, notesSeal, {
  match: m => m.body.contains('Ad'), limit: 20,
});
const rows = await sealed.open(await db.select().from(notes));
```

Use `sealed.insert`, `update`, or `upsert` for encrypted writes; they update parent ciphertext and companion tokens and proofs in a transaction. An `undefined` property is omitted; an omitted nullable encrypted field inserts `null`, while an omitted required encrypted field is invalid. Plain Drizzle encrypted-column writes raise `SEAL_REQUIRED`. Raw SQL encrypted-column writes bypass token maintenance and can cause search omissions; use `reindex` to repair the companion. Ordinary Drizzle reads return ciphertext handles, and `sealed.open` returns decrypted copies. A partial selection must include the registered row and scope columns under their registered property names. For `db.execute` results, pass a property-to-column map to `sealed.openRaw`. Ordinary Drizzle deletes cascade to the companion through its foreign key.

Search supports exact and substring predicates, Boolean combinations, and `m.sql(...)` for ordinary SQL predicates. `sealed.search` accepts a Drizzle or raw SQL candidate query for joins; the callback must apply the supplied `where`, `after`, ordering, flags, and optional limit (omit SQL LIMIT when it is undefined). The first table listed in `match` sets the page order; list the main table first. A 1:N join needs a unique keyset column from the many-side table. `findMany` and `search` return all matches when `limit` is omitted. `count` returns an exact `number`; caller supplied budgets can cause `LIMIT_EXCEEDED`. Substring queries need at least two normalized characters; exact equality also accepts empty and one-character values. Encrypted fields do not support range filters, sorting, or database aggregation.

Use SealQL's `m.field.like(...)` for encrypted predicates. Drizzle's `eq` on an encrypted column raises `SEAL_REQUIRED`; `like`/`ilike` can type-check yet silently return no rows; `orderBy(asc(encryptedColumn))` can silently sort ciphertext. Do not use Drizzle predicates or ordering on encrypted columns. The package schema supports drizzle-kit `generate`, `migrate`, and repeated `push` for UUID or `textId` rows, text scopes, and scope-free tables. See the [integer primary-key example](examples/integer-primary-key.ts) for adding a UUID row column.

The database sees token frequency, co-occurrence, normalized lengths, position permutations, and query/update patterns. Query parameters include value or piece keys that let an observer recover occurrences of those pieces; disable parameter logging in the database, driver, and telemetry. A hostile DB can omit rows or falsify condition results; ciphertext authentication does not authenticate SQL results. Keyless full-record theft resistance remains unproven. Avoid substring indexes for low-vocabulary fields; explicit `exact: { bits: 2 }` makes their candidate buckets coarser while final proofs decide equality. The default stays 16 bits. See the [threat model](docs/threat-model.md). Historical [measurements](bench/README.md) do not predict deployment performance.

## Documents

| Document | Purpose |
|---|---|
| [Integration guide](docs/llm-integration.md) | API, schema, writes, reads, search, and operational limits |
| [Current state](docs/current-state.md) | Implemented code and verification status |
| [Decisions](docs/decisions/README.md) | Design choices and evidence |
| [Plan](plan/README.md) | Work still in progress |
| [Contributor rules](AGENTS.md) | Safety and verification rules |

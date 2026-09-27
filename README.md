# SealQL (experimental)

SealQL encrypts selected PostgreSQL fields and searches them through a separate HMAC token table. The `standard` path uses GIN/B-tree candidate indexes and authenticates each candidate before returning it. The current integration is Drizzle ORM 0.45 on Node 22+ or a WebCrypto runtime. Read the [integration guide](docs/llm-integration.md), [current state](docs/current-state.md), and [schema example](examples/standard-consumer.ts).

The package is not on the npm registry. For an application, install a tarball made with `npm pack` or use a Git dependency; use `npm ci && npm run build` when developing this repository. Peer dependency: `drizzle-orm >=0.45.2 <0.46`; runtime: Node `>=22.12` or compatible WebCrypto. In Workers, use a PostgreSQL driver with transactions (pg with Workers sockets or postgres-js); neon-http cannot run managed writes because it has no transaction callback. Public exports are `sealql` and `sealql/drizzle/v0.45`.

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

await sealed.insert(db, notesSeal, { body: 'Ada' });
const page = await sealed.findMany(db, notesSeal, {
  match: m => m.body.contains('Ad'), limit: 20,
});
const rows = await sealed.open(await db.select().from(notes));
```

Use `sealed.insert`, `update`, or `upsert` for encrypted writes; they update parent ciphertext and companion tokens in a transaction. An `undefined` property is omitted; an omitted nullable encrypted field inserts `null`, while an omitted required encrypted field is invalid. Plain Drizzle encrypted-column writes raise `SEAL_REQUIRED`. Raw SQL encrypted-column writes bypass token maintenance and can cause search omissions; use `reindex` to repair the companion. Ordinary Drizzle reads return ciphertext handles, and `sealed.open` returns decrypted copies. A partial selection must include the registered row and scope columns under their registered property names. For `db.execute` results, pass a property-to-column map to `sealed.openRaw`. Ordinary Drizzle deletes cascade to the companion through its foreign key.

Search supports exact and substring predicates, Boolean combinations, and `m.sql(...)` for ordinary SQL predicates. `sealed.search` accepts a Drizzle or raw SQL candidate query for joins; the callback must apply the supplied `where`, `after`, ordering, flags, and limit. The first table listed in `match` sets the page order; list the main table first. A 1:N join needs a unique keyset column from the many-side table. `findMany` returns `{ items, nextCursor }`; `count` returns an exact `number` or throws `LIMIT_EXCEEDED`. Search needs at least two normalized characters. Encrypted fields do not support range filters, sorting, or database aggregation.

Use SealQL's `m.field.like(...)` for encrypted predicates. Drizzle's `eq` on an encrypted column raises `SEAL_REQUIRED`; `like`/`ilike` can type-check yet silently return no rows; `orderBy(asc(encryptedColumn))` can silently sort ciphertext. Do not use Drizzle predicates or ordering on encrypted columns. The package schema supports drizzle-kit `generate`, `migrate`, and repeated `push` for UUID or `textId` rows, text scopes, and scope-free tables. See the [integer primary-key example](examples/integer-primary-key.ts) for adding a UUID row column.

The database can observe deterministic token frequency, co-occurrence, ciphertext length, and query patterns, and a hostile database can omit rows. Keyless theft resistance for full records is not established by current evidence. Avoid substring indexes on low-vocabulary fields such as status or short choices. See the [threat model](docs/threat-model.md) and [mechanical attack method](docs/attack-simulation.md). If the fixed key changes, the application must re-encrypt all data and rebuild the index. Historical [measurements](bench/README.md) are experimental and do not predict deployment performance.

## Documents

| Document | Purpose |
|---|---|
| [Integration guide](docs/llm-integration.md) | API, schema, writes, reads, search, and operational limits |
| [Current state](docs/current-state.md) | Implemented code and verification status |
| [Decisions](docs/decisions/README.md) | Design choices and evidence |
| [Plan](plan/README.md) | Work still in progress |
| [Contributor rules](AGENTS.md) | Safety and verification rules |

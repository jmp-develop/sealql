# SealQL (experimental)

SealQL encrypts selected PostgreSQL fields and searches them through a separate HMAC token table. The `standard` path uses GIN/B-tree candidate indexes and authenticates each candidate before returning it. The current integration is Drizzle ORM 0.45 on Node 22+ or a WebCrypto runtime. Read the [integration guide](docs/llm-integration.md), [current state](docs/current-state.md), and [schema example](examples/standard-consumer.ts).

Install with `npm ci && npm run build`. Public exports are `sealql` and `sealql/drizzle/v0.45`.

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

Use `sealed.insert`, `update`, or `upsert` for encrypted writes; they update parent ciphertext and companion tokens in a transaction. Ordinary Drizzle reads return ciphertext handles, and `sealed.open` returns decrypted copies. For `db.execute` results, pass a property-to-column map to `sealed.openRaw`. Plain Drizzle writes to encrypted columns and raw SQL writes to them bypass token maintenance. Ordinary Drizzle deletes cascade to the companion through its foreign key.

Search supports exact and substring predicates, Boolean combinations, and `m.sql(...)` for ordinary SQL predicates. `sealed.search` accepts a Drizzle or raw SQL candidate query for joins; the callback must apply the supplied `where`, `after`, ordering, flags, and limit. A 1:N join needs a unique keyset column from the many-side table. `findMany` returns `{ items, nextCursor }`; `count` returns an exact `number` or throws `LIMIT_EXCEEDED`. Search needs at least two normalized characters. Encrypted fields do not support range filters, sorting, or database aggregation.

The database can observe deterministic token frequency, co-occurrence, ciphertext length, and query patterns, and a hostile database can omit rows. Keyless theft resistance for full records is not established by current evidence. Avoid substring indexes on low-vocabulary fields such as status or short choices. See the [threat model](docs/threat-model.md) and [mechanical attack method](docs/attack-simulation.md). If the fixed key changes, the application must re-encrypt all data and rebuild the index. Historical [measurements](bench/README.md) are experimental and do not predict deployment performance.

## Documents

| Document | Purpose |
|---|---|
| [Integration guide](docs/llm-integration.md) | API, schema, writes, reads, search, and operational limits |
| [Current state](docs/current-state.md) | Implemented code and verification status |
| [Decisions](docs/decisions/README.md) | Design choices and evidence |
| [Plan](plan/README.md) | Work still in progress |
| [Contributor rules](AGENTS.md) | Safety and verification rules |

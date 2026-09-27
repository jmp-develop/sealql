# SealQL (experimental)

SealQL manages encrypted PostgreSQL fields and searchable HMAC companion indexes. The `standard` search path uses truncated tokens, PostgreSQL GIN, and authenticated plaintext verification inside the library. It supports Drizzle ORM 0.45 and raw PostgreSQL on Node 22+ and Cloudflare Workers (WebCrypto only, no native modules). See the [integration guide](docs/llm-integration.md), [current state](docs/current-state.md), and [Drizzle](examples/standard-consumer.ts) or [raw SQL](examples/standard-raw.ts) examples.

Install from this checkout with Node 22 or newer: `npm ci && npm run build`. Drizzle is an optional peer. The exports are `sealql`, `sealql/drizzle/v0.45`, and `sealql/postgres`.

## Setup

```ts
import { createSealer } from 'sealql';
import { bindSealed, defineSealed, defineSealStorage } from 'sealql/drizzle/v0.45';

const definition = defineSealed(table, {
  id: 'note', identity: { scope: 'scopeId', row: 'id', revision: 'revision' },
  fields: { body: { type: 'text', search: { exact: true, substring: true } } },
});
const storage = defineSealStorage(definition);
const sealer = createSealer({ key: rootKey }); // 32-byte Uint8Array loaded by the app
const notes = bindSealed({ sealer, definition, storage, executor });
const scoped = notes.forScope({ scopeId });
const page = await scoped.findMany({ match: f => f.body.contains('ell'), limit: 20, budgets: { decryptConcurrency: 64 } });
```

Apply the companion table DDL before use. Raw SQL users can generate a reviewed manifest with `definePostgresStorage`. Drizzle users export the table from `defineSealStorage` to Drizzle Kit. The application loads a fixed 32 byte unpredictable root key before creating the sealer and authorizes `scopeId`. Managed inserts and updates keep ciphertext and companion tokens in one transaction; direct SQL writes bypass index maintenance.

Search supports exact and substring matching of configured fields. Substring searches need at least two characters. Exact token columns have B-tree expression indexes; all substring token columns share one multicolumn GIN index. A page uses a cursor, verifies every returned result, and fills from later candidates when collisions occur. `budgets.decryptConcurrency` sets the field authentication pool size for search and `decryptRows` (default and maximum 64). `count({ match, maxCandidates })` performs bounded exact verification and returns a number; it throws `LIMIT_EXCEEDED` if the bound is reached. If the fixed key must change, the application must re-encrypt and reindex all data.

Substring profiles store one-character-gap pieces by default, including `substring: true` and objects that omit `skipGrams`. Set `substring: { skipGrams: false }` to turn them off; changing this setting requires reindexing. In an earlier local 100,000-row fixture with per-field GIN indexes, the companion measured 211 MB with them off and 305 MB on ([storage data](bench/results/2026-09-27-combined-gin/storage.json)); median single-row insert time was 4.65 ms off and 6.16 ms on ([write data](bench/results/2026-09-27-skip-write-cost/report-ko.md)). The [current multicolumn GIN check](bench/results/2026-09-27-product-multicolumn-gin/report-ko.md) is separate. These experimental measurements are not deployment guarantees.

## Limits

- The standard index leaks deterministic token frequency and co-occurrence, ciphertext length, and query and update patterns visible to the database. A hostile database can omit rows. Keyless database theft resistance for full records is not established by current evidence; see the [threat model](docs/threat-model.md).
- Encrypted fields do not support range queries, order by, `not`, one-character search, or database aggregation such as SUM, AVG, and GROUP BY. Keep fields that need exact database calculation in plaintext.
- `findMany` cannot yet express OR between a plain column and an encrypted condition. A Drizzle-native API that addresses this is planned ([plan/001](plan/001-drizzle-native-api.md)), not implemented.
- Total page time with authenticated decryption is well above plaintext in local measurements ([core verification](bench/results/2026-09-27-core-verification/v3/report-ko.md)).

## Documents

| Document | Purpose |
|---|---|
| [docs/current-state.md](docs/current-state.md) | What is implemented now |
| [docs/llm-integration.md](docs/llm-integration.md) | Public API usage |
| [docs/threat-model.md](docs/threat-model.md) | Attackers, leakage, allowed security statements, operator duties |
| [docs/decisions/](docs/decisions/README.md) | Design decisions with measurements and rejected options |
| [docs/measurement.md](docs/measurement.md), [docs/attack-simulation.md](docs/attack-simulation.md) | Benchmark and mechanical attack rules |
| [plan/](plan/README.md) | Planned work only |
| [bench/README.md](bench/README.md) | Disposable DB rules, fixture, scripts → results → decisions |
| [AGENTS.md](AGENTS.md) | Rules for contributors and coding agents |

# SealQL core concepts

These rules apply independently of an ORM. Read the selected [adapter guide](llm-integration.md#supported-adapters) for database-specific APIs and commands.

## Core boundary

The root `sealql` export provides `createSealer`/`Sealer`, ciphertext envelope validation, field codecs and types, text normalization, search-profile and candidate-token primitives, and `SealError`. A `Sealer` authenticates and encrypts or opens one field in an explicit model, field, scope, and row context. See the compilable [core sealer example](../examples/core/sealer.ts).

The root export does not own tables, transactions, companion rows, database proofs, migrations, or query execution. Candidate tokens alone are not a complete searchable database integration; a versioned adapter must maintain storage and execute proof predicates. The [Drizzle ORM 0.45 adapter](adapters/drizzle-v0.45.md) is currently the only such adapter.

## Keys, identity, and authorization

- Load one fixed 32-byte application root key from secret storage before data operations. An application may configure a separate fixed key for a model.
- A model key changes the key boundary for that whole model; it is not a tenant, user, or group key. There is no key version, in-place rotation API, or database policy table.
- Changing a key requires application-managed decryption with the old key, encryption with the new key, and complete search-index reconstruction.
- Ciphertext authentication binds the model, field, key scope, application scope, and row identity. Moving ciphertext between those contexts fails authentication.
- The application authenticates a caller, derives the caller's authorized tenant or scope, and passes that value to every adapter operation. SealQL uses the supplied scope for AAD, token separation, cursors, and SQL isolation; it does not decide authorization.
- Row identity is the table's primary key when that key is a UUID or text value. A table with an integer or serial primary key registers an additional UUID column as its row identity, because encryption binds the identity before PostgreSQL would assign a serial value.
- Scope is optional. Use it only when rows belong to separate tenants or groups that must never be searched together; ordinary tables omit it.
- A scope-free model uses the constant scope `_`. Adding a real scope later changes the cipher and token context, so every row must be re-encrypted and reindexed.

SealQL automatically maps each row identity to one of 256 deterministic field-key shards; there is no public shard selector or per-shard accounting setting. Without external per-shard accounting, a high-write application must conservatively keep aggregate writes for each model/field/key scope within the per-shard AES-GCM usage limit documented in the [threat model](threat-model.md#5-운영-필수-조치-라이브러리-밖).

## Standard search

`standard` is the only product search design. The application derives HMAC candidate tokens; PostgreSQL indexes narrow rows and per-row salted proofs decide exact or positional predicates. A list query then authenticates only projected encrypted fields. An encrypted-only count reads proof data and decrypts no fields.

Searchable text supports exact equality, `contains`, `startsWith`, `endsWith`, and LIKE. Normalization folds NFC, full-width ASCII, ASCII case, and profile-specific whitespace. Substring operations and every LIKE literal run require at least two normalized characters; exact equality also accepts empty and one-character values. LIKE uses `%`, `_`, and backslash escapes with PostgreSQL-like meanings.

Substring profiles include one-character-gap candidate pieces by default; `substring: { skipGrams: false }` disables them. Exact candidate widths are 2–32 bits and default to 16. A coarser width increases database candidate work; salted proofs still decide equality, but coarsening does not hide equality, frequency, length, or query keys. `exactBitsForPopulation` applies only to exact candidates. Substring tokens remain 16 bits.

Encrypted range predicates, encrypted sorting, `SUM`, `AVG`, `GROUP BY`, exact statistics, word-boundary search, and standalone one-character substring operations are unsupported.

## Choose fields and search profiles

Start with no search profile. Add only the operation the product actually needs.

| Field/use | Choice | Reason and required review |
|---|---|---|
| Fixed format and small alphabet: phone, bank account, resident-registration-like values | Warning: substring search is not recommended; prefer exact only. Enable substring only when the product truly needs partial lookup and accepts the risk below. | Known plaintext or chosen insertions can teach an attacker to assemble unseen values. In the measured fixture, phone substring profiles allowed about 99.8% whole-value recovery under specified T3 conditions; follow the [canonical measurements](threat-model.md#3-누출-매트릭스), not a generic safety claim. |
| Low-cardinality state or short choice | Prefer no encrypted search; if equality lookup is necessary, use exact only. | Exact search exposes equality and frequency. Coarser exact candidates do not remove that leakage. |
| Name, memo, or address | Substring search is available; enable it where partial lookup is needed. | Review whether originals are public or inferable, whether an attacker can insert chosen values in the same scope, and whether value reconstruction is acceptable. The [T3 model](threat-model.md#2-공격자-유형) explicitly includes known plaintext and public distributions. |
| Numeric/date value needing range, order, or aggregate | Do not use an encrypted SealQL query for that operation. | These operations are unsupported; do not weaken encryption or invent approximate public results to simulate them. |

Do not recommend dummy values, token-bit reduction, padding, or a different rejected storage line as a security improvement. Their measured failures and limits are indexed in [experiments](experiments.md#3-누출-완화-모두-기각-025).

## Leakage and trust boundary

With keys outside the database, ciphertext is not directly decrypted by a snapshot attacker. The database still observes deterministic token equality, frequency and co-occurrence, ciphertext and normalized lengths, compact position permutations, query/update patterns, result volume, and the value or piece keys sent by observed queries. Observed piece keys reveal occurrences and positions for that piece.

Returned ciphertext authentication detects selected ciphertext movement or alteration; it does not prove that SQL predicates ran correctly or that the database returned every row. A hostile database can omit results or falsify predicates, including count. Resistance to keyless full-record recovery is not established. Disable bind-parameter logging in the database, driver, proxy, APM, and error paths. Use the [threat model](threat-model.md), not local fixture results, for allowed security wording.

## Exact count and caller budgets

`count` returns one exact safe JavaScript `number` or raises an error. It never returns an estimate or an `exact`/`atLeast` wrapper. Encrypted-only count decrypts no fields. Count accepts only a deadline budget and cancellation signal; deadline exhaustion or a value above `Number.MAX_SAFE_INTEGER` is `LIMIT_EXCEEDED`.

List search has no default byte, time, result, or total-work ceiling. Current list budgets are `batch`, `fetchBytes`, `decryptedBytes`, `resultBytes`, `deadlineMs`, and `decryptConcurrency` (default 64); drivers need their own statement timeout to interrupt an in-flight SQL request.

Set budgets in this order:

1. Measure plaintext, current product, and any candidate with the same data and queries using the repository [measurement rules](measurement.md).
2. Record SQL request-to-response time, total time, candidates, returned rows, projected encrypted fields, fetched bytes, decrypted bytes, and serialized response bytes.
3. Choose the application's maximum response size and memory/time envelope from those measurements. Treat any numeric configuration shown in an example as an example, not a library recommendation.
4. Set list budgets and a database statement timeout below the application's outer request deadline, then test the budget-exhausted path.
5. For count, set only `deadlineMs` and/or `signal`; handle `LIMIT_EXCEEDED` rather than returning an uncertain count.

A list projection budget may return a short page with a continuation cursor after the last fully processed position. If no position can be completed, the adapter raises `LIMIT_EXCEEDED`.

## Rebuild invariant

For a new searchable schema or any search-profile change, deployment order is:

1. Apply the adapter's schema migration.
2. Apply every adapter-supplied predicate/storage statement (`extraMigrationSql` in the current Drizzle adapter).
3. Run the adapter's all-model preparation gate (`prepareAllSearch` in the current Drizzle adapter), which checks installed catalog state and completes authenticated reindex with parent-row coverage.
4. Only then deploy queries that use the profile.

Do not query a partially rebuilt profile. SealQL has no persisted profile-version or rebuild-completion marker, so early search or count can silently omit existing rows. A predicate-function-only change may need the adapter SQL step without a data rewrite; the adapter guide must state that case explicitly.

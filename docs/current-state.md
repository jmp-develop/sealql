# SealQL current state

SealQL's only product search design is `standard`: application-side HMAC candidate tokens narrow rows through PostgreSQL GIN/B-tree indexes, and per-row salted exact or occurrence proofs let PostgreSQL finish each predicate. An encrypted-only `count` reads the companion table, returns one exact scalar, and decrypts no fields. List queries return only final matches, then authenticate and decrypt only projected encrypted fields. Field ciphertext uses AES-256-GCM bound to the model, field, scope, and row.

The product exposes `sealql` and `sealql/drizzle/v0.45`. The [integration entry](llm-integration.md) separates ORM-neutral [core concepts](core-concepts.md) from the [Drizzle ORM 0.45 guide](adapters/drizzle-v0.45.md); the compilable [injected integration flow](../examples/drizzle/v0.45/app.ts), its repository [runner](../scripts/run-drizzle-v0.45-example.ts), and adjacent examples cover schema, managed writes, reads, search, raw SQL, and key loading.

## Storage and execution

Each registered parent table has a companion table with one row per scope and row identity. The companion stores deterministic candidate tokens and salted proof material. Exact proofs use a 64-bit stamp. Substring profiles store only compact two-character occurrence proofs; substring candidate tokens also include the configured adjacent/start/end/skip pieces. Candidate-token and compact-proof arrays use PostgreSQL `MAIN` storage.

Managed `insert`, `update`, and `upsert` operations update ciphertext and the affected companion fields atomically. Partial updates preserve untouched fields, and parent deletes cascade. Raw SQL writes to encrypted columns bypass companion maintenance and can silently omit search results. `reindex` authenticates parent ciphertext and rebuilds companion rows without changing ciphertext.

Substring candidate predicates send at most three existing tokens—the first, middle, and last in token-value order—to the common SQL builder. This is an index-selection input, not a candidate, result, or work limit; the full proof program still decides the predicate. Exact predicates and stored data are unchanged. See [decision 024](decisions/024-candidate-token-selection.md).

Pure encrypted-predicate counts stay on the companion table. `match` and `where` are both optional for count; with neither present, count returns the exact number of every parent row in the supplied scope (or every row for a scope-free model). Unfiltered counts and queries using parent predicates or caller JOINs retain the parent relation. Finite ID-ordered pages try a bounded prefix, keep its final matches, and continue strictly after the complete prefix when necessary. Both paths apply proofs before `LIMIT`. Search has no implicit result or work ceiling; caller-supplied budgets may stop list work or impose a deadline. See [decisions 015](decisions/015-database-search-proofs.md), [020](decisions/020-companion-predicate-plans.md), and [014](decisions/014-unbounded-query-work.md).

## Supported behavior

- Text search supports exact equality, `contains`, `startsWith`, `endsWith`, and LIKE patterns composed from `%`, `_`, escapes, and literal runs of at least two normalized characters.
- A LIKE pattern with one literal and only edge `%` wildcards uses the equivalent positional predicate. A whole-value LIKE also checks compact length. General LIKE evaluates fixed-width segments from left to right. See [decisions 021](decisions/021-like-normalization.md) and [022](decisions/022-like-segment-order.md).
- Exact candidate widths are 2–32 bits with a default of 16. Explicit two-bit exact candidates are available for low-cardinality fields without substring search; salted proofs still decide equality. See [decision 016](decisions/016-coarse-exact-bits.md).
- `findMany` and `search` support unbounded results when `limit` is omitted, caller budgets, plaintext ordering, opaque cursors, Boolean sealed predicates, and ordinary SQL predicates. A custom JOIN callback must apply the supplied predicate, keyset, order, flags, and optional limit. A required numeric caller limit gives the callback a `number`; otherwise it receives `number | undefined`. See [decision 023](decisions/023-join-callback-limit.md).
- UUID and text row identities, text scopes, scope-free models, managed writes, partial updates, deletes, reindexing, Drizzle partial projections, raw result opening, and exact scalar counts are supported.

## Unsupported behavior

- Standalone one-character substring queries and LIKE literal runs shorter than two normalized characters.
- Word-boundary search, singleton or words proof streams, `respectWords`, `wordBoundary`, and `normalizeWords`. The compact-only format is defined by [decision 019](decisions/019-compact-only-search.md).
- Encrypted range predicates, encrypted sorting, `SUM`, `AVG`, `GROUP BY`, or exact statistics over encrypted values.
- Aliases or self-JOINs of a sealed table, stateful search, posting pages, and bucket research.
- Key versions, in-place key rotation, user/group keys outside an application-chosen model-key boundary, or a database policy table.

## Installation and searchable-field changes

For a new schema or any searchable-profile change, complete these steps in order:

1. Apply the Drizzle schema migration.
2. Apply every statement from `sealed.extraMigrationSql(...)`.
3. Complete `sealed.reindex(...)` for existing rows.
4. Deploy queries that use the new profile.

Do not query a partially rebuilt companion: SealQL has no persisted profile-version or rebuild-completion marker, so incomplete work can silently omit rows. Profile changes that alter the token descriptor require the full sequence. A change limited to installed predicate functions requires `extraMigrationSql` again but no data rewrite; a SQL-only candidate-plan change such as decision 024 needs neither migration nor reindex. The [Drizzle ORM 0.45 guide](adapters/drizzle-v0.45.md#migrate-and-rebuild) gives the operational commands, while [core concepts](core-concepts.md#rebuild-invariant) owns the adapter-independent deployment invariant.

## Security and verification boundary

The database receives value or piece keys for each query, never the root or field-encryption keys. Token frequency and co-occurrence, ciphertext and normalized lengths, compact position permutations, query/update patterns, and result volume remain visible. Observed piece keys reveal occurrences and positions of those pieces. A hostile database can omit rows or falsify predicates; authenticating returned ciphertext does not prove SQL execution or completeness. A 64-bit proof collision is possible, and resistance to keyless full-record recovery is not established. Disable bind-parameter logging in PostgreSQL, drivers, proxies, and telemetry. Fixed-format small-alphabet fields such as phone numbers should use exact search only. The [threat model](threat-model.md) is the canonical security statement.

Managed writes and reindex require a driver with transaction support; node-postgres and postgres-js passed the repository's database flow. Verification commands and evidence requirements are in [verification.md](verification.md); measurement rules are in [measurement.md](measurement.md). The main product evidence is the [R9 report](../bench/results/2026-09-29-r9/report-ko.md). Local fixture results are not deployment guarantees or security certification.

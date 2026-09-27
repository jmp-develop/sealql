# Standard core implementation review — 2026-09-27

> Historical measurements below used the earlier key-version format. The fixed-key implementation later on 2026-09-27 removed key versions and companion epochs; see [current state](../../docs/current-state.md) for the shipped API. The measurements remain evidence for that earlier implementation and should not be presented as current performance.

The fixed-key [mechanical attack rerun](standard-product-token-attack-fixed-key-2026-09-27.json) used the same 20,000 victim and 20,000 reference reviews, root bytes, scope, and seed 99 with the shipped versionless descriptor and HKDF framing. Frequency decoding recovered 8.50% of adjacent/boundary piece occurrences and 6.08% with optional skip pieces; 5% known-row decoding recovered 54.84% and 35.04%, respectively. This run covers frequency, known-row, skip-piece consistency, and three search false-positive checks; it does not rerun query-volume, multi-snapshot, or dictionary attacks. These changed samples do not establish keyless database theft resistance. The original attack results and performance table below remain historical measurements of the superseded format.

The fixed-key [same-data rerun](standard-product-basic-bench-fixed-key-2026-09-27.json) used a separate disposable schema and the same 1,000 derived source rows and 20-row queries. The first standard call used a fresh reader with cold cryptographic caches; warm medians follow two warmup pairs and seven alternating measured pairs. SQL and total timings are separate; authenticated field counts are engine-path estimates.

| Predicate / projection | Plain warm total ms | Standard cold SQL / total ms | Standard warm SQL / total ms | Candidates / returned | Authenticated fields |
|---|---:|---:|---:|---:|---:|
| address contains 세종대로 / 3 | 0.33 | 2.09 / 15.05 | 1.11 / 4.77 | 27 / 20 | 67 |
| address contains 세종대로 / 6 | 0.44 | 1.46 / 17.51 | 1.23 / 7.19 | 27 / 20 | 127 |
| memo contains 서비스 / 3 | 0.41 | 1.93 / 11.32 | 1.73 / 5.12 | 27 / 20 | 67 |
| company contains 서울 / 3 | 0.43 | 1.36 / 8.95 | 1.52 / 4.83 | 27 / 20 | 67 |
| memo contains 없는검색어 / 3 | 0.34 | 1.03 / 1.77 | 0.61 / 1.12 | 0 / 0 | 0 |

The fixed-key format removes 4 envelope bytes and the companion epoch column but does not establish a general speedup in this one local rerun. Database buffers may have been warm from fixture creation, and the test does not establish 100,000-row performance.

## Scope and verification

The product now uses code-supplied global or model keys, v3 AES-GCM field envelopes, 8-bit FNV-1a row shards, cached derived keys, HMAC search pieces, one companion semi-join, internal predicate verification, cursor pages, and a bounded exact `number` count. Field keys share a cache entry across data scopes for each key scope/version/model/field/codec/shard; data scope and row ID remain authenticated AAD. Search profile HMAC keys are likewise shared across data scopes, with scope prefixes in a separate small LRU. The legacy, stateful, DB policy, admin, and migration product paths were removed. Public package exports are `.`, `./drizzle/v0.45`, and `./postgres`.

`rtk npm run build`, `rtk npm run check`, `rtk npm test` (10 tests, including cross-tenant authentication, exact v3 AAD and legacy-envelope compatibility, disposable PostgreSQL, and local workerd), and `rtk npm run docs:check` passed. The prior `rtk npm run test:install` gate passed with Drizzle 0.45.2 and 0.45.3; it was not repeated for this internal optimization. The PostgreSQL tests and benchmark used only `127.0.0.1:56439` after `assertDisposable` checked the `.local/pg-test` instance. No retained benchmark rows were changed or deleted.

## Same-data local comparison

The engine authenticates condition fields with a shared bounded pool, verifies candidates, and authenticates the selected fields of only the accepted prefix with the same pool. `decryptConcurrency` defaults to 64 and is capped at 64. A disposable PostgreSQL test checks concurrent projection and confirms that a result-byte budget cursor resumes without skipping or duplicating rows. The cipher now caches the fixed field context and AAD prefix (bounded to 1,024 contexts), reuses one encoded row ID for shard and AAD, and memoizes per-shard key identities. It refreshes derived-key recency every 32 cache hits and passes byte views to WebCrypto without redundant copies; SharedArrayBuffer-backed ciphertext is copied before use. The v3 envelope, HKDF info, and AAD framing are unchanged, with byte-level and legacy-ciphertext tests.

The [raw result](standard-product-basic-bench-2026-09-27.json) uses 1,000 rows read from `bench_realistic_100k.customers` into a separate disposable schema. Plain and encrypted paths used the same values, predicate terms, ID order, 20-row limit, and matching three- or six-field projections. SQL is request-to-response time; total includes token preparation and authenticated decryption. For each predicate, the first standard call used a fresh reader with cold cryptographic caches, followed by two warmup pairs and seven measured pairs whose path order alternated. Database buffers may already have been warm from fixture creation. Medians below are computed separately for SQL and total time from the seven measured pairs.

| Predicate / projection | Plain warm median SQL / total ms | Standard cold first SQL / total ms | Standard warm median SQL / total ms | SQL calls | Candidates / returned | Authenticated fields* |
|---|---:|---:|---:|---:|---:|---:|
| address contains 세종대로 / 3 | 0.36 / 0.36 | 1.76 / 15.28 | 0.69 / 5.09 | 1 | 27 / 20 | 67 |
| address contains 세종대로 / 6 | 0.50 / 0.50 | 0.94 / 16.47 | 0.69 / 7.19 | 1 | 27 / 20 | 127 |
| memo contains 서비스 / 3 | 0.24 / 0.24 | 0.72 / 9.55 | 0.45 / 3.76 | 1 | 27 / 20 | 67 |
| company contains 서울 / 3 | 0.34 / 0.34 | 0.71 / 8.72 | 0.51 / 3.86 | 1 | 27 / 20 | 67 |
| memo contains 없는검색어 / 3 | 0.33 / 0.33 | 0.88 / 1.68 | 0.61 / 1.08 | 1 | 0 / 0 | 0 |

All returned IDs matched plaintext on the first call and all seven measured pairs. *Authenticated field counts are estimates from the engine path: one predicate field per candidate, then other selected fields per returned row. They were not independently instrumented. The cold-to-warm difference includes cache effects and other first-call work; it does not isolate HKDF time. The six-field case improved from 10.52 to 7.19 ms total for an estimated 127 authenticated fields. The earlier `fast-path.ts` prototype reported about 4.4–6 ms for roughly 127 fields on a different fixture and experimental path; this follow-up did not reproduce that prototype under the same conditions. This 1,000-row check does not replace a full 100,000-row performance and exactness review.

The same-value 1,200-open microbenchmark (a local one-off script, not preserved; concurrency 64, warm caches) measured product `Sealer.open` at 28.9 µs/open and the experimental `V3Cipher.open` at 24.7 µs/open after this change. Before the change, the same local script measured 46.5 and 25.2 µs/open respectively. These measurements compare per-call overhead under one local runtime; the prototype uses different key derivation and AAD layouts and is not a product format.

## Mechanical token attacks

The [attack script](../standard-review/product-token-attack.ts) used the product descriptor and piece functions with the product HKDF/HMAC framing and 16-bit piece truncation. Its source was the public [NSMC `ratings.txt`](https://github.com/e9t/nsmc), local SHA-256 `7D1D8E66323EB5A64FEB2E299178F58827D8302111C434195DFEEF48506E1256`. Victim and reference sets each held 20,000 disjoint review rows; 5% of victim rows were revealed for the known-row attack. The [raw result](standard-product-token-attack-2026-09-27.json) includes deterministic seed 99 and search false-positive checks.

| Layout | Frequency decoded piece occurrences | Known-row decoded piece occurrences | Unknown rows at least 80% decoded after known rows |
|---|---:|---:|---:|
| Adjacent + boundary | 10.61% | 55.82% | 4.74% |
| Adjacent + skip + boundary | 4.63% | 36.12% | 0.62% |

With skip pieces enabled, 21.51% of skip-piece occurrences in unknown rows were decoded from known-row signatures; 34% of those decoded occurrences also had a path through decoded adjacent pieces. This is a mechanical consistency check on the optional skip layout, not evidence that skip pieces prevent reconstruction. In the three measured search terms, candidate-to-true-match factors were 1.000–1.007. Frequency, co-occurrence, result volume, and update timing remain visible to a database observer. A hostile database can omit rows; keyless database theft resistance for full records remains unproven.

## Remaining limits

Encrypted-field range search, ordering, and database aggregation are unsupported. Search cannot cross distinct key configurations, and applications must authorize the chosen scope. Key rotation requires an application-managed re-encryption and reindex job before old keys are removed. Hosted Workers/Hyperdrive and production write throughput were not measured here.

# SealQL usage guide and examples

This folder is the usage reference for applications and AI assistants. Read this page first; it holds the rules that apply to every ORM. Then open the guide for your adapter.

| Folder | Contents |
|---|---|
| [`core/`](core/sealer.ts) | Field encryption with the `sealql` core only (no database search) |
| [`drizzle/v0.45/`](drizzle/v0.45/README.md) | Drizzle ORM 0.45 adapter guide and compilable examples |

## Core boundary

The root `sealql` export provides `createSealer`/`Sealer`, ciphertext envelope validation, field codecs and types, text normalization, search-profile and candidate-token primitives, and `SealError`. A `Sealer` authenticates and encrypts or opens one field in an explicit model, field, scope, and row context. See the compilable [core sealer example](core/sealer.ts).

The root export does not own tables, transactions, companion rows, database proofs, migrations, or query execution. Candidate tokens alone are not a complete searchable database integration; a versioned adapter must maintain storage and execute proof predicates. The [Drizzle ORM 0.45 adapter](drizzle/v0.45/README.md) is currently the only such adapter.

## Keys, identity, and authorization

- Load one fixed 32-byte application root key from secret storage before data operations. An application may configure a separate fixed key for a model.
- A model key changes the key boundary for that whole model; it is not a tenant, user, or group key. There is no key version, in-place rotation API, or database policy table.
- Changing a key requires application-managed decryption with the old key, encryption with the new key, and complete search-index reconstruction.
- Ciphertext authentication binds the model, field, key scope, application scope, and row identity. Moving ciphertext between those contexts fails authentication.
- The application authenticates a caller, derives the caller's authorized tenant or scope, and passes that value to every adapter operation. SealQL uses the supplied scope for AAD, token separation, cursors, and SQL isolation; it does not decide authorization.
- Row identity is the table's primary key when that key is a UUID or text value. A table with an integer or serial primary key registers an additional UUID column as its row identity, because encryption binds the identity before PostgreSQL would assign a serial value.
- Scope is optional. Use it only when rows belong to separate tenants or groups that must never be searched together; ordinary tables omit it.
- A scope-free model uses the constant scope `_`. Adding a real scope later changes the cipher and token context, so every row must be re-encrypted and reindexed.

SealQL automatically maps each row identity to one of 256 deterministic field-key shards; there is no public shard selector or per-shard accounting setting. Without external per-shard accounting, a high-write application must conservatively keep aggregate writes for each model/field/key scope within the per-shard AES-GCM usage limit documented in the [threat model](https://github.com/jmp-develop/sealql/blob/main/docs/threat-model.md#5-운영-필수-조치-라이브러리-밖).

## Standard search

`standard` is the only product search design. By default, the application derives HMAC candidate tokens; PostgreSQL indexes narrow rows and per-row salted proofs decide exact or positional predicates. The field option `hardened: true` omits candidate tokens and uses the same salted proofs and query API; see [hardened fields](#hardened-fields). A list query then authenticates only projected encrypted fields. An encrypted-only count reads proof data and decrypts no fields.

Searchable text supports exact equality, `contains`, `startsWith`, `endsWith`, and LIKE.

Search compares normalized forms; stored values keep the original input and decrypt unchanged. By default, both values and queries are normalized the same way: Unicode NFC, full-width ASCII to half-width, ASCII letters to lowercase, and whitespace removed. A search therefore matches regardless of spacing or ASCII case (`강남구 테헤란로` is found by `강남구테헤란로`). Punctuation such as `-` is compared as written. Results equal a plaintext search over these normalized forms. A text search profile may set `normalizer` to change the rule:

| `normalizer` | Use | Behavior |
|---|---|---|
| omitted (default) | Any text | As above |
| `'digits'` | Numbers written with separators: phone, account, or registration numbers | Also ignores `-`, `(`, `)`, `.`, and a leading `+`, so `010-1234-5678` is found by `01012345678`, `1234-5678`, or `12345678`. A value or query that still contains other characters is rejected with `INVALID_VALUE`; do not use it for fields that may hold notes such as an extension label. |
| `'keep-spaces'` | Exact match must treat values differing only in spaces as different, such as a duplicate check where `hong gil` and `honggil` are distinct | Keeps whitespace for exact equality. Substring operations and LIKE still ignore whitespace. |

Substring operations and every LIKE literal run require at least two normalized characters; exact equality also accepts empty and one-character values. LIKE uses `%`, `_`, and backslash escapes with PostgreSQL-like meanings.

Substring profiles include one-character-gap candidate pieces by default; `substring: { skipGrams: false }` disables them. Exact candidate widths are 2–32 bits and default to 16. A coarser width increases database candidate work; salted proofs still decide equality, but coarsening does not hide equality, frequency, length, or query keys. `exactBitsForPopulation` applies only to exact candidates. Substring tokens remain 16 bits.

Encrypted range predicates, encrypted sorting, `SUM`, `AVG`, `GROUP BY`, exact statistics, word-boundary search, and standalone one-character substring operations are unsupported.

## Choose fields and search profiles

Which columns to encrypt, which search operations to enable, and whether to use `normalizer` or `hardened` are decisions of the application owner. An AI assistant applies them only to fields the user asked for. When a field appears to match the criteria in this guide, explain the reason and the cost, recommend it, and follow the user's choice.

Start with no search profile. Add only the operation the product actually needs.

| Field/use | Choice | Reason and required review |
|---|---|---|
| Short or predictably patterned sensitive value: name, phone, account or ID number, address | Exact only on the default profile, or `hardened: true` for any search, including partial. | Default substring tokens let known plaintext or chosen insertions assemble unseen values; short and patterned values are assembled most easily ([measurements](#hardened-fields)). Default exact search avoids assembly but exposes equality and frequency. |
| Low-cardinality state or short choice | Prefer no encrypted search; if equality lookup is necessary, use exact only. | Exact search exposes equality and frequency. Coarser exact candidates do not remove that leakage. |
| Longer free-form text: memo, description, review | Substring search is available; enable it where partial lookup is needed. | Review whether originals are public or inferable, whether an attacker can insert chosen values in the same scope, and whether value reconstruction is acceptable. The [T3 model](https://github.com/jmp-develop/sealql/blob/main/docs/threat-model.md#2-공격자-유형) explicitly includes known plaintext and public distributions. |
| Numeric/date value needing range, order, or aggregate | Do not use an encrypted SealQL query for that operation. | These operations are unsupported; do not weaken encryption or invent approximate public results to simulate them. |

Do not recommend dummy values, token-bit reduction, padding, or a different rejected storage line as a security improvement. Their measured failures and limits are indexed in [experiments](https://github.com/jmp-develop/sealql/blob/main/docs/experiments.md#3-누출-완화-모두-기각-025).

## Hardened fields

`hardened: true` is a field option for any searchable field (text, integer, bigint, decimal); a text field may combine it with any `normalizer`. It stores no deterministic candidate tokens; every predicate is decided by the per-row salted proofs. Supported operations (exact, `contains`, `startsWith`, `endsWith`, LIKE) and the query API are the same as on an ordinary field.

- **Security effect:** a database snapshot, known plaintext, or chosen insertions in the same scope can no longer assemble other values of the field. In the [mechanical attack measurements](https://github.com/jmp-develop/sealql/blob/main/bench/results/2026-10-02-hardened/attack/report-ko.md) with 1% known plaintext, ordinary substring search let 99.8% of phone values and 51.6% of addresses be recovered; hardened, 0% and 0.2%.
- **What remains exposed:** everything listed for both field kinds under [leakage and trust boundary](#leakage-and-trust-boundary). An attacker who observes queries with known search terms recovers as much as on an ordinary substring field, so bind-parameter logging must stay disabled for hardened fields too. A field whose values come from a small set (for example a closed list of company names) can be identified from length alone; hardened does not help there (measured about 70% with or without it).
- **Cost:** no index narrows a hardened predicate, so it checks every row in scope. Measured on local PostgreSQL 18: about 25–150 ms per count and 23–160 ms for a 20-row list at 10,000 rows in scope, and about 0.1–0.45 s at 100,000 rows (a list with few matches took up to about 0.85 s), tens to hundreds of times an ordinary search. Plan scope size and query shape before enabling it.
- **Good fit:** sensitive values that are short and predictably patterned: names, phone, account, or ID numbers, addresses.
- **Poor fit:** long free-form text of unpredictable length (memo, review, description). The measured benefit is for short, patterned values and has not been measured for long text, while every search on the field pays the full-scope cost. Also values from a small set, as above.
- **Query shape:** combine a hardened predicate with an indexed condition in `m.and(...)` so rows are narrowed first. When an integrated search ORs many fields, one hardened branch makes the whole query check every row in scope; the cost of several hardened branches together has not been measured.
- **Converting an existing field:** follow the [rebuild invariant](#rebuild-invariant), including the old-token cleanup.

## Leakage and trust boundary

With keys outside the database, ciphertext is not directly decrypted by a snapshot attacker. Ordinary searchable fields expose deterministic token equality, frequency and co-occurrence. Both ordinary and hardened fields expose ciphertext and normalized lengths, the positions where each two-character piece occurs (not the characters), query/update patterns, result volume, and the value or piece keys sent by observed queries. Observed piece keys reveal occurrences and positions for that piece.

Returned ciphertext authentication detects selected ciphertext movement or alteration; it does not prove that SQL predicates ran correctly or that the database returned every row. A hostile database can omit results or falsify predicates, including count. Resistance to keyless full-record recovery is not established. Disable bind-parameter logging in the database, driver, proxy, APM, and error paths. Use the [threat model](https://github.com/jmp-develop/sealql/blob/main/docs/threat-model.md), not local fixture results, for allowed security wording.

## Exact count and caller budgets

`count` returns one exact safe JavaScript `number` or raises an error. It never returns an estimate or an `exact`/`atLeast` wrapper. Encrypted-only count decrypts no fields. Count accepts only a deadline budget and cancellation signal; deadline exhaustion or a value above `Number.MAX_SAFE_INTEGER` is `LIMIT_EXCEEDED`.

List search has no default byte, time, result, or total-work ceiling. Current list budgets are `batch`, `fetchBytes`, `decryptedBytes`, `resultBytes`, `deadlineMs`, and `decryptConcurrency` (default 64); drivers need their own statement timeout to interrupt an in-flight SQL request.

Set budgets in this order:

1. Measure plaintext, current product, and any candidate with the same data and queries using the repository [measurement rules](https://github.com/jmp-develop/sealql/blob/main/docs/measurement.md).
2. Record SQL request-to-response time, total time, candidates, returned rows, projected encrypted fields, fetched bytes, decrypted bytes, and serialized response bytes.
3. Choose the application's maximum response size and memory/time envelope from those measurements. Treat any numeric configuration shown in an example as an example, not a library recommendation.
4. Set list budgets and a database statement timeout below the application's outer request deadline, then test the budget-exhausted path.
5. For count, set only `deadlineMs` and/or `signal`; handle `LIMIT_EXCEEDED` rather than returning an uncertain count.

A list projection budget may return a short page with a continuation cursor after the last fully processed position. If no position can be completed, the adapter raises `LIMIT_EXCEEDED`.

## Rebuild invariant

For a new searchable schema or any search-profile change, including `normalizer` and enabling or disabling `hardened`, deployment order is:

1. Apply the adapter's schema migration.
2. Apply every adapter-supplied predicate/storage statement (`extraMigrationSql` in the current Drizzle adapter).
3. Run the adapter's all-model preparation gate (`prepareAllSearch` in the current Drizzle adapter), which checks installed catalog state and completes authenticated reindex with parent-row coverage.
4. Only then deploy queries that use the profile.

When converting an existing field from an ordinary profile to hardened, dropping its token columns leaves old tokens in table storage, WAL, and backups. Before deploying the new profile, rewrite the companion table (for example with `VACUUM FULL`, which locks and rewrites the table), or recreate the companion during migration and rebuild it through the sequence above. Pre-transition backups and WAL archives still contain old tokens. Discard those copies if the token-free hardened guarantee must cover all retained data; otherwise keep them protected under the original profile's security controls. A table rewrite does not securely erase old disk pages or retained copies. This extra cleanup applies only to existing fields being converted to hardened, not fields created as hardened.

Do not query a partially rebuilt profile. SealQL has no persisted profile-version or rebuild-completion marker, so early search or count can silently omit existing rows. A predicate-function-only change may need the adapter SQL step without a data rewrite; the adapter guide must state that case explicitly.

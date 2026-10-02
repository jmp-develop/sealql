# Changelog

## 1.3.0 — 2026-10-02

- Renamed the text search `normalizer` options to describe their behavior: `'phone-v1'` → `'digits'` (ignore `-`, `(`, `)`, `.`, and a leading `+`; for any number written with separators) and `'nfc-v1'` → `'keep-spaces'` (keep whitespace for exact equality). Fields that used the old names must be reindexed (`prepareAllSearch`). The default rule and ordinary fields are unchanged.
- Documented search normalization: values and queries are compared after the same normalization, and stored values keep the original input.
- Usage guides now state that choosing encrypted fields, search options, `normalizer`, and `hardened` is the application owner's decision; AI assistants recommend and let the user choose. Hardened guidance is consolidated in one section and no longer framed around phone numbers.

## 1.2.0 — 2026-10-02

- Added per-field `hardened: true` for searchable fields: omit deterministic candidate tokens and evaluate existing salted proofs with the same query API.
- Fixed `prepareAllSearch` rejecting valid search-profile migrations because of physical column order; it still rejects missing, extra, or incompatible columns.
- Removed the finite-list prefix/fallback split when all encrypted predicates are hardened, while preserving ordinary SQL and cursor behavior.
- Ordinary (non-hardened) fields are unchanged: generated SQL, parameters, `extraMigrationSql`, and storage are byte-identical to 1.1.1.

## 1.1.1 — 2026-09-30

- Published to the npm registry as `sealql` (`pnpm add sealql`).
- Usage guides moved next to the examples (`examples/README.md`, `examples/drizzle/v0.45/README.md`); `llms.txt` points there. Maintainer documents stay in the repository and are no longer packaged.
- New English README with a Korean translation (`README_ko.md`).

## 1.1.0 — 2026-09-30

- Added `sealed.prepareAllSearch(db, { batchSize?, signal? })`: after migrations and `extraMigrationSql`, it checks the database objects (read-only), rebuilds search data for every registered table, and proves every row was processed before returning a receipt.
- Added `sealed.where(seal, { scope?, match })`: returns an encrypted-search condition to use inside your own Drizzle queries (JOINs, subqueries, ordering, counts).
- Exported managed-write input types `InferSealedInsert`, `InferSealedIdentity`, `InferSealedPatch`, and `PlainShape`.
- Internal: Drizzle internals are isolated in one adapter file; behavior and generated SQL are unchanged.
- Package: Apache-2.0 license; installable from the GitHub release tarball with npm or pnpm; builds on install from a Git URL with npm.

## 1.0.0 — 2026-09-30

- First release: field encryption (AES-256-GCM) with exact, substring, and LIKE search verified inside PostgreSQL, exact counts, and the Drizzle ORM 0.45 adapter.

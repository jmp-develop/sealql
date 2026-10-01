# Changelog

## Unreleased

- Bug fix: `prepareAllSearch` accepts correctly migrated search columns after profile changes, while still rejecting missing, extra, or incompatible columns.

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

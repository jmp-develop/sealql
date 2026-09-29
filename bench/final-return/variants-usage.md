# 제품 후보 SQL 사용법

`variants.ts`는 r9-impl 소유다. 제품 옵션을 추가하지 않는다. 실행자는 일회용 DB guard·측정 락·예열2/교차7·평문 oracle을 적용하고 연구 최종안 적재가 끝난 뒤 시간 측정을 시작한다.

```ts
import {prepareVariants,researchFallback,functionVariant,storageVariant,exactTailVariant} from './variants.js';
const prepared = await prepareVariants(seal, sealer, scope, case.node);
// Query shape: { text: string, params: unknown[] }. Compile outside SQL timing.
const a = prepared.count; // 4a: pure secured predicate only; no parent where/m.sql.
const d = researchFallback(capturedListQuery, prepared.coarse); // 4d: API's quick/projection/keyset retained.
const b = functionVariant(newTestSchema, 'checks-off');
for (const sql of b.statements) await pool.query(sql); // renamed functions, product originals unchanged.
const bCount = b.rewrite(capturedCountQuery); // can also rewrite a/d; compare independently first.
```

If the caller imports the public API from `dist`, pass its own registration metadata to avoid mixing module registries: import `registrationOf` from `../../dist/adapters/drizzle/v0.45/native.js`, then `prepareVariants(seal,sealer,scope,node,registrationOf(seal))`. `storageVariant` and `exactTailVariant` accept the same optional metadata as their third argument. Source-based tests can omit it.

4b `checks-off` removes input/damaged-proof rejection checks but bounds each occurrence cursor by the stored normalized length so loops terminate. It is a measurement candidate, not an adopted hostile-DB guarantee. Another explicitly separate candidate `qualified-no-set` retains all checks, qualifies built-in functions and every executable operator with `pg_catalog`, retains schema-qualified internal calls, and removes per-call `SET search_path`. This separates validation cost from function configuration overhead; do not combine their measured effects without a separate run.

4c `storageVariant(cloneSeal, 'EXTENDED'|'MAIN')` returns ALTER statements for token and compact stamp/offset arrays. Apply before loading a **fresh owned clone**; changing attstorage alone does not rewrite existing TOAST values. Load identical values/IDs in identical order and ANALYZE both. `exactTailVariant(cloneSeal, false|true)` returns DROP/CREATE statements for exact indexes without/with tail columns. Compare storage and tail factors independently, on owned clones only. None of these helpers executes SQL automatically.

4d removes proof re-lookups and the special top-level OR fallback. It replaces only the fallback CTE with the research candidate subquery (`ORDER BY row_id OFFSET 0`) → final predicate → LIMIT, for every Boolean expression. The API's quick prefix and outer projection remain unchanged. Queries without the bounded CTE are returned unchanged. The helper compacts parameters after transformation to avoid unused parameter type errors.

The count variant must first pass scope/null/delete/rollback/concurrent managed-write checks. Raw SQL bypasses companion maintenance and is outside that write contract. `where`, `m.sql`, and unfiltered count must keep the parent query in any adopted implementation.

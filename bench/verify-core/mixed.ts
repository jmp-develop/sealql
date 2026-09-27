/** Disposable fixture-derived encrypted/plain Boolean checks; no timing. */
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { withNativeFixture } from './native-fixture.js';

await withNativeFixture('verify_native_mixed', async ({ db, sealed, customers, customersSeal, customer, other, scopeId }: any) => {
  const page = await sealed.findMany(db, customersSeal, {
    scope: scopeId,
    match: (m: any) => m.or(m.name.eq(customer.name_plain), m.sql(eq(customers.id, other.id))),
    limit: 10,
  });
  assert.deepEqual(new Set(page.items.map((row: any) => row.id)), new Set([customer.id, other.id]));
  const count = await sealed.count(db, customersSeal, {
    scope: scopeId,
    match: (m: any) => m.or(m.name.eq(customer.name_plain), m.sql(eq(customers.id, other.id))),
    maxCandidates: 10,
  });
  assert.equal(count, 2);
  assert.equal((await sealed.findMany(db, customersSeal, {
    scope: scopeId, match: (m: any) => m.and(m.name.eq(customer.name_plain), m.sql(eq(customers.id, other.id))),
  })).items.length, 0);
  console.log('native mixed predicate checks PASS');
});

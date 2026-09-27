/** Disposable fixture-derived boundary checks for the native Drizzle API. */
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { normalizeText } from '../../src/core/search-tokens.js';
import { withNativeFixture } from './native-fixture.js';

await withNativeFixture('verify_native_boundary', async ({ db, sealed, customers, customersSeal, customer, scopeId }: any) => {
  const source = normalizeText(customer.email_plain, 'legacy-text-v1');
  assert.ok(source.length > 0);
  const long = Array.from(source.repeat(Math.ceil(2048 / source.length))).slice(0, 2048).join('');
  const term = Array.from(long).slice(1021, 1027).join('');
  const optional = customer.email_plain as string;
  const id = customer.id as string;
  await sealed.update(db, customersSeal, { id, scopeId }, { memo: long });
  assert.equal((await sealed.findMany(db, customersSeal, { scope: scopeId, match: (m: any) => m.memo.contains(term) })).items[0].id, id);
  const opened = await sealed.open(await db.select().from(customers).where(eq(customers.id, id)));
  assert.equal(opened[0].memo, long); assert.equal(opened[0].optional, null);
  await sealed.update(db, customersSeal, { id, scopeId }, { optional });
  assert.equal((await sealed.findMany(db, customersSeal, { scope: scopeId, match: (m: any) => m.optional.eq(optional) })).items.length, 1);
  await sealed.update(db, customersSeal, { id, scopeId }, { optional: null });
  assert.equal((await sealed.findMany(db, customersSeal, { scope: scopeId, match: (m: any) => m.optional.eq(optional) })).items.length, 0);
  await assert.rejects(sealed.update(db, customersSeal, { id, scopeId }, { bounded: optional.slice(0, 17) }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(sealed.update(db, customersSeal, { id, scopeId }, { memo: long + Array.from(source)[0] }), { code: 'LIMIT_EXCEEDED' });
  assert.equal((await sealed.open(await db.select().from(customers).where(eq(customers.id, id))))[0].memo, long);
  console.log('native boundary checks PASS');
});

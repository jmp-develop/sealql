import { eq, like, type InferSelectModel } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sealed, fieldsOf, Sealed } from './sealed.ts';
import { customers, customersSearch, orders, customerRel, orderRel } from './customers.ts';

const schema = { customers, orders, customerRel, orderRel };
const db = drizzle.mock({ schema, casing: 'snake_case' });

type Row = InferSelectModel<typeof customers>;
export const rowKeys: (keyof Row)[] = ['id', 'tenantId', 'status', 'name', 'memo', 'score'];
const memoType: Row['memo'] = null as unknown as Sealed<string> | null; void memoType;

export async function writes(tenantId: string, id: string) {
  // @ts-expect-error plain string into sealed column must not compile
  db.insert(customers).values({ id, tenantId, status: 'a', name: 'kim', score: 1 });
  // @ts-expect-error eq on sealed column with plaintext must not compile
  db.select().from(customers).where(eq(customers.memo, 'x'));
  // like() is NOT caught at compile time (value is string | SQLWrapper) -- documented hole, same as proto.ts
  db.select().from(customers).where(like(customers.memo, '%x%'));

  // plain-only update (no sealed columns touched) is allowed straight through drizzle
  db.update(customers).set({ status: 'y' }).where(eq(customers.id, id));

  await sealed.insert(db, customersSearch, { id, tenantId, status: 'active', name: 'kim', score: 3 });
  await sealed.insert(db, customersSearch, [{ id, tenantId, status: 'a', name: 'x', score: 1 }]);

  // @ts-expect-error insert: unknown field
  await sealed.insert(db, customersSearch, { id, tenantId, status: 'a', name: 'kim', score: 1, bogus: true });
  // @ts-expect-error insert: sealed field must be plaintext, not a number
  await sealed.insert(db, customersSearch, { id, tenantId, status: 'a', name: 1, score: 1 });
  // @ts-expect-error insert: required sealed field missing (name)
  await sealed.insert(db, customersSearch, { id, tenantId, status: 'a', score: 1 });

  await sealed.update(db, customersSearch, { id, tenantId }, { memo: 'x', status: 'hold' });
  // @ts-expect-error patch cannot change the row/scope key
  await sealed.update(db, customersSearch, { id, tenantId }, { id: 'other-id' });
  // @ts-expect-error patch cannot change the scope key either
  await sealed.update(db, customersSearch, { id, tenantId }, { tenantId: 'other-tenant' });

  await sealed.upsert(db, customersSearch, { id, tenantId, status: 'active', name: 'kim', score: 1 });
}

export async function reads() {
  const full = await sealed.open(await db.select().from(customers));
  const a: string = full[0].name; const b: string | null = full[0].memo; const c: number = full[0].score;

  const raw = await db.select().from(customers);
  // @ts-expect-error forgetting sealed.open(): Sealed<string> is not a string
  const leak: string = raw[0].name;

  const part = await sealed.open(
    await db.select({ id: customers.id, tenantId: customers.tenantId, m: customers.memo }).from(customers),
  );
  const pm: string | null = part[0].m;

  const joined = await sealed.open(
    await db.select({ c: customers, o: orders }).from(customers).innerJoin(orders, eq(orders.customerId, customers.id)),
  );
  const jn: string = joined[0].c.name; const jt: number = joined[0].o.total;

  const nested = await sealed.open(await db.query.orders.findMany({ with: { customer: true } }));
  const nn: string = nested[0].customer.name;

  const nested2 = await sealed.open(
    await db.query.customers.findMany({ columns: { id: true, tenantId: true, memo: true }, with: { orders: true } }),
  );
  const n2: string | null = nested2[0].memo; const n3: number = nested2[0].orders[0].total;

  return [a, b, c, leak, pm, jn, jt, nn, n2, n3];
}

// ---------- runtime probes (no DB): register() key<->column binding, insert/update SQL, open() round-trip ----------
export function probes() {
  const bindings = fieldsOf(customersSearch);
  console.log('register bindings:', [...bindings.entries()].map(([key, f]) => `${key} -> ${f.column === (customers as any)[key] ? 'same column ref' : 'MISMATCH'} (${f.spec.kind}, search=${JSON.stringify(f.spec.search)})`));

  console.log('companion table:', (customersSearch as any)[Symbol.for('drizzle:Name')] ?? 'customers_seal');

  const insertSql = db.insert(customers).values({
    id: 'i1', tenantId: 't1', status: 'active',
    name: Sealed.wrap('kim'), memo: null, score: Sealed.wrap(3),
  } as any).toSQL();
  console.log('insert SQL:', insertSql.sql);

  try {
    db.insert(customers).values({ id: 'i1', tenantId: 't1', status: 'active', name: 'plain-not-sealed', score: 1 } as any).toSQL();
    console.log('plain value into sealed column: NO runtime error (unexpected)');
  } catch (e) {
    console.log('plain value into sealed column ->', (e as Error).message);
  }

  console.log('update SQL:', db.update(customers).set({ status: 'x' }).where(eq(customers.id, 'i1')).toSQL().sql);

  // sealed.open works on a plain object too, not just drizzle rows
  const plainRow = { id: 'i1', tenantId: 't1', status: 'active', name: Sealed.wrap('kim'), memo: null, score: Sealed.wrap(3) };
  sealed.open(plainRow).then(opened => console.log('open(plain object):', opened));
}
if (process.argv[1]?.endsWith('use.ts')) probes();

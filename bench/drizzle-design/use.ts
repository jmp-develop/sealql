import { and, eq, like, relations, sql, type InferSelectModel } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, uuid, integer } from 'drizzle-orm/pg-core';
import { sealedTable, sealed, findMeta, type Opened, Sealed } from './proto.ts';

export const customerSeal = sealedTable('customers', {
  row: 'id', scope: 'tenantId',
  fields: {
    name: { type: 'text', search: { exact: true, substring: true } },
    memo: { type: 'text', nullable: true, search: { substring: true } },
    score: { type: 'integer', search: { exact: true } },
  },
});
export const customers = pgTable('customers', {
  id: uuid().primaryKey(), tenantId: uuid().notNull(), status: text().notNull(),
  ...customerSeal.columns,
}, t => [...customerSeal.indexes(t)]);
export const orders = pgTable('orders', { id: uuid().primaryKey(), customerId: uuid().notNull(), total: integer().notNull() });
export const customerRel = relations(customers, ({ many }) => ({ orders: many(orders) }));
export const orderRel = relations(orders, ({ one }) => ({ customer: one(customers, { fields: [orders.customerId], references: [customers.id] }) }));
const schema = { customers, orders, customerRel, orderRel };
const db = drizzle.mock({ schema, casing: 'snake_case' });

type Row = InferSelectModel<typeof customers>;
// Show what the select model looks like (token keys included, typed SealTokens)
export const rowKeys: (keyof Row)[] = ['id', 'tenantId', 'status', 'name', 'memo', 'score', '__seal_name_e', '__seal_name_s', '__seal_memo_s', '__seal_score_e'];
const memoType: Row['memo'] = null as unknown as Sealed<string, "id"> | null; void memoType;

export async function writes(tenantId: string, id: string) {
  // @ts-expect-error plain string into sealed column must not compile
  db.insert(customers).values({ id, tenantId, status: 'a', name: 'kim', score: 1 });
  // @ts-expect-error eq on sealed column with plaintext must not compile
  db.select().from(customers).where(eq(customers.memo, 'x'));
  // like() is NOT caught at compile time (value is string | SQLWrapper) -- documented hole
  db.select().from(customers).where(like(customers.memo, '%x%'));

  const v = await sealed.seal(customers, { tenantId, status: 'active', name: 'kim', score: 3 });
  await db.insert(customers).values(v);
  await db.insert(customers).values(v).onConflictDoUpdate({ target: [customers.tenantId, customers.id], set: v });
  const many = await sealed.seal(customers, [{ tenantId, status: 'a', name: 'x', score: 1 }]);
  await db.insert(customers).values(many);
  // @ts-expect-error array cannot be an onConflict set
  db.insert(customers).values(many).onConflictDoUpdate({ target: customers.id, set: many });
  // @ts-expect-error seal input: sealed field must be plaintext
  await sealed.seal(customers, { tenantId, status: 'a', name: 1, score: 1 });
  // @ts-expect-error seal input: required sealed field missing
  await sealed.seal(customers, { tenantId, status: 'a', score: 1 });
  const p = await sealed.patch(customers, { id, tenantId }, { memo: 'x', status: 'hold' });
  await db.update(customers).set(p).where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)));
}

export async function reads() {
  const full = await sealed.open(await db.select().from(customers));
  const a: string = full[0].name; const b: string | null = full[0].memo; const c: number = full[0].score;
  // @ts-expect-error token keys stripped from opened type
  full[0].__seal_name_s;
  const raw = await db.select().from(customers);
  // @ts-expect-error forgetting open: Sealed<string> is not a string
  const leak: string = raw[0].name;
  const part = await sealed.open(await db.select({ id: customers.id, tenantId: customers.tenantId, m: customers.memo }).from(customers));
  const pm: string | null = part[0].m;
  const joined = await sealed.open(await db.select({ c: customers, o: orders }).from(customers).innerJoin(orders, eq(orders.customerId, customers.id)));
  const jn: string = joined[0].c.name; const jt: number = joined[0].o.total;
  const left = await sealed.open(await db.select({ c: customers, o: orders }).from(orders).leftJoin(customers, eq(orders.customerId, customers.id)));
  const ln: string | undefined = left[0].c?.name;
  const nested = await sealed.open(await db.query.orders.findMany({ with: { customer: true } }));
  const nn: string = nested[0].customer.name;
  const nested2 = await sealed.open(await db.query.customers.findMany({ columns: { id: true, tenantId: true, memo: true }, with: { orders: true } }));
  const n2: string | null = nested2[0].memo; const n3: number = nested2[0].orders[0].total;
  return [a, b, c, leak, pm, jn, jt, ln, nn, n2, n3];
}

// Runtime probes (no DB): SQL text, marker lookup, casing
export function probes() {
  console.log('select* :', db.select().from(customers).toSQL().sql);
  console.log('rqb     :', db.query.orders.findMany({ with: { customer: true } }).toSQL().sql.slice(0, 400));
  console.log('meta    :', findMeta(customers)?.key, findMeta(orders));
  try { db.insert(customers).values({ id: 'x', tenantId: 'y', status: 'z' } as any).toSQL(); console.log('insert w/o seal: no error'); }
  catch (e) { console.log('insert w/o seal ->', (e as Error).message); }
  try { db.insert(customers).values({ id: 'x', tenantId: 'y', status: 'z', name: 'plain', score: 1 } as any).toSQL(); console.log('plain toDriver: no error at toSQL'); }
  catch (e) { console.log('plain value ->', (e as Error).message); }
  console.log('update  :', db.update(customers).set({ status: 'x' }).where(eq(customers.id, 'i')).toSQL().sql);
}
if (process.argv[1]?.endsWith('use.ts')) probes();

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { assertDisposable } from './disposable.js';
import { installProofColumns } from './proof-schema.js';

test('custom search matches plaintext across complex joins, nulls, duplicates, cursors, and count', async () => {
const schemaName = 'test_native_complex_join';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
let created = false;
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [schemaName])).rowCount, 0);
  await pool.query(`create schema "${schemaName}"`); created = true;
  const s = pgSchema(schemaName);
  const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(77) }) });
  const customers = s.table('customers', {
    id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
    name: sealed.text('name', { search: { exact: true } }),
    note: sealed.text('note', { search: { substring: true } }),
  });
  const orders = s.table('orders', {
    id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), customerId: uuid('customer_id').notNull(),
    label: sealed.text('label', { search: { exact: true } }),
  });
  const teams = s.table('teams', { customerId: uuid('customer_id').primaryKey(), tier: text('tier').notNull() });
  const regions = s.table('regions', { orderId: uuid('order_id').primaryKey(), code: text('code').notNull() });
  const customerRef = s.table('customer_ref', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), name: text('name').notNull(), note: text('note').notNull() });
  const orderRef = s.table('order_ref', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), customerId: uuid('customer_id').notNull(), label: text('label').notNull() });
  const customerSeal = sealed.register(customers, { row: 'id', scope: 'scopeId' });
  const orderSeal = sealed.register(orders, { row: 'id', scope: 'scopeId' });
  const customerProfiles = registrationOf(customerSeal).storage.index!.profiles!;
  const orderProfiles = registrationOf(orderSeal).storage.index!.profiles!;
  const q = (name: string) => `"${name}"`;
  await pool.query(`
    create table "${schemaName}".customers(id uuid primary key, scope_id uuid not null, name_ct bytea not null, note_ct bytea not null);
    create table "${schemaName}".customers_seal_index(scope_id uuid not null,row_id uuid not null,
      ${q(customerProfiles['name/exact'].tokens!)} bigint[], ${q(customerProfiles['note/substring'].tokens!)} bigint[],
      unique(scope_id,row_id),foreign key(row_id) references "${schemaName}".customers(id) on delete cascade);
    create table "${schemaName}".orders(id uuid primary key, scope_id uuid not null, customer_id uuid not null, label_ct bytea not null);
    create table "${schemaName}".orders_seal_index(scope_id uuid not null,row_id uuid not null,
      ${q(orderProfiles['label/exact'].tokens!)} bigint[], unique(scope_id,row_id),
      foreign key(row_id) references "${schemaName}".orders(id) on delete cascade);
    create table "${schemaName}".teams(customer_id uuid primary key,tier text not null);
    create table "${schemaName}".regions(order_id uuid primary key,code text not null);
    create table "${schemaName}".customer_ref(id uuid primary key,scope_id uuid not null,name text not null,note text not null);
    create table "${schemaName}".order_ref(id uuid primary key,scope_id uuid not null,customer_id uuid not null,label text not null);
  `);
  await installProofColumns(pool, customerSeal);
  await installProofColumns(pool, orderSeal);
  const db = drizzle(pool);
  const customerSource = (await pool.query(`select id,scope_id,name_plain,memo_plain,company_plain
    from bench_realistic_100k.customers order by id limit 3`)).rows;
  const orderSource = (await pool.query(`select id,memo_plain,company_plain
    from bench_realistic_100k.tickets order by id limit 3`)).rows;
  assert.equal(customerSource.length, 3); assert.equal(orderSource.length, 3);
  const scopeId = customerSource[0].scope_id as string;
  const [c1, c2, c3] = customerSource.map(row => row.id as string);
  const [o1, o2, o3] = orderSource.map(row => row.id as string);
  const customerRows = [
    { id: c1, scopeId, name: customerSource[0].name_plain as string, note: customerSource[0].memo_plain as string },
    { id: c2, scopeId, name: customerSource[1].name_plain as string, note: customerSource[1].memo_plain as string },
    { id: c3, scopeId, name: customerSource[2].name_plain as string, note: customerSource[2].memo_plain as string },
  ];
  const orderRows = [
    { id: o1, scopeId, customerId: c1, label: orderSource[0].memo_plain as string },
    { id: o2, scopeId, customerId: c1, label: orderSource[1].memo_plain as string },
    { id: o3, scopeId, customerId: c2, label: orderSource[2].memo_plain as string },
  ];
  await sealed.insert(db, customerSeal, customerRows);
  await sealed.insert(db, orderSeal, orderRows);
  await db.insert(teams).values(customerRows.map((row, index) => ({ customerId: row.id, tier: customerSource[index].company_plain as string })));
  await db.insert(regions).values([{ orderId: o1, code: orderSource[0].company_plain as string }, { orderId: o3, code: orderSource[2].company_plain as string }]);
  await db.insert(customerRef).values(customerRows);
  await db.insert(orderRef).values(orderRows);

  const match = {
    o: [orderSeal, (m: any) => m.or(...orderRows.map(row => m.label.eq(row.label)))] as const,
    c: [customerSeal, (m: any) => m.and(m.or(m.name.eq(customerRows[0].name), m.name.eq(customerRows[1].name)),
      m.or(m.note.contains(customerRows[0].note), m.note.contains(customerRows[1].note)))] as const,
  };
  const threeQuery = ({ where, after, orderBy, flags, limit }: any) => db.select({ o: orders, c: customers, t: teams, ...flags }).from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id)).innerJoin(teams, eq(teams.customerId, customers.id))
    .where(and(where, after)).orderBy(...orderBy).limit(limit!);
  const expected3 = await db.select({ orderId: orderRef.id, customerId: customerRef.id }).from(orderRef)
    .innerJoin(customerRef, eq(orderRef.customerId, customerRef.id)).innerJoin(teams, eq(teams.customerId, customerRef.id))
    .where(and(eq(orderRef.scopeId, scopeId), eq(customerRef.scopeId, scopeId),
      or(eq(customerRef.name, customerRows[0].name), eq(customerRef.name, customerRows[1].name)),
      or(sql`position(${customerRows[0].note} in ${customerRef.note}) > 0`, sql`position(${customerRows[1].note} in ${customerRef.note}) > 0`),
      or(...orderRows.map(row => eq(orderRef.label, row.label)))))
    .orderBy(orderRef.id, customerRef.id);
  const all3: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await sealed.search(db, { scope: scopeId, match, keyset: [orders.id], limit: 1, cursor, query: threeQuery });
    all3.push(...page.items); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(all3.map(row => [row.o.id, row.c.id]), expected3.map(row => [row.orderId, row.customerId]));
  assert.equal(all3.filter(row => row.c.id === c1).length, 2, '1:N duplicate customer rows preserved');

  const fourQuery = ({ where, after, orderBy, flags, limit }: any) => db.select({ o: orders, c: customers, t: teams, r: regions, ...flags }).from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id)).innerJoin(teams, eq(teams.customerId, customers.id))
    .innerJoin(regions, eq(regions.orderId, orders.id)).where(and(where, after))
    .orderBy(...orderBy).limit(limit!);
  const actual4 = await sealed.search(db, { scope: scopeId, match, keyset: [orders.id], query: fourQuery });
  const expected4 = await db.select({ orderId: orderRef.id, customerId: customerRef.id }).from(orderRef)
    .innerJoin(customerRef, eq(orderRef.customerId, customerRef.id)).innerJoin(teams, eq(teams.customerId, customerRef.id))
    .innerJoin(regions, eq(regions.orderId, orderRef.id)).where(and(eq(orderRef.scopeId, scopeId), eq(customerRef.scopeId, scopeId),
      or(eq(customerRef.name, customerRows[0].name), eq(customerRef.name, customerRows[1].name)),
      or(sql`position(${customerRows[0].note} in ${customerRef.note}) > 0`, sql`position(${customerRows[1].note} in ${customerRef.note}) > 0`),
      or(...orderRows.map(row => eq(orderRef.label, row.label)))))
    .orderBy(orderRef.id, customerRef.id);
  assert.deepEqual(actual4.items.map((row: any) => [row.o.id, row.c.id]), expected4.map(row => [row.orderId, row.customerId]));

  const leftMatch = { c: [customerSeal, (m: any) => m.and(m.name.eq(customerRows[2].name), m.sql(eq(customers.id, c3)))] as const };
  const leftActual = await sealed.search(db, { scope: scopeId, match: leftMatch, keyset: [customers.id],
    query: ({ where, after, orderBy, flags, limit }) => db.select({ c: customers, o: orders, t: teams, ...flags }).from(customers)
      .leftJoin(orders, eq(orders.customerId, customers.id)).innerJoin(teams, eq(teams.customerId, customers.id))
      .where(and(where, after)).orderBy(...orderBy).limit(limit!),
  });
  const leftExpected = await db.select({ customerId: customerRef.id, orderId: orderRef.id }).from(customerRef)
    .leftJoin(orderRef, eq(orderRef.customerId, customerRef.id)).innerJoin(teams, eq(teams.customerId, customerRef.id))
    .where(and(eq(customerRef.scopeId, scopeId), eq(customerRef.id, c3), eq(customerRef.name, customerRows[2].name))).orderBy(customerRef.id);
  assert.deepEqual(leftActual.items.map((row: any) => [row.c.id, row.o?.id ?? null]), leftExpected.map(row => [row.customerId, row.orderId]));
  assert.equal((leftActual.items[0] as any).o, null);

  const [{ count: expectedCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(orderRef)
    .innerJoin(customerRef, eq(orderRef.customerId, customerRef.id)).innerJoin(teams, eq(teams.customerId, customerRef.id))
    .where(and(eq(orderRef.scopeId, scopeId), eq(customerRef.scopeId, scopeId),
      or(eq(customerRef.name, customerRows[0].name), eq(customerRef.name, customerRows[1].name)),
      or(sql`position(${customerRows[0].note} in ${customerRef.note}) > 0`, sql`position(${customerRows[1].note} in ${customerRef.note}) > 0`),
      or(...orderRows.map(row => eq(orderRef.label, row.label)))));
  assert.equal(all3.length, expectedCount, 'custom JOIN exact count is exhaustive cursor row count');
} finally {
  if (created) await pool.query(`drop schema if exists "${schemaName}" cascade`);
  await pool.end();
}
});

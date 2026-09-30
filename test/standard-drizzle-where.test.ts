import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, count, eq, inArray, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { assertDisposable } from './disposable.js';
import { installProofColumns } from './proof-schema.js';

const sorted = (values: string[]) => [...values].sort();
const fixtureText = (value: string) => Array.from(value).filter(char => /[\p{L}\p{N}]/u.test(char)).join('');
const piece = (value: string, edge: 'start' | 'end' | 'middle' = 'start') => {
  const chars = Array.from(value);
  if (edge === 'start') return chars.slice(0, 2).join('');
  if (edge === 'end') return chars.slice(-2).join('');
  const pairs = [...value.matchAll(/[\p{L}\p{N}]{2}/gu)].map(match => match[0]);
  return pairs[Math.floor(pairs.length / 2)];
};

test('sealed.where composes with ordinary Drizzle queries, joins, subqueries and count', async () => {
  const schemaName = 'test_native_where';
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  let created = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [schemaName])).rowCount, 0);
    await pool.query(`create schema "${schemaName}"`); created = true;
    const s = pgSchema(schemaName);
    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(81) }) });
    const customers = s.table('customers', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), status: text('status').notNull(),
      name: sealed.text('name', { search: { exact: true } }),
      note: sealed.text('note', { search: { substring: true } }),
    });
    const orders = s.table('orders', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), customerId: uuid('customer_id').notNull(),
      label: sealed.text('label', { search: { exact: true } }),
    });
    const globals = s.table('globals', {
      code: sealed.textId('code').primaryKey(), title: sealed.text('title', { search: { exact: true } }),
    });
    const teams = s.table('teams', { customerId: uuid('customer_id').primaryKey(), tier: text('tier').notNull() });
    const customerRef = s.table('customer_ref', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), status: text('status').notNull(),
      name: text('name').notNull(), note: text('note').notNull(),
    });
    const orderRef = s.table('order_ref', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), customerId: uuid('customer_id').notNull(), label: text('label').notNull(),
    });
    const globalRef = s.table('global_ref', { code: text('code').primaryKey(), title: text('title').notNull() });
    const customerSeal = sealed.register(customers, { row: 'id', scope: 'scopeId' });
    const orderSeal = sealed.register(orders, { row: 'id', scope: 'scopeId' });
    const globalSeal = sealed.register(globals, { row: 'code' });
    const customerProfiles = registrationOf(customerSeal).storage.index!.profiles!;
    const orderProfiles = registrationOf(orderSeal).storage.index!.profiles!;
    const globalProfiles = registrationOf(globalSeal).storage.index!.profiles!;
    const q = (name: string) => `"${name}"`;
    await pool.query(`
      create table "${schemaName}".customers(id uuid primary key,scope_id uuid not null,status text not null,name_ct bytea not null,note_ct bytea not null);
      create table "${schemaName}".customers_seal_index(scope_id uuid not null,row_id uuid not null,
        ${q(customerProfiles['name/exact'].tokens)} bigint[],${q(customerProfiles['note/substring'].tokens)} bigint[],
        unique(scope_id,row_id),foreign key(row_id) references "${schemaName}".customers(id) on delete cascade);
      create table "${schemaName}".orders(id uuid primary key,scope_id uuid not null,customer_id uuid not null,label_ct bytea not null);
      create table "${schemaName}".orders_seal_index(scope_id uuid not null,row_id uuid not null,
        ${q(orderProfiles['label/exact'].tokens)} bigint[],unique(scope_id,row_id),
        foreign key(row_id) references "${schemaName}".orders(id) on delete cascade);
      create table "${schemaName}".globals(code text primary key,title_ct bytea not null);
      create table "${schemaName}".globals_seal_index(scope_id text not null default '_',row_id text not null,
        ${q(globalProfiles['title/exact'].tokens)} bigint[],unique(scope_id,row_id),
        foreign key(row_id) references "${schemaName}".globals(code) on delete cascade);
      create table "${schemaName}".teams(customer_id uuid primary key,tier text not null);
      create table "${schemaName}".customer_ref(id uuid primary key,scope_id uuid not null,status text not null,name text not null,note text not null);
      create table "${schemaName}".order_ref(id uuid primary key,scope_id uuid not null,customer_id uuid not null,label text not null);
      create table "${schemaName}".global_ref(code text primary key,title text not null);
    `);
    await installProofColumns(pool, customerSeal);
    await installProofColumns(pool, orderSeal);
    await installProofColumns(pool, globalSeal);
    const db = drizzle(pool);
    const customerCandidates = (await pool.query(`select id,scope_id,name_plain,memo_plain
      from bench_realistic_100k.customers where char_length(name_plain) >= 2 order by id limit 50`)).rows;
    const customerSource = customerCandidates.filter(row => fixtureText(row.memo_plain as string).length >= 8).slice(0, 3);
    const orderSource = (await pool.query(`select id,memo_plain from bench_realistic_100k.tickets
      where char_length(memo_plain) >= 8 order by id limit 3`)).rows;
    assert.equal(customerSource.length, 3); assert.equal(orderSource.length, 3);
    const scopeId = customerSource[0].scope_id as string;
    const customersData = customerSource.map((row, index) => ({
      id: row.id as string, scopeId, status: index === 2 ? 'inactive' : 'active',
      name: row.name_plain as string, note: fixtureText(row.memo_plain as string),
    }));
    const ordersData = orderSource.map((row, index) => ({
      id: row.id as string, scopeId, customerId: customersData[index === 1 ? 0 : index].id, label: row.memo_plain as string,
    }));
    const globalsData = customersData.slice(0, 2).map(row => ({ code: row.id, title: row.name }));
    await sealed.insert(db, customerSeal, customersData);
    await sealed.insert(db, orderSeal, ordersData);
    await sealed.insert(db, globalSeal, globalsData);
    await db.insert(teams).values(customersData.map((row, index) => ({ customerId: row.id, tier: index < 2 ? 'gold' : 'silver' })));
    await db.insert(customerRef).values(customersData);
    await db.insert(orderRef).values(ordersData);
    await db.insert(globalRef).values(globalsData);

    const cases = [
      [await sealed.where(customerSeal, { scope: scopeId, match: m => m.name.eq(customersData[0].name) }),
        eq(customerRef.name, customersData[0].name)],
      [await sealed.where(customerSeal, { scope: scopeId, match: m => m.note.contains(piece(customersData[0].note, 'middle')) }),
        sql`position(${piece(customersData[0].note, 'middle')} in ${customerRef.note}) > 0`],
      [await sealed.where(customerSeal, { scope: scopeId, match: m => m.note.startsWith(piece(customersData[1].note)) }),
        sql`${customerRef.note} like ${`${piece(customersData[1].note)}%`}`],
      [await sealed.where(customerSeal, { scope: scopeId, match: m => m.note.endsWith(piece(customersData[1].note, 'end')) }),
        sql`${customerRef.note} like ${`%${piece(customersData[1].note, 'end')}`}`],
      [await sealed.where(customerSeal, { scope: scopeId, match: m => m.note.like(`%${piece(customersData[2].note, 'middle')}%`) }),
        sql`${customerRef.note} like ${`%${piece(customersData[2].note, 'middle')}%`}`],
    ] as const;
    for (const [condition, plain] of cases) {
      const actual = await db.select({ id: customers.id }).from(customers).where(condition);
      const expected = await db.select({ id: customerRef.id }).from(customerRef).where(and(eq(customerRef.scopeId, scopeId), plain));
      assert.deepEqual(sorted(actual.map(row => row.id)), sorted(expected.map(row => row.id)));
    }
    const mixed = await sealed.where(customerSeal, { scope: scopeId, match: m => m.and(
      m.or(m.name.eq(customersData[0].name), m.name.eq(customersData[1].name)), m.sql(eq(customers.status, 'active')),
    ) });
    const mixedActual = await db.select({ id: customers.id }).from(customers).where(mixed);
    const mixedExpected = await db.select({ id: customerRef.id }).from(customerRef).where(and(eq(customerRef.scopeId, scopeId),
      or(eq(customerRef.name, customersData[0].name), eq(customerRef.name, customersData[1].name)), eq(customerRef.status, 'active')));
    assert.deepEqual(sorted(mixedActual.map(row => row.id)), sorted(mixedExpected.map(row => row.id)));

    const customerCondition = await sealed.where(customerSeal, { scope: scopeId, match: m =>
      m.or(m.name.eq(customersData[0].name), m.name.eq(customersData[1].name)) });
    const orderCondition = await sealed.where(orderSeal, { scope: scopeId, match: m =>
      m.or(m.label.eq(ordersData[0].label), m.label.eq(ordersData[1].label), m.label.eq(ordersData[2].label)) });
    const joined = await db.select({ customer: customers, order: orders, tier: teams.tier }).from(customers)
      .innerJoin(orders, eq(orders.customerId, customers.id)).innerJoin(teams, eq(teams.customerId, customers.id))
      .where(and(customerCondition, orderCondition));
    const opened = await sealed.open(joined, { scope: scopeId });
    const expectedJoin = await db.select({ customerId: customerRef.id, orderId: orderRef.id }).from(customerRef)
      .innerJoin(orderRef, eq(orderRef.customerId, customerRef.id)).innerJoin(teams, eq(teams.customerId, customerRef.id))
      .where(and(eq(customerRef.scopeId, scopeId), eq(orderRef.scopeId, scopeId),
        or(eq(customerRef.name, customersData[0].name), eq(customerRef.name, customersData[1].name)),
        or(...ordersData.map(row => eq(orderRef.label, row.label)))));
    assert.deepEqual(sorted(opened.map(row => `${row.customer.id}:${row.order.id}`)),
      sorted(expectedJoin.map(row => `${row.customerId}:${row.orderId}`)));
    assert.equal(opened.filter(row => row.customer.id === customersData[0].id).length, 2, '1:N rows stay duplicated');

    const flattened = await db.execute(sql`select ${customers.id} as c_id,
      ${customers.scopeId} as c_scope, ${customers.name} as c_name
      from ${customers} inner join ${teams} on ${teams.customerId} = ${customers.id}
      where ${customerCondition}`);
    const openedRaw = await sealed.openRaw(customerSeal, flattened.rows as Record<string, unknown>[], {
      columns: { id: 'c_id', scopeId: 'c_scope', name: 'c_name' }, scope: scopeId,
    });
    assert.deepEqual(sorted(openedRaw.map(row => row.c_id as string)), sorted(customersData.slice(0, 2).map(row => row.id)));
    assert.deepEqual(sorted(openedRaw.map(row => row.c_name as string)), sorted(customersData.slice(0, 2).map(row => row.name)));

    const leftOn = await db.select({ customer: customers, order: orders }).from(customers)
      .leftJoin(orders, and(eq(orders.customerId, customers.id), orderCondition)).where(customerCondition);
    const openedLeftOn = await sealed.open(leftOn, { scope: scopeId });
    assert.ok(openedLeftOn.some(row => row.order === null));
    const leftWhere = await db.select({ customer: customers, order: orders }).from(customers)
      .leftJoin(orders, eq(orders.customerId, customers.id)).where(and(customerCondition, orderCondition));
    assert.ok((await sealed.open(leftWhere, { scope: scopeId })).every(row => row.order !== null));

    const orderSubquery = db.select({ customerId: orders.customerId }).from(orders).where(orderCondition);
    const subqueryRows = await db.select({ id: customers.id }).from(customers)
      .where(and(customerCondition, inArray(customers.id, orderSubquery)));
    assert.deepEqual(sorted(subqueryRows.map(row => row.id)), sorted([...new Set(expectedJoin.map(row => row.customerId))]));
    const customerSubquery = db.select({ id: customers.id }).from(customers).where(customerCondition);
    const parentInsideSubquery = await db.select({ id: teams.customerId }).from(teams)
      .where(inArray(teams.customerId, customerSubquery));
    assert.deepEqual(sorted(parentInsideSubquery.map(row => row.id)), sorted(customersData.slice(0, 2).map(row => row.id)));
    const [{ n }] = await db.select({ n: count() }).from(customers)
      .innerJoin(orders, eq(orders.customerId, customers.id)).where(and(customerCondition, orderCondition));
    assert.equal(n, expectedJoin.length);

    const globalCondition = await sealed.where(globalSeal, { match: m => m.title.eq(globalsData[0].title) });
    const globalRows = await db.select().from(globals).where(globalCondition);
    const globalExpected = await db.select().from(globalRef).where(eq(globalRef.title, globalsData[0].title));
    assert.deepEqual((await sealed.open(globalRows)).map(row => row.code), globalExpected.map(row => row.code));

    await assert.rejects(sealed.where(customerSeal, { scope: scopeId, match: m => m.note.contains(Array.from(customersData[0].note)[0]) }),
      { code: 'QUERY_TOO_BROAD' });
    await assert.rejects(sealed.where(customerSeal, { match: m => m.name.eq(customersData[0].name) }),
      { code: 'INVALID_VALUE' });
    await assert.rejects(sealed.where(globalSeal, { scope: scopeId, match: m => m.title.eq(globalsData[0].title) }),
      { code: 'INVALID_VALUE' });
    const updated = await db.update(customers).set({ status: 'reviewed' }).where(customerCondition).returning({ id: customers.id });
    assert.deepEqual(sorted(updated.map(row => row.id)), sorted(customersData.slice(0, 2).map(row => row.id)));
  } finally {
    if (created) await pool.query(`drop schema if exists "${schemaName}" cascade`);
    await pool.end();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { assertDisposable } from './disposable.js';

test('native managed writes and opens stay atomic', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  let created = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    const fixture = (await pool.query('select id,scope_id,name_plain,memo_plain from bench_realistic_100k.customers order by id limit 3')).rows;
    assert.equal(fixture.length, 3);
    const schemaName = 'test_native_write';
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [schemaName])).rowCount, 0);
    await pool.query(`create schema "${schemaName}"`); created = true;
    const schema = pgSchema(schemaName);
    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(93) }) });
    const people = schema.table('people', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
      name: sealed.text('name', { search: { exact: true } }),
      memo: sealed.text('memo', { nullable: true, search: { substring: true } }),
    });
    const peopleSeal = sealed.register(people, { row: 'id', scope: 'scopeId' });
    const orders = schema.table('orders', { id: uuid('id').primaryKey(), customerId: uuid('customer_id').notNull() });
    const profiles = registrationOf(peopleSeal).storage.index!.profiles!;
    const exact = profiles['name/exact'].tokens, substring = profiles['memo/substring'].tokens;
    await pool.query(`create table "${schemaName}".people (id uuid primary key,scope_id uuid not null,name_ct bytea not null,memo_ct bytea)`);
    await pool.query(`create table "${schemaName}".people_seal_index (scope_id uuid not null,row_id uuid not null,"${exact}" bigint[],"${substring}" bigint[],unique(scope_id,row_id),foreign key(row_id) references "${schemaName}".people(id) on delete cascade)`);
    await pool.query(`create table "${schemaName}".orders (id uuid primary key,customer_id uuid not null)`);
    const db = drizzle(pool);
    const first = fixture[0], second = fixture[1], third = fixture[2];
    const inserted = await sealed.insert(db, peopleSeal, { id: first.id, scopeId: first.scope_id, name: first.name_plain, memo: first.memo_plain });
    assert.deepEqual(inserted, [{ id: first.id, scopeId: first.scope_id }]);
    const opened = await sealed.open(await db.select().from(people));
    assert.equal(opened[0].name, first.name_plain);
    assert.equal(opened[0].memo, first.memo_plain);
    const exactPage = await sealed.findMany(db, peopleSeal, { scope: first.scope_id, match: m => m.name.eq(first.name_plain) });
    assert.equal(exactPage.items.length, 1);
    assert.equal(exactPage.items[0].name, first.name_plain);
    assert.equal(await sealed.count(db, peopleSeal, { scope: first.scope_id, match: m => m.name.eq(first.name_plain) }), 1);
    const mixedPage = await sealed.findMany(db, peopleSeal, { scope: first.scope_id,
      match: m => m.or(m.memo.contains(second.memo_plain.slice(0, 2)), m.sql(eq(people.id, first.id))) });
    assert.equal(mixedPage.items.length, 1);
    await db.insert(orders).values([{ id: second.id, customerId: first.id }, { id: third.id, customerId: first.id }]);
    const joined = await sealed.search(db, { scope: first.scope_id, match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      keyset: [orders.id], limit: 1,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ c: people, o: orders, ...flags }).from(people)
        .innerJoin(orders, eq(orders.customerId, people.id)).where(and(where, after)).orderBy(...orderBy).limit(limit),
    });
    assert.equal(joined.items.length, 1);
    assert.ok(joined.nextCursor);
    const joinedNext = await sealed.search(db, { scope: first.scope_id, match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      keyset: [orders.id], limit: 1, cursor: joined.nextCursor!,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ c: people, o: orders, ...flags }).from(people)
        .innerJoin(orders, eq(orders.customerId, people.id)).where(and(where, after)).orderBy(...orderBy).limit(limit),
    });
    assert.equal(joinedNext.items.length, 1);
    assert.notEqual((joined.items[0] as any).o.id, (joinedNext.items[0] as any).o.id);
    const rawJoined = await sealed.search(db, { scope: first.scope_id, match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      keyset: [orders.id], limit: 2, columns: { c: { id: 'c_id', scopeId: 'c_scope', name: 'c_name_ct', memo: 'c_memo_ct' } },
      query: ({ where, after, orderBy, flagsSql, limit }) => db.execute(sql`select ${people.id} as c_id, ${people.scopeId} as c_scope,
        ${people.name} as c_name_ct, ${people.memo} as c_memo_ct, ${orders.id} as o_id, ${flagsSql}
        from ${people} inner join ${orders} on ${orders.customerId} = ${people.id}
        where ${where} ${after ? sql`and ${after}` : sql``} order by ${sql.join(orderBy, sql.raw(','))} limit ${limit}`),
    });
    assert.equal(rawJoined.items.length, 2);
    assert.equal((rawJoined.items[0] as any).c_name_ct, first.name_plain);
    await sealed.update(db, peopleSeal, { id: first.id, scopeId: first.scope_id }, { memo: second.memo_plain });
    const afterUpdate = await sealed.open(await db.select().from(people));
    assert.equal(afterUpdate[0].name, first.name_plain);
    assert.equal(afterUpdate[0].memo, second.memo_plain);
    await sealed.update(db, peopleSeal, { id: first.id, scopeId: first.scope_id }, { memo: null });
    assert.equal((await sealed.open(await db.select().from(people)))[0].memo, null);
    await sealed.upsert(db, peopleSeal, { id: first.id, scopeId: first.scope_id, name: second.name_plain, memo: first.memo_plain });
    const afterUpsert = await sealed.open(await db.select().from(people));
    assert.equal(afterUpsert[0].name, second.name_plain);
    assert.equal(afterUpsert[0].memo, first.memo_plain);
    await assert.rejects(sealed.upsert(db, peopleSeal, { id: first.id, scopeId: second.id, name: second.name_plain, memo: second.memo_plain }), { code: 'SCOPE_CONFLICT' });
    const raw = await db.execute(sql`select id,scope_id,name_ct,memo_ct from ${people}`);
    const rawOpen = await sealed.openRaw(peopleSeal, raw.rows as Record<string, unknown>[], { columns: { id: 'id', scopeId: 'scope_id', name: 'name_ct', memo: 'memo_ct' } });
    assert.equal(rawOpen[0].name_ct, second.name_plain);
    await assert.rejects(db.transaction(async tx => {
      await sealed.insert(tx, peopleSeal, [
        { id: second.id, scopeId: second.scope_id, name: second.name_plain, memo: second.memo_plain },
        { id: third.id, scopeId: third.scope_id, name: third.name_plain, memo: third.memo_plain },
      ]);
      throw Error('rollback');
    }), /rollback/);
    assert.equal((await db.select().from(people).where(eq(people.id, second.id))).length, 0);
    assert.equal((await pool.query(`select count(*)::int as n from "${schemaName}".people_seal_index`)).rows[0].n, 1);
    await db.delete(people).where(eq(people.id, first.id));
    assert.equal((await pool.query(`select count(*)::int as n from "${schemaName}".people_seal_index`)).rows[0].n, 0);
  } finally {
    if (created) await pool.query('drop schema test_native_write cascade');
    await pool.end();
  }
});

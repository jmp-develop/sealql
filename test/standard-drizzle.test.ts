import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq, relations, sql } from 'drizzle-orm';
import { PgDialect, pgSchema, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import { canonical, utf8 } from '../src/core/bytes.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { Sealed, registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { assertDisposable } from './disposable.js';
import { databaseError } from '../src/core/errors.js';

test('open rejects pending queries and database wrapping sanitizes cause', async () => {
  const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32) }) });
  const pending = Promise.resolve({ id: 'x' });
  await assert.rejects(sealed.open(pending as never), { code: 'INVALID_VALUE', message: /await the query/ });
  const row = pgSchema('test_open_raw_shape').table('rows', {
    id: uuid('id').primaryKey(), name: sealed.text('name', { search: { exact: true } }),
  });
  const seal = sealed.register(row, { row: 'id' });
  await assert.rejects(sealed.openRaw(seal, pending as never, { columns: { id: 'id' } }), { code: 'INVALID_VALUE', message: /await the query/ });
  const original = Object.assign(new Error('database rejected write'), { code: '23505' });
  const wrapped = databaseError(original);
  assert.equal(wrapped.code, 'CONSTRAINT_VIOLATION');
  assert.notEqual(wrapped.cause, original);
  assert.equal((wrapped.cause as Error & { code: string }).code, '23505');
  const driver = Object.assign(new Error('duplicate key value violates unique constraint "example_key"'), { code: '23505', constraint: 'example_key', detail: 'secret-value' });
  const drizzle = Object.assign(new Error('Failed query: insert into t values ($1)\nparams: secret-value'), { query: 'insert into t values ($1)', params: ['secret-value'], cause: driver });
  const safe = databaseError(drizzle);
  for (const display of [String(safe), inspect(safe, { depth: 5 }), inspect(safe.cause, { depth: 5 })]) {
    assert.doesNotMatch(display, /secret-value|params:|insert into t/i);
    assert.match(display, /23505|CONSTRAINT_VIOLATION/);
  }
  assert.equal((safe.cause as Error & { constraint: string }).constraint, 'example_key');
  const fkDriver = Object.assign(new Error('insert or update violates foreign key constraint'), { code: '23503', constraint: 'example_fk', detail: 'secret-value' });
  const fkWrapped = databaseError(Object.assign(new Error('Failed query: params: secret-value'), { query: 'insert', params: ['secret-value'], cause: fkDriver }));
  assert.equal(fkWrapped.code, 'CONSTRAINT_VIOLATION');
  assert.equal((fkWrapped.cause as Error & { code: string; constraint: string }).code, '23503');
  assert.equal((fkWrapped.cause as Error & { constraint: string }).constraint, 'example_fk');
  assert.doesNotMatch(inspect(fkWrapped, { depth: 5 }), /secret-value|params:/);
});

test('transactionless drivers report UNSUPPORTED_DRIVER before any callback work', async () => {
  const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(93) }) });
  const row = pgSchema('test_driver_shape').table('rows', {
    id: uuid('id').primaryKey(), name: sealed.text('name', { search: { exact: true } }),
  });
  const seal = sealed.register(row, { row: 'id' });
  const db = { transaction: (_callback: unknown) => { throw Error('No transactions support in neon-http driver'); } } as any;
  const id = '00000000-0000-4000-8000-000000000001';
  await assert.rejects(sealed.insert(db, seal, { id, name: 'fixture' }), { code: 'UNSUPPORTED_DRIVER' });
  await assert.rejects(sealed.update(db, seal, { id }, { name: 'fixture' }), { code: 'UNSUPPORTED_DRIVER' });
  await assert.rejects(sealed.upsert(db, seal, { id, name: 'fixture' }), { code: 'UNSUPPORTED_DRIVER' });
  await assert.rejects(sealed.reindex(db, seal), { code: 'UNSUPPORTED_DRIVER' });
  const disconnected = { transaction: () => { throw Error('connection failed'); } } as any;
  await assert.rejects(sealed.insert(disconnected, seal, { id, name: 'fixture' }), { code: 'DATABASE_ERROR' });
  const serverError = Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
  const aborted = { transaction: () => { throw serverError; } } as any;
  await assert.rejects(sealed.insert(aborted, seal, { id, name: 'fixture' }), error => {
    assert.equal((error as { code: string }).code, 'DATABASE_ERROR');
    assert.equal(((error as { cause: { code: string } }).cause).code, '25P02');
    return true;
  });
});

test('text position validation wraps SQL errors and checks cancellation before SQL', async () => {
  const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(91) }) });
  const row = pgSchema('test_text_position_shape').table('rows', {
    id: sealed.textId('id').primaryKey(), name: sealed.text('name', { search: { exact: true } }),
  });
  const seal = sealed.register(row, { row: 'id' });
  const positionTable = pgSchema('test_text_position_shape').table('positions', { position: uuid('position').notNull() });
  const candidate = { n: { id: 'row-a', name: null }, __seal_keyset_0: 'not-a-uuid' };
  const options = { match: { n: [seal, (m: any) => m.sql(sql`true`)] as const }, keyset: [positionTable.position],
    query: () => [candidate] };
  const db = { execute: () => { throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }); } } as any;
  await assert.rejects(sealed.search(db, options), { code: 'INVALID_CANDIDATE_SHAPE' });
  const other = { execute: () => { throw Object.assign(new Error('relation unavailable'), { code: '42P01' }); } } as any;
  await assert.rejects(sealed.search(other, options), error => {
    assert.equal((error as { code: string }).code, 'DATABASE_ERROR');
    assert.equal((error as { cause: { code: string } }).cause.code, '42P01');
    return true;
  });
  const controller = new AbortController();
  const cancelled = { execute: () => { throw Error('should not execute'); } } as any;
  await assert.rejects(sealed.search(cancelled, { ...options, signal: controller.signal,
    query: () => { controller.abort(); return [candidate]; } }), { code: 'CANCELLED' });
});

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
    const cipher = createSealer({ key: new Uint8Array(32).fill(93) });
    const sealed = createSealed({ sealer: cipher });
    const people = schema.table('people', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
      name: sealed.text('name', { search: { exact: true } }),
      memo: sealed.text('memo', { nullable: true, search: { substring: true } }),
    });
    const peopleSeal = sealed.register(people, { row: 'id', scope: 'scopeId' });
    const orders = schema.table('orders', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), customerId: uuid('customer_id').notNull(),
      label: sealed.text('label', { search: { exact: true } }) });
    const ordersSeal = sealed.register(orders, { row: 'id', scope: 'scopeId' });
    const orderExact = registrationOf(ordersSeal).storage.index!.profiles!['label/exact'].tokens;
    const profiles = registrationOf(peopleSeal).storage.index!.profiles!;
    const exact = profiles['name/exact'].tokens, substring = profiles['memo/substring'].tokens;
    await pool.query(`create table "${schemaName}".people (id uuid primary key,scope_id uuid not null,created_at timestamptz(3) not null,name_ct bytea not null,memo_ct bytea)`);
    await pool.query(`create table "${schemaName}".people_seal_index (scope_id uuid not null,row_id uuid not null,"${exact}" bigint[],"${substring}" bigint[],unique(scope_id,row_id),foreign key(row_id) references "${schemaName}".people(id) on delete cascade)`);
    await pool.query(`create table "${schemaName}".orders (id uuid primary key,scope_id uuid not null,customer_id uuid not null,label_ct bytea not null)`);
    await pool.query(`create table "${schemaName}".orders_seal_index (scope_id uuid not null,row_id uuid not null,"${orderExact}" bigint[],unique(scope_id,row_id),foreign key(row_id) references "${schemaName}".orders(id) on delete cascade)`);
    const db = drizzle(pool);
    const first = fixture[0], second = fixture[1], third = fixture[2];
    const derivedTime = (id: string) => new Date(Number.parseInt(id.slice(0, 8), 16) * 1000 + Number.parseInt(id.slice(9, 12), 16) % 1000);
    const fakeTx = { insert: () => ({ values: (rows: any) => ({ returning: async () => Array.isArray(rows) ? rows : [rows] }) }) };
    const commitFails = { transaction: async (fn: any) => { await fn(fakeTx); throw Error('commit failed'); } };
    await assert.rejects(sealed.insert(commitFails as any, peopleSeal, {
      id: first.id, scopeId: first.scope_id, createdAt: derivedTime(first.id), name: first.name_plain, memo: first.memo_plain,
    }), { code: 'WRITE_OUTCOME_UNKNOWN' });
    const fakeDb = { transaction: (fn: any) => fn(fakeTx) };
    const bulkSource = (await pool.query('select id,scope_id,name_plain,memo_plain from bench_realistic_100k.customers order by id limit 501')).rows;
    assert.equal(bulkSource.length, 501);
    const bulk = await sealed.insert(fakeDb as any, peopleSeal, bulkSource.map((row: any) => ({
      id: row.id, scopeId: row.scope_id, createdAt: derivedTime(row.id), name: row.name_plain, memo: row.memo_plain,
    })), { returning: true });
    assert.equal(bulk.length, 501);
    assert.equal(bulk[500].name, bulkSource[500].name_plain);
    await assert.rejects(sealed.insert(db, peopleSeal, []), { code: 'INVALID_VALUE' });
    const inserted = await sealed.insert(db, peopleSeal, { id: first.id, scopeId: first.scope_id, createdAt: derivedTime(first.id), name: first.name_plain, memo: first.memo_plain });
    assert.deepEqual(inserted, [{ id: first.id, scopeId: first.scope_id }]);
    await assert.rejects(sealed.insert(db, peopleSeal, { id: first.id, scopeId: first.scope_id, createdAt: derivedTime(first.id), name: first.name_plain, memo: first.memo_plain }), error => {
      const wrapped = error as Error & { code: string; cause: Error & { code: string; constraint: string } };
      assert.equal(wrapped.code, 'CONSTRAINT_VIOLATION');
      assert.equal(wrapped.cause.code, '23505');
      assert.ok(wrapped.cause.constraint);
      assert.doesNotMatch(inspect(wrapped, { depth: 5 }), /params:|Failed query:/);
      return true;
    });
    await assert.rejects(db.transaction(async tx => {
      try { await tx.execute(sql`select 1 / 0`); } catch { /* Leave this transaction aborted. */ }
      await sealed.insert(tx, peopleSeal, { id: second.id, scopeId: second.scope_id, createdAt: derivedTime(second.id), name: second.name_plain, memo: second.memo_plain });
    }), error => {
      const wrapped = error as Error & { code: string; cause: Error & { code: string } };
      assert.equal(wrapped.code, 'DATABASE_ERROR');
      assert.equal(wrapped.cause.code, '25P02');
      return true;
    });
    const opened = await sealed.open(await db.select().from(people));
    assert.equal(opened[0].name, first.name_plain);
    assert.equal(opened[0].memo, first.memo_plain);
    const cipherRow = (await db.select().from(people))[0];
    await assert.rejects(sealed.open([{ ...cipherRow, id: second.id }]), { code: 'AUTHENTICATION_FAILED' });
    await assert.rejects(sealed.open([{ ...cipherRow, scopeId: second.id }]), { code: 'AUTHENTICATION_FAILED' });
    const damaged = cipherRow.name.bytes.slice(); damaged[damaged.length - 1] ^= 1;
    await assert.rejects(sealed.open([{ ...cipherRow, name: Sealed.fromDriver(damaged, cipherRow.name.binding) }]), { code: 'AUTHENTICATION_FAILED' });
    await assert.rejects(sealed.open([cipherRow], { scope: second.id }), { code: 'SCOPE_MISMATCH' });
    await assert.rejects(sealed.open(await db.select({ name: people.name }).from(people)), { code: 'ROW_CONTEXT_MISSING' });
    await assert.rejects(sealed.open([{ key: cipherRow.id, scopeId: cipherRow.scopeId, name: cipherRow.name }]), { code: 'ROW_CONTEXT_MISSING' });
    await assert.rejects(db.insert(people).values({ id: second.id, scopeId: first.scope_id, createdAt: derivedTime(second.id),
      name: cipherRow.name, memo: null } as any), /SEAL_REQUIRED/);
    await assert.rejects(db.insert(people).values({ id: second.id, scopeId: first.scope_id, createdAt: derivedTime(second.id),
      name: first.name_plain, memo: null } as any), /SEAL_REQUIRED/);
    const exactPage = await sealed.findMany(db, peopleSeal, { scope: first.scope_id, match: m => m.name.eq(first.name_plain) });
    assert.equal(exactPage.items.length, 1);
    assert.equal(exactPage.items[0].name, first.name_plain);
    assert.equal(await sealed.count(db, peopleSeal, { scope: first.scope_id, match: m => m.name.eq(first.name_plain) }), 1);
    const mixedPage = await sealed.findMany(db, peopleSeal, { scope: first.scope_id,
      match: m => m.or(m.memo.contains(second.memo_plain.slice(0, 2)), m.sql(eq(people.id, first.id))) });
    assert.equal(mixedPage.items.length, 1);
    await sealed.insert(db, ordersSeal, [{ id: second.id, scopeId: first.scope_id, customerId: first.id, label: first.name_plain },
      { id: third.id, scopeId: first.scope_id, customerId: first.id, label: first.name_plain }]);
    const peopleRelations = relations(people, ({ many }) => ({ orders: many(orders) }));
    const ordersRelations = relations(orders, ({ one }) => ({ customer: one(people, { fields: [orders.customerId], references: [people.id] }) }));
    const relationalDb = drizzle(pool, { schema: { people, orders, peopleRelations, ordersRelations } });
    const relational = await relationalDb.query.people.findMany({ with: { orders: true } });
    assert.equal((await sealed.open(relational))[0].name, first.name_plain);
    assert.equal(relational[0].orders.length, 2);
    const nestedCustomer = await relationalDb.query.orders.findMany({ with: { customer: true } });
    assert.equal((await sealed.open(nestedCustomer))[0].customer.name, first.name_plain);
    const joined = await sealed.search(db, { scope: first.scope_id, match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      keyset: [orders.id], limit: 1,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ c: people, o: orders, ...flags }).from(people)
        .innerJoin(orders, eq(orders.customerId, people.id)).where(and(where, after)).orderBy(...orderBy).limit(limit!),
    });
    assert.equal(joined.items.length, 1);
    assert.ok(joined.nextCursor);
    assert.equal(Object.keys(joined.items[0]).some(key => key.startsWith('__seal_')), false);
    const joinedNext = await sealed.search(db, { scope: first.scope_id, match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      keyset: [orders.id], limit: 1, cursor: joined.nextCursor!,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ c: people, o: orders, ...flags }).from(people)
        .innerJoin(orders, eq(orders.customerId, people.id)).where(and(where, after)).orderBy(...orderBy).limit(limit!),
    });
    assert.equal(joinedNext.items.length, 1);
    assert.notEqual((joined.items[0] as any).o.id, (joinedNext.items[0] as any).o.id);
    const joinedBudget = canonical(joined.items[0]).length + 1;
    const budgetQuery = ({ where, after, orderBy, flags, limit }: any) => db.select({ c: people, o: orders, ...flags }).from(people)
      .innerJoin(orders, eq(orders.customerId, people.id)).where(and(where, after)).orderBy(...orderBy).limit(limit!);
    const budgeted = await sealed.search(db, { scope: first.scope_id, match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      keyset: [orders.id], limit: 3, budgets: { resultBytes: joinedBudget }, query: budgetQuery });
    assert.equal(budgeted.items.length, 1); assert.ok(budgeted.nextCursor);
    const budgetedNext = await sealed.search(db, { scope: first.scope_id, match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      keyset: [orders.id], limit: 3, budgets: { resultBytes: joinedBudget }, cursor: budgeted.nextCursor!, query: budgetQuery });
    assert.equal(budgetedNext.items.length, 1);
    assert.deepEqual([...budgeted.items, ...budgetedNext.items].map((row: any) => row.o.id), [second.id, third.id]);
    const originalOpen = cipher.open.bind(cipher);
    let customerNameOpens = 0;
    cipher.open = async (...args) => {
      if (args[1].modelId === 'people' && args[1].fieldId === 'name') customerNameOpens++;
      return originalOpen(...args);
    };
    const rawJoined = await sealed.search(db, { scope: first.scope_id, match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      keyset: [orders.id], limit: 2, columns: { c: { id: 'c_id', scopeId: 'c_scope', name: 'c_name_ct', memo: 'c_memo_ct' } },
      query: ({ where, after, orderBy, flagsSql, limit }) => db.execute(sql`select ${people.id} as c_id, ${people.scopeId} as c_scope,
        ${people.name} as c_name_ct, ${people.memo} as c_memo_ct, ${orders.id} as o_id, ${flagsSql}
        from ${people} inner join ${orders} on ${orders.customerId} = ${people.id}
        where ${where} ${after ? sql`and ${after}` : sql``} order by ${sql.join(orderBy, sql.raw(','))} limit ${limit}`),
    });
    assert.equal(rawJoined.items.length, 2);
    assert.equal((rawJoined.items[0] as any).c_name_ct, first.name_plain);
    assert.equal(Object.keys(rawJoined.items[0]).some(key => key.startsWith('__seal_')), false);
    assert.equal(customerNameOpens, 1, '1:N duplicate rows share authenticated field result within a search call');
    cipher.open = originalOpen;
    await assert.rejects(sealed.search(db, { scope: first.scope_id,
      match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      columns: { c: { id: 'c_id', scopeId: 'c_scope', name: 'c_name_ct' } },
      query: async () => [{ c_name_ct: first.name_plain }],
    }), { code: 'INVALID_CANDIDATE_SHAPE' });
    await assert.rejects(sealed.search(db, { scope: first.scope_id,
      match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      query: async () => [{ c: { id: first.id, scopeId: first.scope_id, name: first.name_plain } }],
    }), { code: 'INVALID_CANDIDATE_SHAPE' });
    await assert.rejects(sealed.search(db, { scope: first.scope_id,
      match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      query: async () => [{ c: { id: first.id, scopeId: first.scope_id, name: cipherRow.memo } }],
    }), { code: 'INVALID_CANDIDATE_SHAPE' });
    await assert.rejects(sealed.search(db, { scope: first.scope_id,
      match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      query: async () => [{ c: { id: first.id, scopeId: first.scope_id, name: cipherRow.name, memo: first.memo_plain } }],
    }), { code: 'INVALID_CANDIDATE_SHAPE' });
    await assert.rejects(sealed.search(db, { scope: first.scope_id,
      match: { c: [peopleSeal, m => m.or(m.name.eq(first.name_plain), m.sql(sql`false`))] },
      columns: { c: { id: 'c_id', scopeId: 'c_scope', name: 'c_name_ct', memo: 'c_memo_ct' } },
      budgets: { decryptedBytes: 1 },
      query: ({ where, after, orderBy, flagsSql, limit }) => db.execute(sql`select ${people.id} as c_id,
        ${people.scopeId} as c_scope, ${people.name} as c_name_ct, ${people.memo} as c_memo_ct, ${flagsSql}
        from ${people} where ${where} ${after ? sql`and ${after}` : sql``}
        order by ${sql.join(orderBy, sql.raw(','))} ${limit === undefined ? sql`` : sql`limit ${limit}`}`),
    }), { code: 'LIMIT_EXCEEDED' });
    await assert.rejects(sealed.search(db, { scope: first.scope_id,
      match: { c: [peopleSeal, m => m.or(m.name.eq(first.name_plain), m.sql(sql`false`))] },
      columns: { c: { id: 'c_id', scopeId: 'c_scope', name: 'c_name_ct', memo: 'c_memo_ct' } },
      budgets: { decryptedBytes: cipherRow.name.bytes.length - 29 }, limit: 1,
      query: ({ where, after, orderBy, flagsSql, limit }) => db.execute(sql`select ${people.id} as c_id,
        ${people.scopeId} as c_scope, ${people.name} as c_name_ct, ${people.memo} as c_memo_ct, ${flagsSql}
        from ${people} where ${where} ${after ? sql`and ${after}` : sql``}
        order by ${sql.join(orderBy, sql.raw(','))} ${limit === undefined ? sql`` : sql`limit ${limit}`}`),
    }), { code: 'LIMIT_EXCEEDED' });
    await assert.rejects(sealed.search(db, { scope: first.scope_id,
      match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] },
      budgets: { fetchBytes: 1 }, limit: 1,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ c: people, ...flags }).from(people)
        .where(and(where, after)).orderBy(...orderBy).limit(limit!),
    }), { code: 'LIMIT_EXCEEDED' });
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(sealed.findMany(db, peopleSeal, { scope: first.scope_id, signal: cancelled.signal }), { code: 'CANCELLED' });
    const extraOrderIds = (await pool.query('select id from bench_realistic_100k.tickets where id<>$1 and id<>$2 order by id limit 29',
      [second.id, third.id])).rows.map(row => row.id as string);
    assert.equal(extraOrderIds.length, 29);
    await sealed.insert(db, ordersSeal, extraOrderIds.map(id => ({ id, scopeId: first.scope_id, customerId: first.id, label: first.name_plain })));
    const fieldOpens = new Map<string, number>();
    cipher.open = async (...args) => {
      if (args[1].modelId === 'people') fieldOpens.set(args[1].fieldId, (fieldOpens.get(args[1].fieldId) ?? 0) + 1);
      return originalOpen(...args);
    };
    const duplicatePage = await sealed.search(db, { scope: first.scope_id,
      match: { c: [peopleSeal, m => m.name.eq(first.name_plain)] }, keyset: [orders.id], limit: 31,
      query: budgetQuery,
    });
    assert.equal(duplicatePage.items.length, 31);
    assert.equal(fieldOpens.get('name'), 1);
    assert.equal(fieldOpens.get('memo'), 1);
    cipher.open = originalOpen;
    let joinedOrder = '';
    const orderedJoin = ({ where, after, orderBy, flags, limit }: any) => {
      joinedOrder = new PgDialect().sqlToQuery(sql.join(orderBy, sql.raw(','))).sql;
      return db.select({ o: orders, c: people, ...flags }).from(orders)
        .innerJoin(people, eq(orders.customerId, people.id)).where(and(where, after)).orderBy(...orderBy).limit(limit!);
    };
    const orderedMatch = { o: [ordersSeal, (m: any) => m.label.eq(first.name_plain)] as const,
      c: [peopleSeal, (m: any) => m.name.eq(first.name_plain)] as const };
    const firstOrdered = await sealed.search(db, { scope: first.scope_id, match: orderedMatch, limit: 7, query: orderedJoin });
    assert.ok(joinedOrder.indexOf('"orders"."id"') < joinedOrder.indexOf('"people"."id"'), joinedOrder);
    assert.ok(firstOrdered.nextCursor);
    await assert.rejects(sealed.search(db, { scope: first.scope_id, limit: 7, cursor: firstOrdered.nextCursor!, query: orderedJoin,
      match: { c: orderedMatch.c, o: orderedMatch.o } }), { code: 'CURSOR_INVALID' });
    const joinedIds = firstOrdered.items.map(row => (row as any).o.id as string);
    let joinCursor: string | null = firstOrdered.nextCursor;
    while (joinCursor) {
      const page: { items: typeof firstOrdered.items; nextCursor: string | null } = await sealed.search(db,
        { scope: first.scope_id, match: orderedMatch, limit: 7, cursor: joinCursor, query: orderedJoin });
      joinedIds.push(...page.items.map(row => (row as any).o.id as string));
      joinCursor = page.nextCursor;
    }
    assert.deepEqual(joinedIds, [second.id, third.id, ...extraOrderIds].sort());
    assert.equal(new Set(joinedIds).size, joinedIds.length);
    await sealed.update(db, peopleSeal, { id: first.id, scopeId: first.scope_id }, { memo: second.memo_plain });
    const afterUpdate = await sealed.open(await db.select().from(people));
    assert.equal(afterUpdate[0].name, first.name_plain);
    assert.equal(afterUpdate[0].memo, second.memo_plain);
    await sealed.update(db, peopleSeal, { id: first.id, scopeId: first.scope_id }, { memo: null });
    assert.equal((await sealed.open(await db.select().from(people)))[0].memo, null);
    await assert.rejects(sealed.update(db, peopleSeal, { id: first.id, scopeId: first.scope_id }, { memo: undefined }), { code: 'INVALID_VALUE' });
    await assert.rejects(sealed.update(db, peopleSeal, { id: first.id, scopeId: first.scope_id }, { unknown: undefined } as any), { code: 'INVALID_VALUE' });
    await sealed.update(db, peopleSeal, { id: first.id, scopeId: first.scope_id }, { memo: undefined, name: first.name_plain });
    assert.equal((await sealed.open(await db.select().from(people)))[0].memo, null);
    await sealed.upsert(db, peopleSeal, { id: first.id, scopeId: first.scope_id, createdAt: derivedTime(first.id), name: second.name_plain, memo: first.memo_plain });
    const afterUpsert = await sealed.open(await db.select().from(people));
    assert.equal(afterUpsert[0].name, second.name_plain);
    assert.equal(afterUpsert[0].memo, first.memo_plain);
    await pool.query(`update "${schemaName}".people_seal_index set "${exact}" = null, "${substring}" = null`);
    assert.equal((await sealed.findMany(db, peopleSeal, { scope: first.scope_id, match: m => m.name.eq(second.name_plain) })).items.length, 0);
    assert.deepEqual(await sealed.reindex(db, peopleSeal, { scope: first.scope_id, batch: 1 }), { rows: 1 });
    assert.equal((await sealed.findMany(db, peopleSeal, { scope: first.scope_id, match: m => m.name.eq(second.name_plain) })).items.length, 1);
    await assert.rejects(sealed.upsert(db, peopleSeal, { id: first.id, scopeId: second.id, createdAt: derivedTime(first.id), name: second.name_plain, memo: second.memo_plain }), { code: 'SCOPE_CONFLICT' });
    const raw = await db.execute(sql`select id,scope_id,name_ct,memo_ct from ${people}`);
    const rawOpen = await sealed.openRaw(peopleSeal, raw.rows as Record<string, unknown>[], { columns: { id: 'id', scopeId: 'scope_id', name: 'name_ct', memo: 'memo_ct' } });
    assert.equal(rawOpen[0].name_ct, second.name_plain);
    const hexRows = raw.rows.map((row: any) => ({ ...row, name_ct: `\\x${Buffer.from(row.name_ct).toString('hex')}` }));
    assert.equal((await sealed.openRaw(peopleSeal, hexRows, { columns: { id: 'id', scopeId: 'scope_id', name: 'name_ct' } }))[0].name_ct, second.name_plain);
    await assert.rejects(sealed.update(db, peopleSeal, { id: first.id, scopeId: first.scope_id }, {}), { code: 'INVALID_VALUE' });
    await assert.rejects(db.transaction(async tx => {
      await sealed.insert(tx, peopleSeal, [
        { id: second.id, scopeId: second.scope_id, createdAt: derivedTime(second.id), name: second.name_plain, memo: second.memo_plain },
        { id: third.id, scopeId: third.scope_id, createdAt: derivedTime(third.id), name: third.name_plain, memo: third.memo_plain },
      ]);
      throw Error('rollback');
    }), /rollback/);
    assert.equal((await db.select().from(people).where(eq(people.id, second.id))).length, 0);
    assert.equal((await pool.query(`select count(*)::int as n from "${schemaName}".people_seal_index`)).rows[0].n, 1);
    await sealed.insert(db, peopleSeal, { id: second.id, scopeId: second.id, createdAt: derivedTime(second.id), name: second.name_plain, memo: undefined });
    assert.equal((await sealed.open(await db.select().from(people).where(eq(people.id, second.id))))[0].memo, null);
    await sealed.insert(db, peopleSeal, { id: third.id, scopeId: first.scope_id, createdAt: derivedTime(third.id), name: third.name_plain, memo: third.memo_plain });
    await sealed.upsert(db, peopleSeal, { id: first.id, scopeId: first.scope_id, createdAt: derivedTime(first.id), name: first.name_plain, memo: undefined });
    assert.equal((await sealed.open(await db.select().from(people).where(eq(people.id, first.id))))[0].memo, first.memo_plain);
    const oneItemBytes = canonical({ id: first.id, scopeId: first.scope_id }).length;
    const short = await sealed.findMany(db, peopleSeal, { scope: first.scope_id, columns: { id: true }, limit: 3,
      budgets: { resultBytes: oneItemBytes + 1 } });
    assert.equal(short.items.length, 1); assert.ok(short.nextCursor);
    const resumed = await sealed.findMany(db, peopleSeal, { scope: first.scope_id, columns: { id: true }, limit: 3,
      cursor: short.nextCursor!, budgets: { resultBytes: oneItemBytes + 1 } });
    assert.equal(resumed.items.length, 1);
    assert.deepEqual([...short.items, ...resumed.items].map(row => row.id), [first.id, third.id]);
    const descending: string[] = [];
    let descendingCursor: string | undefined;
    do {
      const page = await sealed.findMany(db, peopleSeal, { scope: first.scope_id, columns: { id: true },
        orderBy: { column: people.createdAt, direction: 'desc' }, limit: 1, cursor: descendingCursor });
      descending.push(...page.items.map(row => row.id));
      descendingCursor = page.nextCursor ?? undefined;
    } while (descendingCursor);
    assert.deepEqual(descending, [third.id, first.id]);
    const decryptedLimit = Math.max(utf8(first.name_plain).length, utf8(third.name_plain).length);
    const decryptedIds: string[] = [];
    let decryptedCursor: string | undefined;
    do {
      const page = await sealed.findMany(db, peopleSeal, { scope: first.scope_id,
        columns: { id: true, name: true }, limit: 2, cursor: decryptedCursor,
        budgets: { decryptedBytes: decryptedLimit } });
      assert.equal(page.items.length, 1);
      decryptedIds.push(page.items[0].id);
      decryptedCursor = page.nextCursor ?? undefined;
    } while (decryptedCursor);
    assert.deepEqual(decryptedIds, [first.id, third.id]);
    const realNow = Date.now, previousOpen = cipher.open;
    const baseNow = realNow();
    let logicalNow = baseNow, openedFields = 0;
    Date.now = () => logicalNow;
    cipher.open = async (...args) => {
      const value = await previousOpen(...args);
      if (args[1].fieldId === 'name') logicalNow = baseNow + (++openedFields === 1 ? 999 : 1000);
      return value;
    };
    let deadlinePage;
    try {
      deadlinePage = await sealed.findMany(db, peopleSeal, { scope: first.scope_id,
        columns: { id: true, name: true }, limit: 2,
        budgets: { deadlineMs: 1000, decryptConcurrency: 1 } });
    } finally { Date.now = realNow; cipher.open = previousOpen; }
    assert.equal(deadlinePage.items.length, 1);
    assert.ok(deadlinePage.nextCursor);
    const deadlineResumed = await sealed.findMany(db, peopleSeal, { scope: first.scope_id,
      columns: { id: true, name: true }, limit: 2, cursor: deadlinePage.nextCursor! });
    assert.deepEqual([...deadlinePage.items, ...deadlineResumed.items].map(row => row.id), [first.id, third.id]);
    const sorted = await sealed.findMany(db, peopleSeal, { scope: first.scope_id, columns: { id: true },
      orderBy: { column: people.createdAt, direction: 'asc' }, limit: 1 });
    assert.equal(sorted.items.length, 1); assert.ok(sorted.nextCursor);
    const sortedNext = await sealed.findMany(db, peopleSeal, { scope: first.scope_id, columns: { id: true },
      orderBy: { column: people.createdAt, direction: 'asc' }, limit: 1, cursor: sorted.nextCursor! });
    assert.equal(sortedNext.items.length, 1);
    assert.deepEqual([sorted.items[0].id, sortedNext.items[0].id], [first.id, third.id]);
    await assert.rejects(sealed.count(db, peopleSeal, { scope: first.scope_id, budgets: { fetchBytes: 80 } }), { code: 'LIMIT_EXCEEDED' });
    const tenantPage = await sealed.search(db, { scope: first.scope_id,
      match: { p: [peopleSeal, m => m.or(m.name.eq('absent'), m.sql(sql`true`))] },
      query: ({ where, after, orderBy, flags, limit }) => db.select({ p: people, ...flags }).from(people)
        .where(and(where, after)).orderBy(...orderBy).limit(limit!),
    });
    assert.deepEqual(tenantPage.items.map(row => row.p.id), [first.id, third.id]);
    const decoy = await sealed.search(db, { scope: first.scope_id,
      match: { p: [peopleSeal, m => m.name.eq(first.name_plain)] },
      columns: { p: { id: 'p_id', scopeId: 'p_scope', name: 'p_name_ct' } },
      query: ({ where, after, orderBy, limit }) => db.execute(sql`select ${people.id} as p_id,
        ${people.scopeId} as p_scope, ${people.name} as p_name_ct, 'wrong' as name
        from ${people} where ${where} ${after ? sql`and ${after}` : sql``}
        order by ${sql.join(orderBy, sql.raw(','))} ${limit === undefined ? sql`` : sql`limit ${limit}`}`),
    });
    assert.equal(decoy.items.length, 1);
    assert.equal((decoy.items[0] as any).p_name_ct, first.name_plain);
    await db.delete(people).where(eq(people.id, first.id));
    assert.equal((await pool.query(`select count(*)::int as n from "${schemaName}".people_seal_index`)).rows[0].n, 2);
  } finally {
    if (created) await pool.query('drop schema test_native_write cascade');
    await pool.end();
  }
});

test('text row IDs follow the database collation and keep index-backed keysets', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  let created = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    const fixture = (await pool.query('select id,scope_id,name_plain from bench_realistic_100k.customers order by id limit 200')).rows;
    assert.equal(fixture.length, 200);
    const schemaName = 'test_native_text';
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [schemaName])).rowCount, 0);
    await pool.query(`create schema "${schemaName}"`); created = true;
    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(93) }) });
    const rows = pgSchema(schemaName).table('rows', {
      id: sealed.textId('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
      name: sealed.text('name', { search: { exact: true } }),
    });
    const seal = sealed.register(rows, { row: 'id', scope: 'scopeId' });
    const exact = registrationOf(seal).storage.index!.profiles!['name/exact'].tokens;
    assert.equal((await pool.query("select count(*)::int as n from pg_collation where collname='und-x-icu'")).rows[0].n, 1);
    await pool.query(`create table "${schemaName}".rows (id text collate "und-x-icu" primary key,scope_id uuid not null,name_ct bytea not null)`);
    await pool.query(`create table "${schemaName}".rows_seal_index (scope_id uuid not null,row_id text collate "und-x-icu" not null,
      "${exact}" bigint[],unique(scope_id,row_id),foreign key(row_id) references "${schemaName}".rows(id) on delete cascade)`);
    const logged: { query: string; params: unknown[] }[] = [];
    const db = drizzle(pool, { logger: { logQuery(query, params) { logged.push({ query, params }); } } });
    const prefixes = ['Z', 'a', '가', '!'];
    const ids = fixture.map((row, index) => index === 0 ? '' : `${prefixes[index % prefixes.length]}${row.id}`);
    await assert.rejects(sealed.insert(db, seal, { scopeId: fixture[0].scope_id, name: fixture[0].name_plain }), { code: 'INVALID_VALUE' });
    await sealed.insert(db, seal, ids.map((id, index) => ({
      id, scopeId: fixture[0].scope_id, name: fixture[index].name_plain,
    })));
    assert.equal((await sealed.open(await db.select().from(rows).where(eq(rows.id, ''))))[0].name, fixture[0].name_plain);
    const emptyPage = await sealed.findMany(db, seal, { scope: fixture[0].scope_id, limit: 1 });
    assert.equal(emptyPage.items[0].id, '');
    assert.ok(emptyPage.nextCursor);
    assert.notEqual((await sealed.findMany(db, seal, { scope: fixture[0].scope_id,
      limit: 1, cursor: emptyPage.nextCursor! })).items[0].id, '');
    await pool.query(`analyze "${schemaName}".rows`);
    await pool.query(`analyze "${schemaName}".rows_seal_index`);
    const expected = (await pool.query(`select id from "${schemaName}".rows order by id`)).rows.map(row => row.id as string);
    await sealed.findMany(db, seal, { scope: fixture[0].scope_id, match: m => m.name.eq(fixture[0].name_plain), limit: 2 });
    const search = (cursor?: string) => sealed.search(db, { scope: fixture[0].scope_id,
      match: { r: [seal, m => m.or(m.name.eq('absent'), m.sql(sql`true`))] }, limit: 20, cursor,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ r: rows, ...flags }).from(rows)
        .where(and(where, after)).orderBy(...orderBy).limit(limit!),
    });
    const searchIds: string[] = [], findIds: string[] = [];
    let nonemptySearchPages = 0;
    let searchCursor: string | undefined, findCursor: string | undefined;
    do {
      const searched = await search(searchCursor);
      if (searched.items.length) nonemptySearchPages++;
      searchIds.push(...searched.items.map(item => item.r.id));
      searchCursor = searched.nextCursor ?? undefined;
    } while (searchCursor);
    assert.equal(logged.filter(entry => entry.query.includes('with input as')).length, nonemptySearchPages);
    await assert.rejects(sealed.search(db, { scope: fixture[0].scope_id,
      match: { r: [seal, m => m.or(m.name.eq('absent'), m.sql(sql`true`))] }, limit: 20,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ r: rows, ...flags }).from(rows)
        .where(and(where, after)).orderBy(desc(rows.id), ...orderBy).limit(limit!),
    }), { code: 'INVALID_CANDIDATE_SHAPE' });
    await assert.rejects(sealed.search(db, { scope: fixture[0].scope_id,
      match: { r: [seal, m => m.or(m.name.eq('absent'), m.sql(sql`true`))] }, limit: 20,
      query: async ({ where, after, flags, limit }) => (await db.select({ r: rows, ...flags }).from(rows)
        .where(and(where, after)).limit(limit!)).reverse(),
    }), { code: 'INVALID_CANDIDATE_SHAPE' });
    do {
      const found = await sealed.findMany(db, seal, { scope: fixture[0].scope_id, limit: 20, cursor: findCursor });
      findIds.push(...found.items.map(item => item.id));
      findCursor = found.nextCursor ?? undefined;
    } while (findCursor);
    assert.deepEqual(searchIds, expected);
    assert.deepEqual(findIds, expected);
    const candidateSql = logged.find(entry => entry.query.includes(' in (select ') && entry.query.includes(exact));
    const keysetSql = logged.find(entry => /"rows"\."id"\s*>\s*\$\d+/.test(entry.query) && entry.query.includes('order by'));
    assert.ok(candidateSql); assert.ok(keysetSql);
    const planClient = await pool.connect();
    try {
      await planClient.query('begin');
      await planClient.query('set local enable_seqscan=off');
      for (const entry of [candidateSql, keysetSql]) {
        const explained = await planClient.query(`explain ${entry.query}`, entry.params);
        const plan = explained.rows.map(row => row['QUERY PLAN']).join('\n');
        assert.match(plan, /Index (?:Only )?Scan using .*rows_pkey/, plan);
        assert.doesNotMatch(plan, /Seq Scan on rows /, plan);
        if (entry === keysetSql) assert.doesNotMatch(plan, /Sort/, plan);
      }
    } finally { await planClient.query('rollback'); planClient.release(); }
    assert.equal(await sealed.count(db, seal, { scope: fixture[0].scope_id }), ids.length);
    assert.deepEqual(await sealed.reindex(db, seal, { scope: fixture[0].scope_id, batch: 50 }), { rows: ids.length });
    assert.deepEqual((await sealed.findMany(db, seal, { scope: fixture[0].scope_id, limit: ids.length })).items.map(row => row.id), expected);
    const beforeDelete = await sealed.search(db, { scope: fixture[0].scope_id,
      match: { r: [seal, m => m.or(m.name.eq('absent'), m.sql(sql`true`))] }, limit: 1,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ r: rows, ...flags }).from(rows)
        .where(and(where, after)).orderBy(...orderBy).limit(limit!),
    });
    await db.delete(rows).where(eq(rows.id, beforeDelete.items[0].r.id));
    const afterDelete = await sealed.search(db, { scope: fixture[0].scope_id,
      match: { r: [seal, m => m.or(m.name.eq('absent'), m.sql(sql`true`))] }, limit: 1, cursor: beforeDelete.nextCursor!,
      query: ({ where, after, orderBy, flags, limit }) => db.select({ r: rows, ...flags }).from(rows)
        .where(and(where, after)).orderBy(...orderBy).limit(limit!),
    });
    assert.equal(afterDelete.items[0].r.id, expected[1]);
  } finally {
    if (created) await pool.query('drop schema test_native_text cascade');
    await pool.end();
  }
});

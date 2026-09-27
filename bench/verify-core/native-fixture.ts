/** Fixture-derived, disposable tables for native API correctness checks. No timing is recorded. */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../../src/index.js';
import { createSealed, registrationOf } from '../../src/adapters/drizzle/v0.45/native.js';
import { assertDisposable } from '../../test/disposable.js';

const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function withNativeFixture<T>(schemaName: string, run: (context: any) => Promise<T>): Promise<T> {
  assert.match(schemaName, /^verify_native_[a-z]+$/);
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  let created = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    const tickets = (await pool.query(`select distinct on (customer_id) id,scope_id,customer_id,memo_plain
      from bench_realistic_100k.tickets where scope_id=$1 order by customer_id,id limit 2`, [scopeId])).rows;
    assert.equal(tickets.length, 2);
    const customer = (await pool.query(`select id,scope_id,name_plain,memo_plain,company_plain,email_plain
      from bench_realistic_100k.customers where scope_id=$1 and id=$2`, [scopeId, tickets[0].customer_id])).rows[0];
    const other = (await pool.query(`select id,scope_id,name_plain,memo_plain,company_plain,email_plain
      from bench_realistic_100k.customers where scope_id=$1 and id=$2`, [scopeId, tickets[1].customer_id])).rows[0];
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [schemaName])).rowCount, 0);
    await pool.query(`create schema ${quote(schemaName)}`); created = true;
    const schema = pgSchema(schemaName), db = drizzle(pool);
    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(93) }) });
    const customers = schema.table('customers', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
      name: sealed.text('name', { search: { exact: true } }),
      memo: sealed.text('memo', { maxBytes: 2048, search: { substring: true } }),
      company: sealed.text('company', { search: { exact: true } }),
      optional: sealed.text('optional', { nullable: true, search: { exact: true, substring: true } }),
      bounded: sealed.text('bounded', { maxBytes: 16, search: { exact: true } }),
    });
    const customersSeal = sealed.register(customers, { row: 'id', scope: 'scopeId' });
    const ticketTable = schema.table('tickets', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), customerId: uuid('customer_id').notNull(),
      memo: sealed.text('memo', { search: { substring: true } }),
    });
    const ticketsSeal = sealed.register(ticketTable, { row: 'id', scope: 'scopeId' });
    for (const [name, table, seal, extra] of [
      ['customers', customers, customersSeal, 'name_ct bytea not null,memo_ct bytea not null,company_ct bytea not null,optional_ct bytea,bounded_ct bytea not null'],
      ['tickets', ticketTable, ticketsSeal, 'customer_id uuid not null,memo_ct bytea not null'],
    ] as const) {
      const profiles = registrationOf(seal).storage.index!.profiles!;
      const tokens = Object.values(profiles).map(profile => `${quote(profile.tokens)} bigint[]`).join(',');
      await pool.query(`create table ${quote(schemaName)}.${quote(name)} (id uuid primary key,scope_id uuid not null,${extra})`);
      await pool.query(`create table ${quote(schemaName)}.${quote(name + '_seal_index')} (scope_id uuid not null,row_id uuid not null,${tokens},
        unique(scope_id,row_id),foreign key(row_id) references ${quote(schemaName)}.${quote(name)}(id) on delete cascade)`);
      const exact = Object.values(profiles).filter(profile => profile.mode === 'exact');
      for (const profile of exact) await pool.query(`create index ${quote(name + '_' + profile.tokens + '_bt')} on ${quote(schemaName)}.${quote(name + '_seal_index')}
        (scope_id,((${quote(profile.tokens)})[1]),row_id)`);
      const substring = Object.values(profiles).filter(profile => profile.mode === 'substring');
      if (substring.length) await pool.query(`create index ${quote(name + '_substring_gin')} on ${quote(schemaName)}.${quote(name + '_seal_index')}
        using gin (${substring.map(profile => quote(profile.tokens)).join(',')})`);
      void table;
    }
    for (const row of [customer, other]) await sealed.insert(db, customersSeal, {
      id: row.id, scopeId: row.scope_id, name: row.name_plain, memo: row.memo_plain,
      company: row.company_plain, optional: null, bounded: row.email_plain.slice(0, 16),
    });
    for (const row of tickets) await sealed.insert(db, ticketsSeal, {
      id: row.id, scopeId: row.scope_id, customerId: row.customer_id, memo: row.memo_plain,
    });
    return await run({ pool, db, sealed, customers, customersSeal, ticketTable, ticketsSeal,
      customer, other, tickets, scopeId, schemaName });
  } finally {
    if (created) await pool.query(`drop schema ${quote(schemaName)} cascade`);
    await pool.end();
  }
}

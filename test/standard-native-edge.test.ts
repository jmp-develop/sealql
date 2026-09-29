import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { pgSchema, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { assertDisposable } from './disposable.js';
import { installProofColumns } from './proof-schema.js';

test('scope-free nullable index rows disappear when every token is null', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  let created = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    const fixture = (await pool.query('select id,name_plain from bench_realistic_100k.customers order by id limit 1')).rows[0];
    const name = 'test_native_scope_free';
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [name])).rowCount, 0);
    await pool.query(`create schema "${name}"`); created = true;
    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(93) }) });
    const rows = pgSchema(name).table('rows', { id: uuid('id').primaryKey(),
      optional: sealed.text('optional', { nullable: true, search: { exact: true } }) });
    const seal = sealed.register(rows, { row: 'id' });
    const token = registrationOf(seal).storage.index!.profiles!['optional/exact'].tokens;
    await pool.query(`create table "${name}".rows (id uuid primary key,optional_ct bytea)`);
    await pool.query(`create table "${name}".rows_seal_index (scope_id text collate "C" not null default '_',row_id uuid not null,
      "${token}" bigint[],unique(scope_id,row_id),foreign key(row_id) references "${name}".rows(id) on delete cascade)`);
    await installProofColumns(pool, seal);
    const db = drizzle(pool);
    await sealed.insert(db, seal, { id: fixture.id });
    assert.equal((await sealed.open(await db.select().from(rows)))[0].optional, null);
    assert.deepEqual(await sealed.reindex(db, seal, { batch: 1 }), { rows: 1 });
    assert.equal((await pool.query(`select count(*)::int n from "${name}".rows_seal_index`)).rows[0].n, 0);
    await sealed.update(db, seal, { id: fixture.id }, { optional: fixture.name_plain });
    assert.equal((await sealed.findMany(db, seal, { match: m => m.optional.eq(fixture.name_plain) })).items.length, 1);
    await sealed.update(db, seal, { id: fixture.id }, { optional: null });
    await sealed.reindex(db, seal);
    assert.equal((await pool.query(`select count(*)::int n from "${name}".rows_seal_index`)).rows[0].n, 0);
    await assert.rejects(sealed.findMany(db, seal, { scope: '_' }), { code: 'INVALID_VALUE' });
  } finally {
    if (created) await pool.query('drop schema test_native_scope_free cascade');
    await pool.end();
  }
});

test('composite parent key uses scope and row foreign key', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  let created = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    const fixture = (await pool.query('select id,scope_id,name_plain from bench_realistic_100k.customers order by id limit 2')).rows;
    const name = 'test_native_composite';
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1', [name])).rowCount, 0);
    await pool.query(`create schema "${name}"`); created = true;
    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(93) }) });
    const rows = pgSchema(name).table('rows', { id: uuid('id').notNull(), scopeId: uuid('scope_id').notNull(),
      name: sealed.text('name', { search: { exact: true } }) }, t => [primaryKey({ columns: [t.scopeId, t.id] })]);
    const seal = sealed.register(rows, { row: 'id', scope: 'scopeId' });
    assert.equal(registrationOf(seal).rowUnique, false);
    const token = registrationOf(seal).storage.index!.profiles!['name/exact'].tokens;
    await pool.query(`create table "${name}".rows (id uuid not null,scope_id uuid not null,name_ct bytea not null,primary key(scope_id,id))`);
    await pool.query(`create table "${name}".rows_seal_index (scope_id uuid not null,row_id uuid not null,
      "${token}" bigint[],unique(scope_id,row_id),foreign key(scope_id,row_id) references "${name}".rows(scope_id,id) on delete cascade)`);
    await installProofColumns(pool, seal);
    const db = drizzle(pool), scopeA = fixture[0].scope_id, scopeB = fixture[1].id, id = fixture[0].id;
    await sealed.insert(db, seal, [
      { id, scopeId: scopeA, name: fixture[0].name_plain },
      { id, scopeId: scopeB, name: fixture[1].name_plain },
    ]);
    assert.equal((await sealed.findMany(db, seal, { scope: scopeA, match: m => m.name.eq(fixture[0].name_plain) })).items.length, 1);
    assert.equal((await sealed.findMany(db, seal, { scope: scopeB, match: m => m.name.eq(fixture[1].name_plain) })).items.length, 1);
    await sealed.update(db, seal, { id, scopeId: scopeB }, { name: fixture[0].name_plain });
    await db.delete(rows).where(eq(rows.scopeId, scopeA));
    assert.equal((await pool.query(`select count(*)::int n from "${name}".rows_seal_index`)).rows[0].n, 1);
  } finally {
    if (created) await pool.query('drop schema test_native_composite cascade');
    await pool.end();
  }
});

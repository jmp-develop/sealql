import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { setPrepareAllSearchTestHooks } from '../src/adapters/drizzle/v0.45/native-runtime.js';
import { assertDisposable } from './disposable.js';

test('prepareAllSearch preflights every registration and proves full parent coverage', async () => {
  const schemaName = 'test_prepare_all_search';
  const missingSchemaName = 'test_prepare_missing_search';
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  let created = false, missingCreated = false;
  try {
    await assertDisposable(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=any($1)', [[schemaName, missingSchemaName]])).rowCount, 0);

    const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(91) }) });
    const schema = pgSchema(schemaName);
    const scoped = schema.table('scoped_rows', {
      id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
      name: sealed.text('name', { nullable: true, search: { exact: true } }),
    });
    const globalRows = schema.table('global_rows', {
      code: sealed.textId('code').primaryKey(),
      name: sealed.text('name', { nullable: true, search: { exact: true } }),
    });
    const scopedSeal = sealed.register(scoped, { row: 'id', scope: 'scopeId' });
    const globalSeal = sealed.register(globalRows, { row: 'code' });
    await pool.query(`create schema "${schemaName}"`); created = true;
    for (const statement of await generateMigration(generateDrizzleJson({}),
      generateDrizzleJson({ scoped, scopedSeal, globalRows, globalSeal }))) await pool.query(statement);
    for (const statement of [...sealed.extraMigrationSql(scopedSeal), ...sealed.extraMigrationSql(globalSeal)]) await pool.query(statement);
    const db = drizzle(pool);
    const noRegistrations = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(90) }) });
    await assert.rejects(noRegistrations.prepareAllSearch(db), { code: 'INVALID_SCHEMA' });

    const empty = await sealed.prepareAllSearch(db);
    assert.deepEqual(empty.registrations.map(item => item.parentRowsAtStart), [0, 0]);
    assert.equal(empty.totalRows, 0); assert.equal(empty.totalFields, 0);

    const fixture = (await pool.query(`select id,scope_id,name_plain from bench_realistic_100k.customers order by id limit 1001`)).rows;
    assert.equal(fixture.length, 1001);
    const scopeId = fixture[0].scope_id as string;
    const inputs = fixture.map(row => ({ id: row.id as string, scopeId, name: row.name_plain as string }));
    await sealed.insert(db, scopedSeal, inputs[0]);
    await sealed.insert(db, globalSeal, { code: fixture[0].id as string, name: null });
    const one = await sealed.prepareAllSearch(db, { batchSize: 1000 });
    assert.deepEqual(one.registrations.map(item => item.parentRowsAtStart), [1, 1]);
    assert.deepEqual(one.registrations.map(item => item.visitedRows), [1, 1]);

    await sealed.insert(db, scopedSeal, inputs.slice(1, 999));
    assert.equal((await sealed.prepareAllSearch(db, { batchSize: 1000 })).registrations[0].parentRowsAtStart, 999);
    await sealed.insert(db, scopedSeal, inputs[999]);
    assert.equal((await sealed.prepareAllSearch(db, { batchSize: 1000 })).registrations[0].parentRowsAtStart, 1000);
    await sealed.insert(db, scopedSeal, inputs[1000]);
    const boundary = await sealed.prepareAllSearch(db, { batchSize: 1000 });
    assert.equal(boundary.registrations[0].parentRowsAtStart, 1001);
    assert.equal(boundary.registrations[0].parentRowsAtEnd, 1001);
    assert.equal(boundary.registrations[0].verifiedRows, 1001);
    assert.equal(boundary.registrations[0].rebuiltFields, 1001);
    assert.equal(boundary.registrations[1].rebuiltFields, 1, 'all-null rows are still covered');
    assert.deepEqual(await sealed.prepareAllSearch(db, { batchSize: 999 }), boundary, 'rerun is idempotent');

    setPrepareAllSearchTestHooks({ skipVisitedRow: (reg, ordinal) => reg.model === 'scoped_rows' && ordinal === 500 });
    await assert.rejects(sealed.prepareAllSearch(db, { batchSize: 1000 }), { code: 'REBUILD_INCOMPLETE' });
    setPrepareAllSearchTestHooks();

    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(sealed.prepareAllSearch(db, { signal: cancelled.signal }), { code: 'CANCELLED' });
    const midRunCancel = new AbortController();
    let cancelledAfterBatch = false;
    setPrepareAllSearchTestHooks({ checkpoint: phase => {
      if (!cancelledAfterBatch && phase === 'afterBatch') { cancelledAfterBatch = true; midRunCancel.abort(); }
    } });
    await assert.rejects(sealed.prepareAllSearch(db, { batchSize: 1000, signal: midRunCancel.signal }), { code: 'CANCELLED' });
    setPrepareAllSearchTestHooks();
    assert.equal((await sealed.prepareAllSearch(db)).registrations[0].visitedRows, 1001, 'a cancelled partial run is restartable');
    await db.transaction(async tx => {
      await assert.rejects(sealed.prepareAllSearch(tx as never), { code: 'INVALID_TRANSACTION_CONTEXT' });
    });

    let changed = false;
    const extraId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    setPrepareAllSearchTestHooks({ checkpoint: async (phase, reg) => {
      if (!changed && phase === 'afterBatch' && reg?.model === 'scoped_rows') {
        changed = true;
        await pool.query(`insert into "${schemaName}".scoped_rows(id,scope_id,name_ct) values($1,$2,null)`, [extraId, scopeId]);
      }
    } });
    await assert.rejects(sealed.prepareAllSearch(db, { batchSize: 1000 }), { code: 'REBUILD_INCOMPLETE' });
    setPrepareAllSearchTestHooks();

    const missing = createSealed({ sealer: createSealer({ key: new Uint8Array(32).fill(92) }) });
    const missingSchema = pgSchema(missingSchemaName);
    const missingParent = missingSchema.table('missing_rows', {
      id: uuid('id').primaryKey(), name: missing.text('name', { search: { exact: true } }),
    });
    const missingSeal = missing.register(missingParent, { row: 'id' });
    await pool.query(`create schema "${missingSchemaName}"`); missingCreated = true;
    for (const statement of await generateMigration(generateDrizzleJson({}),
      generateDrizzleJson({ missingParent, missingSeal }))) await pool.query(statement);
    await assert.rejects(missing.prepareAllSearch(db), (error: any) =>
      error?.code === 'INVALID_SCHEMA' && /extraMigrationSql/.test(error.message));
  } finally {
    setPrepareAllSearchTestHooks();
    if (missingCreated) await pool.query(`drop schema if exists "${missingSchemaName}" cascade`);
    if (created) await pool.query(`drop schema if exists "${schemaName}" cascade`);
    await pool.end();
  }
});

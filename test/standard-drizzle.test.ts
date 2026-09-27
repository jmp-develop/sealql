import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { bigint, getTableConfig, pgSchema, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import { bindSealed, ciphertext, defineSealed, defineSealStorage, drizzleExecutor } from '../src/adapters/drizzle/v0.45/index.js';
import { definePostgresStorage, defineSealedModel } from '../src/adapters/postgres/sealed-schema.js';
import { assertDisposable } from './disposable.js';

test('Drizzle companion performs managed writes and verified search', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
  const schemaName = `sealql_drizzle_${process.pid}`;
  let created = false;
  try {
    await assertDisposable(pool);
    await pool.query(`create schema "${schemaName}"`); created = true;
    const schema = pgSchema(schemaName);
    const note = schema.table('note', {
      scopeId: uuid('scope_id').notNull(), id: uuid('id').notNull(),
      revision: bigint('revision', { mode: 'bigint' }).notNull().default(sql`1`),
      body: ciphertext('body_ct').notNull(), address: ciphertext('address_ct').notNull(), status: text('status').notNull(),
    }, t => [primaryKey({ columns: [t.scopeId, t.id] })]);
    const definition = defineSealed(note, {
      id: 'note', identity: { scope: 'scopeId', row: 'id', revision: 'revision' },
      fields: { body: { type: 'text', search: { exact: true, substring: true } }, address: { type: 'text', search: { substring: true } } }, publicBounds: { status: 32 },
    });
    const storage = defineSealStorage(definition, { schema: schemaName });
    const ginIndexes=getTableConfig(storage.index!).indexes.filter(item=>item.config.name?.endsWith('_gin'));
    assert.equal(ginIndexes.length,1);
    assert.equal(ginIndexes[0].config.columns.length,2);
    const raw = definePostgresStorage(defineSealedModel({
      id: 'note', identity: { scope: 'uuid', row: 'uuid', revision: 'bigint' },
      fields: { body: { type: 'text', nullable: false, search: { exact: true, substring: true } }, address: { type: 'text', nullable: false, search: { substring: true } } },
      public: { status: { type: 'text', nullable: false, maxBytes: 32 } },
    }), {
      schema: schemaName, table: 'note', identity: { scope: 'scope_id', row: 'id', revision: 'revision' },
      fields: { body: 'body_ct', address: 'address_ct' }, public: { status: 'status' },
    });
    for (const statement of raw.ddl) await pool.query(statement.text, statement.values);
    const db = drizzle(pool);
    const sealer = createSealer({ key: new Uint8Array(32).fill(9) });
    const scoped = bindSealed({ sealer, definition, storage, executor: drizzleExecutor(db) }).forScope({ scopeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await scoped.insert({ id, data: { body: 'hello world', address: 'river road', status: 'open' } });
    assert.equal((await scoped.get({ id }))?.body, 'hello world');
    const page = await scoped.findMany({ match: f => f.body.contains('ell'), where: eq(note.status, 'open'), limit: 20 });
    assert.deepEqual(page.items.map(row => row.id), [id]);
    const both=await scoped.findMany({match:f=>f.all(f.body.contains('ell'),f.address.contains('river')),limit:20});
    assert.deepEqual(both.items.map(row=>row.id),[id]);
    assert.equal(await scoped.count({match:f=>f.all(f.body.contains('ell'),f.address.contains('river')),maxCandidates:10}),1);
    const advanced = await scoped.searchWithQuery({
      queryId: 'status', queryVersion: 1, parameters: { status: 'open' },
      match: f => f.body.contains('ell'), select: { body: true }, extra: {}, limit: 20,
      fetchCandidates: async plan => db.select({ sealed: plan.selection(), extra: {} }).from(note).where(and(plan.where(), eq(note.status, 'open'))).orderBy(...plan.orderBy()).limit(plan.batchSize),
    });
    assert.equal(advanced.items[0].record.body, 'hello world');
  } finally {
    if (created) await pool.query(`drop schema "${schemaName}" cascade`);
    await pool.end();
  }
});

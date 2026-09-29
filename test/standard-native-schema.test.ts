import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTableConfig, pgSchema, uuid, text } from 'drizzle-orm/pg-core';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';

test('native registration builds same-schema companion without loading a key', () => {
  const sealed = createSealed({ sealer: () => { throw Error('key must stay lazy'); } });
  const schema = pgSchema('native_schema_test');
  const parent = schema.table('people', {
    id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), status: text('status').notNull(),
    name: sealed.text('name', { search: { exact: true, substring: true } }),
    note: sealed.text('note', { nullable: true, search: { substring: true } }),
  });
  const companion = sealed.register(parent, { row: 'id', scope: 'scopeId' });
  const config = getTableConfig(companion);
  assert.equal(config.schema, 'native_schema_test');
  assert.equal(config.name, 'people_seal_index');
  assert.equal(config.foreignKeys.length, 1);
  assert.equal(config.indexes.length, 4);
  assert.equal(registrationOf(companion).fields.size, 2);
  assert.ok(Object.values(registrationOf(companion).storage.index!.profiles!).every(profile => !('words' in profile) && !('singles' in profile)));
  assert.equal(sealed.extraMigrationSql(companion).filter(sql => sql.includes('set statistics')).length, 2);
  assert.equal(sealed.extraMigrationSql(companion).filter(sql => sql.includes('set storage main')).length, 7);
  assert.throws(() => parent.name.mapToDriverValue('plain' as never), /SEAL_REQUIRED/);
  const withDefault = schema.table('invalid_default', { id: uuid('id').primaryKey(), name: sealed.text('name').default(null as never) });
  assert.throws(() => sealed.register(withDefault, { row: 'id' }), /INVALID_SCHEMA/);
  const uniqueRow = schema.table('unique_row', { id: uuid('id').unique().notNull(), name: sealed.text('unique_name') });
  assert.equal(registrationOf(sealed.register(uniqueRow, { row: 'id' })).rowUnique, true);
});

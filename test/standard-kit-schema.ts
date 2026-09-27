import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

const sealed = createSealed({ sealer: () => createSealer({ key: new Uint8Array(32) }) });
export const schema = pgSchema('test_kit_roundtrip');

export const uuidScoped = schema.table('uuid_scoped', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search: { exact: true, substring: true } }),
});
export const uuidScopedSeal = sealed.register(uuidScoped, { row: 'id', scope: 'scopeId' });

export const uuidUnscoped = schema.table('uuid_unscoped', {
  id: uuid('id').primaryKey(), name: sealed.text('name', { search: { exact: true } }),
});
export const uuidUnscopedSeal = sealed.register(uuidUnscoped, { row: 'id' });

export const textScoped = schema.table('text_scoped', {
  id: sealed.textId('id').primaryKey(), scopeId: text('scope_id').notNull(),
  name: sealed.text('name', { search: { exact: true } }),
});
export const textScopedSeal = sealed.register(textScoped, { row: 'id', scope: 'scopeId' });

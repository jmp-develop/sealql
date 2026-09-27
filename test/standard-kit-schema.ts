import { sql } from 'drizzle-orm';
import { bigint, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { ciphertext, defineSealed, defineSealStorage } from '../src/adapters/drizzle/v0.45/index.js';

export const note = pgTable('r2_kit_note', {
  scopeId: uuid('scope_id').notNull(), id: uuid('id').notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(sql`1`),
  title: ciphertext('title_ct').notNull(), status: text('status').notNull().default('draft'),
}, t => [primaryKey({ columns: [t.scopeId, t.id] })]);
const definition = defineSealed(note, { id: 'r2_kit_note', identity: { scope: 'scopeId', row: 'id', revision: 'revision' }, fields: { title: { type: 'text', search: { exact: true } } }, publicBounds: { status: 32 } });
const storage = defineSealStorage(definition);
export const index = storage.index!;

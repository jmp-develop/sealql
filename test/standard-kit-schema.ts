import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';

const sealed = createSealed({ sealer: () => createSealer({ key: new Uint8Array(32) }) });
export const note = pgTable('kit_note', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), status: text('status').notNull(),
  title: sealed.text('title', { search: { exact: true, substring: true } }),
});
export const noteSeal = sealed.register(note, { row: 'id', scope: 'scopeId' });

import { pgTable, serial, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

const sealed = createSealed({ sealer: () => createSealer({ key: loadFixedKey() }) });
declare function loadFixedKey(): Uint8Array;

export const record = pgTable('record', {
  id: serial('id').primaryKey(),
  sealRow: uuid('seal_row').notNull().unique(),
  body: sealed.text('body', { search: { exact: true } }),
});
export const recordSeal = sealed.register(record, { row: 'sealRow' });

// sealed.insert(db, recordSeal, { body: 'example' }) generates sealRow.

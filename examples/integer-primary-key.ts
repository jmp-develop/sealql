/** Keep an integer primary key while giving SealQL a known unique UUID row identity. */
import { pgTable, serial, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

const sealed = createSealed({ sealer: () => createSealer({ key: loadFixedKey() }) });
declare function loadFixedKey(): Uint8Array;

export const records = pgTable('records', {
  id: serial('id').primaryKey(),
  sealRow: uuid('seal_row').notNull().unique(),
  body: sealed.text('body', { search: { exact: true } }),
});
export const recordsSeal = sealed.register(records, { row: 'sealRow' });

// sealed.insert(db, recordsSeal, { body: 'example' }) generates sealRow before writing.
// Export both records and recordsSeal to drizzle-kit.

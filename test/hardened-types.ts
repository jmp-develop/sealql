import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createSealer } from '../src/index.js';
import { createSealed } from '../src/adapters/drizzle/v0.45/index.js';

const sealed = createSealed({ sealer: createSealer({ key: new Uint8Array(32) }) });
const table = pgTable('hardened_types', {
  id: uuid('id').primaryKey(),
  phone: sealed.text('phone', { hardened: true, search: { exact: true, substring: true } }),
  count: sealed.integer('count', { hardened: true, search: { exact: true } }),
  large: sealed.bigint('large', { hardened: true, search: { exact: true } }),
  price: sealed.decimal('price', { hardened: true, precision: 12, scale: 2, search: { exact: true } }),
});
const seal = sealed.register(table, { row: 'id' });
void sealed.where(seal, { match: m => m.and(m.phone.contains('12'), m.count.eq(2), m.large.eq(3n), m.price.eq('4.00')) });
void sealed.where(seal, { match: m => m.or(m.phone.like('%12_34%'), m.sql(sql`true`)) });
// @ts-expect-error hardened is an opt-in true literal, not a second configuration object
sealed.text('bad', { hardened: { enabled: true }, search: { exact: true } });
// @ts-expect-error the field option supports only the opt-in true literal
sealed.text('bad', { hardened: false, search: { exact: true } });

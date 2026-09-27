import { eq, type InferSelectModel } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import { createSealed, type Sealed, type Opened } from '../src/adapters/drizzle/v0.45/index.js';
import type { PlainShape } from '../src/adapters/drizzle/v0.45/native.js';

const sealed = createSealed({ sealer: () => createSealer({ key: new Uint8Array(32) }) });
const customers = pgTable('native_type_customers', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull(), status: text('status').notNull(),
  name: sealed.text('name', { search: { exact: true, substring: true } }),
  memo: sealed.text('memo', { nullable: true, search: { substring: true } }),
  age: sealed.integer('age', { search: { exact: true } }),
});
export const customersSeal = sealed.register(customers, { row: 'id', scope: 'tenantId' });
// @ts-expect-error row must be a valid plain identifier column
sealed.register(customers, { row: 'name' });
// @ts-expect-error scope must be a valid column
sealed.register(customers, { row: 'id', scope: 'missing' });

const db = drizzle.mock();
// @ts-expect-error plain values cannot be inserted into sealed fields through Drizzle
db.insert(customers).values({ status: 'a', tenantId: 'x', name: 'Ada', age: 3 });
// @ts-expect-error sealed predicate must not accept plaintext
db.select().from(customers).where(eq(customers.name, 'Ada'));
db.update(customers).set({ status: 'b' });
sealed.insert(db, customersSeal, { tenantId: 'x', status: 'a', name: 'Ada', age: 3 });
sealed.insert(db, customersSeal, { tenantId: 'x', status: 'a', name: 'Ada', age: 3, memo: undefined });
sealed.update(db, customersSeal, { id: 'x', tenantId: 'x' }, { memo: undefined, status: 'b' });
sealed.upsert(db, customersSeal, { tenantId: 'x', status: 'a', name: 'Ada', age: 3, memo: undefined });
sealed.findMany(db, customersSeal, { scope: 'x', match: m => {
  // @ts-expect-error ordinary plaintext column is not a sealed search field
  m.status.eq('a');
  // @ts-expect-error integer exact field has no substring operator
  m.age.contains('23');
  // @ts-expect-error substring-only memo has no exact operator
  m.memo.eq('text');
  // @ts-expect-error text substring needs a string
  m.name.contains(3);
  // @ts-expect-error integer exact needs a number
  m.age.eq('3');
  return m.name.contains('Ad');
} });
// @ts-expect-error managed insert requires the sealed name
sealed.insert(db, customersSeal, { tenantId: 'x', status: 'a', age: 3 });
// @ts-expect-error managed insert rejects wrong sealed type
sealed.insert(db, customersSeal, { tenantId: 'x', status: 'a', name: 3, age: 3 });
sealed.update(db, customersSeal, { id: 'x', tenantId: 'x' }, { name: 'Grace', status: 'b' });
const selected = sealed.findMany(db, customersSeal, { scope: 'x', columns: { status: true }, limit: 1 });
void selected.then(page => {
  const id: string = page.items[0].id;
  const status: string = page.items[0].status;
  // @ts-expect-error unselected sealed field is absent
  const name = page.items[0].name;
  void [id, status, name];
});
// @ts-expect-error patch cannot move the row identifier
sealed.update(db, customersSeal, { id: 'x', tenantId: 'x' }, { id: 'y' });
// @ts-expect-error patch cannot move the scope
sealed.update(db, customersSeal, { id: 'x', tenantId: 'x' }, { tenantId: 'y' });

type Row = InferSelectModel<typeof customers>;
const validPlain: PlainShape<typeof customers> = { id: 'x', tenantId: 'x', status: 'a', name: 'Ada', age: 3 };
// @ts-expect-error required sealed field cannot be omitted
const missingPlain: PlainShape<typeof customers> = { id: 'x', tenantId: 'x', status: 'a', age: 3 };
// @ts-expect-error sealed integer requires number
const wrongPlain: PlainShape<typeof customers> = { id: 'x', tenantId: 'x', status: 'a', name: 'Ada', age: '3' };
void [validPlain, missingPlain, wrongPlain];
declare const row: Row;
const sealedName: Sealed<string, { readonly exact: true; readonly substring: true }> = row.name;
const openedName: Opened<Row>['name'] = 'Ada';
void [sealedName, openedName];
// @ts-expect-error unopened data is opaque
const plainName: string = row.name;
void plainName;

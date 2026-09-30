import { eq, type InferSelectModel, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from '../src/index.js';
import {
  createSealed, type InferSealedIdentity, type InferSealedInsert, type InferSealedPatch,
  type Sealed, type Opened, type PlainShape,
} from '../src/adapters/drizzle/v0.45/index.js';

const sealed = createSealed({ sealer: () => createSealer({ key: new Uint8Array(32) }) });
const customers = pgTable('native_type_customers', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull(), status: text('status').notNull(),
  name: sealed.text('name', { search: { exact: true, substring: true } }),
  memo: sealed.text('memo', { nullable: true, search: { substring: true } }),
  age: sealed.integer('age', { search: { exact: true } }),
});
export const customersSeal = sealed.register(customers, { row: 'id', scope: 'tenantId' });
const textRows = pgTable('native_type_text_rows', {
  recordKey: sealed.textId('record_key').primaryKey().default('database-default'),
  accountKey: uuid('account_key').notNull().defaultRandom(),
  name: sealed.text('name'),
});
const textRowsSeal = sealed.register(textRows, { row: 'recordKey', scope: 'accountKey' });
const textScopes = pgTable('native_type_text_scopes', {
  recordKey: uuid('record_key').primaryKey(),
  accountKey: text('account_key').notNull().default('database-default'),
  name: sealed.text('name'),
});
const textScopesSeal = sealed.register(textScopes, { row: 'recordKey', scope: 'accountKey' });
const globalRows = pgTable('native_type_global_rows', {
  recordKey: uuid('record_key').primaryKey(),
  name: sealed.text('name', { search: { exact: true } }),
});
const globalRowsSeal = sealed.register(globalRows, { row: 'recordKey' });
// @ts-expect-error row must be a valid plain identifier column
sealed.register(customers, { row: 'name' });
// @ts-expect-error scope must be a valid column
sealed.register(customers, { row: 'id', scope: 'missing' });

const db = drizzle.mock();
// @ts-expect-error substring predicates have no word-boundary query option
sealed.findMany(db, customersSeal, { scope: 'x', match: m => m.name.contains('ab', { respectWords: true }) });
// @ts-expect-error open requires an awaited query result
sealed.open(Promise.resolve({ id: 'x' }));
// @ts-expect-error openRaw requires awaited raw rows
sealed.openRaw(customersSeal, Promise.resolve({ rows: [] }), { columns: { id: 'id', tenantId: 'tenant_id' } });
// @ts-expect-error plain values cannot be inserted into sealed fields through Drizzle
db.insert(customers).values({ status: 'a', tenantId: 'x', name: 'Ada', age: 3 });
// @ts-expect-error sealed predicate must not accept plaintext
db.select().from(customers).where(eq(customers.name, 'Ada'));
db.update(customers).set({ status: 'b' });
sealed.insert(db, customersSeal, { tenantId: 'x', status: 'a', name: 'Ada', age: 3 });
sealed.insert(db, customersSeal, { tenantId: 'x', status: 'a', name: 'Ada', age: 3, memo: undefined });
// @ts-expect-error managed insert rejects unknown columns
sealed.insert(db, customersSeal, { tenantId: 'x', status: 'a', name: 'Ada', age: 3, unknown: 'x' });
sealed.update(db, customersSeal, { id: 'x', tenantId: 'x' }, { memo: undefined, status: 'b' });
sealed.update(db, customersSeal, { id: 'x', tenantId: 'x' }, { name: undefined, status: undefined });
// @ts-expect-error managed update rejects unknown columns
sealed.update(db, customersSeal, { id: 'x', tenantId: 'x' }, { unknown: 'x' });
sealed.upsert(db, customersSeal, { tenantId: 'x', status: 'a', name: 'Ada', age: 3, memo: undefined });
type CustomerInsert = InferSealedInsert<typeof customersSeal>;
type CustomerIdentity = InferSealedIdentity<typeof customersSeal>;
type CustomerPatch = InferSealedPatch<typeof customersSeal>;
const inferredCustomer: CustomerInsert = { tenantId: 'x', status: 'a', name: 'Ada', age: 3 };
const inferredIdentity: CustomerIdentity = { id: 'x', tenantId: 'x' };
const inferredPatch: CustomerPatch = { status: 'b', memo: null };
// @ts-expect-error a registered scope is required even when the UUID row is generated
const missingCustomerScope: CustomerInsert = { status: 'a', name: 'Ada', age: 3 };
type TextRowInsert = InferSealedInsert<typeof textRowsSeal>;
const inferredTextRow: TextRowInsert = { recordKey: 'row', accountKey: 'scope', name: 'Ada' };
// @ts-expect-error a text row remains required even when the database column has a default
const missingTextRow: TextRowInsert = { accountKey: 'scope', name: 'Ada' };
// @ts-expect-error a UUID scope remains required even when the database column has a default
const missingUuidScope: TextRowInsert = { recordKey: 'row', name: 'Ada' };
type TextScopeInsert = InferSealedInsert<typeof textScopesSeal>;
// @ts-expect-error a text scope remains required even when the database column has a default
const missingTextScope: TextScopeInsert = { name: 'Ada' };
type GlobalInsert = InferSealedInsert<typeof globalRowsSeal>;
type GlobalIdentity = InferSealedIdentity<typeof globalRowsSeal>;
const inferredGlobal: GlobalInsert = { name: 'Ada' };
const inferredGlobalIdentity: GlobalIdentity = { recordKey: 'row' };
// @ts-expect-error a scope-free identity has no scope property
const invalidGlobalIdentity: GlobalIdentity = { recordKey: 'row', accountKey: 'scope' };
// @ts-expect-error update patches cannot move the registered row
const patchWithRow: CustomerPatch = { id: 'row' };
// @ts-expect-error update patches cannot move the registered scope
const patchWithScope: CustomerPatch = { tenantId: 'scope' };
void [inferredCustomer, inferredIdentity, inferredPatch, missingCustomerScope, inferredTextRow, missingTextRow,
  missingUuidScope, missingTextScope, inferredGlobal, inferredGlobalIdentity, invalidGlobalIdentity, patchWithRow, patchWithScope];
const scopedWhere: Promise<SQL> = sealed.where(customersSeal, { scope: 'x', match: m => m.name.contains('Ad') });
const globalWhere: Promise<SQL> = sealed.where(globalRowsSeal, { match: m => m.name.eq('Ada') });
const runtimeScopedWhere: Promise<SQL> = sealed.where(customersSeal, { match: m => m.name.contains('Ad') });
const runtimeGlobalWhere: Promise<SQL> = sealed.where(globalRowsSeal, { scope: 'x', match: m => m.name.eq('Ada') });
void [scopedWhere, globalWhere, runtimeScopedWhere, runtimeGlobalWhere];
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
// @ts-expect-error required sealed name cannot be undefined
sealed.insert(db, customersSeal, { tenantId: 'x', status: 'a', name: undefined, age: 3 });
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
// @ts-expect-error count no longer accepts application candidate budgets
sealed.count(db, customersSeal, { scope: 'x', budgets: { maxCandidates: 10 } });
// @ts-expect-error count returns only a scalar and has no projection batch
sealed.count(db, customersSeal, { scope: 'x', budgets: { batch: 10 } });

const limitedJoin = sealed.search(db, {
  scope: 'x', limit: 20,
  match: { customer: [customersSeal, m => m.name.contains('Ad')] },
  query: ({where, after, orderBy, flags, limit}) => {
    const size: number = limit;
    // The callback batch can differ from the requested page size.
    // @ts-expect-error limit is a number, not the literal page size
    const literal: 20 = limit;
    void [size, literal, after];
    return db.select({customer:customers,...flags}).from(customers).where(where).orderBy(...orderBy).limit(limit);
  },
});
void limitedJoin.then(page => { const name: string = page.items[0].customer.name; void name; });
sealed.search(db, {
  scope: 'x', match: {customer:[customersSeal,m=>m.name.contains('Ad')]},
  query: ({limit}) => {
    // @ts-expect-error an unbounded search may omit the SQL limit
    const size: number = limit;
    void size; return [];
  },
});
declare const optionalPage: {limit?:number};
sealed.search(db, {
  ...optionalPage, scope:'x', match:{customer:[customersSeal,m=>m.name.contains('Ad')]},
  query: ({limit}) => {
    // @ts-expect-error an optional caller limit cannot promise a bounded callback
    const size: number = limit;
    void size; return [];
  },
});
declare const maybeLimit: number | undefined;
sealed.search(db, {
  limit:maybeLimit, scope:'x', match:{customer:[customersSeal,m=>m.name.contains('Ad')]},
  query: ({limit}) => {
    // @ts-expect-error a possibly undefined limit cannot promise a bounded callback
    const size: number = limit;
    void size; return [];
  },
});
sealed.search(db, {
  scope:'x', limit:20, match:{customer:[customersSeal,m=>m.name.contains('Ad')]},
  // A callback accepting the old wider context remains assignable.
  query: (parts:{limit:number|undefined}) => { void parts; return []; },
});

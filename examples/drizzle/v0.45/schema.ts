import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer, type Sealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

export const exampleSchemaName = 'sealql_example_v045';
let activeSealer: Sealer | undefined;

export function configureKey(rootKey: Uint8Array) {
  if (activeSealer) throw new Error('Configure the fixed key only once');
  activeSealer = createSealer({ key: rootKey });
}

export const sealed = createSealed({ sealer: () => {
  if (!activeSealer) throw new Error('Configure the key before data operations');
  return activeSealer;
} });

const app = pgSchema(exampleSchemaName);
export const customer = app.table('customer', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: sealed.text('name', { search: { exact: true, substring: true } }),
  phone: sealed.text('phone', { search: { exact: true } }),
  memo: sealed.text('memo', { nullable: true, search: { substring: true } }),
  // Few distinct values: a coarse 2-bit exact candidate; salted proofs still decide equality.
  tier: sealed.text('tier', { nullable: true, search: { exact: { bits: 2 } } }),
});
export const customerSeal = sealed.register(customer, { row: 'id', scope: 'tenantId' });
export const customerTag = app.table('customer_tag', {
  id: uuid('id').primaryKey(),
  customerId: uuid('customer_id').notNull(),
  label: text('label').notNull(),
});

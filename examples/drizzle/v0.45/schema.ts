import { pgSchema, uuid } from 'drizzle-orm/pg-core';
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
});
export const customerSeal = sealed.register(customer, { row: 'id', scope: 'tenantId' });

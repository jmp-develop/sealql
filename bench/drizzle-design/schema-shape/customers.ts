import { relations } from 'drizzle-orm';
import { pgTable, text, uuid, integer } from 'drizzle-orm/pg-core';
import { sealed } from './sealed.ts';

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  status: text('status').notNull(),
  name: sealed.text('name', { search: { exact: true, substring: true } }),
  memo: sealed.text('memo', { nullable: true, search: { substring: true } }),
  score: sealed.integer('score', { search: { exact: true } }),
});

// companion posting table: customers_seal (scope_id, row_id, name_exact, name_substring,
// memo_substring, score_exact bigint[], GIN over substring cols, btree over exact cols,
// FK (scope_id,row_id) -> customers(tenant_id,id) ON DELETE CASCADE. Exported so drizzle-kit sees it.
export const customersSearch = sealed.register(customers, { row: 'id', scope: 'tenantId' });

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey(),
  customerId: uuid('customer_id').notNull(),
  total: integer('total').notNull(),
});

export const customerRel = relations(customers, ({ many }) => ({ orders: many(orders) }));
export const orderRel = relations(orders, ({ one }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
}));

import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

export const schema = pgSchema('native_verify_main');
export const fields = ['name', 'phone', 'address', 'memo', 'email', 'company'] as const;
export const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const sealed = createSealed({ sealer: () => createSealer({ key: new Uint8Array(32).fill(93) }) });
const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;

export const customers = schema.table('customers', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }),
  address: sealed.text('address', { search }), memo: sealed.text('memo', { search }),
  email: sealed.text('email', { search }), company: sealed.text('company', { search }),
});
export const customersSeal = sealed.register(customers, { row: 'id', scope: 'scopeId' });

export const tickets = schema.table('tickets', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }),
  address: sealed.text('address', { search }), memo: sealed.text('memo', { search }),
  email: sealed.text('email', { search }), company: sealed.text('company', { search }),
});
export const ticketsSeal = sealed.register(tickets, { row: 'id', scope: 'scopeId' });

export const customersWrite = schema.table('customers_write', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }),
  address: sealed.text('address', { search }), memo: sealed.text('memo', { search }),
  email: sealed.text('email', { search }), company: sealed.text('company', { search }),
});
export const customersWriteSeal = sealed.register(customersWrite, { row: 'id', scope: 'scopeId' });

export const probe = schema.table('probe', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search }),
  memo: sealed.text('memo', { nullable:true, search }),
});
export const probeSeal = sealed.register(probe, { row: 'id', scope: 'scopeId' });

/** Derived, constant-scope fixture for the V2 token-dump attack. */
export const attackCustomers = schema.table('attack_customers', {
  id: uuid('id').primaryKey(), scopeId: text('scope_id').notNull(),
  memo: sealed.text('memo', { search }),
});
export const attackCustomersSeal = sealed.register(attackCustomers, { row: 'id', scope: 'scopeId' });

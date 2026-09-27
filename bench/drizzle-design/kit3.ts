import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
export const customers = pgTable('customers', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull(), memo: text('memo_ct') });

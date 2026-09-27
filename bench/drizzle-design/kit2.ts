import { pgTable, text, uuid, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';
// app-facing lean table
export const customers = pgTable('customers', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull(), memo: text('memo_ct') }, t => [uniqueIndex('customers_seal_row').on(t.tenantId, t.id)]);
// kit-only view of the SAME physical table declaring only token columns
export const customersTokens = pgTable('customers', { memoTokS: bigint('memo_tok_s', { mode: 'bigint' }).array() }, t => [index('customers_seal_gin').using('gin', t.memoTokS)]);

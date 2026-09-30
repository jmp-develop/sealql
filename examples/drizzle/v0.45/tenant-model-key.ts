import type { PgDatabase } from 'drizzle-orm/pg-core';
import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

export function sensitiveCustomerModel(rootKey: Uint8Array, customerKey: Uint8Array) {
  const sealed = createSealed({
    sealer: createSealer({ key: rootKey, models: { sensitiveCustomer: { key: customerKey } } }),
  });
  const customer = pgTable('sensitive_customer', {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    email: sealed.text('email', { search: { exact: true } }),
  });
  const customerSeal = sealed.register(customer, {
    row: 'id', scope: 'tenantId', model: 'sensitiveCustomer',
  });
  return { sealed, customer, customerSeal };
}

export interface AuthenticatedRequest { tenantId: string }

export function findAuthorizedEmail(
  db: PgDatabase<any, any, any>,
  model: ReturnType<typeof sensitiveCustomerModel>,
  auth: AuthenticatedRequest,
  email: string,
) {
  return model.sealed.findMany(db, model.customerSeal, {
    scope: auth.tenantId, match: m => m.email.eq(email), limit: 20,
  });
}

import { and, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customer, customerSeal, sealed } from './schema.js';

export interface CustomerInput {
  id?: string;
  tenantId: string;
  name: string;
  phone: string;
  memo?: string | null;
}

export const insertCustomer = (db: PgDatabase<any, any, any>, value: CustomerInput) =>
  sealed.insert(db, customerSeal, value, { returning: true });

export const updateCustomer = (db: PgDatabase<any, any, any>, tenantId: string, id: string, name: string) =>
  sealed.update(db, customerSeal, { tenantId, id }, { name }, { returning: true });

export const upsertCustomer = (db: PgDatabase<any, any, any>, value: CustomerInput) =>
  sealed.upsert(db, customerSeal, value, { returning: true });

export const deleteCustomer = (db: PgDatabase<any, any, any>, tenantId: string, id: string) =>
  db.delete(customer).where(and(eq(customer.tenantId, tenantId), eq(customer.id, id)));

export const reindexCustomers = (db: PgDatabase<any, any, any>, tenantId?: string) =>
  sealed.reindex(db, customerSeal, { ...(tenantId ? { scope: tenantId } : {}), batch: 1_000 });

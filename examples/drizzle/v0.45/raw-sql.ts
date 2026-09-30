import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customer, customerSeal, sealed } from './schema.js';

export async function openRawCustomers(db: PgDatabase<any, any, any>, tenantId: string) {
  const result = await db.execute(sql`select ${customer.id} as c_id,
    ${customer.tenantId} as c_tenant, ${customer.name} as c_name_ct
    from ${customer} where ${customer.tenantId} = ${tenantId}`);
  return sealed.openRaw(customerSeal, result.rows as Record<string, unknown>[], {
    columns: { id: 'c_id', tenantId: 'c_tenant', name: 'c_name_ct' }, scope: tenantId,
  });
}

export function searchCustomersWithJoin(
  db: PgDatabase<any, any, any>, tenantId: string, name: string,
) {
  return sealed.search(db, {
    scope: tenantId,
    match: { c: [customerSeal, m => m.name.contains(name)] },
    columns: { c: { id: 'c_id', tenantId: 'c_tenant', name: 'c_name_ct' } },
    limit: 20,
    query: ({ where, after, orderBy, flagsSql, limit }) => db.execute(sql`
      select ${customer.id} as c_id, ${customer.tenantId} as c_tenant,
        ${customer.name} as c_name_ct, permission.allowed, ${flagsSql}
      from ${customer} inner join (select true as allowed) permission on permission.allowed
      where ${where} ${after ? sql`and ${after}` : sql``}
      order by ${sql.join(orderBy, sql.raw(', '))} limit ${limit}`),
  });
}

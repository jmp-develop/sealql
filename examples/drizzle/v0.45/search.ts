import { count, eq } from 'drizzle-orm';
import { SealError } from 'sealql';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customer, customerSeal, customerTag, sealed } from './schema.js';

export async function searchCustomerTags(
  db: PgDatabase<any, any, any>, tenantId: string, name: string,
) {
  const condition = await sealed.where(customerSeal, {
    scope: tenantId, match: m => m.name.contains(name),
  });
  const selected = await db.select({ customer, tag: customerTag }).from(customer)
    .innerJoin(customerTag, eq(customerTag.customerId, customer.id)).where(condition);
  const rows = await sealed.open(selected, { scope: tenantId });
  const [{ value }] = await db.select({ value: count() }).from(customer).where(condition);
  // Flattened or renamed db.execute columns use sealed.openRaw with a column map; see raw-sql.ts.
  return { rows, count: value };
}

export const findPhone = (db: PgDatabase<any, any, any>, tenantId: string, phone: string) =>
  sealed.findMany(db, customerSeal, { scope: tenantId, match: m => m.phone.eq(phone), limit: 20 });

export const findNameAndMemo = (db: PgDatabase<any, any, any>, tenantId: string, name: string, memo: string) =>
  sealed.findMany(db, customerSeal, {
    scope: tenantId, match: m => m.and(m.name.contains(name), m.memo.contains(memo)), limit: 20,
  });

export const findNameOrPhone = (db: PgDatabase<any, any, any>, tenantId: string, name: string, phone: string) =>
  sealed.findMany(db, customerSeal, {
    scope: tenantId, match: m => m.or(m.name.contains(name), m.phone.eq(phone)), limit: 20,
  });

export const findNameLike = (db: PgDatabase<any, any, any>, tenantId: string, pattern: string) =>
  sealed.findMany(db, customerSeal, { scope: tenantId, match: m => m.name.like(pattern), limit: 20 });

export const findNameOrId = (db: PgDatabase<any, any, any>, tenantId: string, name: string, id: string) =>
  sealed.findMany(db, customerSeal, {
    scope: tenantId, match: m => m.or(m.name.contains(name), m.sql(eq(customer.id, id))), limit: 20,
  });

export const findNamePreview = (
  db: PgDatabase<any, any, any>, tenantId: string, name: string, resultBytes: number, deadlineMs: number,
) => sealed.findMany(db, customerSeal, {
  scope: tenantId,
  match: m => m.name.contains(name),
  columns: { id: true, name: true },
  budgets: { resultBytes, deadlineMs },
  limit: 20,
});

export async function readAllPages(db: PgDatabase<any, any, any>, tenantId: string) {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await sealed.findMany(db, customerSeal, { scope: tenantId, limit: 20, cursor });
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

export async function safeNameSearch(db: PgDatabase<any, any, any>, tenantId: string, term: string) {
  try {
    const page = await sealed.findMany(db, customerSeal, {
      scope: tenantId, match: m => m.name.contains(term), limit: 20,
    });
    return { ok: true as const, page };
  } catch (error) {
    if (error instanceof SealError && error.code === 'QUERY_TOO_BROAD') {
      return {
        ok: false as const,
        error: {
          code: 'QUERY_TOO_BROAD' as const,
          message: 'Search terms require at least two normalized characters.',
        },
      };
    }
    throw error;
  }
}

import { SealError } from 'sealql';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customerSeal, sealed } from './schema.js';

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
    return await sealed.findMany(db, customerSeal, {
      scope: tenantId, match: m => m.name.contains(term), limit: 20,
    });
  } catch (error) {
    if (error instanceof SealError && error.code === 'QUERY_TOO_BROAD') return { items: [], nextCursor: null };
    throw error;
  }
}

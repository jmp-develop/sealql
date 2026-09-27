/** Raw SQL remains available through Drizzle db.execute plus SealQL opening. */
import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { configureKey, note, noteSeal, sealed } from './standard-consumer.js';

export async function rawExample(db: PgDatabase<any, any, any>, rootKey: Uint8Array, scopeId: string) {
  configureKey(rootKey);
  const result = await db.execute(sql`select ${note.id} as id, ${note.scopeId} as scope_id,
    ${note.title} as title_ct from ${note} where ${note.scopeId} = ${scopeId}`);
  return sealed.openRaw(noteSeal, result.rows as Record<string, unknown>[], {
    columns: { id: 'id', scopeId: 'scope_id', title: 'title_ct' }, scope: scopeId,
  });
}

export async function rawSearch(db: PgDatabase<any, any, any>, rootKey: Uint8Array, scopeId: string) {
  configureKey(rootKey);
  return sealed.search(db, {
    scope: scopeId, match: { n: [noteSeal, m => m.title.contains('ell')] },
    columns: { n: { id: 'n_id', scopeId: 'n_scope', title: 'n_title_ct' } },
    limit: 20,
    query: ({ where, after, orderBy, flags, flagsSql, limit }) => db.execute(sql`
      select ${note.id} as n_id, ${note.scopeId} as n_scope, ${note.title} as n_title_ct
      ${Object.keys(flags).length ? sql`, ${flagsSql}` : sql``}
      from ${note} where ${where} ${after ? sql`and ${after}` : sql``}
      order by ${sql.join(orderBy, sql.raw(','))} limit ${limit}`),
  });
}

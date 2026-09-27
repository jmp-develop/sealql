/** Shared managed operations; ordinary selects, joins and deletes still use Drizzle. */
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { configureKey, noteSeal, sealed } from './standard-consumer.js';

export function bindWithKey(key: Uint8Array) {
  configureKey(key);
  return sealed;
}
export async function countMatching(db: PgDatabase<any, any, any>, key: Uint8Array, scopeId: string) {
  bindWithKey(key);
  return sealed.count(db, noteSeal, { scope: scopeId, match: m => m.title.contains('ell'), maxCandidates: 10000 });
}
export async function findMatching(db: PgDatabase<any, any, any>, key: Uint8Array, scopeId: string) {
  bindWithKey(key);
  return sealed.findMany(db, noteSeal, { scope: scopeId, match: m => m.title.contains('ell'), limit: 20,
    budgets: { decryptConcurrency: 64 } });
}

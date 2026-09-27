/** Shared managed operations; ordinary selects, joins and deletes still use Drizzle. */
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { configureKey, noteSeal, sealed } from './standard-consumer.js';

/** Call once during application startup, before any data operation. */
export function initializeSealql(key: Uint8Array) {
  configureKey(key);
}
export async function countMatching(db: PgDatabase<any, any, any>, scopeId: string) {
  return sealed.count(db, noteSeal, { scope: scopeId, match: m => m.title.contains('ell') });
}
export async function findMatching(db: PgDatabase<any, any, any>, scopeId: string) {
  return sealed.findMany(db, noteSeal, { scope: scopeId, match: m => m.title.contains('ell'), limit: 20 });
}

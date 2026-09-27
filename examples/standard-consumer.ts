/** Export both tables so drizzle-kit sees the companion. Configure the key before data access. */
import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer, type Sealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

let activeSealer: Sealer | undefined;
let activeKey: Uint8Array | undefined;
export function configureKey(rootKey: Uint8Array) {
  if (activeKey) {
    if (activeKey.length !== rootKey.length || !activeKey.every((byte, i) => byte === rootKey[i])) throw new Error('Fixed key already configured');
    return;
  }
  activeSealer = createSealer({ key: rootKey });
  activeKey = rootKey.slice();
}
export const sealed = createSealed({ sealer: () => {
  if (!activeSealer) throw new Error('Configure the fixed key before SealQL operations');
  return activeSealer;
} });

export const note = pgTable('note', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), status: text('status').notNull(),
  title: sealed.text('title', { search: { exact: true, substring: true } }),
  count: sealed.integer('count', { nullable: true, search: { exact: true } }),
});
export const noteSeal = sealed.register(note, { row: 'id', scope: 'scopeId' });

export async function example(db: PgDatabase<any, any, any>, rootKey: Uint8Array, scopeId: string, id: string) {
  configureKey(rootKey);
  await sealed.insert(db, noteSeal, { id, scopeId, title: 'Ada', count: 2, status: 'draft' });
  const row = await sealed.open(await db.select().from(note).where(eq(note.id, id)));
  const page = await sealed.findMany(db, noteSeal, {
    scope: scopeId, match: m => m.title.contains('Ad'), where: eq(note.status, 'draft'), limit: 20,
  });
  const total = await sealed.count(db, noteSeal, { scope: scopeId, match: m => m.title.contains('Ad'), maxCandidates: 10000 });
  await sealed.update(db, noteSeal, { id, scopeId }, { status: 'active' });
  return { row, page, total };
}

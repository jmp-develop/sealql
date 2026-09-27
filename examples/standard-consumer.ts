/** A compact, compilable consumer. Apply reviewed schema DDL before setup. */
import { eq, sql } from 'drizzle-orm';
import { bigint, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { bindSealed, ciphertext, defineSealed, defineSealStorage, drizzleExecutor, type DrizzleSealedExecutor } from 'sealql/drizzle/v0.45';

export const note = pgTable('note', {
  scopeId: uuid('scope_id').notNull(), id: uuid('id').notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(sql`1`),
  title: ciphertext('title_ct').notNull(), count: ciphertext('count_ct'),
  status: text('status').notNull().default('draft'),
}, t => [primaryKey({ columns: [t.scopeId, t.id] })]);

export const noteDefinition = defineSealed(note, {
  id: 'note', identity: { scope: 'scopeId', row: 'id', revision: 'revision' },
  fields: {
    // Substring stores skip grams by default; add skipGrams: false to opt out.
    title: { type: 'text', search: { exact: true, substring: { wordBoundary: true } } },
    count: { type: 'integer', search: { exact: true } },
  },
  publicBounds: { status: 32 },
});
export const noteStorage = defineSealStorage(noteDefinition);

export function setup(executor: DrizzleSealedExecutor, rootKey: Uint8Array) {
const sealer = createSealer({ key: rootKey });
  const binding = { sealer, definition: noteDefinition, storage: noteStorage, executor };
  return { sealer, notes: bindSealed(binding) };
}
export function setupDb(db: Parameters<typeof drizzleExecutor>[0], rootKey: Uint8Array) {
  return setup(drizzleExecutor(db), rootKey);
}

export async function example(executor: DrizzleSealedExecutor, rootKey: Uint8Array, scopeId: string, id: string) {
  const { sealer, notes } = setup(executor, rootKey);
  const scoped = notes.forScope({ scopeId });
  await scoped.insert({ id, data: { title: 'Ada', count: 2, status: 'draft' } });
  const row = await scoped.get({ id });
  const page = await scoped.findMany({
    match: f => f.title.contains('Ad'), where: eq(note.status, 'draft'),
    select: { title: true, status: true }, limit: 20,
  });
  const total = await scoped.count({ match: f => f.title.contains('Ad'), maxCandidates: 10000 });
  await scoped.update({ id, expectedRevision: 1n, patch: { status: 'active' } });
  return { row, page, total };
}

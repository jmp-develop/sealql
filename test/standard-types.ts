import { sql } from 'drizzle-orm';
import { bigint, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { bindSealed, ciphertext, defineSealed, type ManagedInsert, type ManagedRow } from '../src/adapters/drizzle/v0.45/index.js';
import type { SearchFields } from '../src/core/search-predicate.js';

const source = pgTable('r2_type_source', {
  scopeId: uuid('scope_id').notNull(), id: uuid('id').notNull(), revision: bigint('revision', { mode: 'bigint' }).notNull().default(sql`1`),
  name: ciphertext('name_ct').notNull(), note: ciphertext('note_ct'), age: ciphertext('age_ct'), status: text('status').notNull().default('new'),
}, t => [primaryKey({ columns: [t.scopeId, t.id] })]);
export const definition = defineSealed(source, {
  id: 'typed', identity: { scope: 'scopeId', row: 'id', revision: 'revision' },
  fields: { name: { type: 'text', search: { substring: true } }, note: { type: 'text' }, age: { type: 'integer', search: { exact: true } } },
});
// @ts-expect-error every branded ciphertext column requires a field or legacy entry
defineSealed(source, { id: 'missing', identity: { scope: 'scopeId', row: 'id', revision: 'revision' }, fields: { name: { type: 'text' } } });
export type Insert = ManagedInsert<typeof definition>;
export type Row = ManagedRow<typeof definition>;
export const valid: Insert = { name: 'Ada', age: 3 };
export const validStatus: Insert = { name: 'Ada', status: 'new' };
// @ts-expect-error sealed input must be plaintext
export const wrongName: Insert = { name: new Uint8Array([2]) };
// @ts-expect-error identity is not writable in managed data
export const wrongIdentity: Insert = { name: 'Ada', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
// @ts-expect-error required name cannot be omitted
export const missingName: Insert = { age: 2 };
const selected: Row = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 1n, name: 'Ada', note: null, age: null, status: 'new' };
void selected;
type F = typeof definition.fields;
declare const fields: SearchFields<F>;
fields.name.contains('Ad');
fields.age.eq(3);
// @ts-expect-error substring-only field has no exact operator
fields.name.eq('Ada');
// @ts-expect-error integer has no substring operator
fields.age.contains('3');
// @ts-expect-error non-searchable field has no operator
fields.note.eq('x');

async function typedReads(repository: ReturnType<typeof bindSealed<typeof definition>>) {
  const scoped = repository.forScope({ scopeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const full = await scoped.get({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  if (full) { const name: string = full.name; const status: string = full.status; void [name, status]; }
  const selected = await scoped.get({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', select: { name: true } });
  if (selected) { const name: string = selected.name; const revision: bigint = selected.revision; void [name, revision];
    // @ts-expect-error status was not selected
    selected.status;
  }
  const page = await scoped.findMany({ select: { age: true }, limit: 2 });
  const age: number | null = page.items[0].age; void age;
  // @ts-expect-error name was not selected
  page.items[0].name;
}
void typedReads;

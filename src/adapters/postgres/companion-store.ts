import { ensure } from '../../core/errors.js';
import { column as ident, join, pgsql as q, render } from './fragment.js';
import type { SealedSqlExecutor, SealedStorage } from '../../engine/sealed-types.js';

/** Companion rows are changed in the caller's managed-write transaction. */
export class CompanionStore {
  constructor(readonly storage: SealedStorage) {}
  async replaceIndexes(executor: SealedSqlExecutor, scopeId: string, id: string, items: readonly { indexId: string; tokens: string[] }[]): Promise<void> {
    if (!this.storage.index) { ensure(items.length === 0, 'INVALID_SCHEMA'); return; }
    if (!items.length) return;
    const map = this.storage.index.profiles; ensure(map, 'INVALID_SCHEMA');
    const seen = new Set<string>();
    for (const item of items) { ensure(map[item.indexId] && !seen.has(item.indexId), 'INVALID_SCHEMA'); seen.add(item.indexId); }
    const table = ident(this.storage.index.schema, this.storage.index.name);
    const columns = items.map(item => map[item.indexId].tokens);
    const values = items.map(item => item.tokens.length ? q`${item.tokens}::bigint[]` : q`null::bigint[]`);
    const updates = columns.map(name => q`${ident(name)}=excluded.${ident(name)}`);
    await executor.query(render(q`insert into ${table} (${join([ident('scope_id'), ident('row_id'), ...columns.map(name => ident(name))], ',')}) values (${join([q`${scopeId}`, q`${id}`, ...values], ',')}) on conflict (scope_id,row_id) do update set ${join(updates, ',')}`));
    if (items.some(item => item.tokens.length === 0)) {
      const empty = join(Object.values(map).map(profile => q`${ident(profile.tokens)} is null`), ' and ');
      await executor.query(render(q`delete from ${table} where scope_id=${scopeId} and row_id=${id} and ${empty}`));
    }
  }
}

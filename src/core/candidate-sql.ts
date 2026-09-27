import { ensure } from './errors.js';
import type { CompiledSearch } from './search-predicate.js';
import type { SealedModelDefinition, SealedStorage } from './sealed-model.js';
import { column as ident, join, pgsql as q, type Fragment } from './sql-fragment.js';

export function candidatePredicate(definition: SealedModelDefinition, storage: SealedStorage, scopeId: string, search: CompiledSearch): Fragment {
  ensure(storage.index, 'INVALID_SCHEMA');
  const companion = storage.index;
  const parentRow = ident(storage.parent.name, definition.columns[definition.identity.row].name);
  const index = ident(companion.schema, companion.name);
  const inside = (node: CompiledSearch): Fragment => {
    if (node.op === 'all' || node.op === 'any') return q`(${join(node.children.map(inside), node.op === 'all' ? ' and ' : ' or ')})`;
    const { profile, tokens } = node.leaf;
    ensure(tokens.length > 0, 'QUERY_TOO_BROAD');
    const mapped = companion.profiles?.[profile.indexId];
    ensure(mapped && mapped.mode === profile.mode, 'INVALID_SCHEMA');
    const col = ident('__seal_idx', mapped.tokens);
    const tokenPredicate = mapped.mode === 'exact' ? (ensure(tokens.length === 1, 'INVALID_SCHEMA'), q`(${col})[1]=${tokens[0]}::bigint`) : q`${col} @> ${tokens}::bigint[]`;
    return q`(${tokenPredicate})`;
  };
  return q`${parentRow} in (select ${ident('__seal_idx', 'row_id')} from ${index} as ${ident('__seal_idx')} where ${ident('__seal_idx', 'scope_id')}=${scopeId} and ${inside(search)})`;
}
/** Probe a bounded ordered prefix before allowing the GIN path to read every match. */
export function boundedCandidatePredicate(definition: SealedModelDefinition, storage: SealedStorage, scopeId: string, search: CompiledSearch, limit: number, after?: string): Fragment {
  ensure(storage.index && Number.isInteger(limit) && limit > 0 && limit <= 200, 'INVALID_VALUE');
  const companion = storage.index;
  const used = new Set<string>();
  const condition = (node: CompiledSearch): Fragment => {
    if (node.op === 'all' || node.op === 'any') return q`(${join(node.children.map(condition), node.op === 'all' ? ' and ' : ' or ')})`;
    const { profile, tokens } = node.leaf;
    ensure(tokens.length > 0, 'QUERY_TOO_BROAD');
    const mapped = companion.profiles?.[profile.indexId];
    ensure(mapped && mapped.mode === profile.mode, 'INVALID_SCHEMA');
    used.add(mapped.tokens);
    const col = ident('c', mapped.tokens);
    return mapped.mode === 'exact' ? (ensure(tokens.length === 1, 'INVALID_SCHEMA'), q`(${col})[1]=${tokens[0]}::bigint`) : q`${col} @> ${tokens}::bigint[]`;
  };
  const tokenWhere = condition(search);
  const index = ident(companion.schema, companion.name);
  const rowId = ident('c', 'row_id');
  const keyset = after ? q` and ${rowId}>${after}` : q``;
  const sampleColumns = join([...used].map(name => ident(name)), ',');
  const row = ident(storage.parent.name, definition.columns[definition.identity.row].name);
  return q`${row} in (
    with sample as materialized (
      select ${ident('row_id')},${sampleColumns} from ${index} as ${ident('c')}
      where ${ident('c', 'scope_id')}=${scopeId}${keyset} order by ${rowId} limit 256
    ), quick as materialized (
      select ${rowId} from sample as ${ident('c')} where ${tokenWhere} order by ${rowId} limit ${limit}
    ), fallback as materialized (
      select ${rowId} from ${index} as ${ident('c')}
      where ${ident('c', 'scope_id')}=${scopeId}${keyset} and ${tokenWhere}
        and (select count(*) from quick)<${limit}
      order by ${rowId} limit ${limit}
    )
    select row_id from quick where (select count(*) from quick)=${limit}
    union all select row_id from fallback
  )`;
}

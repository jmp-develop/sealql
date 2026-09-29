import { ensure } from './errors.js';
import type { CompiledSearch } from './search-predicate.js';
import type { SealedModelDefinition, SealedStorage } from './sealed-model.js';
import { column as ident, join, pgsql as q, type Fragment } from './sql-fragment.js';
import { keyArray } from './stamp-query.js';
import { profileColumns, type ProfileStorage } from './sealed-model.js';

function leafPredicate(schema: string, alias: string, leaf: Extract<CompiledSearch, { op: 'leaf' }>['leaf'], mapped: ProfileStorage): Fragment {
  const { profile, tokens, proof, node } = leaf;
  const col = (name: string) => ident(alias, name);
  const tokenPredicate = profile.mode === 'exact'
    ? q`(${col(mapped.tokens)})[1]=${tokens[0]}::bigint` : q`${col(mapped.tokens)} @> ${tokens}::bigint[]`;
  let exact: Fragment;
  if (mapped.exact) {
    const key = proof.keys[0];
    exact = q`${col(mapped.exact.stamp)}=(('x'||pg_catalog.encode(pg_catalog.substr(pg_catalog.sha256(${key}::bytea||${col(mapped.exact.salt)}),1,8),'hex'))::bit(64)::bigint)`;
  } else {
    const stream = node.respectWords ? mapped.words! : mapped.positions!;
    ensure(stream, 'INVALID_SCHEMA');
    const single = mapped.singles!;
    exact = proof.pattern ? q`${ident(schema, 'sealql_match_like')}(${keyArray(proof.keys)}::bytea[],${proof.kinds}::integer[],${JSON.stringify(proof.pattern)}::jsonb,
      ${col(stream.length)},${col(stream.salt)},${col(stream.stamps)},${col(stream.offsets)},${col(single.salt)},${col(single.stamps)},${col(single.offsets)})`
      : q`${ident(schema, 'sealql_match_positions')}(${keyArray(proof.keys)}::bytea[],${proof.offsets}::integer[],${proof.length},
        ${col(stream.length)},${col(stream.salt)},${col(stream.stamps)},${col(stream.offsets)},${node.op === 'startsWith' ? 1 : node.op === 'endsWith' ? 2 : 0})`;
  }
  return q`(${tokenPredicate} and coalesce(${exact},false))`;
}

export function candidatePredicate(definition: SealedModelDefinition, storage: SealedStorage, scopeId: string, search: CompiledSearch): Fragment {
  ensure(storage.index, 'INVALID_SCHEMA');
  const companion = storage.index;
  const parentRow = ident(storage.parent.name, definition.columns[definition.identity.row].name);
  const indexRow = ident('__seal_idx', 'row_id');
  const index = ident(companion.schema, companion.name);
  const inside = (node: CompiledSearch): Fragment => {
    if (node.op === 'all' || node.op === 'any') return q`(${join(node.children.map(inside), node.op === 'all' ? ' and ' : ' or ')})`;
    const { profile, tokens } = node.leaf;
    ensure(tokens.length > 0, 'QUERY_TOO_BROAD');
    const mapped = companion.profiles?.[profile.indexId];
    ensure(mapped && mapped.mode === profile.mode, 'INVALID_SCHEMA');
    return leafPredicate(companion.schema, '__seal_idx', node.leaf, mapped);
  };
  return q`${parentRow} in (select ${indexRow} from ${index} as ${ident('__seal_idx')} where ${ident('__seal_idx', 'scope_id')}=${scopeId} and ${inside(search)})`;
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
    profileColumns(mapped).forEach(name => used.add(name));
    return leafPredicate(companion.schema, 'c', node.leaf, mapped);
  };
  const tokenWhere = condition(search);
  const index = ident(companion.schema, companion.name);
  const rowId = ident('c', 'row_id');
  const keyset = after === undefined ? q`` : q` and ${rowId}>${after}`;
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

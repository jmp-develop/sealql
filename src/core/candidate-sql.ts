import { ensure } from './errors.js';
import type { CompiledSearch } from './search-predicate.js';
import type { SealedModelDefinition, SealedStorage } from './sealed-model.js';
import { column as ident, join, pgsql as q, type Fragment } from './sql-fragment.js';
import { keyArray, patternProgram } from './stamp-query.js';
import { type ProfileStorage } from './sealed-model.js';

function tokenPredicate(alias: string, leaf: Extract<CompiledSearch, { op: 'leaf' }>['leaf'], mapped: ProfileStorage): Fragment {
  return leaf.profile.mode === 'exact'
    ? q`(${ident(alias, mapped.tokens)})[1]=${leaf.tokens[0]}::bigint`
    : q`${ident(alias, mapped.tokens)} @> ${leaf.tokens}::bigint[]`;
}

function leafPredicate(schema: string, alias: string, leaf: Extract<CompiledSearch, { op: 'leaf' }>['leaf'], mapped: ProfileStorage): Fragment {
  const { proof, node } = leaf;
  const col = (name: string) => ident(alias, name);
  let exact: Fragment;
  if (mapped.exact) {
    const key = proof.keys[0];
    exact = q`${col(mapped.exact.stamp)}=(('x'||pg_catalog.encode(pg_catalog.substr(pg_catalog.sha256(${key}::bytea||${col(mapped.exact.salt)}),1,8),'hex'))::bit(64)::bigint)`;
  } else {
    const stream = node.respectWords ? mapped.words! : mapped.positions!;
    ensure(stream, 'INVALID_SCHEMA');
    const single = mapped.singles!;
    exact = proof.pattern ? q`${ident(schema, 'sealql_match_like')}(${keyArray(proof.keys)}::bytea[],${proof.kinds}::integer[],${patternProgram(proof.pattern)}::integer[],
      ${col(stream.length)},${col(stream.salt)},${col(stream.stamps)},${col(stream.offsets)},${col(single.salt)},${col(single.stamps)},${col(single.offsets)})`
      : q`${ident(schema, 'sealql_match_positions')}(${keyArray(proof.keys)}::bytea[],${proof.offsets}::integer[],${proof.length},
        ${col(stream.length)},${col(stream.salt)},${col(stream.stamps)},${col(stream.offsets)},${node.op === 'startsWith' ? 1 : node.op === 'endsWith' ? 2 : 0})`;
  }
  return q`(${tokenPredicate(alias, leaf, mapped)} and coalesce(${exact},false))`;
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
/** Order candidates before evaluation so LIMIT can stop proof evaluation early. */
export function boundedCandidatePredicate(definition: SealedModelDefinition, storage: SealedStorage, scopeId: string, search: CompiledSearch, limit: number, after?: string): Fragment {
  ensure(storage.index && Number.isSafeInteger(limit) && limit > 0, 'INVALID_VALUE');
  const companion = storage.index;
  const used = new Set<string>();
  const condition = (node: CompiledSearch, tokensOnly = false): Fragment => {
    if (node.op === 'all' || node.op === 'any') return q`(${join(node.children.map(child => condition(child, tokensOnly)), node.op === 'all' ? ' and ' : ' or ')})`;
    const { profile, tokens } = node.leaf;
    ensure(tokens.length > 0, 'QUERY_TOO_BROAD');
    const mapped = companion.profiles?.[profile.indexId];
    ensure(mapped && mapped.mode === profile.mode, 'INVALID_SCHEMA');
    used.add(mapped.tokens);
    const proofColumns = mapped.exact ?? (node.leaf.node.respectWords ? mapped.words! : mapped.positions!);
    Object.values(proofColumns).forEach(name => used.add(name));
    if (node.leaf.proof.pattern) Object.values(mapped.singles!).forEach(name => used.add(name));
    return tokensOnly ? tokenPredicate('c', node.leaf, mapped) : leafPredicate(companion.schema, 'c', node.leaf, mapped);
  };
  const tokenWhere = condition(search);
  const coarseWhere = condition(search, true);
  const index = ident(companion.schema, companion.name);
  const rowId = ident('c', 'row_id');
  const keyset = after === undefined ? q`` : q` and ${rowId}>${after}`;
  const sampleColumns = join([...used].map(name => ident(name)), ',');
  const row = ident(storage.parent.name, definition.columns[definition.identity.row].name);
  const ordered = q`(
    select ${ident('picked','row_id')},${join([...used].map(name => ident('proof',name)), ',')}
    from (
      select ${ident('row_id')} from ${index} as ${ident('c')}
      where ${ident('c', 'scope_id')}=${scopeId}${keyset} and ${coarseWhere}
      order by ${rowId} offset 0
    ) as ${ident('picked')}
    cross join lateral (
      select ${sampleColumns} from ${index} as ${ident('lookup')}
      where ${ident('lookup','scope_id')}=${scopeId} and ${ident('lookup','row_id')}=${ident('picked','row_id')} offset 0
    ) as ${ident('proof')}
    order by ${ident('picked','row_id')} offset 0
  ) as ${ident('c')}`;
  const finalSource = search.op === 'any' ? q`${index} as ${ident('c')}` : ordered;
  const finalScope = search.op === 'any' ? q`${ident('c', 'scope_id')}=${scopeId}${keyset} and ` : q``;
  // A dense ID prefix can satisfy the page without sorting all token candidates.
  // This is a probe size, never a result/work cap: misses use the complete fallback.
  const sampleLimit = Math.max(256, Math.min(Number.MAX_SAFE_INTEGER, limit * 4));
  return q`${row} in (
    with sample as materialized (
      select ${ident('row_id')},${sampleColumns} from ${index} as ${ident('c')}
      where ${ident('c', 'scope_id')}=${scopeId}${keyset} order by ${rowId} limit ${sampleLimit}
    ), quick as materialized (
      select ${rowId} from sample as ${ident('c')} where ${tokenWhere} order by ${rowId} limit ${limit}
    ), fallback as materialized (
      select ${rowId} from ${finalSource}
      where ${finalScope}${tokenWhere} and (select count(*) from quick)<${limit}
      order by ${rowId} limit ${limit}
    )
    select row_id from quick where (select count(*) from quick)=${limit}
    union all select row_id from fallback
  )`;
}

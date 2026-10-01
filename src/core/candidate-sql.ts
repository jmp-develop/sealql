import { ensure } from './errors.js';
import type { CompiledSearch } from './search-predicate.js';
import type { SealedModelDefinition, SealedStorage } from './sealed-model.js';
import { column as ident, join, pgsql as q, type Fragment } from './sql-fragment.js';
import { keyArray, patternProgram } from './stamp-query.js';
import { type ProfileStorage } from './sealed-model.js';

function tokenPredicate(alias: string, leaf: Extract<CompiledSearch, { op: 'leaf' }>['leaf'], mapped: ProfileStorage): Fragment {
  if (leaf.profile.hardened) return q`true`;
  ensure(mapped.tokens, 'INVALID_SCHEMA');
  if (leaf.profile.mode === 'exact') return q`(${ident(alias, mapped.tokens)})[1]=${leaf.tokens[0]}::bigint`;
  const tokens = leaf.tokens;
  // Three sorted pieces curb planner underestimation from correlated selectivities; this is not a candidate/result/work limit.
  const selected = tokens.length > 3 ? [tokens[0], tokens[Math.floor((tokens.length - 1) / 2)], tokens[tokens.length - 1]] : tokens;
  return q`${ident(alias, mapped.tokens)} @> ${selected}::bigint[]`;
}

function leafPredicate(schema: string, alias: string, leaf: Extract<CompiledSearch, { op: 'leaf' }>['leaf'], mapped: ProfileStorage): Fragment {
  const { proof } = leaf;
  const col = (name: string) => ident(alias, name);
  let exact: Fragment;
  if (mapped.exact) {
    const key = proof.keys[0];
    exact = q`${col(mapped.exact.stamp)}=(('x'||pg_catalog.encode(pg_catalog.substr(pg_catalog.sha256(${key}::bytea||${col(mapped.exact.salt)}),1,8),'hex'))::bit(64)::bigint)`;
  } else {
    const stream = mapped.positions!;
    ensure(stream, 'INVALID_SCHEMA');
    exact = proof.pattern ? q`${ident(schema, 'sealql_match_like')}(${keyArray(proof.keys)}::bytea[],${patternProgram(proof.pattern)}::integer[],
      ${col(stream.length)},${col(stream.salt)},${col(stream.stamps)},${col(stream.offsets)})`
      : q`${ident(schema, 'sealql_match_positions')}(${keyArray(proof.keys)}::bytea[],${proof.offsets}::integer[],${proof.length},
        ${col(stream.length)},${col(stream.salt)},${col(stream.stamps)},${col(stream.offsets)},${proof.affix ?? 0})`;
    if (proof.whole) exact = q`(${col(stream.length)}=${proof.length} and ${exact})`;
  }
  return leaf.profile.hardened ? exact : q`(${tokenPredicate(alias, leaf, mapped)} and ${exact})`;
}

/** Pure secured predicates are evaluated entirely against their companion. */
export function candidateRows(storage: SealedStorage, scopeId: string, search: CompiledSearch): Fragment {
  ensure(storage.index, 'INVALID_SCHEMA');
  const companion = storage.index;
  const indexRow = ident('__seal_idx', 'row_id');
  const index = ident(companion.schema, companion.name);
  const inside = (node: CompiledSearch): Fragment => {
    if (node.op === 'all' || node.op === 'any') return q`(${join(node.children.map(inside), node.op === 'all' ? ' and ' : ' or ')})`;
    const { profile, tokens } = node.leaf;
    ensure(profile.hardened || tokens.length > 0, 'QUERY_TOO_BROAD');
    const mapped = companion.profiles?.[profile.indexId];
    ensure(mapped && mapped.mode === profile.mode, 'INVALID_SCHEMA');
    return leafPredicate(companion.schema, '__seal_idx', node.leaf, mapped);
  };
  return q`select ${indexRow} from ${index} as ${ident('__seal_idx')} where ${ident('__seal_idx', 'scope_id')}=${scopeId} and ${inside(search)}`;
}

export function candidatePredicate(definition: SealedModelDefinition, storage: SealedStorage, scopeId: string, search: CompiledSearch): Fragment {
  const parentRow = ident(storage.parent.name, definition.columns[definition.identity.row].name);
  return q`${parentRow} in (${candidateRows(storage, scopeId, search)})`;
}
/** Order candidates before evaluation so LIMIT can stop proof evaluation early. */
export function boundedCandidatePredicate(definition: SealedModelDefinition, storage: SealedStorage, scopeId: string, search: CompiledSearch, limit: number, after?: string): Fragment {
  ensure(storage.index && Number.isSafeInteger(limit) && limit > 0, 'INVALID_VALUE');
  const companion = storage.index;
  const used = new Set<string>();
  const condition = (node: CompiledSearch, tokensOnly = false): Fragment => {
    if (node.op === 'all' || node.op === 'any') return q`(${join(node.children.map(child => condition(child, tokensOnly)), node.op === 'all' ? ' and ' : ' or ')})`;
    const { profile, tokens } = node.leaf;
    ensure(profile.hardened || tokens.length > 0, 'QUERY_TOO_BROAD');
    const mapped = companion.profiles?.[profile.indexId];
    ensure(mapped && mapped.mode === profile.mode, 'INVALID_SCHEMA');
    if (!profile.hardened) { ensure(mapped.tokens, 'INVALID_SCHEMA'); used.add(mapped.tokens); }
    const proofColumns = mapped.exact ?? mapped.positions!;
    Object.values(proofColumns).forEach(name => used.add(name));
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
    select ${ident('row_id')},${sampleColumns} from ${index} as ${ident('c')}
    where ${ident('c', 'scope_id')}=${scopeId} and ${rowId}>(select row_id from sample order by row_id desc limit 1) and ${coarseWhere}
    order by ${rowId} offset 0
  ) as ${ident('c')}`;
  // A dense ID prefix can satisfy the page without sorting all token candidates.
  // The sample is a complete ID prefix within this scope/keyset, before any
  // predicate. If quick is short it evaluated that whole prefix, so fallback
  // can keep its matches and continue strictly after the sample's last ID.
  const sampleLimit = Math.max(256, Math.min(Number.MAX_SAFE_INTEGER, limit * 4));
  return q`${row} in (
    with sample as materialized (
      select ${ident('row_id')},${sampleColumns} from ${index} as ${ident('c')}
      where ${ident('c', 'scope_id')}=${scopeId}${keyset} order by ${rowId} limit ${sampleLimit}
    ), quick as materialized (
      select ${rowId} from sample as ${ident('c')} where ${tokenWhere} order by ${rowId} limit ${limit}
    ), fallback as materialized (
      select ${rowId} from ${ordered}
      where ${tokenWhere}
      order by ${rowId} limit (${limit}-(select count(*) from quick))
    )
    select row_id from quick
    union all select row_id from fallback
  )`;
}

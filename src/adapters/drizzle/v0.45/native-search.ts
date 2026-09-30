import { and, asc, desc, eq, gt, lt, getTableColumns, getTableName, sql, SQL, type InferSelectModel } from 'drizzle-orm';
import { PgDialect, type PgColumn, type PgDatabase, type PgTable } from 'drizzle-orm/pg-core';
import { canonical, compareText, hex, identity, utf8 } from '../../../core/bytes.js';
import { databaseError, driverError, ensure, fail } from '../../../core/errors.js';
import { openCursor, sealCursor } from '../../../core/search-cursor.js';
import {
  compileSearch, validateSearch,
  type CompiledSearch, type SearchNode, type SearchOperator,
} from '../../../core/search-predicate.js';
import { profiles, type SearchTokenCache } from '../../../core/search-tokens.js';
import { boundedCandidatePredicate, candidatePredicate, candidateRows } from '../../../core/candidate-sql.js';
import type { Fragment, Node } from '../../../core/sql-fragment.js';
import { Sealed, registrationOf, type Opened, type Registration, type SealMeta } from './native.js';
import { mapRawRow } from './native-mapping.js';

type Db = PgDatabase<any, any, any>;
export interface SearchBudgets { batch?: number; fetchBytes?: number; decryptedBytes?: number; resultBytes?: number; deadlineMs?: number; decryptConcurrency?: number }
type ResolvedBudgets = Required<SearchBudgets>;
function budgetsFor(counting: boolean, requested?: SearchBudgets): ResolvedBudgets {
  const budgets: ResolvedBudgets = { batch: Infinity,
    fetchBytes: Infinity, decryptedBytes: Infinity, resultBytes: Infinity,
    deadlineMs: Infinity, decryptConcurrency: 64, ...requested };
  for (const [key, value] of Object.entries(requested ?? {})) {
    ensure((counting ? ['deadlineMs'] : ['batch','fetchBytes','decryptedBytes','resultBytes','deadlineMs','decryptConcurrency']).includes(key), 'INVALID_VALUE');
    ensure(Number.isSafeInteger(value) && value > 0, 'INVALID_VALUE');
  }
  return budgets;
}
type PlainOfSealed<V> = V extends Sealed<infer P, any> ? P : never;
type SearchOfSealed<V> = V extends Sealed<any, infer S> ? S : never;
type ParentOf<C> = C extends SealMeta<infer T, any, any> ? T : never;
type Operation<V> = (SearchOfSealed<V> extends { exact: unknown } ? { eq(value: PlainOfSealed<V>): NativeNode } : {}) &
  (PlainOfSealed<V> extends string ? SearchOfSealed<V> extends { substring: unknown } ? {
    contains(value: string): NativeNode;
    startsWith(value: string): NativeNode; endsWith(value: string): NativeNode; like(value: string): NativeNode;
  } : {} : {});
export type MatchBuilder<T extends PgTable> = {
  [K in keyof InferSelectModel<T> as NonNullable<InferSelectModel<T>[K]> extends Sealed<any, infer S>
    ? S extends false | undefined ? never : K : never]: Operation<NonNullable<InferSelectModel<T>[K]>>;
} & { and(...children: NativeNode[]): NativeNode; or(...children: NativeNode[]): NativeNode; sql(condition: SQL): NativeNode };

export type NativeNode = { op: SearchOperator; field: string; value: unknown } |
  { op: 'and' | 'or'; children: NativeNode[] } | { op: 'sql'; condition: SQL; flag?: string };
type CompiledNode = { op: 'secure'; search: CompiledSearch } | { op: 'sql'; condition: SQL } |
  { op: 'and' | 'or'; children: CompiledNode[] };
type FindOptions<T extends PgTable> = {
  scope?: string; match?: (m: MatchBuilder<T>) => NativeNode; where?: SQL;
  columns?: Partial<Record<keyof InferSelectModel<T>, boolean>>;
  orderBy?: { column: PgColumn; direction: 'asc' | 'desc' } | readonly { column: PgColumn; direction: 'asc' | 'desc' }[];
  limit?: number; cursor?: string | undefined; budgets?: SearchBudgets; signal?: AbortSignal;
};
type CountOptions<T extends PgTable> = Pick<FindOptions<T>, 'scope' | 'match' | 'where' | 'signal'> & { budgets?: { deadlineMs?: number } };
type WhereOptions<T extends PgTable> = Pick<FindOptions<T>, 'scope'> &
  { match: (m: MatchBuilder<T>) => NativeNode };
type SelectedKeys<T extends PgTable, R extends string, S extends string | undefined, O> =
  Extract<R | Exclude<S, undefined>, keyof InferSelectModel<T>> |
  (O extends { columns: infer C } ? { [K in keyof C]: C[K] extends true ? K : never }[keyof C] : keyof InferSelectModel<T>);
type SelectedRow<T extends PgTable, R extends string, S extends string | undefined, O> =
  Opened<Pick<InferSelectModel<T>, Extract<SelectedKeys<T, R, S, O>, keyof InferSelectModel<T>>>>;

function m<T extends PgTable>(reg: Registration): MatchBuilder<T> {
  const result: Record<string, unknown> = {
    and: (...children: NativeNode[]) => ({ op: 'and', children }),
    or: (...children: NativeNode[]) => ({ op: 'or', children }),
    sql: (condition: SQL) => ({ op: 'sql', condition }),
  };
  for (const [key, field] of reg.fields) {
    const search = field.spec.search;
    if (!search) continue;
    const operations: Record<string, (...values: any[]) => NativeNode> = {};
    if ('exact' in search) operations.eq = value => ({ op: 'eq', field: key, value });
    if ('substring' in search) for (const op of ['contains', 'startsWith', 'endsWith', 'like'] as const)
      operations[op] = (value, ...extra) => { ensure(extra.length === 0, 'INVALID_VALUE'); return { op, field: key, value }; };
    result[key] = operations;
  }
  return result as MatchBuilder<T>;
}
function validate(node: NativeNode, reg: Registration): void {
  const visit = (current: NativeNode) => {
    if (current.op === 'and' || current.op === 'or') {
      ensure(current.children.length > 0, 'INVALID_VALUE');
      current.children.forEach(visit); return;
    }
    if (current.op === 'sql') return;
    ensure('field' in current, 'INVALID_VALUE');
    const field = reg.fields.get(current.field);
    ensure(field?.spec.search && (current.op === 'eq' ? 'exact' in field.spec.search : 'substring' in field.spec.search), 'UNSUPPORTED_SEARCH');
  };
  visit(node);
}
function plainFree(node: NativeNode): boolean {
  return node.op === 'sql' ? false : node.op === 'and' || node.op === 'or' ? node.children.every(plainFree) : true;
}
function asCore(node: NativeNode): SearchNode {
  if (node.op === 'sql') fail('INVALID_VALUE');
  if (node.op === 'and' || node.op === 'or') return { op: node.op === 'and' ? 'all' : 'any', children: node.children.map(asCore) };
  ensure('field' in node, 'INVALID_VALUE');
  return node;
}
async function compile(node: NativeNode, reg: Registration, scopeId: string, sealer: ReturnType<() => import('../../../core/field-cipher.js').Sealer>, cache: SearchTokenCache): Promise<CompiledNode> {
  if (plainFree(node)) {
    const core = asCore(node);
    validateSearch(core, reg.definition);
    const stored = [...reg.fields].flatMap(([key, field]) => profiles(reg.model, field.spec.id ?? key, field.spec));
    return { op: 'secure', search: await compileSearch(core, reg.definition, stored, sealer.ring(reg.model), scopeId, cache) };
  }
  if (node.op === 'sql') return { op: 'sql', condition: node.condition };
  if (node.op === 'and' || node.op === 'or') return { op: node.op, children: await Promise.all(node.children.map(child => compile(child, reg, scopeId, sealer, cache))) };
  fail('INVALID_VALUE');
}
function fromFragment(fragment: Fragment): SQL {
  const build = (node: Node): SQL => {
    switch (node.kind) {
      case 'literal': return sql.raw(node.text);
      case 'identifier': return sql.join(node.names.map(name => sql.identifier(name)), sql.raw('.'));
      case 'param': return sql`${Array.isArray(node.value) ? `{${node.value.join(',')}}` : node.value}`;
      case 'concat': return sql.join(node.nodes.map(build), sql.raw(''));
    }
  };
  return build(fragment.node);
}
function candidate(reg: Registration, scopeId: string, node: CompiledNode, bounded?: { limit: number; after?: string | undefined }): SQL {
  if (node.op === 'secure') return fromFragment(bounded
    ? boundedCandidatePredicate(reg.definition, reg.storage, scopeId, node.search, bounded.limit, bounded.after)
    : candidatePredicate(reg.definition, reg.storage, scopeId, node.search));
  if (node.op === 'sql') return node.condition;
  const children = node.children.map(child => candidate(reg, scopeId, child));
  return node.op === 'and' ? and(...children)! : sql`(${sql.join(children.map(child => sql`(${child})`), sql.raw(' or '))})`;
}
function sqlFingerprint(value: SQL | undefined): unknown {
  if (!value) return null;
  const query = new PgDialect().sqlToQuery(value);
  return [query.sql, query.params];
}
async function digest(value: unknown): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', canonical(value) as Uint8Array<ArrayBuffer>)));
}
function nodeFingerprint(node: NativeNode | undefined): unknown {
  if (!node) return null;
  if (node.op === 'sql') return { op: 'sql', condition: sqlFingerprint(node.condition) };
  if (node.op === 'and' || node.op === 'or') return { op: node.op, children: node.children.map(nodeFingerprint) };
  return node;
}
function scope(reg: Registration, requested: string | undefined): string {
  if (!reg.scope) { ensure(requested === undefined, 'INVALID_VALUE'); return '_'; }
  ensure(requested !== undefined, 'INVALID_VALUE');
  return identity(requested, reg.definition.scopeType);
}
function order(reg: Registration, requested?: FindOptions<PgTable>['orderBy']) {
  if (!requested) return [];
  const items = Array.isArray(requested) ? requested : [requested];
  ensure(items.length > 0, 'INVALID_VALUE');
  const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
  const allowed = /^(?:smallint|integer|bigint|numeric(?:\(\d+(?:,\s*\d+)?\))?|decimal(?:\(\d+(?:,\s*\d+)?\))?|text|character varying(?:\(\d+\))?|varchar(?:\(\d+\))?|uuid|date|timestamp(?:\s*\(\d+\))?(?: with(?:out)? time zone)?|boolean)$/;
  const seen = new Set<PgColumn>();
  for (const item of items) {
    ensure(Object.values(columns).includes(item.column) && ![...reg.fields.values()].some(field => field.column === item.column) &&
      allowed.test(item.column.getSQLType()) && ['asc', 'desc'].includes(item.direction) && !seen.has(item.column), 'INVALID_VALUE');
    seen.add(item.column);
  }
  return items;
}
function keysetAfter(columns: PgColumn[], values: (string | null)[], directions: ('asc' | 'desc')[]): SQL {
  ensure(columns.length === values.length && columns.length === directions.length, 'CURSOR_INVALID');
  if (values.every(value => value !== null) && directions.every(direction => direction === directions[0]) &&
    columns.every(column => column.notNull)) {
    return sql`(${sql.join(columns.map(column => sql`${column}`), sql.raw(','))})
      ${sql.raw(directions[0] === 'asc' ? '>' : '<')}
      (${sql.join(values.map(value => sql`${value}`), sql.raw(','))})`;
  }
  const terms = columns.map((column, index) => {
    const value = values[index], direction = directions[index];
    const comparison = value === null ? direction === 'asc' ? sql`false` : sql`${column} is not null`
      : direction === 'asc' ? sql`(${column} > ${value} or ${column} is null)` : sql`${column} < ${value}`;
    return and(...columns.slice(0, index).map((prior, offset) => sql`${prior} is not distinct from ${values[offset]}`), comparison)!;
  });
  return sql`(${sql.join(terms.map(term => sql`(${term})`), sql.raw(' or '))})`;
}

function measureRow(value: unknown): { fetched: number; decrypted: number } {
  if (value instanceof Sealed) return { fetched: value.bytes.length, decrypted: value.bytes.length-29 };
  if (value instanceof Uint8Array) return { fetched: value.length, decrypted: 0 };
  if (typeof value === 'string') return { fetched: utf8(value).length, decrypted: 0 };
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.values(value).reduce(
    (sum, part) => { const size = measureRow(part); return { fetched: sum.fetched+size.fetched, decrypted: sum.decrypted+size.decrypted }; }, { fetched: 0, decrypted: 0 });
  return { fetched: 16, decrypted: 0 };
}
type AuthCache = Map<string, { bytes: Uint8Array; result: Promise<unknown> }>;
type ResultState = { scanned: number; fetchedBytes: number; decryptedBytes: number; limited: boolean };
async function scanRows<R, P>(rows: R[], remaining: () => number, budgets: SearchBudgets & {
  fetchBytes: number; decryptedBytes: number; decryptConcurrency: number;
}, deadline: number, signal: AbortSignal | undefined, state: ResultState,
  measure: (row: R) => { fetched: number; decrypted: number },
  openWindow: (window: R[]) => Promise<P[]>, consume: (row: R, opened: P) => Promise<boolean>): Promise<number> {
  let offset = 0, consumed = 0;
  while (offset < rows.length && remaining() > 0 && !state.limited) {
    const window: R[] = [];
    const windowSize = Math.min(budgets.decryptConcurrency, remaining());
    while (offset < rows.length && window.length < windowSize) {
      if (signal?.aborted) fail('CANCELLED');
      if (Date.now() >= deadline) { state.limited = true; break; }
      const row = rows[offset], size = measure(row);
      if (state.fetchedBytes + size.fetched > budgets.fetchBytes || state.decryptedBytes + size.decrypted > budgets.decryptedBytes) {
        state.limited = true; break;
      }
      state.fetchedBytes += size.fetched; state.decryptedBytes += size.decrypted;
      window.push(row); offset++;
    }
    if (!window.length) break;
    const opened = await openWindow(window);
    ensure(opened.length === window.length, 'INVALID_CANDIDATE_SHAPE');
    for (let i = 0; i < window.length; i++) {
      if (signal?.aborted) fail('CANCELLED');
      if (Date.now() >= deadline) { state.limited = true; break; }
      if (!(await consume(window[i], opened[i]))) { state.limited = true; break; }
      state.scanned++; consumed++;
      if (remaining() === 0) break;
    }
  }
  return consumed;
}
// Carry each text column's collation into the comparison without looking up the row.
// The previous cursor row may have been deleted between requests.
async function validateTextOrder(db: Db, columns: PgColumn[], positions: unknown[][], signal: AbortSignal | undefined, deadline: number): Promise<void> {
  const names = columns.map((_, index) => `p${index}`);
  const types = columns.map(column => column.getSQLType());
  const arrays = columns.map((_, index) => {
    const literal = `{${positions.map(parts => parts[index] === null ? 'NULL' : `"${String(parts[index]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
    return sql`${literal}::${sql.raw(types[index])}[]`;
  });
  const input = sql.identifier('input');
  const qualified = (table: string, name: string) => sql`${sql.identifier(table)}.${sql.identifier(name)}`;
  const inputColumn = (index: number) => qualified('input', names[index]);
  const values = columns.map((column, index) => /^(?:text|character varying|varchar)/.test(types[index])
    ? sql`coalesce((select ${column} from ${column.table} where false), ${inputColumn(index)})` : inputColumn(index));
  const current = values.map((_, index) => qualified('ordered', `v${index}`));
  const prior = values.map((_, index) => qualified('ordered', `previous_${index}`));
  const orderedAfter = sql`(${sql.join(values.map((_, index) => {
    const before = prior[index], after = current[index];
    const equalPrefix = prior.slice(0, index).map((value, i) => sql`${value} is not distinct from ${current[i]}`);
    return sql`(${and(...equalPrefix, sql`(${before} < ${after} or (${before} is not null and ${after} is null))`)})`;
  }), sql.raw(' or '))})`;
  const statement = sql`with input as (
    select * from unnest(${sql.join(arrays, sql.raw(','))}) with ordinality as ${input}(${sql.join(names.map(name => sql`${sql.identifier(name)}`), sql.raw(','))}, ordinal)
  ), resolved as (
    select ${qualified('input', 'ordinal')} as ordinal,
      ${sql.join(values.map((value, index) => sql`${value} as ${sql.identifier(`v${index}`)}`), sql.raw(','))}
    from input
  ), ordered as (
    select *, ${sql.join(values.map((_, index) => sql`lag(${sql.identifier(`v${index}`)}) over (order by ordinal) as ${sql.identifier(`previous_${index}`)}`), sql.raw(','))}
    from resolved
  ) select coalesce(bool_and(
    ${qualified('ordered', 'ordinal')} = 1 or (${orderedAfter}) is true
  ), false) as valid from ordered`;
  if (signal?.aborted) fail('CANCELLED');
  ensure(Date.now() < deadline, 'LIMIT_EXCEEDED');
  let result: any;
  try { result = await (db as any).execute(statement); }
  catch (error) {
    const code = driverError(error)?.code;
    if (typeof code === 'string' && ['22P02', '22P03', '22P04', '22P05', '2202E'].includes(code)) fail('INVALID_CANDIDATE_SHAPE');
    throw databaseError(error);
  }
  if (signal?.aborted) fail('CANCELLED');
  ensure(Date.now() < deadline, 'LIMIT_EXCEEDED');
  const rows = Array.isArray(result) ? result : result.rows;
  ensure(rows?.length === 1 && rows[0].valid === true, 'INVALID_CANDIDATE_SHAPE');
}
export function searchMethods(sealerOf: () => import('../../../core/field-cipher.js').Sealer, open: <R>(rows: R, options?: { scope?: string; budgets?: { maxRows?: number; maxBytes?: number; deadlineMs?: number; concurrency?: number } }, authCache?: AuthCache) => Promise<Opened<R>>,
  cache: SearchTokenCache) {
  async function where<T extends PgTable, R extends string, S extends string | undefined = undefined>(
    seal: SealMeta<T, R, S> & object, options: WhereOptions<T>,
  ): Promise<SQL> {
    ensure(options && typeof options === 'object' && typeof options.match === 'function' &&
      Object.keys(options).every(key => ['scope','match'].includes(key)), 'INVALID_VALUE');
    const reg = registrationOf(seal), scopeId = scope(reg, options.scope);
    const ast = options.match(m<T>(reg));
    validate(ast, reg);
    const compiled = await compile(ast, reg, scopeId, sealerOf(), cache);
    const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
    return and(reg.scope ? eq(columns[reg.scope], scopeId) : undefined, candidate(reg, scopeId, compiled))!;
  }
  async function run<T extends PgTable>(db: Db, reg: Registration, options: FindOptions<T>) {
    ensure(options && typeof options === 'object', 'INVALID_VALUE');
    const scopeId = scope(reg, options.scope), columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
    const rowColumn = columns[reg.row], orders = order(reg, options.orderBy);
    // Preserve cursor binding, but canonicalize equivalent ID orderings in SQL.
    const ascendingIdentity = !orders.length || (orders.length === 1 && orders[0].column === rowColumn && orders[0].direction === 'asc');
    const executionOrders = ascendingIdentity ? [] : orders;
    const limit = options.limit ?? Infinity, budgets = budgetsFor(false, options.budgets);
    if (options.limit !== undefined) ensure(Number.isSafeInteger(limit) && limit > 0, 'INVALID_VALUE');
    const deadline = Date.now() + budgets.deadlineMs;
    const check = () => { if (options.signal?.aborted) fail('CANCELLED'); ensure(Date.now() < deadline, 'LIMIT_EXCEEDED'); };
    check();
    const ast = options.match?.(m<T>(reg));
    if (ast) validate(ast, reg);
    const compiled = ast ? await compile(ast, reg, scopeId, sealerOf(), cache) : undefined;
    const selection = options.columns ? Object.keys(options.columns).filter(key => options.columns![key as keyof typeof options.columns]) : Object.keys(columns);
    selection.forEach(key => ensure(!!columns[key], 'INVALID_VALUE'));
    const projected = [...new Set([reg.row, ...(reg.scope ? [reg.scope] : []), ...selection])];
    const selected: Record<string, PgColumn | SQL> = Object.fromEntries(projected.map(key => [key, columns[key]]));
    executionOrders.forEach(({ column }, index) => { selected[`__seal_sort_${index}`] = sql<string>`to_jsonb(${column}) #>> '{}'`; });
    const queryDigest = await digest({ scopeId, positionEncoding: 'jsonb-v1', match: nodeFingerprint(ast), where: sqlFingerprint(options.where),
      orderBy: orders.map(item => [item.column.name, item.direction]) });
    const ring = sealerOf().ring(reg.model), context = { modelId: reg.model, scopeId, keyScopeId: ring.keyScopeId, queryDigest };
    const cursor = options.cursor ? await openCursor(options.cursor, context, ring) : undefined;
    let after = cursor?.lastId, afterSort = cursor?.lastSort, exhausted = false, resultBytes = 0;
    const items: Record<string, unknown>[] = [], state: ResultState = { scanned: 0, fetchedBytes: 0, decryptedBytes: 0, limited: false };
    const batch = options.budgets?.batch ?? limit;
    while (items.length < limit && !state.limited) {
      check();
      const requestLimit = Math.min(batch, limit-items.length), direction = orders.at(-1)?.direction ?? 'asc';
      const values = afterSort === undefined ? [] : JSON.parse(afterSort) as (string | null)[];
      const afterCondition = after === undefined ? undefined : executionOrders.length
        ? keysetAfter([...executionOrders.map(item => item.column), rowColumn], [...values, after], [...executionOrders.map(item => item.direction), direction])
        : direction === 'asc' ? gt(rowColumn, after) : lt(rowColumn, after);
      const bounded = compiled?.op === 'secure' && !options.where && ascendingIdentity && Number.isFinite(requestLimit)
        ? { limit: requestLimit, after } : undefined;
      const condition = and(reg.scope ? eq(columns[reg.scope], scopeId) : undefined, options.where, afterCondition,
        compiled ? candidate(reg, scopeId, compiled, bounded) : undefined);
      let rows: Record<string, unknown>[];
      try {
        const query = (db as any).select(selected).from(reg.parent).where(condition).orderBy(
          ...executionOrders.map(item => item.direction === 'asc' ? asc(item.column) : desc(item.column)),
          direction === 'asc' ? asc(rowColumn) : desc(rowColumn));
        rows = await (Number.isFinite(requestLimit) ? query.limit(requestLimit) : query);
      } catch (error) { throw databaseError(error); }
      ensure(rows.length <= requestLimit, 'INVALID_CANDIDATE_SHAPE');
      if (!rows.length) { check(); exhausted = true; break; }
      await scanRows(rows, () => limit-items.length, budgets, deadline, options.signal, state,
        row => {
          identity(row[reg.row] as string, reg.definition.rowType);
          ensure(!reg.scope || row[reg.scope] === scopeId, 'INVALID_CANDIDATE_SHAPE');
          return measureRow(row);
        },
        window => open(window, { scope: scopeId, budgets: { concurrency: budgets.decryptConcurrency } }) as Promise<Record<string, unknown>[]>,
        async (row, plain) => {
          const item = Object.fromEntries(projected.map(key => [key, plain[key]]));
          const size = Number.isFinite(budgets.resultBytes) ? canonical(item).length : 0;
          if (resultBytes+size > budgets.resultBytes) return false;
          resultBytes += size; items.push(item);
          after = identity(row[reg.row] as string, reg.definition.rowType);
          afterSort = orders.length ? JSON.stringify(ascendingIdentity ? [after] : orders.map((_, index) => row[`__seal_sort_${index}`] ?? null)) : undefined;
          return true;
        });
      if (state.limited) break;
      if (rows.length < requestLimit) { exhausted = true; break; }
    }
    if (state.limited && !state.scanned) fail('LIMIT_EXCEEDED');
    return { items, nextCursor: exhausted || after === undefined ? null : await sealCursor(context,
      { lastId: after, ...(afterSort === undefined ? {} : { lastSort: afterSort }) }, ring) };
  }
  async function findMany<T extends PgTable, R extends string, S extends string | undefined = undefined, const O extends FindOptions<T> = FindOptions<T>>(
    db: Db, seal: SealMeta<T, R, S> & object, options: O,
  ): Promise<{ items: SelectedRow<T, R, S, O>[]; nextCursor: string | null }> {
    const result = await run<T>(db, registrationOf(seal), options);
    return { items: result.items as SelectedRow<T, R, S, O>[], nextCursor: result.nextCursor };
  }
  async function count<T extends PgTable, R extends string, S extends string | undefined = undefined>(
    db: Db, seal: SealMeta<T, R, S> & object, options: CountOptions<T>,
  ): Promise<number> {
    ensure(options && typeof options === 'object' && Object.keys(options).every(key =>
      ['scope','match','where','signal','budgets'].includes(key)), 'INVALID_VALUE');
    const reg = registrationOf(seal), scopeId = scope(reg, options.scope);
    const budgets = budgetsFor(true, options.budgets), deadline = Date.now()+budgets.deadlineMs;
    const check = () => { if (options.signal?.aborted) fail('CANCELLED'); ensure(Date.now() < deadline, 'LIMIT_EXCEEDED'); };
    check();
    const ast = options.match?.(m<T>(reg));
    if (ast) validate(ast, reg);
    const compiled = ast ? await compile(ast, reg, scopeId, sealerOf(), cache) : undefined;
    check();
    const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
    let rows: { count: string }[];
    try {
      if (compiled?.op === 'secure' && !options.where) {
        const result = await (db as any).execute(sql`select count(*)::text as count from (${fromFragment(candidateRows(reg.storage, scopeId, compiled.search))}) as ${sql.identifier('__seal_matches')}`);
        rows = Array.isArray(result) ? result : result.rows;
      } else rows = await (db as any).select({ count: sql<string>`count(*)::text` }).from(reg.parent).where(and(
        reg.scope ? eq(columns[reg.scope], scopeId) : undefined, options.where, compiled ? candidate(reg, scopeId, compiled) : undefined));
    }
    catch (error) { throw databaseError(error); }
    check();
    const value = rows[0]?.count;
    ensure(typeof value === 'string' && /^[0-9]+$/.test(value), 'INVALID_CANDIDATE_SHAPE');
    const exact = BigInt(value);
    ensure(exact <= BigInt(Number.MAX_SAFE_INTEGER), 'LIMIT_EXCEEDED');
    return Number(exact);
  }
  type SearchParts<L extends number | undefined = number | undefined> = { where: SQL; after: SQL | undefined; orderBy: SQL[]; flags: Record<string, SQL | SQL.Aliased>;
    flagsSql: SQL; limit: L };
  type SearchOptions<M extends Record<string, object>, R, L extends number | undefined = number | undefined> = {
    scope?: string;
    match: { [K in keyof M]: readonly [M[K], (m: MatchBuilder<ParentOf<M[K]>>) => NativeNode] };
    keyset?: PgColumn[]; columns?: Record<string, Record<string, string>>;
    limit?: number; cursor?: string | undefined; budgets?: SearchBudgets; signal?: AbortSignal;
    query: (parts: SearchParts<L>) => Promise<R[] | { rows: R[] }> | R[] | { rows: R[] };
  };
  type PublicRow<R> = { [K in keyof R as K extends `__seal_${string}` ? never : K]: Opened<R[K]> };
  function search<const M extends Record<string, object>, R extends Record<string, unknown>>(db: Db, options: SearchOptions<M, R, number> & { limit: number }): Promise<{ items: PublicRow<R>[]; nextCursor: string | null }>;
  function search<const M extends Record<string, object>, R extends Record<string, unknown>>(db: Db, options: SearchOptions<M, R>): Promise<{ items: PublicRow<R>[]; nextCursor: string | null }>;
  // The overloads preserve the caller's required/optional limit; the shared
  // implementation validates it before computing the callback's batch size.
  async function search<const M extends Record<string, object>, R extends Record<string, unknown>>(db: Db, options: SearchOptions<M, R, any>): Promise<{ items: PublicRow<R>[]; nextCursor: string | null }> {
    ensure(options && options.match && typeof options.query === 'function', 'INVALID_VALUE');
    const keys = Object.keys(options.match);
    ensure(keys.length > 0, 'INVALID_VALUE');
    const limit = options.limit ?? Infinity, budgets = budgetsFor(false, options.budgets), deadline = Date.now()+budgets.deadlineMs;
    if (options.limit !== undefined) ensure(Number.isSafeInteger(limit) && limit > 0, 'INVALID_VALUE');
    const check = () => { if (options.signal?.aborted) fail('CANCELLED'); ensure(Date.now() < deadline, 'LIMIT_EXCEEDED'); };
    check();
    const regs = Object.fromEntries(keys.map(key => [key, registrationOf(options.match[key][0])])) as Record<string, Registration>;
    ensure(new Set(keys.map(key => regs[key].parent)).size === keys.length, 'INVALID_SCHEMA');
    const scopeId = options.scope ?? '_';
    keys.forEach(key => ensure(scope(regs[key], options.scope) === scopeId, 'INVALID_VALUE'));
    const asts = Object.fromEntries(keys.map(key => [key, options.match[key][1](m(regs[key]))])) as Record<string, NativeNode>;
    const compiled: Record<string, CompiledNode> = Object.create(null);
    for (const key of keys) { validate(asts[key], regs[key]); compiled[key] = await compile(asts[key], regs[key], scopeId, sealerOf(), cache); }
    const keyset = options.keyset ?? [];
    const allowed = /^(?:smallint|integer|bigint|numeric(?:\(\d+(?:,\s*\d+)?\))?|decimal(?:\(\d+(?:,\s*\d+)?\))?|text|character varying(?:\(\d+\))?|varchar(?:\(\d+\))?|uuid|date|timestamp(?:\s*\(\d+\))?(?: with(?:out)? time zone)?|boolean)$/;
    keyset.forEach(column => ensure(allowed.test(column.getSQLType()), 'INVALID_VALUE'));
    const positionColumns = [...keys.map(key => (getTableColumns(regs[key].parent) as Record<string, PgColumn>)[regs[key].row]), ...keyset];
    const orderBy = positionColumns.map(column => asc(column));
    const allFlags: Record<string, SQL | SQL.Aliased> = {};
    keyset.forEach((column, index) => { allFlags[`__seal_keyset_${index}`] = sql<string>`to_jsonb(${column}) #>> '{}'`.as(`__seal_keyset_${index}`); });
    const flagsSql = Object.keys(allFlags).length ? sql.join(Object.entries(allFlags).map(([name, expression]) =>
      sql`${expression instanceof SQL ? expression : expression.sql} as ${sql.identifier(name)}`), sql.raw(',')) : sql`true as __seal_position`;
    const where = and(...keys.flatMap(key => { const reg = regs[key], columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
      return [reg.scope ? eq(columns[reg.scope], scopeId) : undefined, candidate(reg, scopeId, compiled[key])]; }))!;
    const queryDigest = await digest({ scopeId, positionEncoding: 'jsonb-v1', match: keys.map(key => [key, regs[key].model, nodeFingerprint(asts[key])]),
      keyset: keyset.map(column => [getTableName(column.table), column.name]) });
    const ring = sealerOf().ring(regs[[...keys].sort()[0]].model);
    const context = { modelId: `search:${JSON.stringify(keys.map(key => regs[key].model).sort())}`, scopeId, keyScopeId: ring.keyScopeId, queryDigest };
    const cursor = options.cursor ? await openCursor(options.cursor, context, ring) : undefined;
    let previous: (string | null)[] | undefined;
    if (cursor) {
      try { previous = JSON.parse(cursor.lastId); ensure(Array.isArray(previous) && previous.length === positionColumns.length, 'CURSOR_INVALID'); }
      catch { fail('CURSOR_INVALID'); }
    }
    const seen = new Set<string>(previous ? [JSON.stringify(previous)] : []), authCache: AuthCache = new Map();
    const position = (raw: Record<string, unknown>): (string | null)[] => {
      const parts = keys.map(key => {
        const reg = regs[key], mapping = options.columns?.[key], row = mapping ? raw : raw[key] as Record<string, unknown>;
        ensure(row && typeof row === 'object', 'INVALID_CANDIDATE_SHAPE');
        const id = row[mapping ? mapping[reg.row] : reg.row];
        ensure(typeof id === 'string' && (!reg.scope || row[mapping ? mapping[reg.scope] : reg.scope] === scopeId), 'INVALID_CANDIDATE_SHAPE');
        return identity(id, reg.definition.rowType);
      }) as (string | null)[];
      keyset.forEach((_, index) => { const value = raw[`__seal_keyset_${index}`]; ensure(value !== undefined, 'INVALID_CANDIDATE_SHAPE'); parts.push(value === null ? null : String(value)); });
      return parts;
    };
    const openProjection = async (raw: Record<string, unknown>) => {
      const view = { ...raw }, mapped: { viewKey: string; columns: Record<string, string>; fields: string[] }[] = [];
      for (const key of keys) {
        const reg = regs[key], mapping = options.columns?.[key];
        if (mapping) {
          const fields = [...reg.fields.keys()].filter(field => !!mapping[field] && Object.hasOwn(raw, mapping[field]));
          const viewKey = `__seal_view_${key}`;
          view[viewKey] = mapRawRow(reg, raw, mapping, fields, true); mapped.push({ viewKey, columns: mapping, fields });
        } else {
          const row = raw[key] as Record<string, unknown>;
          for (const field of reg.fields.keys()) if (Object.hasOwn(row, field)) {
            const value = row[field]; ensure(value === null || value instanceof Sealed && value.binding?.registration === reg && value.binding.key === field, 'INVALID_CANDIDATE_SHAPE');
          }
        }
      }
      const opened = await open(view, { scope: scopeId }, authCache) as Record<string, unknown>;
      for (const { viewKey, columns, fields } of mapped) { const row = opened[viewKey] as Record<string, unknown>;
        fields.forEach(field => { opened[columns[field]] = row[field]; }); delete opened[viewKey]; }
      return opened;
    };
    const items: PublicRow<R>[] = [], state: ResultState = { scanned: 0, fetchedBytes: 0, decryptedBytes: 0, limited: false };
    const batch = options.budgets?.batch ?? (Number.isFinite(limit) ? 200 : Infinity);
    const needsDbOrder = positionColumns.some(column => !column.notNull || !['uuid','smallint','integer','bigint'].includes(column.getSQLType()));
    let exhausted = false, resultBytes = 0;
    while (items.length < limit && !state.limited) {
      check();
      const requestLimit = Math.min(batch, limit-items.length);
      const after = previous ? keysetAfter(positionColumns, previous, positionColumns.map(() => 'asc')) : undefined;
      let returned: R[] | { rows: R[] };
      try { returned = await options.query({ where, after, orderBy, flags: allFlags, flagsSql, limit: Number.isFinite(requestLimit) ? requestLimit : undefined }); }
      catch (error) { throw databaseError(error); }
      const rows = Array.isArray(returned) ? returned : returned?.rows;
      ensure(Array.isArray(rows) && rows.length <= requestLimit, 'INVALID_CANDIDATE_SHAPE');
      if (!rows.length) { check(); exhausted = true; break; }
      if (needsDbOrder) await validateTextOrder(db, positionColumns, previous ? [previous,...rows.map(position)] : rows.map(position), options.signal, deadline);
      await scanRows(rows, () => limit-items.length, budgets, deadline, options.signal, state,
        raw => {
          position(raw); const size = measureRow(raw);
          for (const key of keys) { const mapping = options.columns?.[key]; if (!mapping) continue;
            for (const field of regs[key].fields.keys()) { const value = raw[mapping[field]];
              if (value === null || value === undefined) continue;
              const bytes = value instanceof Uint8Array ? value.length : typeof value === 'string' && /^\\x(?:[0-9a-f]{2})*$/i.test(value) ? (value.length-2)/2 : 0;
              ensure(bytes >= 29, 'INVALID_CANDIDATE_SHAPE'); size.decrypted += bytes-29;
            }
          }
          return size;
        }, window => Promise.all(window.map(openProjection)),
        async (raw, opened) => {
          const parts = position(raw), encoded = JSON.stringify(parts);
          ensure(!seen.has(encoded), 'INVALID_CANDIDATE_SHAPE');
          if (previous && !needsDbOrder) {
            const signs = parts.map((value, i) => ['smallint','integer','bigint'].includes(positionColumns[i].getSQLType())
              ? BigInt(value!) < BigInt(previous![i]!) ? -1 : BigInt(value!) > BigInt(previous![i]!) ? 1 : 0
              : compareText(value!, previous![i]!));
            ensure(signs.find(sign => sign !== 0)! > 0, 'INVALID_CANDIDATE_SHAPE');
          }
          const item = Object.fromEntries(Object.entries(opened).filter(([key]) => !key.startsWith('__seal_'))) as PublicRow<R>;
          const size = Number.isFinite(budgets.resultBytes) ? canonical(item).length : 0;
          if (resultBytes+size > budgets.resultBytes) return false;
          resultBytes += size; items.push(item); previous = parts; seen.add(encoded); return true;
        });
      if (rows.length < requestLimit && !state.limited) { exhausted = true; break; }
    }
    if (state.limited && !state.scanned) fail('LIMIT_EXCEEDED');
    return { items, nextCursor: exhausted || !previous ? null : await sealCursor(context, { lastId: JSON.stringify(previous) }, ring) };
  }
  return { where, findMany, count, search };
}

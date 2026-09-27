import { and, asc, desc, eq, gt, lt, getTableColumns, getTableName, sql, SQL, type InferSelectModel } from 'drizzle-orm';
import { PgDialect, type PgColumn, type PgDatabase, type PgTable } from 'drizzle-orm/pg-core';
import { canonical, compareText, hex, identity, utf8 } from '../../../core/bytes.js';
import { databaseError, driverError, ensure, fail } from '../../../core/errors.js';
import { openCursor, sealCursor } from '../../../core/search-cursor.js';
import {
  compileSearch, validateSearch, verifySearch,
  type CompiledSearch, type SearchNode, type SearchOperator,
} from '../../../core/search-predicate.js';
import { profiles, type SearchTokenCache } from '../../../core/search-tokens.js';
import { boundedCandidatePredicate, candidatePredicate } from '../../../core/candidate-sql.js';
import type { Fragment, Node } from '../../../core/sql-fragment.js';
import { Sealed, registrationOf, type Opened, type Registration, type SealMeta } from './native.js';
import { mapRawRow } from './native-mapping.js';

type Db = PgDatabase<any, any, any>;
export interface SearchBudgets { batch?: number; maxCandidates?: number; fetchBytes?: number; decryptedBytes?: number; resultBytes?: number; deadlineMs?: number; decryptConcurrency?: number }
type ResolvedBudgets = Required<SearchBudgets>;
function budgetsFor(counting: boolean, requested?: SearchBudgets): ResolvedBudgets {
  const budgets: ResolvedBudgets = { batch: Infinity, maxCandidates: Infinity,
    fetchBytes: Infinity, decryptedBytes: Infinity, resultBytes: Infinity,
    deadlineMs: Infinity, decryptConcurrency: 64, ...requested };
  for (const value of Object.values(requested ?? {})) ensure(Number.isSafeInteger(value) && value > 0, 'INVALID_VALUE');
  return budgets;
}
// Keep the first request within the 256-row prefix path (decisions 006/014); removing 200 regressed limit-200 OR queries.
function firstPageBatch(limit: number, callerBatch?: number): number {
  return Math.min(callerBatch ?? 200, Math.max(limit + Math.ceil(limit / 4) + 2, 16));
}
type PlainOfSealed<V> = V extends Sealed<infer P, any> ? P : never;
type SearchOfSealed<V> = V extends Sealed<any, infer S> ? S : never;
type ParentOf<C> = C extends SealMeta<infer T, any, any> ? T : never;
type Operation<V> = (SearchOfSealed<V> extends { exact: unknown } ? { eq(value: PlainOfSealed<V>): NativeNode } : {}) &
  (PlainOfSealed<V> extends string ? SearchOfSealed<V> extends { substring: unknown } ? {
    contains(value: string, options?: { respectWords?: boolean }): NativeNode;
    startsWith(value: string): NativeNode; endsWith(value: string): NativeNode; like(value: string): NativeNode;
  } : {} : {});
export type MatchBuilder<T extends PgTable> = {
  [K in keyof InferSelectModel<T> as NonNullable<InferSelectModel<T>[K]> extends Sealed<any, infer S>
    ? S extends false | undefined ? never : K : never]: Operation<NonNullable<InferSelectModel<T>[K]>>;
} & { and(...children: NativeNode[]): NativeNode; or(...children: NativeNode[]): NativeNode; sql(condition: SQL): NativeNode };

export type NativeNode = { op: SearchOperator; field: string; value: unknown; respectWords?: boolean } |
  { op: 'and' | 'or'; children: NativeNode[] } | { op: 'sql'; condition: SQL; flag?: string };
type CompiledNode = { op: 'secure'; search: CompiledSearch } | { op: 'sql'; condition: SQL; flag: string } |
  { op: 'and' | 'or'; children: CompiledNode[] };
type FindOptions<T extends PgTable> = {
  scope?: string; match?: (m: MatchBuilder<T>) => NativeNode; where?: SQL;
  columns?: Partial<Record<keyof InferSelectModel<T>, boolean>>;
  orderBy?: { column: PgColumn; direction: 'asc' | 'desc' } | readonly { column: PgColumn; direction: 'asc' | 'desc' }[];
  limit?: number; cursor?: string | undefined; budgets?: SearchBudgets; signal?: AbortSignal;
};
type CountOptions<T extends PgTable> = Omit<FindOptions<T>, 'columns' | 'orderBy' | 'limit' | 'cursor'> & { maxCandidates?: number };
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
      operations[op] = (value, options) => ({ op, field: key, value, ...(op === 'contains' && options?.respectWords ? { respectWords: true } : {}) });
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
async function compile(node: NativeNode, reg: Registration, scopeId: string, sealer: ReturnType<() => import('../../../core/field-cipher.js').Sealer>, cache: SearchTokenCache, nextFlag: () => string): Promise<CompiledNode> {
  if (plainFree(node)) {
    const core = asCore(node);
    validateSearch(core, reg.definition);
    const stored = [...reg.fields].flatMap(([key, field]) => profiles(reg.model, field.spec.id ?? key, field.spec));
    return { op: 'secure', search: await compileSearch(core, reg.definition, stored, sealer.ring(reg.model), scopeId, cache) };
  }
  if (node.op === 'sql') return { op: 'sql', condition: node.condition, flag: nextFlag() };
  if (node.op === 'and' || node.op === 'or') return { op: node.op, children: await Promise.all(node.children.map(child => compile(child, reg, scopeId, sealer, cache, nextFlag))) };
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
async function verify(node: CompiledNode, row: Record<string, unknown>): Promise<boolean> {
  if (node.op === 'secure') return verifySearch(node.search, key => Promise.resolve(row[key]));
  if (node.op === 'sql') return row[node.flag] === true;
  if (node.op === 'and') { for (const child of node.children) if (!(await verify(child, row))) return false; return true; }
  for (const child of node.children) if (await verify(child, row)) return true;
  return false;
}
function encryptedKeys(node: NativeNode): string[] {
  if (node.op === 'sql') return [];
  if (node.op === 'and' || node.op === 'or') return [...new Set(node.children.flatMap(encryptedKeys))];
  ensure('field' in node, 'INVALID_VALUE');
  return [node.field];
}
function flags(node: CompiledNode): Record<string, SQL | SQL.Aliased> {
  if (node.op === 'sql') return { [node.flag]: sql`coalesce((${node.condition}),false)`.as(node.flag) };
  if (node.op === 'secure') return {};
  return Object.assign({}, ...node.children.map(flags));
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

type AuthCache = Map<string, { bytes: Uint8Array; result: Promise<unknown> }>;
type CandidateState = { scanned: number; fetchedBytes: number; decryptedBytes: number; limited: boolean };
async function scanCandidates<R, P>(rows: R[], remaining: () => number, budgets: SearchBudgets & {
  maxCandidates: number; fetchBytes: number; decryptedBytes: number; decryptConcurrency: number;
}, deadline: number, signal: AbortSignal | undefined, state: CandidateState,
  measure: (row: R) => { fetched: number; decrypted: number },
  openWindow: (window: R[]) => Promise<P[]>, consume: (row: R, opened: P) => Promise<boolean>): Promise<number> {
  let offset = 0, consumed = 0;
  while (offset < rows.length && remaining() > 0 && !state.limited) {
    const window: R[] = [];
    const windowSize = Math.min(budgets.decryptConcurrency, remaining());
    while (offset < rows.length && window.length < windowSize) {
      if (signal?.aborted) fail('CANCELLED');
      if (Date.now() >= deadline || state.scanned + window.length >= budgets.maxCandidates) { state.limited = true; break; }
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
function growBatch(current: number, remaining: number, verified: number, accepted: number): number {
  const estimated = accepted === 0 ? current * 2 : Math.ceil(remaining * verified / accepted * 1.25);
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(current * 2, estimated));
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
  async function run<T extends PgTable>(db: Db, reg: Registration, options: FindOptions<T>, counting: boolean, absoluteDeadline?: number) {
    ensure(options && typeof options === 'object', 'INVALID_VALUE');
    const scopeId = scope(reg, options.scope), columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
    const rowColumn = columns[reg.row], scopeColumn = reg.scope ? columns[reg.scope] : undefined;
    const orders = order(reg, options.orderBy), orderColumn = orders[0]?.column;
    const limit = options.limit ?? Infinity;
    if (options.limit !== undefined) ensure(Number.isSafeInteger(limit) && limit >= 1, 'INVALID_VALUE');
    const budgets = budgetsFor(counting, options.budgets);
    const deadline = absoluteDeadline ?? Date.now() + budgets.deadlineMs;
    const check = () => { if (options.signal?.aborted) fail('CANCELLED'); ensure(Date.now() < deadline, 'LIMIT_EXCEEDED'); };
    check();
    const ast = options.match?.(m<T>(reg));
    if (ast) validate(ast, reg);
    let flagIndex = 0;
    const compiled = ast ? await compile(ast, reg, scopeId, sealerOf(), cache, () => `__seal_flag_${flagIndex++}`) : undefined;
    const selection = options.columns ? Object.keys(options.columns).filter(key => options.columns![key as keyof typeof options.columns]) : Object.keys(columns);
    for (const key of selection) ensure(!!columns[key], 'INVALID_VALUE');
    const projected = [...new Set([reg.row, ...(reg.scope ? [reg.scope] : []), ...selection])];
    const fetched = [...new Set([...projected, ...(ast ? encryptedKeys(ast) : [])])];
    const conditionKeys = ast ? encryptedKeys(ast) : [];
    const selected: Record<string, PgColumn | SQL> = Object.fromEntries(fetched.map(key => [key, columns[key]]));
    orders.forEach(({ column }, index) => { selected[`__seal_sort_${index}`] = sql<string>`to_jsonb(${column}) #>> '{}'`; });
    const flagCols = compiled ? flags(compiled) : {};
    const cursorDigest = await digest({ scopeId, positionEncoding: 'jsonb-v1', match: nodeFingerprint(ast), where: sqlFingerprint(options.where),
      orderBy: orders.map(item => [item.column.name, item.direction]) });
    const ring = sealerOf().ring(reg.model);
    const cursorContext = { modelId: reg.model, scopeId, keyScopeId: ring.keyScopeId, queryDigest: cursorDigest };
    const openedCursor = options.cursor ? await openCursor(options.cursor, cursorContext, ring) : undefined;
    let after = openedCursor?.lastId, afterSort = openedCursor?.lastSort;
    const items: Record<string, unknown>[] = [];
    let scanned = 0, fetchedBytes = 0, decryptedBytes = 0, resultBytes = 0;
    let batch = Number.isFinite(limit) ? firstPageBatch(limit, options.budgets?.batch) : 200;
    let exhausted = false, limited = false;
    while (items.length < limit) {
      if (Date.now() >= deadline || scanned >= budgets.maxCandidates) {
        if (scanned === 0) fail('LIMIT_EXCEEDED');
        limited = true;
        break;
      }
      check();
      const remainingCandidates = budgets.maxCandidates - scanned;
      const requestLimit = Number.isFinite(limit) ? Math.min(batch, remainingCandidates) + (remainingCandidates <= batch ? 1 : 0)
        : counting && Number.isFinite(remainingCandidates) ? remainingCandidates + 1 : Infinity;
      const orderedRow = rowColumn;
      const direction = orders.at(-1)?.direction ?? 'asc';
      const sortValues = afterSort === undefined ? [] : JSON.parse(afterSort) as (string | null)[];
      const afterCondition = after === undefined ? undefined : orders.length
        ? keysetAfter([...orders.map(item => item.column), rowColumn], [...sortValues, after],
          [...orders.map(item => item.direction), direction])
        : direction === 'asc' ? gt(rowColumn, after) : lt(rowColumn, after);
      const hasSql = ast && !plainFree(ast);
      const hasSubstring = (node: CompiledSearch): boolean => node.op === 'leaf' ? node.leaf.profile.mode === 'substring' : node.children.some(hasSubstring);
      const bounded = compiled?.op === 'secure' && hasSubstring(compiled.search) && !options.where && !orderColumn && !hasSql && requestLimit <= 200
        ? { limit: requestLimit, after } : undefined;
      const condition = and(scopeColumn ? eq(scopeColumn, scopeId) : undefined, options.where, afterCondition,
        compiled ? candidate(reg, scopeId, compiled, bounded) : undefined);
      const query = (db as any).select({ ...selected, ...flagCols }).from(reg.parent).where(condition)
        .orderBy(...orders.map(item => item.direction === 'asc' ? asc(item.column) : desc(item.column)),
          direction === 'asc' ? asc(orderedRow) : desc(orderedRow));
      const rows = await (Number.isFinite(requestLimit) ? query.limit(requestLimit) : query);
      ensure(rows.length <= requestLimit, 'INVALID_CANDIDATE_SHAPE');
      if (!rows.length) { exhausted = true; break; }
      const acceptedBefore = items.length;
      const state: CandidateState = { scanned, fetchedBytes, decryptedBytes, limited };
      const consumed = await scanCandidates(rows as Record<string, unknown>[], () => limit - items.length, budgets, deadline, options.signal, state,
        row => {
          identity(row[reg.row] as string, reg.definition.rowType);
          ensure(!reg.scope || row[reg.scope] === scopeId, 'INVALID_CANDIDATE_SHAPE');
          return {
            fetched: Object.values(row).reduce((sum: number, value) => sum + (value instanceof Sealed ? value.bytes.length : typeof value === 'string' ? utf8(value).length : 16), 0),
            decrypted: conditionKeys.reduce((sum, key) => sum + (row[key] instanceof Sealed ? (row[key] as Sealed<unknown>).bytes.length - 29 : 0), 0),
          };
        },
        async window => {
          const conditionPlains = await open(window.map(row => Object.fromEntries(
            [reg.row, ...(reg.scope ? [reg.scope] : []), ...conditionKeys, ...Object.keys(flagCols)].map(key => [key, row[key]]))),
          { scope: scopeId, budgets: { concurrency: budgets.decryptConcurrency } }) as Record<string, unknown>[];
          const matches = await Promise.all(conditionPlains.map(plain => compiled ? verify(compiled, plain) : true));
          const remainingKeys = projected.filter(key => reg.fields.has(key) && !conditionKeys.includes(key));
          const projectionInputs: Record<string, unknown>[] = [], projectionIndexes: number[] = [];
          for (let i = 0; i < window.length; i++) if (matches[i]) {
            const extraBytes = remainingKeys.reduce((sum, key) => sum + (window[i][key] instanceof Sealed ? (window[i][key] as Sealed<unknown>).bytes.length - 29 : 0), 0);
            if (state.decryptedBytes + extraBytes > budgets.decryptedBytes) break;
            state.decryptedBytes += extraBytes;
            projectionInputs.push(Object.fromEntries([reg.row, ...(reg.scope ? [reg.scope] : []), ...remainingKeys].map(key => [key, window[i][key]])));
            projectionIndexes.push(i);
          }
          const projections = projectionInputs.length ? await open(projectionInputs, { scope: scopeId,
            budgets: { concurrency: budgets.decryptConcurrency } }) as Record<string, unknown>[] : [];
          const result = conditionPlains.map((conditionPlain, i) => ({ conditionPlain, matches: matches[i], projectionPlain: undefined as Record<string, unknown> | undefined }));
          projectionIndexes.forEach((index, i) => { result[index].projectionPlain = projections[i]; });
          return result;
        },
        async (row, opened) => {
          const position = identity(row[reg.row] as string, reg.definition.rowType);
          const sort = orders.length ? JSON.stringify(orders.map((_, index) => row[`__seal_sort_${index}`] ?? null)) : undefined;
          ensure(after === undefined || reg.definition.rowType === 'text' || !!orderColumn ||
            (direction === 'asc' ? compareText(position, after) > 0 : compareText(position, after) < 0), 'INVALID_CANDIDATE_SHAPE');
          if (opened.matches) {
            if (!opened.projectionPlain) return false;
            const plain = { ...row, ...opened.conditionPlain, ...opened.projectionPlain };
            const item = Object.fromEntries(projected.map(key => [key, plain[key]]));
            const itemBytes = Number.isFinite(budgets.resultBytes) ? canonical(item).length : 0;
            if (resultBytes + itemBytes > budgets.resultBytes) return false;
            resultBytes += itemBytes;
            items.push(item);
          }
          after = position; afterSort = sort;
          return true;
        });
      ({ scanned, fetchedBytes, decryptedBytes, limited } = state);
      if (limited) {
        if (!scanned) fail('LIMIT_EXCEEDED');
        if (scanned >= budgets.maxCandidates && consumed === rows.length && rows.length < requestLimit) { exhausted = true; limited = false; }
        break;
      }
      if (items.length === limit || rows.length < requestLimit || scanned >= budgets.maxCandidates) {
        exhausted = consumed === rows.length && rows.length < requestLimit;
        limited = scanned >= budgets.maxCandidates && !exhausted; break;
      }
      batch = growBatch(batch, limit - items.length, consumed, items.length - acceptedBefore);
    }
    const nextCursor = exhausted || after === undefined ? null : await sealCursor(cursorContext,
      { lastId: after, ...(afterSort === undefined ? {} : { lastSort: afterSort }) }, ring);
    return { items, nextCursor, scanned, exhausted, limited };
  }

  async function findMany<T extends PgTable, R extends string, S extends string | undefined = undefined, const O extends FindOptions<T> = FindOptions<T>>(
    db: Db, seal: SealMeta<T, R, S> & object, options: O,
  ): Promise<{ items: SelectedRow<T, R, S, O>[]; nextCursor: string | null }> {
    const result = await run<T>(db, registrationOf(seal), options, false);
    return { items: result.items as SelectedRow<T, R, S, O>[], nextCursor: result.nextCursor };
  }
  async function count<T extends PgTable, R extends string, S extends string | undefined = undefined>(
    db: Db, seal: SealMeta<T, R, S> & object, options: CountOptions<T>,
  ): Promise<number> {
    if (options.maxCandidates !== undefined) ensure(Number.isSafeInteger(options.maxCandidates) && options.maxCandidates > 0, 'INVALID_VALUE');
    const page = await run<T>(db, registrationOf(seal), { ...options, columns: {},
      budgets: { ...options.budgets, ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }) } }, true);
    if (page.limited) fail('LIMIT_EXCEEDED');
    return page.items.length;
  }
  type SearchParts = { where: SQL; after: SQL | undefined; orderBy: SQL[]; flags: Record<string, SQL | SQL.Aliased>;
    flagsSql: SQL; limit: number | undefined };
  type SearchOptions<M extends Record<string, object>, R> = {
    scope?: string;
    match: { [K in keyof M]: readonly [M[K], (m: MatchBuilder<ParentOf<M[K]>>) => NativeNode] };
    keyset?: PgColumn[]; columns?: Record<string, Record<string, string>>;
    limit?: number; cursor?: string | undefined; budgets?: SearchBudgets; signal?: AbortSignal;
    query: (parts: SearchParts) => Promise<R[] | { rows: R[] }> | R[] | { rows: R[] };
  };
  type PublicRow<R> = { [K in keyof R as K extends `__seal_${string}` ? never : K]: Opened<R[K]> };
  async function search<const M extends Record<string, object>, R extends Record<string, unknown>>(db: Db, options: SearchOptions<M, R>): Promise<{ items: PublicRow<R>[]; nextCursor: string | null }> {
    ensure(options && options.match && options.query && typeof options.query === 'function', 'INVALID_VALUE');
    const keys = Object.keys(options.match);
    ensure(keys.length > 0, 'INVALID_VALUE');
    const limit = options.limit ?? Infinity;
    if (options.limit !== undefined) ensure(Number.isSafeInteger(limit) && limit >= 1, 'INVALID_VALUE');
    const budgets = budgetsFor(false, options.budgets);
    const deadline = Date.now() + budgets.deadlineMs;
    const regs = Object.fromEntries(keys.map(key => [key, registrationOf(options.match[key][0])])) as Record<string, Registration>;
    ensure(new Set(keys.map(key => regs[key].parent)).size === keys.length, 'INVALID_SCHEMA');
    const scopeId = options.scope ?? '_';
    for (const key of keys) ensure(scope(regs[key], options.scope) === scopeId, 'INVALID_VALUE');
    const asts = Object.fromEntries(keys.map(key => [key, options.match[key][1](m(regs[key]))])) as Record<string, NativeNode>;
    for (const key of keys) validate(asts[key], regs[key]);
    let flagIndex = 0;
    const compiled: Record<string, CompiledNode> = Object.create(null);
    for (const key of keys) compiled[key] = await compile(asts[key], regs[key], scopeId, sealerOf(), cache, () => `__seal_flag_${flagIndex++}`);
    const keyset = options.keyset ?? [];
    const keysetTypes = /^(?:smallint|integer|bigint|numeric(?:\(\d+(?:,\s*\d+)?\))?|decimal(?:\(\d+(?:,\s*\d+)?\))?|text|character varying(?:\(\d+\))?|varchar(?:\(\d+\))?|uuid|date|timestamp(?:\s*\(\d+\))?(?: with(?:out)? time zone)?|boolean)$/;
    const columnTypes = keyset.map(column => {
      ensure(keysetTypes.test(column.getSQLType()), 'INVALID_VALUE');
      return column.getSQLType();
    });
    const positionColumns = [...keys.map(key => (getTableColumns(regs[key].parent) as Record<string, PgColumn>)[regs[key].row]), ...keyset];
    const orderBy = positionColumns.map(column => asc(column));
    const allFlags = Object.assign({}, ...keys.map(key => flags(compiled[key]))) as Record<string, SQL | SQL.Aliased>;
    keyset.forEach((column, index) => { allFlags[`__seal_keyset_${index}`] = sql<string>`to_jsonb(${column}) #>> '{}'`.as(`__seal_keyset_${index}`); });
    const flagsSql = sql.join(Object.entries(allFlags).map(([name, expression]) => sql`${expression instanceof SQL ? expression : expression.sql} as ${sql.identifier(name)}`), sql.raw(','));
    const where = and(...keys.flatMap(key => {
      const reg = regs[key];
      const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
      return [reg.scope ? eq(columns[reg.scope], scopeId) : undefined, candidate(reg, scopeId, compiled[key])];
    }))!;
    const queryDigest = await digest({ scopeId, positionEncoding: 'jsonb-v1', match: keys.map(key => [key, regs[key].model, nodeFingerprint(asts[key])]),
      keyset: keyset.map(column => [getTableName(column.table), column.name]) });
    const firstByName = regs[[...keys].sort()[0]], ring = sealerOf().ring(firstByName.model);
    const cursorContext = { modelId: `search:${JSON.stringify(keys.map(key => regs[key].model).sort())}`, scopeId, keyScopeId: ring.keyScopeId, queryDigest };
    const openedCursor = options.cursor ? await openCursor(options.cursor, cursorContext, ring) : undefined;
    let previous: unknown[] | undefined;
    if (openedCursor) {
      try { previous = JSON.parse(openedCursor.lastId); ensure(Array.isArray(previous) && previous.length === positionColumns.length, 'CURSOR_INVALID'); }
      catch { fail('CURSOR_INVALID'); }
    }
    const positionKey = (parts: unknown[]) => JSON.stringify(parts.map(value => value === null ? null : String(value)));
    const seenPositions = new Set<string>(previous ? [positionKey(previous)] : []);
    const items: PublicRow<R>[] = [];
    const authCache: AuthCache = new Map();
    const conditionKeys = Object.fromEntries(keys.map(key => [key, encryptedKeys(asts[key])])) as Record<string, string[]>;
    const ciphertextBytes = (value: unknown): number => value instanceof Sealed ? value.bytes.length : value instanceof Uint8Array ? value.length
      : typeof value === 'string' && /^\\x(?:[0-9a-f]{2})*$/i.test(value) ? (value.length - 2) / 2 : 0;
    const rawDecryptedBytes = (raw: Record<string, unknown>, conditionOnly: boolean): number => keys.reduce((sum, key) => {
      const mapping = options.columns?.[key];
      if (!mapping) return sum;
      const fields = conditionOnly ? conditionKeys[key] : [...regs[key].fields.keys()].filter(field => !conditionKeys[key].includes(field));
      return sum + fields.reduce((bytes, field) => {
        const name = mapping[field];
        if (!name || raw[name] === null || !Object.hasOwn(raw, name)) return bytes;
        const length = ciphertextBytes(raw[name]);
        ensure(length >= 29, 'INVALID_CANDIDATE_SHAPE');
        return bytes + length - 29;
      }, 0);
    }, 0);
    const openMapped = async (raw: Record<string, unknown>, conditionOnly: boolean) => {
      const view: Record<string, unknown> = conditionOnly ? {} : { ...raw };
      if (conditionOnly) for (const [name, value] of Object.entries(raw))
        if (!value || typeof value !== 'object' || value instanceof Date || value instanceof Uint8Array || name.startsWith('__seal_')) view[name] = value;
      const mapped = new Map<string, { columns: Record<string, string>; fields: string[] }>();
      for (const key of keys) {
        const reg = regs[key], mapping = options.columns?.[key];
        if (mapping) {
          ensure(!!mapping[reg.row] && (!reg.scope || !!mapping[reg.scope]), 'INVALID_VALUE');
          const fields = conditionOnly ? conditionKeys[key] : [...reg.fields.keys()].filter(field => !!mapping[field] && Object.hasOwn(raw, mapping[field]));
          const nested = mapRawRow(reg, raw, mapping, fields, true);
          const viewKey = `__seal_view_${key}`;
          view[viewKey] = nested;
          mapped.set(viewKey, { columns: mapping, fields });
        } else {
          const nested = raw[key] as Record<string, unknown>;
          ensure(nested && typeof nested === 'object' && !Array.isArray(nested), 'INVALID_CANDIDATE_SHAPE');
          for (const field of reg.fields.keys()) if (Object.hasOwn(nested, field)) {
            const value = nested[field];
            ensure(value === null || value instanceof Sealed &&
              value.binding?.registration === reg && value.binding.key === field, 'INVALID_CANDIDATE_SHAPE');
          }
          if (conditionOnly) for (const field of conditionKeys[key]) ensure(Object.hasOwn(nested, field), 'INVALID_CANDIDATE_SHAPE');
          if (conditionOnly) view[key] = Object.fromEntries([reg.row, ...(reg.scope ? [reg.scope] : []), ...conditionKeys[key]]
            .map(field => [field, nested[field]]));
        }
      }
      const opened = await open(view, { scope: scopeId }, authCache) as Record<string, unknown>;
      for (const [viewKey, { columns, fields }] of mapped) {
        const nested = opened[viewKey] as Record<string, unknown>;
        for (const field of fields) opened[columns[field]] = nested[field];
        delete opened[viewKey];
      }
      return opened;
    };
    const openCondition = (raw: Record<string, unknown>) => openMapped(raw, true);
    const openProjection = (raw: Record<string, unknown>) => openMapped(raw, false);
    const matchesCondition = async (opened: Record<string, unknown>) => {
      for (const key of keys) {
        const mapping = options.columns?.[key];
        const row = mapping ? opened : opened[key] as Record<string, unknown>;
        ensure(row && typeof row === 'object', 'INVALID_CANDIDATE_SHAPE');
        const view = mapping ? Object.fromEntries([...regs[key].fields.keys()].map(field => [field, row[mapping[field]]])) : row;
        if (!(await verify(compiled[key], { ...opened, ...view }))) return false;
      }
      return true;
    };
    let scanned = 0, fetchedBytes = 0, decryptedBytes = 0, resultBytes = 0;
    let batch = Number.isFinite(limit) ? firstPageBatch(limit, options.budgets?.batch) : Infinity;
    let exhausted = false, limited = false;
    const compare = (left: unknown, right: unknown, type: string) => ['smallint', 'integer', 'bigint'].includes(type)
      ? BigInt(left as string) < BigInt(right as string) ? -1 : BigInt(left as string) > BigInt(right as string) ? 1 : 0
      : compareText(String(left), String(right));
    const measured = (value: unknown): { fetched: number; decrypted: number } => {
      if (value instanceof Sealed) return { fetched: value.bytes.length, decrypted: value.bytes.length - 29 };
      if (value instanceof Uint8Array) return { fetched: value.length, decrypted: 0 };
      if (typeof value === 'string') return { fetched: utf8(value).length, decrypted: 0 };
      if (value && typeof value === 'object' && !(value instanceof Date))
        return Object.values(value).reduce((sum, part) => { const next = measured(part); return { fetched: sum.fetched + next.fetched, decrypted: sum.decrypted + next.decrypted }; }, { fetched: 0, decrypted: 0 });
      return { fetched: 16, decrypted: 0 };
    };
    while (items.length < limit) {
      if (options.signal?.aborted) fail('CANCELLED');
      if (Date.now() >= deadline || scanned >= budgets.maxCandidates) { if (!scanned) fail('LIMIT_EXCEEDED'); limited = true; break; }
      const requestLimit = Math.min(batch, budgets.maxCandidates - scanned);
      const after = previous ? keysetAfter(positionColumns, previous.map(value => value === null ? null : String(value)),
        positionColumns.map(() => 'asc')) : undefined;
      const returned = await options.query({ where, after, orderBy, flags: allFlags, flagsSql,
        limit: Number.isFinite(requestLimit) ? requestLimit : undefined });
      const rows = Array.isArray(returned) ? returned : returned?.rows;
      ensure(Array.isArray(rows) && rows.length <= requestLimit, 'INVALID_CANDIDATE_SHAPE');
      if (!rows.length) { exhausted = true; break; }
      const needsDbOrder = positionColumns.some(column => !column.notNull || !['uuid', 'smallint', 'integer', 'bigint'].includes(column.getSQLType()));
      if (needsDbOrder) {
        const positions = rows.map(raw => {
          ensure(raw && typeof raw === 'object', 'INVALID_CANDIDATE_SHAPE');
          const parts: (string | null)[] = keys.map(key => {
            const reg = regs[key], mapping = options.columns?.[key];
            const source = mapping ? raw : raw[key] as Record<string, unknown>;
            ensure(source && typeof source === 'object', 'INVALID_CANDIDATE_SHAPE');
            const id = source[mapping ? mapping[reg.row] : reg.row];
            ensure(typeof id === 'string', 'INVALID_CANDIDATE_SHAPE');
            return id;
          });
          keyset.forEach((_, index) => {
            const value = raw[`__seal_keyset_${index}`];
            ensure(value !== undefined, 'INVALID_CANDIDATE_SHAPE');
            parts.push(value === null ? null : String(value));
          });
          return parts;
        });
        await validateTextOrder(db, positionColumns, previous ? [previous, ...positions] : positions, options.signal, deadline);
      }
      const acceptedBefore = items.length;
      const state: CandidateState = { scanned, fetchedBytes, decryptedBytes, limited };
      const consumed = await scanCandidates(rows as Record<string, unknown>[], () => limit - items.length,
        budgets, deadline, options.signal, state,
        raw => { ensure(raw && typeof raw === 'object', 'INVALID_CANDIDATE_SHAPE');
          const size = measured(raw); return { fetched: size.fetched, decrypted: size.decrypted + rawDecryptedBytes(raw, true) }; },
        async window => {
          const conditions = await Promise.all(window.map(openCondition));
          const matches = await Promise.all(conditions.map(matchesCondition));
          const projections = await Promise.all(window.map((raw, i) => {
            if (!matches[i]) return undefined;
            const extraBytes = rawDecryptedBytes(raw, false);
            if (state.decryptedBytes + extraBytes > budgets.decryptedBytes) return undefined;
            state.decryptedBytes += extraBytes;
            return openProjection(raw);
          }));
          return conditions.map((condition, i) => ({ condition, matched: matches[i], full: projections[i] }));
        },
        async (_raw, opened) => {
        const condition = opened.condition;
        const parts: unknown[] = [];
        for (const key of keys) {
          const reg = regs[key], mapping = options.columns?.[key];
          const row = mapping ? condition : condition[key] as Record<string, unknown>;
          ensure(row && typeof row === 'object', 'INVALID_CANDIDATE_SHAPE');
          const get = (field: string) => mapping ? row[mapping[field]] : row[field];
          const rowId = get(reg.row);
          ensure(typeof rowId === 'string' && (!reg.scope || get(reg.scope) === scopeId), 'INVALID_CANDIDATE_SHAPE');
          for (const field of conditionKeys[key]) ensure(get(field) !== undefined, 'INVALID_CANDIDATE_SHAPE');
          parts.push(rowId);
        }
        keyset.forEach((_, index) => { ensure(condition[`__seal_keyset_${index}`] !== undefined, 'INVALID_CANDIDATE_SHAPE'); parts.push(condition[`__seal_keyset_${index}`]); });
        const currentPosition = positionKey(parts);
        ensure(!seenPositions.has(currentPosition), 'INVALID_CANDIDATE_SHAPE');
        seenPositions.add(currentPosition);
        if (previous && !needsDbOrder) {
          const signs = parts.map((value, index) => compare(value, previous![index], index < keys.length ? regs[keys[index]].definition.rowType : columnTypes[index - keys.length]));
          ensure(signs.find(sign => sign !== 0)! > 0, 'INVALID_CANDIDATE_SHAPE');
        }
        if (opened.matched) {
          if (!opened.full) return false;
          const full = Object.fromEntries(Object.entries(opened.full).filter(([key]) => !key.startsWith('__seal_'))) as PublicRow<R>;
          const size = Number.isFinite(budgets.resultBytes) ? canonical(full).length : 0;
          if (resultBytes + size > budgets.resultBytes) return false;
          resultBytes += size;
          items.push(full);
        }
        previous = parts;
        return true;
        });
      ({ scanned, fetchedBytes, decryptedBytes, limited } = state);
      if (limited) { if (!scanned) fail('LIMIT_EXCEEDED'); break; }
      if (items.length === limit || rows.length < requestLimit) { exhausted = items.length < limit && rows.length < requestLimit; break; }
      if (consumed === 0) { if (!scanned) fail('LIMIT_EXCEEDED'); break; }
      batch = growBatch(batch, limit - items.length, consumed, items.length - acceptedBefore);
    }
    const nextCursor = exhausted || !previous ? null : await sealCursor(cursorContext, { lastId: JSON.stringify(previous) }, ring);
    return { items, nextCursor };
  }
  return { findMany, count, search };
}

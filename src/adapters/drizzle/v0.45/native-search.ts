import { and, asc, desc, eq, gt, lt, getTableColumns, getTableName, sql, SQL, type InferSelectModel } from 'drizzle-orm';
import { PgDialect, type PgColumn, type PgDatabase, type PgTable } from 'drizzle-orm/pg-core';
import { canonical, hex, identity, utf8 } from '../../../core/bytes.js';
import { ensure, fail } from '../../../core/errors.js';
import { openCursor, sealCursor } from '../../../core/search-cursor.js';
import {
  compileSearch, validateSearch, verifySearch,
  type CompiledSearch, type SearchNode, type SearchOperator,
} from '../../../core/search-predicate.js';
import { profiles, type SearchTokenCache } from '../../../core/search-tokens.js';
import { candidateStatement } from '../../../core/candidate-sql.js';
import { Sealed, registrationOf, type Opened, type Registration, type SealMeta } from './native.js';

type Db = PgDatabase<any, any, any>;
export interface SearchBudgets { batch?: number; maxCandidates?: number; fetchBytes?: number; decryptedBytes?: number; resultBytes?: number; deadlineMs?: number; decryptConcurrency?: number }
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
  orderBy?: { column: PgColumn; direction: 'asc' | 'desc' };
  limit?: number; cursor?: string; budgets?: SearchBudgets; signal?: AbortSignal;
};
type CountOptions<T extends PgTable> = Omit<FindOptions<T>, 'columns' | 'orderBy' | 'limit' | 'cursor'> & { maxCandidates?: number };

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
  let leaves = 0;
  const visit = (current: NativeNode, depth: number) => {
    ensure(depth <= 8, 'INVALID_VALUE');
    if (current.op === 'and' || current.op === 'or') {
      ensure(current.children.length > 0, 'INVALID_VALUE');
      current.children.forEach(child => visit(child, depth + 1)); return;
    }
    ensure(++leaves <= 8, 'INVALID_VALUE');
    if (current.op === 'sql') return;
    ensure('field' in current, 'INVALID_VALUE');
    const field = reg.fields.get(current.field);
    ensure(field?.spec.search && (current.op === 'eq' ? 'exact' in field.spec.search : 'substring' in field.spec.search), 'UNSUPPORTED_SEARCH');
  };
  visit(node, 1);
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
function fromStatement(statement: { text: string; values: unknown[] }): SQL {
  const chunks: SQL[] = []; let offset = 0;
  for (const match of statement.text.matchAll(/\$([1-9][0-9]*)/g)) {
    chunks.push(sql.raw(statement.text.slice(offset, match.index)));
    const value = statement.values[Number(match[1]) - 1];
    chunks.push(sql`${Array.isArray(value) ? `{${value.join(',')}}` : value}`);
    offset = match.index! + match[0].length;
  }
  chunks.push(sql.raw(statement.text.slice(offset)));
  return sql.join(chunks, sql.raw(''));
}
function candidate(reg: Registration, scopeId: string, node: CompiledNode, bounded?: { limit: number; after?: string }): SQL {
  if (node.op === 'secure') return fromStatement(candidateStatement(reg.definition, reg.storage, scopeId, node.search, bounded));
  if (node.op === 'sql') return node.condition;
  return (node.op === 'and' ? and : (...conditions: (SQL | undefined)[]) => sql.join(conditions.filter(Boolean) as SQL[], sql.raw(' or ')))
    (...node.children.map(child => candidate(reg, scopeId, child)))!;
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
  if (!requested) return undefined;
  const column = requested.column;
  const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
  ensure(Object.values(columns).includes(column) && ![...reg.fields.values()].some(field => field.column === column) && column.notNull &&
    ['integer', 'bigint', 'uuid', 'timestamp with time zone'].includes(column.getSQLType()) && ['asc', 'desc'].includes(requested.direction), 'INVALID_VALUE');
  return column;
}

export function searchMethods(sealerOf: () => import('../../../core/field-cipher.js').Sealer, open: <R>(rows: R, options?: { scope?: string }) => Promise<Opened<R>>,
  openRaw: (seal: object, rows: Record<string, unknown>[], options: { columns: Record<string, string>; scope?: string }) => Promise<Record<string, unknown>[]>, cache: SearchTokenCache) {
  async function run<T extends PgTable>(db: Db, reg: Registration, options: FindOptions<T>, counting: boolean) {
    ensure(options && typeof options === 'object', 'INVALID_VALUE');
    const scopeId = scope(reg, options.scope), columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
    const rowColumn = columns[reg.row], scopeColumn = reg.scope ? columns[reg.scope] : undefined;
    const orderColumn = order(reg, options.orderBy);
    const limit = options.limit ?? 50;
    ensure(Number.isInteger(limit) && limit >= 1 && limit <= (counting ? 2000 : 200), 'INVALID_VALUE');
    const budgets = { batch: counting ? 2000 : 200, maxCandidates: counting ? 20000 : 2000, fetchBytes: 4 * 1024 * 1024,
      decryptedBytes: 4 * 1024 * 1024, resultBytes: 4 * 1024 * 1024, deadlineMs: 2000, decryptConcurrency: 64, ...options.budgets };
    const deadline = Date.now() + budgets.deadlineMs;
    const check = () => { if (options.signal?.aborted) fail('CANCELLED'); ensure(Date.now() < deadline, 'LIMIT_EXCEEDED'); };
    for (const value of Object.values(budgets)) ensure(Number.isSafeInteger(value) && value > 0, 'INVALID_VALUE');
    check();
    const ast = options.match?.(m<T>(reg));
    if (ast) validate(ast, reg);
    let flagIndex = 0;
    const compiled = ast ? await compile(ast, reg, scopeId, sealerOf(), cache, () => `__seal_flag_${flagIndex++}`) : undefined;
    const selection = options.columns ? Object.keys(options.columns).filter(key => options.columns![key as keyof typeof options.columns]) : Object.keys(columns);
    for (const key of selection) ensure(!!columns[key], 'INVALID_VALUE');
    const projected = [...new Set([reg.row, ...(reg.scope ? [reg.scope] : []), ...selection])];
    const fetched = [...new Set([...projected, ...(ast ? encryptedKeys(ast) : [])])];
    const selected = Object.fromEntries(fetched.map(key => [key, columns[key]]));
    const flagCols = compiled ? flags(compiled) : {};
    const cursorDigest = await digest({ scopeId, match: nodeFingerprint(ast), where: sqlFingerprint(options.where),
      selected: projected, orderBy: orderColumn?.name ?? null, direction: options.orderBy?.direction ?? null, limit });
    const ring = sealerOf().ring(reg.model);
    const cursorContext = { modelId: reg.model, scopeId, keyScopeId: ring.keyScopeId, queryDigest: cursorDigest };
    const openedCursor = options.cursor ? await openCursor(options.cursor, cursorContext, ring) : undefined;
    let after = openedCursor?.lastId, afterSort = openedCursor?.lastSort;
    const items: Record<string, unknown>[] = [];
    let scanned = 0, fetchedBytes = 0, decryptedBytes = 0, resultBytes = 0;
    let batch = Math.min(budgets.batch, Math.max(limit + Math.ceil(limit / 4) + 2, 16));
    let verified = 0, accepted = 0, exhausted = false;
    while (items.length < limit) {
      if (Date.now() >= deadline || scanned >= budgets.maxCandidates) {
        if (scanned === 0) fail('LIMIT_EXCEEDED');
        break;
      }
      check();
      const requestLimit = Math.min(batch, budgets.maxCandidates - scanned);
      const sortCol = orderColumn ?? rowColumn;
      const direction = options.orderBy?.direction ?? 'asc';
      const afterCondition = after === undefined ? undefined : orderColumn
        ? sql`(${sortCol},${rowColumn}) ${sql.raw(direction === 'asc' ? '>' : '<')} (${afterSort},${after})`
        : direction === 'asc' ? gt(rowColumn, after) : lt(rowColumn, after);
      const hasSql = ast && !plainFree(ast);
      const hasSubstring = (node: CompiledSearch): boolean => node.op === 'leaf' ? node.leaf.profile.mode === 'substring' : node.children.some(hasSubstring);
      const bounded = compiled?.op === 'secure' && hasSubstring(compiled.search) && !options.where && !orderColumn && !hasSql && requestLimit <= 200
        ? { limit: requestLimit, after } : undefined;
      const condition = and(scopeColumn ? eq(scopeColumn, scopeId) : undefined, options.where, afterCondition,
        compiled ? candidate(reg, scopeId, compiled, bounded) : undefined);
      const rows = await (db as any).select({ ...selected, ...flagCols }).from(reg.parent).where(condition)
        .orderBy(direction === 'asc' ? asc(sortCol) : desc(sortCol), ...(orderColumn ? [direction === 'asc' ? asc(rowColumn) : desc(rowColumn)] : []))
        .limit(requestLimit);
      ensure(rows.length <= requestLimit, 'INVALID_CANDIDATE_SHAPE');
      if (!rows.length) { exhausted = true; break; }
      for (const row of rows as Record<string, unknown>[]) {
        if (Date.now() >= deadline || scanned >= budgets.maxCandidates) break;
        const rowId = identity(row[reg.row] as string, reg.definition.rowType);
        ensure(!reg.scope || row[reg.scope] === scopeId, 'INVALID_CANDIDATE_SHAPE');
        const rawBytes = Object.values(row).reduce((sum: number, value) => sum + (value instanceof Sealed ? value.bytes.length : typeof value === 'string' ? utf8(value).length : 16), 0);
        if (fetchedBytes + rawBytes > budgets.fetchBytes) break;
        fetchedBytes += rawBytes;
        decryptedBytes += Object.values(row).reduce((sum: number, value) => sum + (value instanceof Sealed ? value.bytes.length - 29 : 0), 0);
        if (decryptedBytes > budgets.decryptedBytes) break;
        const plain = await open(row, { scope: scopeId }) as Record<string, unknown>;
        const position = rowId;
        const sort = orderColumn ? String(plain[Object.keys(columns).find(key => columns[key] === orderColumn)!]) : undefined;
        ensure(after === undefined || (direction === 'asc' ? position > after : position < after) || !!orderColumn, 'INVALID_CANDIDATE_SHAPE');
        after = position; afterSort = sort; scanned++; verified++;
        if (!compiled || await verify(compiled, plain)) {
          const item = Object.fromEntries(projected.map(key => [key, plain[key]]));
          const itemBytes = canonical(item).length;
          if (resultBytes + itemBytes > budgets.resultBytes) break;
          resultBytes += itemBytes;
          items.push(item); accepted++;
          if (items.length === limit) break;
        }
      }
      if (items.length === limit || rows.length < requestLimit || scanned >= budgets.maxCandidates) { exhausted = items.length < limit && rows.length < requestLimit; break; }
      const remaining = limit - items.length;
      const estimate = accepted === 0 ? batch * 2 : Math.ceil(remaining * verified / accepted * 1.25);
      batch = Math.min(budgets.batch, Math.max(batch * 2, estimate));
    }
    const nextCursor = exhausted || !after ? null : await sealCursor(cursorContext, { lastId: after, lastSort: afterSort }, ring);
    return { items, nextCursor, scanned, exhausted };
  }

  async function findMany<T extends PgTable, R extends string, S extends string | undefined = undefined>(
    db: Db, seal: SealMeta<T, R, S> & object, options: FindOptions<T>,
  ): Promise<{ items: Opened<InferSelectModel<T>>[]; nextCursor: string | null }> {
    const result = await run<T>(db, registrationOf(seal), options, false);
    return { items: result.items as Opened<InferSelectModel<T>>[], nextCursor: result.nextCursor };
  }
  async function count<T extends PgTable, R extends string, S extends string | undefined = undefined>(
    db: Db, seal: SealMeta<T, R, S> & object, options: CountOptions<T>,
  ): Promise<number> {
    const maxCandidates = options.maxCandidates ?? 20000;
    ensure(Number.isSafeInteger(maxCandidates) && maxCandidates >= 1 && maxCandidates <= 1000000, 'INVALID_VALUE');
    let result = 0, scanned = 0, cursor: string | undefined;
    do {
      const remaining = maxCandidates - scanned;
      if (remaining <= 0) fail('LIMIT_EXCEEDED');
      const page = await run<T>(db, registrationOf(seal), { ...options, columns: {}, limit: 2000, cursor,
        budgets: { ...options.budgets, batch: 2000, maxCandidates: Math.min(remaining, 20000) } }, true);
      result += page.items.length; scanned += page.scanned;
      if (page.exhausted) return result;
      if (!page.nextCursor) fail('LIMIT_EXCEEDED');
      cursor = page.nextCursor;
    } while (true);
  }
  type SearchParts = { where: SQL; after: SQL | undefined; orderBy: SQL[]; flags: Record<string, SQL | SQL.Aliased>;
    flagsSql: SQL; limit: number };
  type SearchOptions<M extends Record<string, object>, R> = {
    scope?: string;
    match: { [K in keyof M]: readonly [M[K], (m: MatchBuilder<ParentOf<M[K]>>) => NativeNode] };
    keyset?: PgColumn[]; columns?: Record<string, Record<string, string>>;
    limit?: number; cursor?: string; budgets?: SearchBudgets; signal?: AbortSignal;
    query: (parts: SearchParts) => Promise<R[] | { rows: R[] }> | R[] | { rows: R[] };
  };
  async function search<const M extends Record<string, object>, R extends Record<string, unknown>>(db: Db, options: SearchOptions<M, R>): Promise<{ items: Opened<R>[]; nextCursor: string | null }> {
    ensure(options && options.match && options.query && typeof options.query === 'function', 'INVALID_VALUE');
    const keys = Object.keys(options.match).sort();
    ensure(keys.length > 0 && keys.length <= 8 && keys.every(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)), 'INVALID_VALUE');
    const limit = options.limit ?? 50;
    ensure(Number.isInteger(limit) && limit >= 1 && limit <= 200, 'INVALID_VALUE');
    const budgets = { batch: 200, maxCandidates: 2000, fetchBytes: 4 * 1024 * 1024, decryptedBytes: 4 * 1024 * 1024,
      resultBytes: 4 * 1024 * 1024, deadlineMs: 2000, decryptConcurrency: 64, ...options.budgets };
    for (const value of Object.values(budgets)) ensure(Number.isSafeInteger(value) && value > 0, 'INVALID_VALUE');
    const deadline = Date.now() + budgets.deadlineMs;
    const regs = Object.fromEntries(keys.map(key => [key, registrationOf(options.match[key][0])])) as Record<string, Registration>;
    ensure(new Set(keys.map(key => regs[key].parent)).size === keys.length, 'INVALID_SCHEMA');
    const scopeId = options.scope ?? '_';
    for (const key of keys) ensure(scope(regs[key], options.scope) === scopeId, 'INVALID_VALUE');
    const asts = Object.fromEntries(keys.map(key => [key, options.match[key][1](m(regs[key]))])) as Record<string, NativeNode>;
    for (const key of keys) validate(asts[key], regs[key]);
    let flagIndex = 0;
    const compiled: Record<string, CompiledNode> = {};
    for (const key of keys) compiled[key] = await compile(asts[key], regs[key], scopeId, sealerOf(), cache, () => `__seal_${key}_flag_${flagIndex++}`);
    const keyset = options.keyset ?? [];
    const columnTypes = keyset.map(column => {
      ensure(column.notNull && ['uuid', 'text COLLATE "C"', 'integer', 'bigint'].includes(column.getSQLType()), 'INVALID_VALUE');
      return column.getSQLType();
    });
    const positionColumns = [...keys.map(key => (getTableColumns(regs[key].parent) as Record<string, PgColumn>)[regs[key].row]), ...keyset];
    const orderBy = positionColumns.map(column => asc(column));
    const allFlags = Object.assign({}, ...keys.map(key => flags(compiled[key]))) as Record<string, SQL | SQL.Aliased>;
    keyset.forEach((column, index) => { allFlags[`__seal_keyset_${index}`] = sql`${column}`.as(`__seal_keyset_${index}`); });
    const flagsSql = sql.join(Object.entries(allFlags).map(([name, expression]) => sql`${expression instanceof SQL ? expression : expression.sql} as ${sql.identifier(name)}`), sql.raw(','));
    const where = and(...keys.map(key => candidate(regs[key], scopeId, compiled[key])))!;
    const queryDigest = await digest({ scopeId, match: keys.map(key => [key, regs[key].model, nodeFingerprint(asts[key])]),
      keyset: keyset.map(column => [getTableName(column.table), column.name]), limit });
    const first = regs[keys[0]], ring = sealerOf().ring(first.model);
    const cursorContext = { modelId: `search:${keys.map(key => regs[key].model).sort().join(',')}`, scopeId, keyScopeId: ring.keyScopeId, queryDigest };
    const openedCursor = options.cursor ? await openCursor(options.cursor, cursorContext, ring) : undefined;
    let previous: unknown[] | undefined;
    if (openedCursor) {
      try { previous = JSON.parse(openedCursor.lastId); ensure(Array.isArray(previous) && previous.length === positionColumns.length, 'CURSOR_INVALID'); }
      catch { fail('CURSOR_INVALID'); }
    }
    const items: Opened<R>[] = [];
    let scanned = 0, fetchedBytes = 0, decryptedBytes = 0, resultBytes = 0;
    let batch = Math.min(budgets.batch, Math.max(limit + Math.ceil(limit / 4) + 2, 16));
    let accepted = 0, exhausted = false;
    const compare = (left: unknown, right: unknown, type: string) => type === 'integer' || type === 'bigint'
      ? BigInt(left as string) < BigInt(right as string) ? -1 : BigInt(left as string) > BigInt(right as string) ? 1 : 0
      : String(left).localeCompare(String(right), 'en');
    while (items.length < limit) {
      if (options.signal?.aborted) fail('CANCELLED');
      if (Date.now() >= deadline || scanned >= budgets.maxCandidates) { if (!scanned) fail('LIMIT_EXCEEDED'); break; }
      const requestLimit = Math.min(batch, budgets.maxCandidates - scanned);
      const after = previous ? sql`(${sql.join(positionColumns.map(column => sql`${column}`), sql.raw(','))}) > (${sql.join(previous.map(value => sql`${value}`), sql.raw(','))})` : undefined;
      const returned = await options.query({ where, after, orderBy, flags: allFlags, flagsSql, limit: requestLimit });
      const rows = Array.isArray(returned) ? returned : returned?.rows;
      ensure(Array.isArray(rows) && rows.length <= requestLimit, 'INVALID_CANDIDATE_SHAPE');
      if (!rows.length) { exhausted = true; break; }
      let consumed = 0;
      for (const raw of rows) {
        if (Date.now() >= deadline || scanned >= budgets.maxCandidates) break;
        ensure(raw && typeof raw === 'object', 'INVALID_CANDIDATE_SHAPE');
        const bytes = Object.values(raw).reduce((sum: number, value) => sum + (value instanceof Sealed ? value.bytes.length : typeof value === 'string' ? utf8(value).length : 16), 0);
        if (fetchedBytes + bytes > budgets.fetchBytes) break;
        fetchedBytes += bytes;
        decryptedBytes += Object.values(raw).reduce((sum: number, value) => sum + (value instanceof Sealed ? value.bytes.length - 29 : 0), 0);
        if (decryptedBytes > budgets.decryptedBytes) break;
        let opened = await open(raw, { scope: scopeId }) as Record<string, unknown>;
        for (const key of keys) if (options.columns?.[key]) opened = (await openRaw(options.match[key][0], [opened], { columns: options.columns[key], scope: scopeId }))[0];
        const parts: unknown[] = [];
        for (const key of keys) {
          const reg = regs[key], mapping = options.columns?.[key];
          const row = mapping ? opened : opened[key] as Record<string, unknown>;
          ensure(row && typeof row === 'object', 'INVALID_CANDIDATE_SHAPE');
          const get = (field: string) => mapping ? row[mapping[field]] : row[field];
          const rowId = get(reg.row);
          ensure(typeof rowId === 'string' && (!reg.scope || get(reg.scope) === scopeId), 'INVALID_CANDIDATE_SHAPE');
          for (const field of encryptedKeys(asts[key])) ensure(get(field) !== undefined, 'INVALID_CANDIDATE_SHAPE');
          parts.push(rowId);
        }
        keyset.forEach((_, index) => { ensure(opened[`__seal_keyset_${index}`] !== undefined, 'INVALID_CANDIDATE_SHAPE'); parts.push(opened[`__seal_keyset_${index}`]); });
        if (previous) {
          const signs = parts.map((value, index) => compare(value, previous![index], index < keys.length ? 'uuid' : columnTypes[index - keys.length]));
          ensure(signs.find(sign => sign !== 0)! > 0, 'INVALID_CANDIDATE_SHAPE');
        }
        previous = parts; scanned++; consumed++;
        let matched = true;
        for (const key of keys) {
          const mapping = options.columns?.[key];
          const row = mapping ? opened : opened[key] as Record<string, unknown>;
          const view = mapping ? Object.fromEntries([...regs[key].fields.keys()].map(field => [field, row[mapping[field]]])) : row;
          if (!(await verify(compiled[key], { ...view, ...opened }))) { matched = false; break; }
        }
        if (matched) {
          const size = canonical(opened).length;
          if (resultBytes + size > budgets.resultBytes) break;
          resultBytes += size;
          items.push(opened as Opened<R>); accepted++;
          if (items.length === limit) break;
        }
      }
      if (items.length === limit || rows.length < requestLimit) { exhausted = items.length < limit && rows.length < requestLimit; break; }
      if (consumed === 0) { if (!scanned) fail('LIMIT_EXCEEDED'); break; }
      const remaining = limit - items.length;
      const estimate = accepted === 0 ? batch * 2 : Math.ceil(remaining * scanned / accepted * 1.25);
      batch = Math.min(budgets.batch, Math.max(batch * 2, estimate));
    }
    const nextCursor = exhausted || !previous ? null : await sealCursor(cursorContext, { lastId: JSON.stringify(previous) }, ring);
    return { items, nextCursor };
  }
  return { findMany, count, search };
}

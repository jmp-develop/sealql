import { and, asc, desc, eq, getTableColumns, is, sql, SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { PgDialect, PgTransaction } from 'drizzle-orm/pg-core';
import { ensure, fail, SealError } from '../../core/errors.js';
import type { SealedPhysicalRow, SealedRowAccessPort, SealedSqlExecutor, SealedStorage } from '../../engine/sealed-types.js';
import type { CompiledSearch } from '../../core/search-predicate.js';
import { PostgresRowAccess } from '../postgres/sealed-row.js';
import type { SealedDefinition } from './sealed-schema.js';

interface BuilderDb {
  insert(table: PgTable): { values(values: Record<string, unknown>): { returning(selection: Record<string, PgColumn>): Promise<Record<string, unknown>[]> } };
  update(table: PgTable): { set(values: Record<string, unknown>): { where(condition: SQL): { returning(selection: Record<string, PgColumn>): Promise<Record<string, unknown>[]> } } };
  delete(table: PgTable): { where(condition: SQL): { returning(selection: Record<string, PgColumn>): Promise<Record<string, unknown>[]> } };
  select(selection: Record<string, PgColumn | SQL>): { from(table: PgTable): { where(condition: SQL): Promise<Record<string, unknown>[]> } };
  execute(fragment: SQL): Promise<unknown>;
  transaction?<T>(fn: (tx: BuilderDb) => Promise<T>, options?: { isolationLevel: 'read committed' }): Promise<T>;
}
export interface DrizzleSealedExecutor extends SealedSqlExecutor { readonly db: BuilderDb }
function sqlStatement(statement: { text: string; values: unknown[] }): SQL {
  const fragments: SQL[] = [];
  let cursor = 0;
  for (const match of statement.text.matchAll(/\$([1-9][0-9]*)/g)) {
    fragments.push(sql.raw(statement.text.slice(cursor, match.index)));
    const value = statement.values[Number(match[1]) - 1];
    ensure(value !== undefined, 'INVALID_VALUE');
    if (Array.isArray(value)) {
      ensure(value.every(item => typeof item === 'string' && (/^-?[0-9]+$/.test(item) || /^[0-9a-f]{64}$/.test(item))), 'INVALID_VALUE');
      fragments.push(sql`${`{${value.join(',')}}`}`);
    } else fragments.push(sql`${value}`);
    cursor = match.index! + match[0].length;
  }
  fragments.push(sql.raw(statement.text.slice(cursor)));
  return sql.join(fragments);
}
export function drizzleExecutor(dbOrTx: PgDatabase<any, any, any>, options?: { transaction?: { isolation: 'read committed' } }): DrizzleSealedExecutor {
  if (is(dbOrTx, PgTransaction)) ensure(options?.transaction?.isolation === 'read committed', 'UNSUPPORTED_DRIVER');
  const db = dbOrTx as unknown as BuilderDb;
  const dialect = new PgDialect();
  ensure(db && typeof db.execute === 'function', 'UNSUPPORTED_DRIVER');
  if (!db.transaction) ensure(options?.transaction?.isolation === 'read committed', 'UNSUPPORTED_DRIVER');
  return {
    db,
    fingerprintWhere(value) { ensure(is(value, SQL), 'INVALID_VALUE'); return dialect.sqlToQuery(value); },
    async query(statement) {
      const result = await db.execute(sqlStatement(statement));
      const rows = Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] }).rows;
      ensure(Array.isArray(rows), 'UNSUPPORTED_DRIVER');
      return { rows, rowCount: (result as { rowCount?: number }).rowCount ?? rows.length };
    },
    async transaction<T>(fn: (tx: SealedSqlExecutor) => Promise<T>): Promise<T> {
      if (options?.transaction) return fn(drizzleExecutor(db as unknown as PgDatabase<any, any, any>, { transaction: { isolation: 'read committed' } }));
      ensure(db.transaction, 'UNSUPPORTED_DRIVER');
      let callbackFinished = false;
      try { return await db.transaction(async tx => { const result = await fn(drizzleExecutor(tx as unknown as PgDatabase<any, any, any>, { transaction: { isolation: 'read committed' } })); callbackFinished = true; return result; }, { isolationLevel: 'read committed' }); }
      catch (error) { if (callbackFinished) throw new SealError('WRITE_OUTCOME_UNKNOWN'); throw error; }
    },
  };
}
const isDrizzle = (executor: SealedSqlExecutor): executor is DrizzleSealedExecutor => 'db' in executor;
export class DrizzleRowAccess implements SealedRowAccessPort {
  readonly columns: Record<string, PgColumn>;
  constructor(readonly definition: SealedDefinition, readonly storage: SealedStorage) { this.columns = getTableColumns(definition.table) as Record<string, PgColumn>; }
  private db(executor: SealedSqlExecutor) { ensure(isDrizzle(executor), 'UNSUPPORTED_DRIVER'); return executor.db; }
  private identity() { const { scope, row, revision } = this.definition.identity; return { scope: this.columns[scope], row: this.columns[row], revision: this.columns[revision] }; }
  private where(scopeId: string, id: string, expectedRevision?: bigint): SQL {
    const identity = this.identity();
    return and(eq(identity.scope, scopeId), eq(identity.row, id), ...(expectedRevision === undefined ? [] : [eq(identity.revision, expectedRevision)]))!;
  }
  async insert(executor: SealedSqlExecutor, args: { scopeId: string; id: string; fields: Record<string, Uint8Array | null>; public: Record<string, unknown> }): Promise<number> {
    const values = { ...args.fields, ...args.public, [this.definition.identity.scope]: args.scopeId, [this.definition.identity.row]: args.id, [this.definition.identity.revision]: 1n };
    return (await this.db(executor).insert(this.definition.table).values(values).returning({ id: this.identity().row })).length;
  }
  async update(executor: SealedSqlExecutor, args: { scopeId: string; id: string; expectedRevision: bigint; fields: Record<string, Uint8Array | null>; public: Record<string, unknown> }): Promise<number> {
    const revision = this.identity().revision;
    const values = { ...args.fields, ...args.public, [this.definition.identity.revision]: sql`${revision}+1` };
    return (await this.db(executor).update(this.definition.table).set(values).where(this.where(args.scopeId, args.id, args.expectedRevision)).returning({ id: this.identity().row })).length;
  }
  async delete(executor: SealedSqlExecutor, args: { scopeId: string; id: string; expectedRevision: bigint }): Promise<number> {
    return (await this.db(executor).delete(this.definition.table).where(this.where(args.scopeId, args.id, args.expectedRevision)).returning({ id: this.identity().row })).length;
  }
  private selection(fields: string[], pub: string[], orderBy?: { field: string; direction: 'asc' | 'desc' }) {
    const identity = this.identity();
    const sort = orderBy ? (() => {
      ensure(this.definition.orderable.includes(orderBy.field), 'INVALID_VALUE');
      const col = this.columns[orderBy.field], type = col.getSQLType();
      if (type === 'timestamp with time zone') return sql<string>`to_char(${col} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
      ensure(['integer', 'bigint', 'uuid'].includes(type), 'INVALID_SCHEMA');
      return sql<string>`${col}::text`;
    })() : undefined;
    return { __seal_scope: identity.scope, __seal_id: identity.row, __seal_revision: identity.revision, ...Object.fromEntries(fields.map(key => [`__seal_f_${key}`, this.columns[key]])), ...Object.fromEntries(pub.map(key => [`__seal_p_${key}`, this.columns[key]])), ...(sort ? { __seal_sort: sort } : {}) };
  }
  private decode(row: Record<string, unknown>, fields: string[], pub: string[]): SealedPhysicalRow {
    ensure(typeof row.__seal_scope === 'string' && typeof row.__seal_id === 'string' && row.__seal_revision !== undefined, 'INVALID_CANDIDATE_SHAPE');
    const sealed: Record<string, Uint8Array | null> = {}, publicValues: Record<string, unknown> = {};
    for (const key of fields) { const value = row[`__seal_f_${key}`]; ensure(value === null || value instanceof Uint8Array, 'INVALID_CANDIDATE_SHAPE'); sealed[key] = value; }
    for (const key of pub) { ensure(Object.hasOwn(row, `__seal_p_${key}`), 'INVALID_CANDIDATE_SHAPE'); publicValues[key] = row[`__seal_p_${key}`]; }
    return { scopeId: row.__seal_scope, id: row.__seal_id, revision: BigInt(row.__seal_revision as string), fields: sealed, public: publicValues, sort: row.__seal_sort === undefined ? undefined : String(row.__seal_sort) };
  }
  async get(executor: SealedSqlExecutor, args: { scopeId: string; id: string; fields: string[]; public: string[]; lock?: 'share' }): Promise<SealedPhysicalRow | null> {
    const query = (this.db(executor) as unknown as PgDatabase<any, any, any>).select(this.selection(args.fields, args.public)).from(this.definition.table).where(this.where(args.scopeId, args.id));
    const rows = await (args.lock ? query.for('share') : query);
    ensure(rows.length <= 1, 'INVALID_CANDIDATE_SHAPE');
    return rows.length ? this.decode(rows[0], args.fields, args.public) : null;
  }
  async candidates(executor: SealedSqlExecutor, args: { scopeId: string; fields: string[]; public: string[]; where?: unknown; after?: { id: string; sort?: string }; orderBy?: { field: string; direction: 'asc' | 'desc' }; limit: number; candidateSql?: { text: string; values: unknown[] } }): Promise<SealedPhysicalRow[]> {
    ensure(args.where === undefined || is(args.where, SQL), 'INVALID_VALUE');
    const db = this.db(executor) as unknown as PgDatabase<any, any, any>;
    const identity = this.identity(), direction = args.orderBy?.direction ?? 'asc';
    const candidate = args.candidateSql ? sqlStatement(args.candidateSql) : undefined;
    let after: SQL | undefined;
    if (args.after) {
      if (args.orderBy) {
        ensure(typeof args.after.sort === 'string', 'CURSOR_INVALID');
        const col = this.columns[args.orderBy.field], type = col.getSQLType();
        const cast = type === 'timestamp with time zone' ? 'timestamptz' : type === 'uuid' ? 'uuid' : type === 'bigint' ? 'bigint' : 'integer';
        after = sql`(${col},${identity.row}) ${sql.raw(direction === 'asc' ? '>' : '<')} (${args.after.sort}::${sql.raw(cast)},${args.after.id})`;
      } else after = sql`${identity.row} ${sql.raw(direction === 'asc' ? '>' : '<')} ${args.after.id}`;
    }
    const condition = and(eq(identity.scope, args.scopeId), candidate, args.where as SQL | undefined, after);
    const orders = args.orderBy ? [direction === 'asc' ? asc(this.columns[args.orderBy.field]) : desc(this.columns[args.orderBy.field]), direction === 'asc' ? asc(identity.row) : desc(identity.row)] : [asc(identity.row)];
    const rows = await db.select(this.selection(args.fields, args.public, args.orderBy)).from(this.definition.table).where(condition).orderBy(...orders).limit(args.limit);
    return rows.map(value => this.decode(value, args.fields, args.public));
  }
  advancedPlan(args: { scopeId: string; fields: string[]; public: string[]; after?: { id: string; sort?: string }; orderBy?: { field: string; direction: 'asc' | 'desc' }; limit: number; candidateSql?: { text: string; values: unknown[] }; candidateSearch?: CompiledSearch }) {
    const identity = this.identity(), direction = args.orderBy?.direction ?? 'asc';
    const candidate = args.candidateSql ? sqlStatement(args.candidateSql) : undefined;
    let after: SQL | undefined;
    if (args.after) {
      if (args.orderBy) {
        ensure(typeof args.after.sort === 'string', 'CURSOR_INVALID');
        const col = this.columns[args.orderBy.field], type = col.getSQLType();
        const cast = type === 'timestamp with time zone' ? 'timestamptz' : type === 'uuid' ? 'uuid' : type === 'bigint' ? 'bigint' : 'integer';
        after = sql`(${col},${identity.row}) ${sql.raw(direction === 'asc' ? '>' : '<')} (${args.after.sort}::${sql.raw(cast)},${args.after.id})`;
      } else after = sql`${identity.row} ${sql.raw(direction === 'asc' ? '>' : '<')} ${args.after.id}`;
    }
    const where = and(eq(identity.scope, args.scopeId), candidate, after)!;
    const orderBy = args.orderBy ? [direction === 'asc' ? asc(this.columns[args.orderBy.field]) : desc(this.columns[args.orderBy.field]), direction === 'asc' ? asc(identity.row) : desc(identity.row)] : [asc(identity.row)];
    const raw = new PostgresRowAccess(this.definition, this.storage).advancedPlan(args);
    return Object.freeze({ batchSize: args.limit, selection: () => this.selection(args.fields, args.public, args.orderBy), where: () => where, orderBy: () => orderBy, sql: raw.sql });
  }
}

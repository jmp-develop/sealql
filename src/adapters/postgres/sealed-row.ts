import { ensure, fail } from '../../core/errors.js';
import { column as ident, Fragment, join, literal, param, pgsql as q, render } from './fragment.js';
import { candidatePredicate, statementFragment } from './search-sql.js';
import type { CompiledSearch } from '../../core/search-predicate.js';
import type { SealedModelDefinition, SealedPhysicalRow, SealedRowAccessPort, SealedSqlExecutor, SealedStorage } from '../../engine/sealed-types.js';

const table = (v: { schema: string; name: string }) => ident(v.schema, v.name);
const bytea = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value.slice();
  if (typeof value === 'string' && /^\\x(?:[0-9a-fA-F]{2})*$/.test(value)) return Uint8Array.from(value.slice(2).match(/../g) ?? [], h => parseInt(h, 16));
  return fail('INVALID_CANDIDATE_SHAPE');
};
export class PostgresRowAccess implements SealedRowAccessPort {
  constructor(readonly definition: SealedModelDefinition, readonly storage: SealedStorage) {}
  private col(key: string, alias?: string): Fragment { const column = this.definition.columns[key]; ensure(column, 'INVALID_SCHEMA'); return alias ? ident(alias, column.name) : ident(column.name); }
  private baseWhere(scopeId: string, id: string, revision?: bigint) {
    const identity = this.definition.identity;
    return q`${this.col(identity.scope)}=${scopeId} and ${this.col(identity.row)}=${id}${revision === undefined ? q`` : q` and ${this.col(identity.revision)}=${revision.toString()}`}`;
  }
  private values(fields: Record<string, Uint8Array | null>, pub: Record<string, unknown>): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...fields, ...pub })) values[this.definition.columns[key].name] = value;
    return values;
  }
  async insert(executor: SealedSqlExecutor, args: { scopeId: string; id: string; fields: Record<string, Uint8Array | null>; public: Record<string, unknown> }): Promise<number> {
    const d = this.definition, values = this.values(args.fields, args.public);
    values[d.columns[d.identity.scope].name] = args.scopeId;
    values[d.columns[d.identity.row].name] = args.id;
    values[d.columns[d.identity.revision].name] = 1n;
    const keys = Object.keys(values);
    const result = await executor.query(render(q`insert into ${table(this.storage.parent)} (${join(keys.map(key => ident(key)), ',')}) values (${join(keys.map(k => param(values[k])), ',')}) returning ${this.col(d.identity.row)}`));
    return result.rows.length;
  }
  async update(executor: SealedSqlExecutor, args: { scopeId: string; id: string; expectedRevision: bigint; fields: Record<string, Uint8Array | null>; public: Record<string, unknown> }): Promise<number> {
    const values = this.values(args.fields, args.public), revision = this.col(this.definition.identity.revision);
    const assignments = [...Object.entries(values).map(([key, value]) => q`${ident(key)}=${value}`), q`${revision}=${revision}+1`];
    const result = await executor.query(render(q`update ${table(this.storage.parent)} set ${join(assignments, ',')} where ${this.baseWhere(args.scopeId, args.id, args.expectedRevision)} returning ${this.col(this.definition.identity.row)}`));
    return result.rows.length;
  }
  async delete(executor: SealedSqlExecutor, args: { scopeId: string; id: string; expectedRevision: bigint }): Promise<number> {
    const result = await executor.query(render(q`delete from ${table(this.storage.parent)} where ${this.baseWhere(args.scopeId, args.id, args.expectedRevision)} returning ${this.col(this.definition.identity.row)}`));
    return result.rows.length;
  }
  private projection(fields: string[], pub: string[], orderBy?: { field: string; direction: 'asc' | 'desc' }, alias?: string): Fragment {
    const d = this.definition, identity = d.identity;
    return join([
      q`${this.col(identity.scope, alias)} as ${ident('__seal_scope')}`,
      q`${this.col(identity.row, alias)} as ${ident('__seal_id')}`,
      q`${this.col(identity.revision, alias)} as ${ident('__seal_revision')}`,
      ...fields.map(key => q`${this.col(key, alias)} as ${ident(`__seal_f_${key}`)}`),
      ...pub.map(key => q`${this.col(key, alias)} as ${ident(`__seal_p_${key}`)}`),
      ...(orderBy ? [q`${this.sortText(orderBy.field, alias)} as ${ident('__seal_sort')}`] : []),
    ], ',');
  }
  private sortText(key: string, alias?: string): Fragment {
    ensure(this.definition.orderable.includes(key), 'INVALID_VALUE');
    const type = this.definition.columns[key].getSQLType(), column = this.col(key, alias);
    if (type === 'timestamp with time zone') return q`to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    ensure(['integer', 'bigint', 'uuid'].includes(type), 'INVALID_SCHEMA');
    return q`${column}::text`;
  }
  private decode(row: Record<string, unknown>, fields: string[], pub: string[]): SealedPhysicalRow {
    ensure(typeof row.__seal_scope === 'string' && typeof row.__seal_id === 'string' && row.__seal_revision !== undefined, 'INVALID_CANDIDATE_SHAPE');
    const sealed: Record<string, Uint8Array | null> = {}, publicValues: Record<string, unknown> = {};
    for (const key of fields) { const value = row[`__seal_f_${key}`]; ensure(value !== undefined, 'INVALID_CANDIDATE_SHAPE'); sealed[key] = value === null ? null : bytea(value); }
    for (const key of pub) { ensure(Object.hasOwn(row, `__seal_p_${key}`), 'INVALID_CANDIDATE_SHAPE'); publicValues[key] = row[`__seal_p_${key}`]; }
    return { scopeId: row.__seal_scope, id: row.__seal_id, revision: BigInt(row.__seal_revision as string), fields: sealed, public: publicValues, sort: row.__seal_sort === undefined ? undefined : String(row.__seal_sort) };
  }
  async get(executor: SealedSqlExecutor, args: { scopeId: string; id: string; fields: string[]; public: string[]; lock?: 'share' }): Promise<SealedPhysicalRow | null> {
    const rows = (await executor.query(render(q`select ${this.projection(args.fields, args.public)} from ${table(this.storage.parent)} where ${this.baseWhere(args.scopeId, args.id)}${args.lock ? literal(' for share') : q``}`))).rows;
    ensure(rows.length <= 1, 'INVALID_CANDIDATE_SHAPE');
    return rows.length ? this.decode(rows[0], args.fields, args.public) : null;
  }
  async candidates(executor: SealedSqlExecutor, args: { scopeId: string; fields: string[]; public: string[]; where?: unknown; after?: { id: string; sort?: string }; orderBy?: { field: string; direction: 'asc' | 'desc' }; limit: number; candidateSql?: { text: string; values: unknown[] } }): Promise<SealedPhysicalRow[]> {
    ensure(args.where === undefined || args.where instanceof Fragment, 'INVALID_VALUE');
    const row = this.col(this.definition.identity.row);
    const order = args.orderBy;
    const direction = order?.direction ?? 'asc';
    const op = direction === 'asc' ? '>' : '<';
    const keyset = args.after ? order ? (() => {
      ensure(args.after?.sort !== undefined, 'CURSOR_INVALID');
      const sortType = this.definition.columns[order.field].getSQLType();
      const cast = sortType === 'timestamp with time zone' ? 'timestamptz' : sortType === 'uuid' ? 'uuid' : sortType === 'bigint' ? 'bigint' : 'integer';
      return q` and (${this.col(order.field)},${row}) ${literal(op)} (${args.after.sort}::${literal(cast)},${args.after.id})`;
    })() : q` and ${row} ${literal(op)} ${args.after.id}` : q``;
    const candidate = args.candidateSql ? q` and (${statementFragment(args.candidateSql)})` : q``;
    const publicWhere = args.where ? q` and (${args.where as Fragment})` : q``;
    const rows = (await executor.query(render(q`select ${this.projection(args.fields, args.public, order)} from ${table(this.storage.parent)} where ${this.col(this.definition.identity.scope)}=${args.scopeId}${candidate}${publicWhere}${keyset} order by ${order ? q`${this.col(order.field)} ${literal(direction)},` : q``}${row} ${literal(direction)} limit ${args.limit}`))).rows;
    return rows.map(value => this.decode(value, args.fields, args.public));
  }
  advancedPlan(args: { scopeId: string; fields: string[]; public: string[]; after?: { id: string; sort?: string }; orderBy?: { field: string; direction: 'asc' | 'desc' }; limit: number; candidateSql?: { text: string; values: unknown[] }; candidateSearch?: CompiledSearch }) {
    const build = (alias?: string) => {
      if (alias !== undefined) ensure(/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) && alias.length <= 63, 'INVALID_VALUE');
      const row = this.col(this.definition.identity.row, alias), scope = this.col(this.definition.identity.scope, alias);
      const candidate = args.candidateSearch ? q` and (${candidatePredicate(this.definition, this.storage, args.scopeId, args.candidateSearch, alias)})` : q``;
      const order = args.orderBy, direction = order?.direction ?? 'asc', op = direction === 'asc' ? '>' : '<';
      const after = args.after ? order ? (() => {
        ensure(args.after?.sort !== undefined, 'CURSOR_INVALID');
        const type = this.definition.columns[order.field].getSQLType();
        const cast = type === 'timestamp with time zone' ? 'timestamptz' : type === 'uuid' ? 'uuid' : type === 'bigint' ? 'bigint' : 'integer';
        return q` and (${this.col(order.field, alias)},${row}) ${literal(op)} (${args.after.sort}::${literal(cast)},${args.after.id})`;
      })() : q` and ${row} ${literal(op)} ${args.after.id}` : q``;
      return {
        selection: this.projection(args.fields, args.public, order, alias),
        where: q`${scope}=${args.scopeId}${candidate}${after}`,
        orderBy: q`${order ? q`${this.col(order.field, alias)} ${literal(direction)},` : q``}${row} ${literal(direction)}`,
        limit: q`${args.limit}`,
        decodeRows: (rows: readonly Record<string, unknown>[]) => rows.map(row => ({ sealed: row, extra: Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('__seal_'))) })),
      };
    };
    return Object.freeze({ batchSize: args.limit, selection: () => build().selection, where: () => build().where, orderBy: () => [build().orderBy], sql: (options?: { alias?: string }) => build(options?.alias) });
  }
}
export function postgresExecutor(options: SealedSqlExecutor): SealedSqlExecutor { ensure(options && typeof options.query === 'function' && typeof options.transaction === 'function', 'UNSUPPORTED_DRIVER'); return { ...options, fingerprintWhere: value => { ensure(value instanceof Fragment, 'INVALID_VALUE'); return render(value); } }; }

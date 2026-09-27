import { and, eq, getTableColumns, sql, type InferSelectModel } from 'drizzle-orm';
import type { PgColumn, PgDatabase, PgTable } from 'drizzle-orm/pg-core';
import { identity, unhex, utf8 } from '../../../core/bytes.js';
import { databaseError, ensure, fail, SealError } from '../../../core/errors.js';
import { envelopeShape, type Sealer } from '../../../core/field-cipher.js';
import { profiles, searchPieces, searchTokens, type SearchTokenCache } from '../../../core/search-tokens.js';
import { Sealed, registrationOf, type Opened, type PlainShape, type Registration, type SealMeta } from './native.js';
import { searchMethods } from './native-search.js';

type Db = PgDatabase<any, any, any>;
type Identity<T extends PgTable, R extends string, S extends string | undefined> =
  Pick<InferSelectModel<T>, Extract<R | Exclude<S, undefined>, keyof InferSelectModel<T>>>;
type InsertRow<T extends PgTable, R extends string> = Omit<PlainShape<T>, R> & Partial<Pick<PlainShape<T>, Extract<R, keyof PlainShape<T>>>>;
type Patch<T extends PgTable, R extends string, S extends string | undefined> = Partial<Omit<PlainShape<T>, R | Exclude<S, undefined>>>;
type Result<T extends PgTable, R extends string, S extends string | undefined, O> = O extends { returning: true }
  ? Opened<InferSelectModel<T>>[] : Identity<T, R, S>[];
export interface OpenOptions { scope?: string; budgets?: { maxRows?: number; maxBytes?: number; deadlineMs?: number; concurrency?: number } }

function asRecord(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_VALUE');
  return value as Record<string, unknown>;
}
function context(reg: Registration, scopeId: string, rowId: string, fieldKey: string, sealer: Sealer) {
  const spec = reg.fields.get(fieldKey)?.spec ?? fail('INVALID_SCHEMA');
  return { modelId: reg.model, fieldId: spec.id ?? fieldKey, keyScopeId: sealer.keyScopeId(reg.model), scopeId, rowId, spec };
}
function rowIdentity(reg: Registration, source: Record<string, unknown>, fill: boolean): { rowId: string; scopeId: string } {
  const rawId = source[reg.row];
  if (rawId === undefined && fill) {
    ensure(reg.definition.rowType === 'uuid', 'INVALID_VALUE');
    source[reg.row] = crypto.randomUUID();
  }
  const rowId = identity(source[reg.row] as string, reg.definition.rowType);
  const scopeId = reg.scope ? identity(source[reg.scope] as string, reg.definition.scopeType) : '_';
  return { rowId, scopeId };
}
interface Prepared { parent: Record<string, unknown>; index: Record<string, unknown>; identity: Record<string, unknown>; sealed: Sealed<unknown, unknown>[] }

async function prepare(reg: Registration, source: Record<string, unknown>, sealer: Sealer, cache: SearchTokenCache, fillId: boolean): Promise<Prepared> {
  const parent: Record<string, unknown> = { ...source };
  const { rowId, scopeId } = rowIdentity(reg, parent, fillId);
  const identityValue = { [reg.row]: rowId, ...(reg.scope ? { [reg.scope]: scopeId } : {}) };
  const index: Record<string, unknown> = { scopeId, rowId };
  const sealed: Sealed<unknown, unknown>[] = [];
  const ring = sealer.ring(reg.model);
  for (const [key, value] of Object.entries(parent)) {
    const field = reg.fields.get(key);
    if (!field) continue;
    ensure(value !== undefined || !field.column.notNull, 'INVALID_VALUE');
    if (value === undefined) { delete parent[key]; continue; }
    if (value === null) ensure(!field.column.notNull, 'INVALID_VALUE');
    if (value !== null) {
      const bytes = await sealer.seal(value, context(reg, scopeId, rowId, key, sealer), ring);
      const handle = Sealed.forWrite(bytes, field);
      parent[key] = handle;
      sealed.push(handle);
    }
    for (const profile of profiles(reg.model, field.spec.id ?? key, field.spec)) {
      const tokens = value === null ? [] : await searchTokens(ring, scopeId, profile, searchPieces(profile, value), cache);
      const column = reg.storage.index?.profiles?.[profile.indexId]?.tokens ?? fail('INVALID_SCHEMA');
      index[column] = tokens.length ? tokens.map(BigInt) : null;
    }
  }
  return { parent, index, identity: identityValue, sealed };
}

function release(prepared: readonly Prepared[]) { for (const row of prepared) for (const handle of row.sealed) Sealed.releaseWrite(handle); }
function checkedDb(db: Db): any {
  ensure(db && typeof db.transaction === 'function', 'UNSUPPORTED_DRIVER');
  return db;
}
function checkedValues(reg: Registration, source: Record<string, unknown>, mode: 'insert' | 'update' | 'upsert'): void {
  const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
  for (const [key, value] of Object.entries(source)) {
    ensure(Object.hasOwn(columns, key) && value !== undefined, 'INVALID_VALUE');
    if (mode === 'update') ensure(key !== reg.row && key !== reg.scope, 'INVALID_VALUE');
  }
  ensure(mode !== 'update' || Object.keys(source).length > 0, 'INVALID_VALUE');
}
function whereIdentity(reg: Registration, value: Record<string, unknown>) {
  const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
  const { rowId, scopeId } = rowIdentity(reg, value, false);
  return and(eq(columns[reg.row], rowId), reg.scope ? eq(columns[reg.scope], scopeId) : undefined);
}
function indexValues(reg: Registration, row: Prepared): Record<string, unknown> {
  const columns = getTableColumns(reg.index) as Record<string, PgColumn>;
  return Object.fromEntries(Object.entries(row.index).filter(([key]) => !!columns[key]));
}
async function upsertIndexes(tx: any, reg: Registration, rows: readonly Prepared[], onlyChanged: boolean) {
  const cols = getTableColumns(reg.index) as Record<string, PgColumn>;
  const values = rows.map(row => indexValues(reg, row));
  if (!values.length) return;
  if (!onlyChanged) { await tx.insert(reg.index).values(values); return; }
  for (const value of values) {
    const changed = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'scopeId' && key !== 'rowId'));
    if (!Object.keys(changed).length) continue;
    await tx.insert(reg.index).values(value).onConflictDoUpdate({ target: [cols.scopeId, cols.rowId], set: changed });
  }
}

export function runtimeMethods(sealerOf: () => Sealer) {
  const cache: SearchTokenCache = { profiles: new Map() };
  async function open<R>(rows: R, options: OpenOptions = {}): Promise<Opened<R>> {
    const budget = { maxRows: 500, maxBytes: 4 * 1024 * 1024, deadlineMs: 2000, concurrency: 64, ...options.budgets };
    for (const value of Object.values(budget)) ensure(Number.isSafeInteger(value) && value > 0, 'INVALID_VALUE');
    const deadline = Date.now() + budget.deadlineMs;
    let count = 0, bytes = 0;
    const jobs: { target: Record<string, unknown>; key: string; value: Sealed<unknown, unknown>; rowId: string; scopeId: string }[] = [];
    const walk = (value: unknown): unknown => {
      ensure(Date.now() < deadline, 'LIMIT_EXCEEDED');
      if (Array.isArray(value)) return value.map(walk);
      if (value === null || typeof value !== 'object' || value instanceof Date || value instanceof Uint8Array) return value;
      if (value instanceof Sealed) fail('ROW_CONTEXT_MISSING');
      const original = value as Record<string, unknown>, copy: Record<string, unknown> = {};
      let hasSealed = false;
      for (const [key, part] of Object.entries(original)) {
        if (!(part instanceof Sealed)) { copy[key] = walk(part); continue; }
        const field = part.binding ?? fail('ROW_CONTEXT_MISSING');
        const reg = field.registration;
        ensure(Object.hasOwn(original, reg.row) && (!reg.scope || Object.hasOwn(original, reg.scope)), 'ROW_CONTEXT_MISSING');
        const rowId = identity(original[reg.row] as string, reg.definition.rowType);
        const scopeId = reg.scope ? identity(original[reg.scope] as string, reg.definition.scopeType) : '_';
        if (options.scope !== undefined) ensure(scopeId === options.scope, 'SCOPE_MISMATCH');
        bytes += part.bytes.length;
        ensure(bytes <= budget.maxBytes, 'LIMIT_EXCEEDED');
        jobs.push({ target: copy, key, value: part, rowId, scopeId });
        hasSealed = true;
      }
      if (hasSealed) ensure(++count <= budget.maxRows, 'LIMIT_EXCEEDED');
      return copy;
    };
    const result = walk(rows);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(budget.concurrency, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        ensure(Date.now() < deadline, 'LIMIT_EXCEEDED');
        const job = jobs[cursor++], field = job.value.binding!;
        const reg = field.registration, sealer = sealerOf();
        job.target[job.key] = await sealer.open(job.value.bytes, context(reg, job.scopeId, job.rowId, field.key, sealer), sealer.ring(reg.model));
      }
    }));
    return result as Opened<R>;
  }

  async function insert<T extends PgTable, R extends string, S extends string | undefined = undefined, O extends { returning?: boolean } = {}>(
    db: Db, seal: SealMeta<T, R, S> & object, rows: InsertRow<T, R> | InsertRow<T, R>[], options?: O,
  ): Promise<Result<T, R, S, O>> {
    const reg = registrationOf(seal), arr = Array.isArray(rows) ? rows : [rows];
    ensure(arr.length > 0, 'INVALID_VALUE'); ensure(arr.length <= 1000, 'LIMIT_EXCEEDED');
    const sealer = sealerOf();
    const prepared: Prepared[] = [];
    try {
      for (const row of arr) { const input = asRecord(row); checkedValues(reg, input, 'insert'); prepared.push(await prepare(reg, input, sealer, cache, true)); }
      const dbValue = checkedDb(db);
      const inserted = await dbValue.transaction(async (tx: any) => {
        const result = await tx.insert(reg.parent).values(prepared.map(row => row.parent)).returning();
        await upsertIndexes(tx, reg, prepared, false);
        return result;
      });
      return (options?.returning ? await open(inserted) : prepared.map(row => row.identity)) as Result<T, R, S, O>;
    } catch (error) { if (error instanceof SealError) throw error; throw databaseError(error); }
    finally { release(prepared); }
  }

  async function update<T extends PgTable, R extends string, S extends string | undefined = undefined, O extends { returning?: boolean } = {}>(
    db: Db, seal: SealMeta<T, R, S> & object, at: Identity<T, R, S>, patch: Patch<T, R, S>, options?: O,
  ): Promise<Result<T, R, S, O>> {
    const reg = registrationOf(seal), input = asRecord(patch);
    checkedValues(reg, input, 'update');
    const where = whereIdentity(reg, asRecord(at));
    const sealer = sealerOf(), prepared: Prepared[] = [];
    try {
      prepared.push(await prepare(reg, { ...at, ...input }, sealer, cache, false));
      const changed = Object.fromEntries(Object.entries(prepared[0].parent).filter(([key]) => key !== reg.row && key !== reg.scope));
      const result = await checkedDb(db).transaction(async (tx: any) => {
        const found = await tx.update(reg.parent).set(changed).where(where).returning();
        if (!found.length) fail('NOT_FOUND');
        await upsertIndexes(tx, reg, prepared, true);
        return found;
      });
      return (options?.returning ? await open(result) : prepared.map(row => row.identity)) as Result<T, R, S, O>;
    } catch (error) { if (error instanceof SealError) throw error; throw databaseError(error); }
    finally { release(prepared); }
  }

  async function upsert<T extends PgTable, R extends string, S extends string | undefined = undefined, O extends { returning?: boolean } = {}>(
    db: Db, seal: SealMeta<T, R, S> & object, row: InsertRow<T, R>, options?: O,
  ): Promise<Result<T, R, S, O>> {
    const reg = registrationOf(seal), input = asRecord(row);
    checkedValues(reg, input, 'upsert');
    const sealer = sealerOf(), prepared: Prepared[] = [];
    try {
      prepared.push(await prepare(reg, input, sealer, cache, true));
      const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
      const target = reg.rowUnique ? [columns[reg.row]] : [columns[reg.scope!], columns[reg.row]];
      const changed = Object.fromEntries(Object.entries(prepared[0].parent).filter(([key]) => key !== reg.row && key !== reg.scope));
      const setWhere = reg.scope && reg.rowUnique ? eq(columns[reg.scope], sql.raw(`excluded."${columns[reg.scope].name}"`)) : undefined;
      const result = await checkedDb(db).transaction(async (tx: any) => {
        const found = await tx.insert(reg.parent).values(prepared[0].parent)
          .onConflictDoUpdate({ target, set: changed, setWhere }).returning();
        if (!found.length) fail('SCOPE_CONFLICT');
        await upsertIndexes(tx, reg, prepared, true);
        return found;
      });
      return (options?.returning ? await open(result) : prepared.map(row => row.identity)) as Result<T, R, S, O>;
    } catch (error) { if (error instanceof SealError) throw error; throw databaseError(error); }
    finally { release(prepared); }
  }

  async function openRaw<T extends PgTable, R extends string, S extends string | undefined, V extends Record<string, unknown>>(
    seal: SealMeta<T, R, S> & object, rows: V[] | { rows: V[] }, options: { columns: Record<string, string>; scope?: string; budgets?: OpenOptions['budgets'] },
  ): Promise<V[]> {
    const reg = registrationOf(seal), columns = options.columns;
    ensure(!!columns[reg.row] && (!reg.scope || !!columns[reg.scope]), 'INVALID_VALUE');
    const source = Array.isArray(rows) ? rows : rows.rows;
    ensure(Array.isArray(source), 'INVALID_VALUE');
    const mapped = source.map(row => {
      const contextRow: Record<string, unknown> = { [reg.row]: row[columns[reg.row]], ...(reg.scope ? { [reg.scope]: row[columns[reg.scope]] } : {}) };
      for (const [key, field] of reg.fields) {
        const rawKey = columns[key];
        if (!rawKey || !Object.hasOwn(row, rawKey)) continue;
        const value = row[rawKey];
        contextRow[key] = value === null ? null : Sealed.fromDriver(value, field);
      }
      return contextRow;
    });
    const opened = await open(mapped, options);
    return source.map((row, i) => {
      const output: Record<string, unknown> = { ...row };
      for (const key of reg.fields.keys()) if (columns[key] && Object.hasOwn(opened[i], key)) output[columns[key]] = opened[i][key];
      return output as V;
    });
  }
  return { insert, update, upsert, open, openRaw, ...searchMethods(sealerOf, open, openRaw as any, cache) };
}

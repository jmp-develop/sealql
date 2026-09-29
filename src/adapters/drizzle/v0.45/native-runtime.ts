import { and, eq, gt, getTableColumns, is, sql, type InferSelectModel } from 'drizzle-orm';
import { PgTransaction, type PgColumn, type PgDatabase, type PgTable } from 'drizzle-orm/pg-core';
import { identity } from '../../../core/bytes.js';
import { databaseError, ensure, fail, SealError, unsupportedTransaction } from '../../../core/errors.js';
import type { Sealer } from '../../../core/field-cipher.js';
import { profiles, searchPieces, searchTokens, type SearchTokenCache } from '../../../core/search-tokens.js';
import { exactProof, positionProof } from '../../../core/search-stamps.js';
import { profileColumns, type ProfileStorage } from '../../../core/sealed-model.js';
import { Sealed, registrationOf, type Opened, type PlainShape, type Registration, type SealMeta } from './native.js';
import { mapRawRow } from './native-mapping.js';
import { searchMethods } from './native-search.js';

type AuthCache = Map<string, { bytes: Uint8Array; result: Promise<unknown> }>;

type Db = PgDatabase<any, any, any>;
type Identity<T extends PgTable, R extends string, S extends string | undefined> =
  Pick<InferSelectModel<T>, Extract<R | Exclude<S, undefined>, keyof InferSelectModel<T>>>;
type InsertRow<T extends PgTable, R extends string> = Omit<PlainShape<T>, R> & Partial<PlainShape<T>>;
type Patch<T extends PgTable, R extends string, S extends string | undefined> = {
  [K in keyof Omit<PlainShape<T>, R | Exclude<S, undefined>>]?: PlainShape<T>[K] | undefined;
};
type Result<T extends PgTable, R extends string, S extends string | undefined, O> = O extends { returning: true }
  ? Opened<InferSelectModel<T>>[] : Identity<T, R, S>[];
export interface OpenOptions { scope?: string; budgets?: { maxRows?: number; maxBytes?: number; deadlineMs?: number; concurrency?: number } | undefined }

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

async function proofValues(sealer: Sealer, scope: string, profile: ReturnType<typeof profiles>[number], stored: ProfileStorage, value: unknown): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  if (value === null) return Object.fromEntries(profileColumns(stored).filter(name => name !== stored.tokens).map(name => [name, null]));
  const ring = sealer.ring(profile.modelId);
  if (stored.exact) {
    const proof = await exactProof(ring, profile, scope, value);
    result[stored.exact.salt] = proof.salt; result[stored.exact.stamp] = proof.stamp;
  }
  for (const [group, stream] of [[stored.positions, 'compact2'], [stored.words, 'words2'], [stored.singles, 'single1']] as const) if (group) {
    const proof = await positionProof(ring, profile, scope, value as string, stream);
    result[group.salt] = proof.salt; result[group.length] = proof.length;
    result[group.stamps] = proof.stamps; result[group.offsets] = proof.offsets;
  }
  return result;
}

async function prepare(reg: Registration, source: Record<string, unknown>, sealer: Sealer, cache: SearchTokenCache, fillId: boolean, fillFields: boolean): Promise<Prepared> {
  const parent: Record<string, unknown> = { ...source };
  if (fillFields) for (const [key, field] of reg.fields) if (parent[key] === undefined) {
    ensure(!field.column.notNull, 'INVALID_VALUE');
    parent[key] = null;
  }
  const { rowId, scopeId } = rowIdentity(reg, parent, fillId);
  const identityValue = { [reg.row]: rowId, ...(reg.scope ? { [reg.scope]: scopeId } : {}) };
  const index: Record<string, unknown> = { scopeId, rowId };
  const sealed: Sealed<unknown, unknown>[] = [];
  const ring = sealer.ring(reg.model);
  for (const [key, value] of Object.entries(parent)) {
    const field = reg.fields.get(key);
    if (!field) continue;
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
      Object.assign(index, await proofValues(sealer, scopeId, profile, reg.storage.index!.profiles![profile.indexId], value));
    }
  }
  return { parent, index, identity: identityValue, sealed };
}

function release(prepared: readonly Prepared[]) { for (const row of prepared) for (const handle of row.sealed) Sealed.releaseWrite(handle); }
function checkedDb(db: Db): any {
  ensure(db && typeof db.transaction === 'function', 'UNSUPPORTED_DRIVER');
  return db;
}
async function writeTransaction<T>(db: Db, callback: (tx: any) => Promise<T>): Promise<T> {
  let callbackEntered = false, callbackDone = false;
  try {
    return await checkedDb(db).transaction(async (tx: any) => {
      callbackEntered = true;
      const value = await callback(tx);
      callbackDone = true;
      return value;
    });
  } catch (error) {
    if (!callbackEntered && unsupportedTransaction(error)) fail('UNSUPPORTED_DRIVER');
    if (callbackDone && !is(db, PgTransaction)) fail('WRITE_OUTCOME_UNKNOWN');
    throw error;
  }
}
function checkedValues(reg: Registration, source: Record<string, unknown>, mode: 'insert' | 'update' | 'upsert'): Record<string, unknown> {
  const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    ensure(Object.hasOwn(columns, key), 'INVALID_VALUE');
    if (value === undefined) continue;
    if (mode === 'update') ensure(key !== reg.row && key !== reg.scope, 'INVALID_VALUE');
    values[key] = value;
  }
  ensure(mode !== 'update' || Object.keys(values).length > 0, 'INVALID_VALUE');
  return values;
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
function parameterChunks<T>(rows: readonly T[], width: (row: T) => number): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [], used = 0;
  for (const row of rows) {
    const count = width(row);
    ensure(count <= 65535, 'INVALID_SCHEMA');
    if (chunk.length && used + count > 60000) { chunks.push(chunk); chunk = []; used = 0; }
    chunk.push(row); used += count;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
async function upsertIndexes(tx: any, reg: Registration, rows: readonly Prepared[], onlyChanged: boolean, changedKeys?: Set<string>) {
  const cols = getTableColumns(reg.index) as Record<string, PgColumn>;
  const values = rows.map(row => indexValues(reg, row));
  if (!values.length) return;
  if (!onlyChanged) {
    for (const chunk of parameterChunks(values, () => Object.keys(cols).length)) await tx.insert(reg.index).values(chunk);
    return;
  }
  for (const value of values) {
    const changed = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'scopeId' && key !== 'rowId' && (!changedKeys || changedKeys.has(key))));
    if (!Object.keys(changed).length) continue;
    await tx.insert(reg.index).values(value).onConflictDoUpdate({ target: [cols.scopeId, cols.rowId], set: changed });
  }
}

export function runtimeMethods(sealerOf: () => Sealer) {
  const cache: SearchTokenCache = { profiles: new Map() };
  async function openWithCache<R>(rows: R, options: OpenOptions = {}, authCache?: AuthCache): Promise<Opened<R>> {
    const budget = { maxRows: Infinity, maxBytes: Infinity, deadlineMs: Infinity, concurrency: 64, ...options.budgets };
    for (const value of Object.values(options.budgets ?? {})) ensure(Number.isSafeInteger(value) && value > 0, 'INVALID_VALUE');
    const deadline = Date.now() + budget.deadlineMs;
    let count = 0, bytes = 0;
    const jobs: { target: Record<string, unknown>; key: string; value: Sealed<unknown, unknown>; rowId: string; scopeId: string }[] = [];
    const walk = (value: unknown): unknown => {
      ensure(Date.now() < deadline, 'LIMIT_EXCEEDED');
      if (value && (typeof value === 'object' || typeof value === 'function') && typeof (value as PromiseLike<unknown>).then === 'function')
        throw new SealError('INVALID_VALUE', undefined, { detail: 'await the query' });
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
        const key = `${reg.model}\0${job.scopeId}\0${job.rowId}\0${field.key}`;
        let entry = authCache?.get(key);
        if (entry) ensure(entry.bytes.length === job.value.bytes.length && entry.bytes.every((byte, i) => byte === job.value.bytes[i]), 'INVALID_CANDIDATE_SHAPE');
        else {
          entry = { bytes: job.value.bytes, result: sealer.open(job.value.bytes,
            context(reg, job.scopeId, job.rowId, field.key, sealer), sealer.ring(reg.model)) };
          authCache?.set(key, entry);
        }
        job.target[job.key] = await entry.result;
      }
    }));
    return result as Opened<R>;
  }
  const open = <R>(rows: R & (R extends PromiseLike<unknown> ? never : unknown), options?: OpenOptions): Promise<Opened<R>> => openWithCache(rows, options);

  async function insert<T extends PgTable, R extends string, S extends string | undefined = undefined, O extends { returning?: boolean } = {}>(
    db: Db, seal: SealMeta<T, R, S> & object, rows: InsertRow<T, R> | InsertRow<T, R>[], options?: O,
  ): Promise<Result<T, R, S, O>> {
    const reg = registrationOf(seal), arr = Array.isArray(rows) ? rows : [rows];
    ensure(arr.length > 0, 'INVALID_VALUE');
    const sealer = sealerOf();
    const prepared: Prepared[] = [];
    try {
      for (const row of arr) { const input = checkedValues(reg, asRecord(row), 'insert'); prepared.push(await prepare(reg, input, sealer, cache, true, true)); }
      const inserted = await writeTransaction(db, async (tx: any) => {
        const result: Record<string, unknown>[] = [];
        for (const chunk of parameterChunks(prepared, () => Object.keys(getTableColumns(reg.parent)).length))
          result.push(...await tx.insert(reg.parent).values(chunk.map(row => row.parent)).returning());
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
    const reg = registrationOf(seal), input = checkedValues(reg, asRecord(patch), 'update');
    const where = whereIdentity(reg, asRecord(at));
    const sealer = sealerOf(), prepared: Prepared[] = [];
    try {
      prepared.push(await prepare(reg, { ...at, ...input }, sealer, cache, false, false));
      const changed = Object.fromEntries(Object.entries(prepared[0].parent).filter(([key]) => key !== reg.row && key !== reg.scope));
      const result = await writeTransaction(db, async (tx: any) => {
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
    const reg = registrationOf(seal), input = checkedValues(reg, asRecord(row), 'upsert');
    const sealer = sealerOf(), prepared: Prepared[] = [];
    try {
      prepared.push(await prepare(reg, input, sealer, cache, true, true));
      const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
      const target = reg.rowUnique ? [columns[reg.row]] : [columns[reg.scope!], columns[reg.row]];
      const changed = Object.fromEntries(Object.entries(prepared[0].parent).filter(([key]) => key !== reg.row && key !== reg.scope && Object.hasOwn(input, key)));
      const setWhere = reg.scope && reg.rowUnique ? eq(columns[reg.scope], sql.raw(`excluded."${columns[reg.scope].name}"`)) : undefined;
      const result = await writeTransaction(db, async (tx: any) => {
        const found = await tx.insert(reg.parent).values(prepared[0].parent)
          .onConflictDoUpdate({ target, set: changed, setWhere }).returning();
        if (!found.length) fail('SCOPE_CONFLICT');
        const changedTokens = new Set([...reg.fields].filter(([key]) => Object.hasOwn(input, key))
          .flatMap(([key, field]) => profiles(reg.model, field.spec.id ?? key, field.spec)
            .flatMap(profile => profileColumns(reg.storage.index!.profiles![profile.indexId]))));
        await upsertIndexes(tx, reg, prepared, true, changedTokens);
        return found;
      });
      return (options?.returning ? await open(result) : prepared.map(row => row.identity)) as Result<T, R, S, O>;
    } catch (error) { if (error instanceof SealError) throw error; throw databaseError(error); }
    finally { release(prepared); }
  }

  async function openRaw<T extends PgTable, R extends string, S extends string | undefined, V extends Record<string, unknown>>(
    seal: SealMeta<T, R, S> & object, rows: V[] | { rows: V[] }, options: { columns: Record<string, string>; scope?: string; budgets?: OpenOptions['budgets'] },
    authCache?: AuthCache,
  ): Promise<V[]> {
    if (rows && typeof (rows as unknown as PromiseLike<unknown>).then === 'function') throw new SealError('INVALID_VALUE', undefined, { detail: 'await the query' });
    const reg = registrationOf(seal), columns = options.columns;
    ensure(!!columns[reg.row] && (!reg.scope || !!columns[reg.scope]), 'INVALID_VALUE');
    const source = Array.isArray(rows) ? rows : rows.rows;
    ensure(Array.isArray(source), 'INVALID_VALUE');
    const mapped = source.map(row => mapRawRow(reg, row, columns, reg.fields.keys(), false));
    const opened = await openWithCache(mapped, options, authCache);
    return source.map((row, i) => {
      const output: Record<string, unknown> = { ...row };
      for (const key of reg.fields.keys()) if (columns[key] && Object.hasOwn(opened[i], key)) output[columns[key]] = opened[i][key];
      return output as V;
    });
  }

  async function reindex<T extends PgTable, R extends string, S extends string | undefined = undefined>(
    db: Db, seal: SealMeta<T, R, S> & object, options: { scope?: string; batch?: number } = {},
  ): Promise<{ rows: number }> {
    const reg = registrationOf(seal);
    if (options.batch !== undefined) ensure(Number.isSafeInteger(options.batch) && options.batch >= 1, 'INVALID_VALUE');
    const batch = options.batch ?? 1000;
    ensure(!options.scope || !!reg.scope, 'INVALID_VALUE');
    const scopeId = options.scope === undefined ? undefined : identity(options.scope, reg.definition.scopeType);
    const parent = getTableColumns(reg.parent) as Record<string, PgColumn>;
    const index = getTableColumns(reg.index) as Record<string, PgColumn>;
    const profileList = [...reg.fields].flatMap(([key, field]) => profiles(reg.model, field.spec.id ?? key, field.spec).map(profile => ({ key, profile })));
    const tokenKeys = [...new Set(profileList.flatMap(({ profile }) => profileColumns(reg.storage.index?.profiles?.[profile.indexId] ?? fail('INVALID_SCHEMA'))))];
    let lastRow: string | undefined, lastScope: string | undefined, count = 0;
    const sealer = sealerOf(), ring = sealer.ring(reg.model);
    while (true) {
      let callbackEntered = false;
      let page: { row: string; scope: string }[];
      try { page = await checkedDb(db).transaction(async (tx: any) => {
        callbackEntered = true;
        const rowOrder = parent[reg.row];
        const scopeOrder = reg.scope ? parent[reg.scope] : undefined;
        const after = lastRow === undefined ? undefined : reg.scope && scopeId === undefined
          ? sql`(${scopeOrder},${rowOrder}) > (${lastScope},${lastRow})`
          : gt(parent[reg.row], lastRow);
        const rows = await tx.select().from(reg.parent).where(and(
          scopeId !== undefined ? eq(parent[reg.scope!], scopeId) : undefined, after,
        )).orderBy(...(scopeOrder && scopeId === undefined ? [scopeOrder] : []), rowOrder).limit(batch).for('update');
        const opened = await open(rows) as Record<string, unknown>[];
        for (const row of opened) {
          const rowId = identity(row[reg.row] as string, reg.definition.rowType);
          const rowScope = reg.scope ? identity(row[reg.scope] as string, reg.definition.scopeType) : '_';
          const values: Record<string, unknown> = { scopeId: rowScope, rowId };
          for (const { key, profile } of profileList) {
            const value = row[key];
            const tokens = value === null ? [] : await searchTokens(ring, rowScope, profile, searchPieces(profile, value), cache);
            values[reg.storage.index!.profiles![profile.indexId].tokens] = tokens.length ? tokens.map(BigInt) : null;
            Object.assign(values, await proofValues(sealer, rowScope, profile, reg.storage.index!.profiles![profile.indexId], value));
          }
          if (tokenKeys.length && tokenKeys.every(key => values[key] === null)) {
            await tx.delete(reg.index).where(and(eq(index.scopeId, rowScope), eq(index.rowId, rowId)));
            continue;
          }
          const query = tx.insert(reg.index).values(values);
          if (tokenKeys.length) await query.onConflictDoUpdate({ target: [index.scopeId, index.rowId],
            set: Object.fromEntries(tokenKeys.map(key => [key, values[key]])) });
          else await query.onConflictDoNothing({ target: [index.scopeId, index.rowId] });
        }
        return opened.map(row => ({ row: row[reg.row] as string, scope: reg.scope ? row[reg.scope] as string : '_' }));
      }); } catch (error) {
        if (!callbackEntered && unsupportedTransaction(error)) fail('UNSUPPORTED_DRIVER');
        throw error;
      }
      if (!page.length) break;
      count += page.length;
      lastRow = page.at(-1)!.row; lastScope = page.at(-1)!.scope;
      if (page.length < batch) break;
    }
    return { rows: count };
  }
  return { insert, update, upsert, open, openRaw, reindex, ...searchMethods(sealerOf, openWithCache, cache) };
}

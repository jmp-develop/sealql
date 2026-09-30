import { and, eq, gt, getTableColumns, sql, type InferSelectModel } from 'drizzle-orm';
import { type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { identity } from '../../../core/bytes.js';
import { databaseError, ensure, fail, SealError, unsupportedTransaction } from '../../../core/errors.js';
import type { Sealer } from '../../../core/field-cipher.js';
import { profiles, searchPieces, searchTokens, type SearchTokenCache } from '../../../core/search-tokens.js';
import { exactProof, positionProof } from '../../../core/search-stamps.js';
import { profileColumns, type ProfileStorage } from '../../../core/sealed-model.js';
import {
  Sealed, registrationOf, type InferSealedIdentity, type InferSealedInsert, type InferSealedPatch,
  type Opened, type Registration, type SealMeta,
} from './native.js';
import { mapRawRow } from './native-mapping.js';
import { searchMethods } from './native-search.js';
import { columnInfo, drizzleTableConfig, isTransaction, type DrizzleDb, type DrizzleTransaction } from './drizzle-surface.js';

type AuthCache = Map<string, { bytes: Uint8Array; result: Promise<unknown> }>;

type Db = DrizzleDb;
type Identity<T extends PgTable, R extends string, S extends string | undefined> =
  Pick<InferSelectModel<T>, Extract<R | Exclude<S, undefined>, keyof InferSelectModel<T>>>;
type Result<T extends PgTable, R extends string, S extends string | undefined, O> = O extends { returning: true }
  ? Opened<InferSelectModel<T>>[] : Identity<T, R, S>[];
export interface OpenOptions { scope?: string; budgets?: { maxRows?: number; maxBytes?: number; deadlineMs?: number; concurrency?: number } | undefined }
export interface PrepareRegistrationReceipt {
  modelId: string; schemaVerified: true; parentRowsAtStart: number; visitedRows: number;
  verifiedRows: number; parentRowsAtEnd: number; rebuiltFields: number;
}
export interface PrepareAllSearchReceipt {
  registrations: readonly PrepareRegistrationReceipt[]; totalRows: number; totalFields: number;
}
type PreparePhase = 'beforeCatalog' | 'afterCatalog' | 'beforeBatch' | 'afterBatch' | 'beforeFinal' | 'afterRegistration' | 'beforeReceipt';
interface PrepareTestHooks {
  checkpoint?: (phase: PreparePhase, reg?: Registration) => void | Promise<void>;
  skipVisitedRow?: (reg: Registration, ordinal: number) => boolean;
}
let prepareTestHooks: PrepareTestHooks | undefined;
/** Internal fault injection for source tests; not exported from the adapter entry point. */
export function setPrepareAllSearchTestHooks(hooks?: PrepareTestHooks): void { prepareTestHooks = hooks; }

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const resultRows = (value: unknown): Record<string, any>[] => {
  const rows = Array.isArray(value) ? value : (value as { rows?: unknown })?.rows;
  ensure(Array.isArray(rows), 'DATABASE_ERROR');
  return rows as Record<string, any>[];
};
const schemaFailure = (): never => { throw new SealError('INVALID_SCHEMA', undefined, { detail: 'extraMigrationSql 적용 필요' }); };
function exactNumber(value: unknown): number {
  let integer: bigint;
  try {
    integer = typeof value === 'bigint' ? value : typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value)
      : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : schemaFailure();
  } catch { return schemaFailure(); }
  ensure(integer >= 0n && integer <= BigInt(Number.MAX_SAFE_INTEGER), 'LIMIT_EXCEEDED');
  return Number(integer);
}
function safeAdd(left: number, right: number): number {
  const next = left + right;
  ensure(Number.isSafeInteger(next) && next >= 0, 'LIMIT_EXCEEDED');
  return next;
}
async function checkpoint(signal: AbortSignal | undefined, phase: PreparePhase, reg?: Registration): Promise<void> {
  if (signal?.aborted) fail('CANCELLED');
  await prepareTestHooks?.checkpoint?.(phase, reg);
  if (signal?.aborted) fail('CANCELLED');
}

async function parentCount(db: Db, reg: Registration): Promise<number> {
  const rows = resultRows(await db.execute(sql`select count(*)::text as n from ${reg.parent}`));
  ensure(rows.length === 1, 'INVALID_SCHEMA');
  return exactNumber(rows[0].n);
}

async function strictDatabaseOrder(
  db: Db, reg: Registration, pairs: { current: { row: string; scope: string }; previous: { row: string; scope: string } }[],
): Promise<boolean> {
  if (!pairs.length) return true;
  const parent = getTableColumns(reg.parent) as Record<string, PgColumn>;
  const storage = reg.storage.parent;
  const parentName = sql.raw(`${quote(storage.schema)}.${quote(storage.name)}`);
  const rowName = sql.raw(`p.${quote(parent[reg.row].name)}`);
  const rowType = sql.raw(reg.definition.rowType);
  let query;
  if (reg.scope) {
    const scopeName = sql.raw(`p.${quote(parent[reg.scope].name)}`);
    const scopeType = sql.raw(reg.definition.scopeType);
    const values = sql.join(pairs.map(({ current, previous }) => sql`(
      ${current.scope}::${scopeType},${current.row}::${rowType},
      ${previous.scope}::${scopeType},${previous.row}::${rowType})`), sql.raw(','));
    query = sql`select count(*)::integer as n,
      coalesce(bool_and((${scopeName},${rowName}) > (v.previous_scope,v.previous_row)),true) as ok
      from ${parentName} p
      join (values ${values}) as v(current_scope,current_row,previous_scope,previous_row)
        on ${scopeName}=v.current_scope and ${rowName}=v.current_row`;
  } else {
    const values = sql.join(pairs.map(({ current, previous }) => sql`(
      ${current.row}::${rowType},${previous.row}::${rowType})`), sql.raw(','));
    query = sql`select count(*)::integer as n,
      coalesce(bool_and(${rowName} > v.previous_row),true) as ok
      from ${parentName} p
      join (values ${values}) as v(current_row,previous_row) on ${rowName}=v.current_row`;
  }
  const rows = resultRows(await db.execute(query));
  return rows.length === 1 && Number(rows[0].n) === pairs.length && rows[0].ok === true;
}

async function catalogPreflight(db: Db, reg: Registration): Promise<void> {
  const storage = reg.storage.index ?? schemaFailure();
  const attributes = resultRows(await db.execute(sql`
    select a.attname as name, format_type(a.atttypid,a.atttypmod) as type,
      a.attnotnull as not_null, a.attstattarget as statistics, a.attstorage as storage, a.attnum as position
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid=a.attrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname=${storage.schema} and c.relname=${storage.name}
      and a.attnum>0 and not a.attisdropped order by a.attnum`));
  const expectedColumns = Object.values(getTableColumns(reg.index)) as PgColumn[];
  if (attributes.length !== expectedColumns.length) schemaFailure();
  for (let i = 0; i < expectedColumns.length; i++) {
    const actual = attributes[i], expected = expectedColumns[i];
    if (actual.name !== expected.name || String(actual.type).replaceAll(' ', '') !== expected.getSQLType().replaceAll(' ', '') ||
      actual.not_null !== expected.notNull || Number(actual.position) !== i + 1) schemaFailure();
  }

  const indexRows = resultRows(await db.execute(sql`
    select i.relname as name, x.indisvalid as valid, x.indisready as ready,
      x.indisunique as unique_index, x.indkey::text as keys
    from pg_catalog.pg_index x
    join pg_catalog.pg_class t on t.oid=x.indrelid
    join pg_catalog.pg_namespace n on n.oid=t.relnamespace
    join pg_catalog.pg_class i on i.oid=x.indexrelid
    where n.nspname=${storage.schema} and t.relname=${storage.name}`));
  const byIndex = new Map(indexRows.map(row => [row.name, row]));
  for (const expected of drizzleTableConfig(reg.index).indexes) {
    const actual = byIndex.get(expected.config.name);
    if (!actual || actual.valid !== true || actual.ready !== true || actual.unique_index !== !!expected.config.unique) schemaFailure();
  }
  const positions = new Map(attributes.map(row => [row.name, Number(row.position)]));
  const expectedIdentityIndexes = [
    [`${storage.name}_scope_row_uq`, [positions.get('scope_id'), positions.get('row_id')]],
    ...(reg.rowUnique ? [[`${storage.name}_row_uq`, [positions.get('row_id')]]] as [string, (number | undefined)[]][] : []),
  ] as [string, (number | undefined)[]][];
  for (const [name, expectedKeys] of expectedIdentityIndexes) {
    const actual = byIndex.get(name);
    const keys = String(actual?.keys ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
    if (!actual || actual.unique_index !== true || expectedKeys.some(key => key === undefined) ||
      keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) schemaFailure();
  }

  const constraints = resultRows(await db.execute(sql`
    select c.contype as type, c.convalidated as validated, c.confdeltype as delete_action,
      pg_catalog.pg_get_constraintdef(c.oid) as definition
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid=c.conrelid
    join pg_catalog.pg_namespace n on n.oid=t.relnamespace
    where n.nspname=${storage.schema} and t.relname=${storage.name}`));
  const foreign = constraints.find(row => row.type === 'f' && row.validated === true && row.delete_action === 'c');
  if (constraints.some(row => row.validated !== true)) schemaFailure();
  if (!foreign) schemaFailure();
  const foreignDefinition = String(foreign!.definition).replace(/["\s]/g, '').toLowerCase();
  const parentColumns = getTableColumns(reg.parent) as Record<string, PgColumn>;
  const localKeys = reg.rowUnique ? 'foreignkey(row_id)' : 'foreignkey(scope_id,row_id)';
  const referencedKeys = reg.rowUnique ? `(${parentColumns[reg.row].name})`
    : `(${parentColumns[reg.scope!].name},${parentColumns[reg.row].name})`;
  if (!foreignDefinition.includes(localKeys) || !foreignDefinition.includes(referencedKeys.toLowerCase())) schemaFailure();

  const functions = resultRows(await db.execute(sql`
    select p.proname as name, pg_catalog.oidvectortypes(p.proargtypes) as arguments,
      pg_catalog.format_type(p.prorettype,null) as returns, l.lanname as language,
      p.provolatile as volatility, p.proisstrict as strict, p.proparallel as parallel,
      p.prosecdef as security_definer, p.procost as cost, p.proconfig as config
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    join pg_catalog.pg_language l on l.oid=p.prolang
    where n.nspname=${reg.storage.parent.schema}
      and p.proname in ('sealql_match_positions','sealql_find_positions','sealql_match_like')`));
  const expectedFunctions = new Map<string, { arguments: string; returns: string; cost: number }>([
    ['sealql_match_positions', { arguments: 'bytea[], integer[], integer, integer, bytea, bigint[], integer[], integer', returns: 'boolean', cost: 1900 }],
    ['sealql_find_positions', { arguments: 'bytea[], integer[], integer, integer, bytea, bigint[], integer[], integer, integer', returns: 'integer', cost: 1900 }],
    ['sealql_match_like', { arguments: 'bytea[], integer[], integer, bytea, bigint[], integer[]', returns: 'boolean', cost: 100 }],
  ]);
  if (functions.length !== expectedFunctions.size) schemaFailure();
  for (const row of functions) {
    const expected = expectedFunctions.get(row.name);
    if (!expected || row.arguments !== expected.arguments || row.returns !== expected.returns || row.language !== 'plpgsql' ||
      row.volatility !== 'i' || row.strict !== true || row.parallel !== 's' || row.security_definer !== false ||
      Number(row.cost) !== expected.cost || !Array.isArray(row.config) || !row.config.includes('search_path=pg_catalog')) schemaFailure();
  }

  const byColumn = new Map(attributes.map(row => [row.name, row]));
  for (const profile of Object.values(storage.profiles ?? {})) {
    const token = byColumn.get(profile.tokens);
    if (!token || token.storage !== 'm' || (profile.mode === 'substring' && Number(token.statistics) !== 1000)) schemaFailure();
    if (profile.positions) for (const name of [profile.positions.stamps, profile.positions.offsets])
      if (byColumn.get(name)?.storage !== 'm') schemaFailure();
  }
}

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
  if (stored.positions) {
    const group = stored.positions;
    const proof = await positionProof(ring, profile, scope, value as string, 'compact2');
    result[group.salt] = proof.salt; result[group.length] = proof.length;
    result[group.stamps] = proof.stamps; result[group.offsets] = proof.offsets;
  }
  return result;
}

async function prepare(reg: Registration, source: Record<string, unknown>, sealer: Sealer, cache: SearchTokenCache, fillId: boolean, fillFields: boolean): Promise<Prepared> {
  const parent: Record<string, unknown> = { ...source };
  if (fillFields) for (const [key, field] of reg.fields) if (parent[key] === undefined) {
    ensure(!columnInfo(field.column).notNull, 'INVALID_VALUE');
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
    if (value === null) ensure(!columnInfo(field.column).notNull, 'INVALID_VALUE');
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
    if (callbackDone && !isTransaction(db)) fail('WRITE_OUTCOME_UNKNOWN');
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

export function runtimeMethods(sealerOf: () => Sealer, registrationsOf: () => Registration[] = () => []) {
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
    db: Db, seal: SealMeta<T, R, S> & object,
    rows: InferSealedInsert<SealMeta<T, R, S>> | InferSealedInsert<SealMeta<T, R, S>>[], options?: O,
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
    db: Db, seal: SealMeta<T, R, S> & object, at: InferSealedIdentity<SealMeta<T, R, S>>,
    patch: InferSealedPatch<SealMeta<T, R, S>>, options?: O,
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
    db: Db, seal: SealMeta<T, R, S> & object, row: InferSealedInsert<SealMeta<T, R, S>>, options?: O,
  ): Promise<Result<T, R, S, O>> {
    const reg = registrationOf(seal), input = checkedValues(reg, asRecord(row), 'upsert');
    const sealer = sealerOf(), prepared: Prepared[] = [];
    try {
      prepared.push(await prepare(reg, input, sealer, cache, true, true));
      const columns = getTableColumns(reg.parent) as Record<string, PgColumn>;
      const target = reg.rowUnique ? [columns[reg.row]] : [columns[reg.scope!], columns[reg.row]];
      const changed = Object.fromEntries(Object.entries(prepared[0].parent).filter(([key]) => key !== reg.row && key !== reg.scope && Object.hasOwn(input, key)));
      const setWhere = reg.scope && reg.rowUnique ? eq(columns[reg.scope], sql.raw(`excluded."${columnInfo(columns[reg.scope]).name}"`)) : undefined;
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

  async function reindexRegistration(
    db: Db, reg: Registration, batch: number, scopeId?: string,
    control?: { signal?: AbortSignal; coverage?: boolean },
  ): Promise<{ rows: number; fields: number }> {
    const parent = getTableColumns(reg.parent) as Record<string, PgColumn>;
    const index = getTableColumns(reg.index) as Record<string, PgColumn>;
    const profileList = [...reg.fields].flatMap(([key, field]) => profiles(reg.model, field.spec.id ?? key, field.spec).map(profile => ({ key, profile })));
    const tokenKeys = [...new Set(profileList.flatMap(({ profile }) => profileColumns(reg.storage.index?.profiles?.[profile.indexId] ?? fail('INVALID_SCHEMA'))))];
    const searchableFields = new Set(profileList.map(item => item.key)).size;
    let lastRow: string | undefined, lastScope: string | undefined, count = 0, fieldCount = 0, encountered = 0;
    const seen = new Set<string>();
    const sealer = sealerOf(), ring = sealer.ring(reg.model);
    while (true) {
      if (control) await checkpoint(control.signal, 'beforeBatch', reg);
      let callbackEntered = false;
      let result: { page: { row: string; scope: string }[]; visited: { row: string; scope: string }[] };
      try { result = await checkedDb(db).transaction(async (tx: any) => {
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
        const visited: { row: string; scope: string }[] = [];
        for (const row of opened) {
          const rowId = identity(row[reg.row] as string, reg.definition.rowType);
          const rowScope = reg.scope ? identity(row[reg.scope] as string, reg.definition.scopeType) : '_';
          const ordinal = encountered++;
          if (control?.coverage && prepareTestHooks?.skipVisitedRow?.(reg, ordinal)) continue;
          visited.push({ row: rowId, scope: rowScope });
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
        return {
          page: opened.map(row => ({ row: row[reg.row] as string, scope: reg.scope ? row[reg.scope] as string : '_' })),
          visited,
        };
      }); } catch (error) {
        if (!callbackEntered && unsupportedTransaction(error)) fail('UNSUPPORTED_DRIVER');
        throw error;
      }
      if (control) await checkpoint(control.signal, 'afterBatch', reg);
      if (!result.page.length) break;
      let previous = lastRow === undefined ? undefined : { row: lastRow, scope: lastScope! };
      const orderPairs: { current: { row: string; scope: string }; previous: { row: string; scope: string } }[] = [];
      for (const current of result.visited) {
        const key = `${current.scope}\0${current.row}`;
        if (seen.has(key)) fail('REBUILD_INCOMPLETE');
        seen.add(key);
        if (control?.coverage && previous) orderPairs.push({ current, previous });
        previous = current;
        count = safeAdd(count, 1);
        fieldCount = safeAdd(fieldCount, searchableFields);
      }
      if (control?.coverage && !await strictDatabaseOrder(db, reg, orderPairs)) fail('REBUILD_INCOMPLETE');
      lastRow = result.page.at(-1)!.row; lastScope = result.page.at(-1)!.scope;
      if (result.page.length < batch) break;
    }
    return { rows: count, fields: fieldCount };
  }

  async function reindex<T extends PgTable, R extends string, S extends string | undefined = undefined>(
    db: Db, seal: SealMeta<T, R, S> & object, options: { scope?: string; batch?: number } = {},
  ): Promise<{ rows: number }> {
    const reg = registrationOf(seal);
    if (options.batch !== undefined) ensure(Number.isSafeInteger(options.batch) && options.batch >= 1, 'INVALID_VALUE');
    const batch = options.batch ?? 1000;
    ensure(!options.scope || !!reg.scope, 'INVALID_VALUE');
    const scopeId = options.scope === undefined ? undefined : identity(options.scope, reg.definition.scopeType);
    return { rows: (await reindexRegistration(db, reg, batch, scopeId)).rows };
  }

  async function prepareAllSearch<D extends Db>(
    db: D extends DrizzleTransaction ? never : D,
    options: { batchSize?: number; signal?: AbortSignal } = {},
  ): Promise<PrepareAllSearchReceipt> {
    const snapshot = [...registrationsOf()];
    ensure(snapshot.length > 0, 'INVALID_SCHEMA');
    if (options.batchSize !== undefined) ensure(Number.isSafeInteger(options.batchSize) && options.batchSize >= 1, 'INVALID_VALUE');
    const batch = options.batchSize ?? 1000;
    if (isTransaction(db)) fail('INVALID_TRANSACTION_CONTEXT');
    await checkpoint(options.signal, 'beforeCatalog');
    for (const reg of snapshot) {
      await catalogPreflight(db, reg);
      await checkpoint(options.signal, 'afterCatalog', reg);
    }
    const receipts: PrepareRegistrationReceipt[] = [];
    let totalRows = 0, totalFields = 0;
    for (const reg of snapshot) {
      const parentRowsAtStart = await parentCount(db, reg);
      const rebuilt = await reindexRegistration(db, reg, batch, undefined, { signal: options.signal, coverage: true });
      await checkpoint(options.signal, 'beforeFinal', reg);
      const parentRowsAtEnd = await parentCount(db, reg);
      if (parentRowsAtStart !== parentRowsAtEnd || rebuilt.rows !== parentRowsAtStart) fail('REBUILD_INCOMPLETE');
      receipts.push({ modelId: reg.model, schemaVerified: true, parentRowsAtStart,
        visitedRows: rebuilt.rows, verifiedRows: rebuilt.rows, parentRowsAtEnd, rebuiltFields: rebuilt.fields });
      totalRows = safeAdd(totalRows, rebuilt.rows);
      totalFields = safeAdd(totalFields, rebuilt.fields);
      await checkpoint(options.signal, 'afterRegistration', reg);
    }
    await checkpoint(options.signal, 'beforeReceipt');
    return { registrations: receipts, totalRows, totalFields };
  }
  return { insert, update, upsert, open, openRaw, reindex, prepareAllSearch, ...searchMethods(sealerOf, openWithCache, cache) };
}

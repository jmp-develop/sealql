import { canonical, compareText, hex, identity, utf8 } from '../core/bytes.js';
import { databaseError, ensure, fail, SealError } from '../core/errors.js';
import { envelopeShape, type Keyring, type Sealer } from '../core/field-cipher.js';
import { encodeField, type JsonValue } from '../core/field-codec.js';
import { profiles, searchPieces, searchTokens, type SearchTokenCache } from '../core/search-tokens.js';
import { compileSearch, searchFields, validateSearch, verifySearch, type CompiledSearch, type SearchFields, type SearchNode } from '../core/search-predicate.js';
import { openCursor, sealCursor } from '../core/search-cursor.js';
import { CompanionStore } from '../adapters/postgres/companion-store.js';
import { candidateStatement } from '../adapters/postgres/search-sql.js';
import type { RuntimeSnapshot, SealedAdvancedPlan, SealedModelDefinition, SealedPhysicalRow, SealedRowAccessPort, SealedSqlExecutor, SealedStorage } from './sealed-types.js';

const maxRevision = 9223372036854775807n;
async function mapBounded<T, R>(items: readonly T[], workers: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length); let cursor = 0;
  let failureIndex = Infinity, failureError: unknown;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (cursor < items.length && failureIndex === Infinity) {
      const index = cursor++;
      try { result[index] = await fn(items[index]); }
      catch (error) { if (index < failureIndex) { failureIndex = index; failureError = error; } }
    }
  }));
  if (failureIndex !== Infinity) throw failureError;
  return result;
}
export interface SealedBinding<D extends SealedModelDefinition = SealedModelDefinition, P extends SealedAdvancedPlan = SealedAdvancedPlan> { sealer: Sealer; definition: D; storage: SealedStorage; executor: SealedSqlExecutor; rows: SealedRowAccessPort<P> }
export interface SearchBudgets { batch?: number; maxCandidates?: number; fetchBytes?: number; decryptedBytes?: number; resultBytes?: number; deadlineMs?: number; decryptConcurrency?: number }
export interface FindOptions<D extends SealedModelDefinition> {
  match?: (fields: SearchFields<D['fields']>) => SearchNode;
  where?: unknown;
  select?: Record<string, boolean>;
  orderBy?: { field: string; direction: 'asc' | 'desc' };
  limit?: number; cursor?: string; budgets?: SearchBudgets; signal?: AbortSignal;
}
export interface SearchPage<R = Record<string, unknown>> { items: R[]; nextCursor: string | null; stopReason: 'page-full' | 'exhausted' | 'budget-exceeded' }
type IdentityRow<R> = { id: R extends { id: infer V } ? V : string; revision: R extends { revision: infer V } ? V : bigint };
export type SelectedRow<R, S extends Record<string, boolean> | undefined> = S extends undefined ? R :
  string extends keyof S ? IdentityRow<R> & Partial<Omit<R, 'id' | 'revision'>> :
  IdentityRow<R> & Pick<R, Extract<{ [K in keyof S]: S[K] extends true ? K : never }[keyof S], keyof R>>;
function sanitizedExecutor<E extends SealedSqlExecutor>(executor: E): E {
  return {
    ...executor,
    async query(statement) { try { return await executor.query(statement); } catch (error) { throw databaseError(error); } },
    async transaction<T>(fn: (tx: SealedSqlExecutor) => Promise<T>): Promise<T> {
      try { return await executor.transaction(tx => fn(sanitizedExecutor(tx))); }
      catch (error) { throw databaseError(error); }
    },
  } as E;
}
function sanitizedRows<P extends SealedAdvancedPlan>(rows: SealedRowAccessPort<P>): SealedRowAccessPort<P> {
  const guarded = async <T>(operation: () => Promise<T>) => { try { return await operation(); } catch (error) { throw databaseError(error); } };
  return {
    insert: (executor, args) => guarded(() => rows.insert(executor, args)),
    update: (executor, args) => guarded(() => rows.update(executor, args)),
    delete: (executor, args) => guarded(() => rows.delete(executor, args)),
    get: (executor, args) => guarded(() => rows.get(executor, args)),
    candidates: (executor, args) => guarded(() => rows.candidates(executor, args)),
    advancedPlan: args => rows.advancedPlan(args),
  };
}
export class SealedRepository<D extends SealedModelDefinition, P extends SealedAdvancedPlan = SealedAdvancedPlan, I = Record<string, unknown>, R = Record<string, unknown>> {
  readonly companion: CompanionStore;
  readonly tokenCache: SearchTokenCache;
  readonly binding: SealedBinding<D, P>;
  constructor(binding: SealedBinding<D, P>) {
    this.binding = { ...binding, executor: sanitizedExecutor(binding.executor), rows: sanitizedRows(binding.rows) };
    this.companion = new CompanionStore(binding.storage);
    this.tokenCache = { profiles: new Map() };
  }
  forScope(args: { scopeId: string; expectedKeyScopeId?: string }) {
    const scopeId = identity(args.scopeId, this.binding.definition.scopeType);
    return new ScopedRepository<D, P, I, R>(this, scopeId, args.expectedKeyScopeId);
  }
}
export function bindSealed<D extends SealedModelDefinition, P extends SealedAdvancedPlan, I = Record<string, unknown>, R = Record<string, unknown>>(binding: SealedBinding<D, P>): SealedRepository<D, P, I, R> { return new SealedRepository(binding); }
export class ScopedRepository<D extends SealedModelDefinition, P extends SealedAdvancedPlan = SealedAdvancedPlan, I = Record<string, unknown>, R = Record<string, unknown>> {
  constructor(readonly repository: SealedRepository<D, P, I, R>, readonly scopeId: string, readonly expectedKeyScopeId?: string) {}
  private get binding() { return this.repository.binding; }
  private id(value: string) { return identity(value, this.binding.definition.rowType); }
  private async context(_executor: SealedSqlExecutor) {
    const definition = this.binding.definition;
    const keyScopeId = this.binding.sealer.keyScopeId(definition.id);
    if (this.expectedKeyScopeId !== undefined) ensure(keyScopeId === this.expectedKeyScopeId, 'KEY_SCOPE_MISMATCH');
    const ring = this.binding.sealer.ring(definition.id);
    const stored = Object.entries(definition.fields).flatMap(([field, spec]) => profiles(definition.id, spec.id ?? field, spec, definition.searchProtection));
    const snapshot = { keyScopeId, profiles: stored } satisfies RuntimeSnapshot;
    return { snapshot, ring };
  }
  private openField(encrypted: Uint8Array, key: string, rowId: string, snapshot: RuntimeSnapshot, ring: Keyring): Promise<unknown> {
    const spec = this.binding.definition.fields[key];
    envelopeShape(encrypted, spec.maxBytes ?? 65536);
    return this.binding.sealer.open(encrypted, { modelId: this.binding.definition.id, fieldId: spec.id ?? key, keyScopeId: snapshot.keyScopeId, scopeId: this.scopeId, rowId, spec }, ring);
  }
  private async pack(data: Record<string, unknown>, id: string, snapshot: RuntimeSnapshot, ring: Keyring, inserting: boolean) {
    const definition = this.binding.definition;
    const fields: Record<string, Uint8Array | null> = {}, pub: Record<string, unknown> = {};
    const replacements: { indexId: string; tokens: string[] }[] = [];
    for (const [key, value] of Object.entries(data)) ensure(Object.hasOwn(definition.fields, key) || (Object.hasOwn(definition.columns, key) && !Object.values(definition.identity).includes(key)), 'INVALID_VALUE');
    const packedFields = await mapBounded(Object.entries(definition.fields), 4, async ([key, spec]) => {
      if (!inserting && data[key] === undefined) return undefined;
      const value = data[key] === undefined ? null : data[key];
      ensure(value !== null || !definition.columns[key].notNull, 'INVALID_VALUE');
      if (value !== null) encodeField(spec, value);
      const encrypted = value === null ? null : await this.binding.sealer.seal(value, { modelId: definition.id, fieldId: spec.id ?? key, keyScopeId: snapshot.keyScopeId, scopeId: this.scopeId, rowId: id, spec }, ring);
      const indexes: typeof replacements = [];
      for (const profile of snapshot.profiles.filter(profile => profile.fieldId === (spec.id ?? key))) {
        const pieces = value === null ? [] : searchPieces(profile, value);
        indexes.push({ indexId: profile.indexId, tokens: await searchTokens(ring, this.scopeId, profile, pieces, this.repository.tokenCache) });
      }
      return { key, encrypted, indexes };
    });
    for (const packed of packedFields) if (packed) {
      fields[packed.key] = packed.encrypted;
      replacements.push(...packed.indexes);
    }
    for (const [key, value] of Object.entries(data)) if (!Object.hasOwn(definition.fields, key) && value !== undefined) pub[key] = value;
    return { fields, pub, replacements };
  }
  async insert(args: { id: string; data: I }) {
    const id = this.id(args.id), { snapshot, ring } = await this.context(this.binding.executor);
    const packed = await this.pack(args.data as Record<string, unknown>, id, snapshot, ring, true);
    await this.binding.executor.transaction(async tx => {
      ensure(await this.binding.rows.insert(tx, { scopeId: this.scopeId, id, fields: packed.fields, public: packed.pub }) === 1, 'WRITE_CONFLICT');
      await this.repository.companion.replaceIndexes(tx, this.scopeId, id, packed.replacements);
    });
    return { id, revision: 1n };
  }
  async update(args: { id: string; expectedRevision: bigint; patch: Partial<I> }) {
    const id = this.id(args.id), rev = args.expectedRevision;
    ensure(typeof rev === 'bigint' && rev >= 1n && rev < maxRevision && Object.values(args.patch).some(value => value !== undefined), 'INVALID_VALUE');
    const { snapshot, ring } = await this.context(this.binding.executor);
    const packed = await this.pack(args.patch as Record<string, unknown>, id, snapshot, ring, false);
    await this.binding.executor.transaction(async tx => {
      ensure(await this.binding.rows.update(tx, { scopeId: this.scopeId, id, expectedRevision: rev, fields: packed.fields, public: packed.pub }) === 1, 'WRITE_CONFLICT');
      await this.repository.companion.replaceIndexes(tx, this.scopeId, id, packed.replacements);
    });
    return { id, revision: rev + 1n };
  }
  async delete(args: { id: string; expectedRevision: bigint }) {
    const id = this.id(args.id), rev = args.expectedRevision;
    ensure(typeof rev === 'bigint' && rev >= 1n && rev <= maxRevision, 'INVALID_VALUE');
    await this.binding.executor.transaction(async tx => {
      ensure(await this.binding.rows.delete(tx, { scopeId: this.scopeId, id, expectedRevision: rev }) === 1, 'WRITE_CONFLICT');
    });
    return { id, deleted: true as const };
  }
  private selection(select?: Record<string, boolean>) {
    const d = this.binding.definition, publicKeys = Object.keys(d.columns).filter(key => !Object.hasOwn(d.fields, key) && !Object.values(d.identity).includes(key));
    const allowed = [...Object.keys(d.fields), ...publicKeys];
    if (select) for (const [key, value] of Object.entries(select)) ensure(allowed.includes(key) && typeof value === 'boolean', 'INVALID_VALUE');
    const selected = select ? Object.keys(select).filter(key => select[key]) : allowed;
    return { fields: selected.filter(key => Object.hasOwn(d.fields, key)), public: selected.filter(key => !Object.hasOwn(d.fields, key)) };
  }
  private async decrypt(row: SealedPhysicalRow, snapshot: RuntimeSnapshot, ring: Keyring, selection: ReturnType<ScopedRepository<D, P, I, R>['selection']>) {
    ensure(row.scopeId === this.scopeId && row.revision >= 1n && row.revision <= maxRevision, 'INVALID_CANDIDATE_SHAPE');
    this.id(row.id);
    this.publicSize(row, selection.public);
    const result: Record<string, unknown> = { id: row.id, revision: row.revision, ...row.public };
    const values = await mapBounded(selection.fields, 4, async key => {
      const encrypted = row.fields[key], spec = this.binding.definition.fields[key];
      ensure(encrypted !== undefined, 'INVALID_CANDIDATE_SHAPE');
      return encrypted === null ? null : this.openField(encrypted, key, row.id, snapshot, ring);
    });
    selection.fields.forEach((key, index) => { result[key] = values[index]; });
    return result;
  }
  private publicSize(row: SealedPhysicalRow, keys: string[]) {
    let size = 0;
    for (const key of keys) {
      ensure(Object.hasOwn(row.public, key), 'INVALID_CANDIDATE_SHAPE');
      const column = this.binding.definition.columns[key], type = column.getSQLType();
      const bound = this.binding.definition.publicBounds[key] ?? (['uuid', 'boolean', 'smallint', 'integer', 'bigint', 'timestamp with time zone'].includes(type) ? 128 : undefined);
      ensure(bound, 'UNBOUNDED_PROJECTION');
      const value = row.public[key];
      const actual = value === null ? 0 : typeof value === 'string' ? utf8(value).length : canonical(value).length;
      ensure(actual <= bound, 'LIMIT_EXCEEDED'); size += actual;
    }
    return size;
  }
  async get<const S extends Record<string, boolean> | undefined = undefined>(args: { id: string; select?: S }): Promise<SelectedRow<R, S> | null> {
    const id = this.id(args.id), selected = this.selection(args.select), { snapshot, ring } = await this.context(this.binding.executor);
    const row = await this.binding.rows.get(this.binding.executor, { scopeId: this.scopeId, id, ...selected });
    const result = row ? await this.decrypt(row, snapshot, ring, selected) : null;
    return result as SelectedRow<R, S> | null;
  }
  async decryptRows<const S extends Record<string, boolean> | undefined = undefined>(args: { rows: readonly Record<string, unknown>[]; mapping: { scope: string; row: string; revision: string; fields: Record<string, string>; public?: Record<string, string>; nullableRoot?: boolean }; select?: S; budgets?: Pick<SearchBudgets, 'fetchBytes' | 'decryptedBytes' | 'resultBytes' | 'deadlineMs' | 'decryptConcurrency'>; signal?: AbortSignal }): Promise<(SelectedRow<R, S> | null)[]> {
    ensure(Array.isArray(args.rows) && args.rows.length <= 500, 'LIMIT_EXCEEDED');
    const budgets = { fetchBytes: 4 * 1024 * 1024, decryptedBytes: 4 * 1024 * 1024, resultBytes: 4 * 1024 * 1024, deadlineMs: 2000, decryptConcurrency: 64, ...args.budgets };
    for (const [key, value] of Object.entries(budgets)) ensure(Number.isSafeInteger(value) && value > 0 && value <= ({ fetchBytes: 32 * 1024 * 1024, decryptedBytes: 32 * 1024 * 1024, resultBytes: 32 * 1024 * 1024, deadlineMs: 30000, decryptConcurrency: 64 } as Record<string, number>)[key], 'INVALID_VALUE');
    const deadline = Date.now() + budgets.deadlineMs;
    let fetchedBytes = 0, decryptedBytes = 0, resultBytes = 0;
    const checkpoint = () => { if (args.signal?.aborted) fail('CANCELLED'); ensure(Date.now() < deadline, 'LIMIT_EXCEEDED'); };
    const selected = this.selection(args.select), { snapshot, ring } = await this.context(this.binding.executor);
    const mapping = args.mapping, aliases = [mapping.scope, mapping.row, mapping.revision, ...Object.values(mapping.fields), ...Object.values(mapping.public ?? {})];
    ensure(aliases.every(alias => typeof alias === 'string' && alias.length > 0 && !alias.startsWith('__seal_')) && new Set(aliases).size === aliases.length, 'INVALID_VALUE');
    const output: (Record<string, unknown> | null)[] = [];
    const authenticated = new Map<string, Map<string, { bytes: Uint8Array; value: Promise<unknown> }[]>>();
    let cachedBytes = 0, cachedEntries = 0;
    const copyMutable = (value: unknown) => value !== null && typeof value === 'object' ? structuredClone(value) : value;
    const open = async (row: SealedPhysicalRow, key: string, encrypted: Uint8Array) => {
      checkpoint();
      // Definition, scopes, ring and codec specs are fixed for this call.
      // Input bytes were copied before awaits; exact equality also binds the
      // envelope format and detects changed or tampered JOIN duplicates.
      const byField = authenticated.get(row.id);
      const entries = byField?.get(key);
      const existing = entries?.find(entry => entry.bytes.length === encrypted.length && entry.bytes.every((byte, index) => byte === encrypted[index]));
      if (existing) return copyMutable(await existing.value);
      const value = this.openField(encrypted, key, row.id, snapshot, ring);
      if (cachedEntries < 256 && cachedBytes + encrypted.length <= 1024 * 1024) {
        const fields = byField ?? new Map<string, { bytes: Uint8Array; value: Promise<unknown> }[]>();
        if (!byField) authenticated.set(row.id, fields);
        fields.set(key, [...(entries ?? []), { bytes: encrypted, value }]);
        cachedEntries++; cachedBytes += encrypted.length;
      }
      return copyMutable(await value);
    };
    const work: { row: SealedPhysicalRow; outputIndex: number; key: string; encrypted: Uint8Array }[] = [];
    for (const source of args.rows) {
      checkpoint();
      ensure(source && typeof source === 'object', 'INVALID_CANDIDATE_SHAPE');
      const id = source[mapping.row], scope = source[mapping.scope], revision = source[mapping.revision];
      if (id === null) {
        ensure(mapping.nullableRoot === true && scope === null && revision === null, 'INVALID_CANDIDATE_SHAPE');
        output.push(null); continue;
      }
      ensure(typeof id === 'string' && scope === this.scopeId && revision !== null && revision !== undefined, 'INVALID_CANDIDATE_SHAPE');
      const fields: Record<string, Uint8Array | null> = {}, pub: Record<string, unknown> = {};
      for (const key of selected.fields) {
        const alias = mapping.fields[key]; ensure(alias && Object.hasOwn(source, alias), 'INVALID_CANDIDATE_SHAPE');
        const value = source[alias];
        ensure(value === null || value instanceof Uint8Array || (typeof value === 'string' && /^\\x(?:[0-9a-fA-F]{2})*$/.test(value)), 'INVALID_CANDIDATE_SHAPE');
        fields[key] = value === null ? null : typeof value === 'string' ? Uint8Array.from(value.slice(2).match(/../g) ?? [], h => parseInt(h, 16)) : Uint8Array.from(value as Uint8Array);
      }
      for (const key of selected.public) { const alias = mapping.public?.[key]; ensure(alias && Object.hasOwn(source, alias), 'INVALID_CANDIDATE_SHAPE'); pub[key] = source[alias]; }
      const physical = { scopeId: this.scopeId, id, revision: BigInt(revision as string), fields, public: pub };
      ensure(physical.revision >= 1n && physical.revision <= maxRevision, 'INVALID_CANDIDATE_SHAPE');
      this.id(id);
      let bytes = 2048 + this.publicSize(physical, selected.public);
      for (const [key, value] of Object.entries(fields)) {
        bytes += value?.length ?? 0;
        if (value !== null) {
          const spec = this.binding.definition.fields[key];
          envelopeShape(value, spec.maxBytes ?? 65536);
          decryptedBytes += value.length - 29;
          work.push({ row: physical, outputIndex: output.length, key, encrypted: value });
        }
      }
      fetchedBytes += bytes;
      ensure(fetchedBytes <= budgets.fetchBytes && decryptedBytes <= budgets.decryptedBytes, 'LIMIT_EXCEEDED');
      const result: Record<string, unknown> = { id, revision: physical.revision, ...pub };
      for (const key of selected.fields) if (fields[key] === null) result[key] = null;
      output.push(result);
    }
    const values = await mapBounded(work, budgets.decryptConcurrency, item => open(item.row, item.key, item.encrypted));
    checkpoint();
    work.forEach((item, index) => { output[item.outputIndex]![item.key] = values[index]; });
    for (const result of output) {
      resultBytes += result === null ? 0 : canonical(result).length;
      ensure(resultBytes <= budgets.resultBytes, 'LIMIT_EXCEEDED');
    }
    return output as (SelectedRow<R, S> | null)[];
  }
  async findMany<const S extends Record<string, boolean> | undefined = undefined>(options: Omit<FindOptions<D>, 'select'> & { select?: S }): Promise<SearchPage<SelectedRow<R, S>>> {
    const { scanned: _scanned, ...page } = await this.findCore(options);
    return page as SearchPage<SelectedRow<R, S>>;
  }
  async count(args: { match?: FindOptions<D>['match']; where?: unknown; maxCandidates?: number; budgets?: Pick<SearchBudgets, 'deadlineMs' | 'fetchBytes' | 'decryptedBytes' | 'decryptConcurrency'>; signal?: AbortSignal }): Promise<number> {
    const maxCandidates = args.maxCandidates ?? 20000;
    ensure(Number.isSafeInteger(maxCandidates) && maxCandidates >= 1 && maxCandidates <= 1000000, 'INVALID_VALUE');
    let count = 0, scanned = 0, cursor: string | undefined;
    do {
      const remaining = maxCandidates - scanned;
      if (remaining <= 0) fail('LIMIT_EXCEEDED');
      const page = await this.findCore({ match: args.match, where: args.where, select: {}, limit: 2000, cursor,
        budgets: { ...args.budgets, batch: 2000, maxCandidates: Math.min(remaining, 20000) }, signal: args.signal }, undefined, undefined, true);
      count += page.items.length; scanned += page.scanned;
      if (page.stopReason === 'budget-exceeded') fail('LIMIT_EXCEEDED');
      if (!page.nextCursor) return count;
      cursor = page.nextCursor;
    } while (true);
  }
  async searchWithQuery<E extends Record<string, unknown>, const S extends Record<string, boolean> | undefined = undefined>(options: Omit<FindOptions<D>, 'select'> & { select?: S } & {
    queryId: string; queryVersion: number; parameters: JsonValue;
    extra?: { [K in keyof E]: { maxBytes: number; decode?: (value: unknown) => E[K] } };
    fetchCandidates: (plan: P) => Promise<readonly { sealed: Record<string, unknown>; extra: E }[]>;
  }): Promise<{ items: { record: SelectedRow<R, S>; extra: E }[]; nextCursor: string | null; stopReason: SearchPage['stopReason'] }> {
    ensure(typeof options.queryId === 'string' && utf8(options.queryId).length >= 1 && utf8(options.queryId).length <= 128 && Number.isInteger(options.queryVersion) && options.queryVersion > 0, 'INVALID_VALUE');
    ensure(options.where === undefined, 'INVALID_VALUE');
    encodeField({ type: 'json' }, options.parameters, false);
    const extraSpec = options.extra ?? {} as NonNullable<typeof options.extra>;
    for (const [key, spec] of Object.entries(extraSpec)) ensure(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('__seal_') && Number.isInteger(spec.maxBytes) && spec.maxBytes > 0 && spec.maxBytes <= 1048576, 'INVALID_VALUE');
    const extras = new Map<string, E>();
    let extraBytes = 0;
    const override = async (args: Parameters<SealedRowAccessPort<P>['candidates']>[1], candidateSearch?: CompiledSearch): Promise<SealedPhysicalRow[]> => {
      const plan = this.binding.rows.advancedPlan({ ...args, candidateSearch });
      let result: Awaited<ReturnType<typeof options.fetchCandidates>>;
      try { result = await options.fetchCandidates(plan); } catch (error) { throw databaseError(error); }
      ensure(Array.isArray(result) && result.length <= args.limit, 'INVALID_CANDIDATE_SHAPE');
      return result.map(entry => {
        ensure(entry && typeof entry === 'object' && entry.sealed && typeof entry.sealed === 'object', 'INVALID_CANDIDATE_SHAPE');
        const sourceExtra = entry.extra ?? (Object.keys(extraSpec).length === 0 ? {} as E : undefined);
        ensure(sourceExtra && typeof sourceExtra === 'object' && !Array.isArray(sourceExtra), 'INVALID_CANDIDATE_SHAPE');
        ensure(Object.keys(sourceExtra).sort().join(',') === Object.keys(extraSpec).sort().join(','), 'INVALID_CANDIDATE_SHAPE');
        const publicExtra: Record<string, unknown> = {};
        for (const [key, spec] of Object.entries(extraSpec)) {
          const value = spec.decode ? spec.decode(sourceExtra[key]) : sourceExtra[key];
          const size = canonical(value).length;
          ensure(size <= spec.maxBytes, 'LIMIT_EXCEEDED');
          extraBytes += size;
          ensure(extraBytes <= (options.budgets?.resultBytes ?? 4 * 1024 * 1024), 'LIMIT_EXCEEDED');
          publicExtra[key] = value;
        }
        const row = entry.sealed;
        ensure(typeof row.__seal_scope === 'string' && typeof row.__seal_id === 'string' && row.__seal_revision !== undefined, 'INVALID_CANDIDATE_SHAPE');
        const fields: Record<string, Uint8Array | null> = {}, publicValues: Record<string, unknown> = {};
        for (const key of args.fields) { const value = row[`__seal_f_${key}`]; ensure(value === null || value instanceof Uint8Array || typeof value === 'string' && /^\\x(?:[0-9a-fA-F]{2})*$/.test(value), 'INVALID_CANDIDATE_SHAPE'); fields[key] = value === null ? null : typeof value === 'string' ? Uint8Array.from(value.slice(2).match(/../g) ?? [], h => parseInt(h, 16)) : Uint8Array.from(value as Uint8Array); }
        for (const key of args.public) { ensure(Object.hasOwn(row, `__seal_p_${key}`), 'INVALID_CANDIDATE_SHAPE'); publicValues[key] = row[`__seal_p_${key}`]; }
        const id = row.__seal_id;
        ensure(!extras.has(id), 'INVALID_CANDIDATE_SHAPE'); extras.set(id, publicExtra as E);
        return { scopeId: row.__seal_scope, id, revision: BigInt(row.__seal_revision as string), fields, public: publicValues, sort: row.__seal_sort === undefined ? undefined : String(row.__seal_sort) };
      });
    };
    const identity = { queryId: options.queryId, queryVersion: options.queryVersion, parameters: options.parameters, extra: Object.keys(extraSpec).sort() };
    const page = await this.findCore(options, override, identity);
    ensure(extraBytes + page.items.reduce((sum, record) => sum + canonical(record).length, 0) <= (options.budgets?.resultBytes ?? 4 * 1024 * 1024), 'LIMIT_EXCEEDED');
    const { scanned: _scanned, ...visible } = page;
    return { ...visible, items: page.items.map(record => ({ record: record as SelectedRow<R, S>, extra: extras.get(record.id as string)! })) };
  }
  private async findCore(options: FindOptions<D>, override?: (args: Parameters<SealedRowAccessPort<P>['candidates']>[1], candidateSearch?: CompiledSearch) => Promise<SealedPhysicalRow[]>, queryIdentity?: unknown, counting = false): Promise<SearchPage & { scanned: number }> {
    ensure(options && typeof options === 'object', 'INVALID_VALUE');
    if (options.signal?.aborted) fail('CANCELLED');
    const limit = options.limit ?? 50, budgets = { batch: 200, maxCandidates: 2000, fetchBytes: 4 * 1024 * 1024, decryptedBytes: 4 * 1024 * 1024, resultBytes: 4 * 1024 * 1024, deadlineMs: 2000, decryptConcurrency: 64, ...options.budgets };
    ensure(Number.isInteger(limit) && limit >= 1 && limit <= (counting ? 2000 : 200), 'INVALID_VALUE');
    for (const [key, value] of Object.entries(budgets)) ensure(Number.isSafeInteger(value) && value > 0 && value <= ({ batch: counting ? 2000 : 500, maxCandidates: 20000, fetchBytes: 32 * 1024 * 1024, decryptedBytes: 32 * 1024 * 1024, resultBytes: 32 * 1024 * 1024, deadlineMs: 30000, decryptConcurrency: 64 } as Record<string, number>)[key], 'INVALID_VALUE');
    const deadline = Date.now() + budgets.deadlineMs;
    const prepareCheck = () => { if (options.signal?.aborted) fail('CANCELLED'); ensure(Date.now() < deadline, 'LIMIT_EXCEEDED'); };
    if (options.orderBy) ensure(this.binding.definition.orderable.includes(options.orderBy.field) && ['asc', 'desc'].includes(options.orderBy.direction), 'INVALID_VALUE');
    const selected = this.selection(options.select), { snapshot, ring } = await this.context(this.binding.executor);
    prepareCheck();
    const ast = options.match?.(searchFields(this.binding.definition));
    if (ast) validateSearch(ast, this.binding.definition);
    const compiled = ast ? await compileSearch(ast, this.binding.definition, snapshot.profiles, ring, this.scopeId,
      this.repository.tokenCache, prepareCheck) : undefined;
    const hasSubstring = (node: CompiledSearch): boolean => node.op === 'leaf' ? node.leaf.profile.mode === 'substring' : node.children.some(hasSubstring);
    prepareCheck();
    const conditions = new Set<string>();
    const visit = (node: SearchNode) => { if (node.op === 'all' || node.op === 'any') node.children.forEach(visit); else conditions.add(node.field); };
    if (ast) visit(ast);
    const fields = [...new Set([...conditions, ...selected.fields])], pub = selected.public;
    for (const key of pub) {
      const column = this.binding.definition.columns[key], type = column.getSQLType();
      const bound = this.binding.definition.publicBounds[key] ?? (['uuid', 'boolean', 'smallint', 'integer', 'bigint', 'timestamp with time zone'].includes(type) ? 128 : undefined);
      ensure(bound && bound > 0, 'UNBOUNDED_PROJECTION');
    }
    let batch = Math.min(budgets.batch, limit + Math.ceil(limit / 4) + 2);
    const filter = options.where === undefined ? null : this.binding.executor.fingerprintWhere?.(options.where);
    ensure(options.where === undefined || filter !== undefined, 'INVALID_VALUE');
    const digestInput = canonical({ ast: ast ?? null, select: [...fields, ...pub].sort(), orderBy: options.orderBy ?? null, limit, filter, queryIdentity: queryIdentity ?? null });
    const queryDigest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(digestInput).buffer)));
    const cursorContext = { modelId: this.binding.definition.id, scopeId: this.scopeId, keyScopeId: snapshot.keyScopeId, queryDigest };
    const opened = options.cursor ? await openCursor(options.cursor, cursorContext, ring) : undefined;
    let after: { id: string; sort?: string } | undefined = opened ? { id: opened.lastId, sort: opened.lastSort } : undefined;
    const items: Record<string, unknown>[] = [];
    let scanned = 0, fetchedBytes = 0, decryptedBytes = 0, resultBytes = 0;
    let verifiedCandidates = 0, verifiedMatches = 0;
    let stopReason: SearchPage['stopReason'] = 'exhausted';
    const checkpoint = () => { if (options.signal?.aborted) fail('CANCELLED'); if (Date.now() >= deadline) return false; return true; };
    const comparePosition = (left: { id: string; sort?: string }, right: { id: string; sort?: string }) => {
      if (options.orderBy) {
        ensure(left.sort !== undefined && right.sort !== undefined, 'INVALID_CANDIDATE_SHAPE');
        const type = this.binding.definition.columns[options.orderBy.field].getSQLType();
        const c = type === 'integer' || type === 'bigint' ? (BigInt(left.sort) < BigInt(right.sort) ? -1 : BigInt(left.sort) > BigInt(right.sort) ? 1 : 0) : compareText(left.sort, right.sort);
        if (c) return c;
      }
      return compareText(left.id, right.id);
    };
    outer: while (true) {
      if (!checkpoint() || scanned >= budgets.maxCandidates) { if (!scanned) fail('LIMIT_EXCEEDED'); stopReason = 'budget-exceeded'; break; }
      const requestLimit = Math.min(batch, budgets.maxCandidates - scanned);
      // The prefix decides sufficiency before parent filters, so it is safe only for ID order without a public WHERE.
      const candidateSql = compiled ? candidateStatement(this.binding.definition, this.binding.storage, this.scopeId, compiled,
        !override && !options.where && !options.orderBy && requestLimit <= 200 && hasSubstring(compiled) ? { limit: requestLimit, after: after?.id } : undefined) : undefined;
      const request = { scopeId: this.scopeId, fields, public: pub, where: options.where, after, orderBy: options.orderBy, limit: requestLimit, candidateSql };
      const rows = override ? await override(request, compiled) : await this.binding.rows.candidates(this.binding.executor, request);
      ensure(rows.length <= batch, 'INVALID_CANDIDATE_SHAPE');
      if (!rows.length) break;
      const prepared: { row: SealedPhysicalRow; position: { id: string; sort?: string }; get: (key: string) => Promise<unknown> }[] = [];
      let fetchedLimit = false;
      for (const row of rows) {
        if (!checkpoint()) { if (!scanned) fail('LIMIT_EXCEEDED'); stopReason = 'budget-exceeded'; break outer; }
        const position = { id: row.id, sort: row.sort };
        const previous = prepared.at(-1)?.position ?? after;
        ensure(row.scopeId === this.scopeId && row.revision >= 1n && row.revision <= maxRevision && (!previous || (options.orderBy?.direction === 'desc' ? comparePosition(position, previous) < 0 : comparePosition(position, previous) > 0)), 'INVALID_CANDIDATE_SHAPE');
        let rowBytes = 2048 + this.publicSize(row, pub);
        for (const key of fields) { const encrypted = row.fields[key]; ensure(encrypted !== undefined, 'INVALID_CANDIDATE_SHAPE'); rowBytes += encrypted?.length ?? 0; }
        if (fetchedBytes + rowBytes > budgets.fetchBytes) { fetchedLimit = true; break; }
        fetchedBytes += rowBytes;
        const cache = new Map<string, Promise<unknown>>();
        const get = (key: string): Promise<unknown> => {
          const cached = cache.get(key); if (cached) return cached;
          const encrypted = row.fields[key], spec = this.binding.definition.fields[key];
          ensure(encrypted !== undefined, 'INVALID_CANDIDATE_SHAPE');
          const estimated = encrypted === null ? 0 : encrypted.length - 29;
          ensure(estimated >= 0, 'INVALID_CANDIDATE_SHAPE');
          if (decryptedBytes + estimated > budgets.decryptedBytes) fail('LIMIT_EXCEEDED');
          decryptedBytes += estimated;
          const pending = encrypted === null ? Promise.resolve(null) : this.openField(encrypted, key, row.id, snapshot, ring);
          cache.set(key, pending); return pending;
        };
        prepared.push({ row, position, get });
      }
      if (!prepared.length && fetchedLimit) { if (!scanned) fail('LIMIT_EXCEEDED'); stopReason = 'budget-exceeded'; break; }
      try {
        const conditionTasks = prepared.flatMap(item => [...conditions].map(key => ({ item, key })));
        await mapBounded(conditionTasks, budgets.decryptConcurrency, async ({ item, key }) => { await item.get(key); });
      } catch (error) {
        if (error instanceof SealError && error.code === 'LIMIT_EXCEEDED' && scanned > 0) { stopReason = 'budget-exceeded'; break; }
        throw error;
      }
      let matches: boolean[];
      try {
        matches = compiled ? await mapBounded(prepared, budgets.decryptConcurrency, item => {
          if (!checkpoint()) fail('LIMIT_EXCEEDED');
          return verifySearch(compiled, item.get);
        }) : prepared.map(() => true);
      } catch (error) {
        if (error instanceof SealError && error.code === 'LIMIT_EXCEEDED' && scanned > 0) { stopReason = 'budget-exceeded'; break; }
        throw error;
      }
      const consumed: { item: typeof prepared[number]; matched: boolean }[] = [];
      let accepted = 0;
      for (let i = 0; i < prepared.length; i++) {
        if (!checkpoint()) { if (!scanned) fail('LIMIT_EXCEEDED'); stopReason = 'budget-exceeded'; break outer; }
        consumed.push({ item: prepared[i], matched: matches[i] });
        if (matches[i] && ++accepted === limit - items.length) break;
      }
      const keep = consumed.filter(entry => entry.matched);
      let allowed = 0, reservedBytes = decryptedBytes;
      for (const { item } of keep) {
        let extra = 0;
        for (const key of selected.fields) if (!conditions.has(key)) {
          const encrypted = item.row.fields[key];
          ensure(encrypted !== undefined, 'INVALID_CANDIDATE_SHAPE');
          extra += encrypted === null ? 0 : encrypted.length - 29;
        }
        if (reservedBytes + extra > budgets.decryptedBytes) break;
        reservedBytes += extra; allowed++;
      }
      const projected = keep.slice(0, allowed);
      const projectionTasks = projected.flatMap(({ item }) => selected.fields.map(key => ({ item, key })));
      const values = await mapBounded(projectionTasks, budgets.decryptConcurrency, async ({ item, key }) => {
        try { if (!checkpoint()) fail('LIMIT_EXCEEDED'); return { value: await item.get(key) }; }
        catch (error) { return { error }; }
      });
      let projectedIndex = 0;
      for (const { item, matched } of consumed) {
        if (!checkpoint()) { if (!scanned) fail('LIMIT_EXCEEDED'); stopReason = 'budget-exceeded'; break outer; }
        if (matched) {
          if (projectedIndex >= allowed) { if (!scanned) fail('LIMIT_EXCEEDED'); stopReason = 'budget-exceeded'; break outer; }
          const result: Record<string, unknown> = { id: item.row.id, revision: item.row.revision, ...item.row.public };
          for (let fieldIndex = 0; fieldIndex < selected.fields.length; fieldIndex++) {
            const outcome = values[projectedIndex * selected.fields.length + fieldIndex];
            if ('error' in outcome) {
              if (outcome.error instanceof SealError && outcome.error.code === 'LIMIT_EXCEEDED' && scanned > 0) { stopReason = 'budget-exceeded'; break outer; }
              throw outcome.error;
            }
            result[selected.fields[fieldIndex]] = outcome.value;
          }
          const size = canonical(result).length;
          if (resultBytes + size > budgets.resultBytes) { if (!scanned) fail('LIMIT_EXCEEDED'); stopReason = 'budget-exceeded'; break outer; }
          resultBytes += size; items.push(result); projectedIndex++;
        }
        after = item.position; scanned++;
        if (items.length === limit) { stopReason = 'page-full'; break outer; }
      }
      if (fetchedLimit) { stopReason = 'budget-exceeded'; break; }
      if (rows.length < request.limit) break;
      // Grow only after a short page. This call's authenticated pass rate is
      // enough to estimate the next batch; no frequency state survives it.
      verifiedCandidates += consumed.length;
      verifiedMatches += keep.length;
      const remaining = limit - items.length;
      const estimated = verifiedMatches === 0 ? batch * 2 : Math.ceil(remaining * verifiedCandidates / verifiedMatches * 1.25);
      batch = Math.min(budgets.batch, Math.max(batch * 2, estimated));
    }
    const nextCursor = stopReason === 'exhausted' ? null : await sealCursor(cursorContext, { lastId: after!.id, lastSort: after!.sort }, ring);
    return { items, nextCursor, stopReason, scanned };
  }
}

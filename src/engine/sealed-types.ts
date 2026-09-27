import type { FieldSpec, SearchProtection } from '../core/field-codec.js';
import type { SearchProfile } from '../core/search-tokens.js';
import type { CompiledSearch } from '../core/search-predicate.js';

export interface SealedModelDefinition {
  id: string;
  searchProtection?: SearchProtection;
  identity: { scope: string; row: string; revision: string };
  fields: Record<string, FieldSpec>;
  columns: Record<string, { name: string; getSQLType(): string; notNull: boolean; hasDefault: boolean; generated?: unknown }>;
  scopeType: 'uuid' | 'text'; rowType: 'uuid' | 'text';
  orderable: readonly string[]; publicBounds: Readonly<Record<string, number>>;
}
export interface SealedStorage {
  parent: { schema: string; name: string };
  index?: { schema: string; name: string; layout?: 'companion-v1'; profiles?: Record<string, { tokens: string; assignments?: string; mode: 'exact' | 'substring'; protection: SearchProtection }> };
}
export interface RuntimeSnapshot {
  keyScopeId: string;
  profiles: SearchProfile[];
}
export interface SealedSqlExecutor {
  query(statement: { text: string; values: unknown[] }): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  transaction<T>(fn: (tx: SealedSqlExecutor) => Promise<T>): Promise<T>;
  fingerprintWhere?(where: unknown): unknown;
}
export interface SealedPhysicalRow {
  scopeId: string; id: string; revision: bigint;
  fields: Record<string, Uint8Array | null>;
  public: Record<string, unknown>;
  sort?: string;
}
export interface SealedAdvancedPlan {
  readonly batchSize: number;
  selection(): unknown;
  where(): unknown;
  orderBy(): readonly unknown[];
  sql(options?: { alias?: string }): unknown;
}
export interface SealedRowAccessPort<P extends SealedAdvancedPlan = SealedAdvancedPlan> {
  insert(executor: SealedSqlExecutor, args: { scopeId: string; id: string; fields: Record<string, Uint8Array | null>; public: Record<string, unknown> }): Promise<number>;
  update(executor: SealedSqlExecutor, args: { scopeId: string; id: string; expectedRevision: bigint; fields: Record<string, Uint8Array | null>; public: Record<string, unknown> }): Promise<number>;
  delete(executor: SealedSqlExecutor, args: { scopeId: string; id: string; expectedRevision: bigint }): Promise<number>;
  get(executor: SealedSqlExecutor, args: { scopeId: string; id: string; fields: string[]; public: string[]; lock?: 'share' }): Promise<SealedPhysicalRow | null>;
  candidates(executor: SealedSqlExecutor, args: { scopeId: string; fields: string[]; public: string[]; where?: unknown; after?: { id: string; sort?: string }; orderBy?: { field: string; direction: 'asc' | 'desc' }; limit: number; candidateSql?: { text: string; values: unknown[] } }): Promise<SealedPhysicalRow[]>;
  advancedPlan(args: { scopeId: string; fields: string[]; public: string[]; after?: { id: string; sort?: string }; orderBy?: { field: string; direction: 'asc' | 'desc' }; limit: number; candidateSql?: { text: string; values: unknown[] }; candidateSearch?: CompiledSearch }): P;
}

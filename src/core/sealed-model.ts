import type { FieldSpec, SearchProtection } from './field-codec.js';

export interface SealedModelDefinition {
  id: string;
  identity: { row: string; scope?: string };
  fields: Record<string, FieldSpec>;
  columns: Record<string, { name: string; getSQLType(): string; notNull: boolean; generated?: unknown }>;
  scopeType: 'uuid' | 'text'; rowType: 'uuid' | 'text';
}
export interface SealedStorage {
  parent: { schema: string; name: string };
  index?: { schema: string; name: string; profiles?: Record<string, {
    tokens: string; mode: 'exact' | 'substring'; protection: SearchProtection;
  }> };
}

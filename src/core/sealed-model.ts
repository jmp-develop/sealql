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
    exact?: { salt: string; stamp: string };
    positions?: { salt: string; length: string; stamps: string; offsets: string };
    words?: { salt: string; length: string; stamps: string; offsets: string };
    singles?: { salt: string; length: string; stamps: string; offsets: string };
  }> };
}
export type ProfileStorage = NonNullable<NonNullable<SealedStorage['index']>['profiles']>[string];
export const profileColumns = (profile: ProfileStorage): string[] => [profile.tokens,
  ...[profile.exact, profile.positions, profile.words, profile.singles].flatMap(group => group ? Object.values(group) : [])];

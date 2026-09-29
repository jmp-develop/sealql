import { ensure } from './errors.js';
import { profiles } from './search-tokens.js';
import type { SealedModelDefinition, SealedStorage } from './sealed-model.js';

/** Stable physical names independent of field declaration order and key scope. */
function suffix(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
export const companionIndexName = (tableName: string, indexId: string) => `seal_${suffix(`${tableName}/${indexId}`)}`;

export function companionProfiles(definition: SealedModelDefinition): NonNullable<NonNullable<SealedStorage['index']>['profiles']> {
  const result: NonNullable<NonNullable<SealedStorage['index']>['profiles']> = {};
  const names = new Set<string>();
  for (const [key, spec] of Object.entries(definition.fields)) {
    for (const profile of profiles(definition.id, spec.id ?? key, spec)) {
      ensure(!Object.hasOwn(result, profile.indexId), 'INVALID_SCHEMA');
      const tag = suffix(profile.indexId);
      const tokens = `tokens_${tag}`;
      ensure(!names.has(tokens), 'INVALID_SCHEMA');
      names.add(tokens);
      const positions = (prefix: string) => ({ salt: `${prefix}_salt_${tag}`, length: `${prefix}_len_${tag}`,
        stamps: `${prefix}_stamps_${tag}`, offsets: `${prefix}_offsets_${tag}` });
      result[profile.indexId] = { tokens, mode: profile.mode, protection: 'standard',
        ...(profile.mode === 'exact' ? { exact: { salt: `eq_salt_${tag}`, stamp: `eq_stamp_${tag}` } }
          : { positions: positions('pos') }) };
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

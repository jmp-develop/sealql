import { getTableConfig } from 'drizzle-orm/pg-core';
export { createSealed } from './native.js';
export type { Sealed, Opened } from './native.js';
import { bindSealed as bindEngine } from '../../../engine/sealed-repository.js';
import type { SealedStorage } from '../../../engine/sealed-types.js';
import type { Sealer } from '../../../core/field-cipher.js';
import { DrizzleRowAccess, type DrizzleSealedExecutor, drizzleExecutor } from '../sealed-row.js';
import { ciphertext, defineSealed, defineSealStorage, sealTextId, type SealedDefinition, type ManagedInsert, type ManagedRow } from '../sealed-schema.js';

export { ciphertext, defineSealed, defineSealStorage, sealTextId, drizzleExecutor };
export type { SealedDefinition, ManagedInsert, ManagedRow, DrizzleSealedExecutor };
function location(table: import('drizzle-orm/pg-core').PgTable) { const config = getTableConfig(table); return { schema: config.schema ?? 'public', name: config.name }; }
function physical(definition: SealedDefinition, storage: ReturnType<typeof defineSealStorage>): SealedStorage {
  return { parent: location(definition.table), index: storage.index ? { ...location(storage.index), layout: 'companion-v1', profiles: storage.profiles } : undefined };
}
export function bindSealed<D extends SealedDefinition>(options: { sealer: Sealer; definition: D; storage: ReturnType<typeof defineSealStorage>; executor: DrizzleSealedExecutor }) {
  const mapped = physical(options.definition, options.storage);
  return bindEngine<D, ReturnType<DrizzleRowAccess['advancedPlan']>, ManagedInsert<D>, ManagedRow<D>>({ ...options, storage: mapped, rows: new DrizzleRowAccess(options.definition, mapped) });
}

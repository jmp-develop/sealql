import { bindSealed as bindEngine } from '../../engine/sealed-repository.js';
import type { Sealer } from '../../core/field-cipher.js';
import type { SealedModelDefinition, SealedSqlExecutor, SealedStorage } from '../../engine/sealed-types.js';
import { PostgresRowAccess, postgresExecutor } from './sealed-row.js';
export { defineSealedModel, definePostgresStorage } from './sealed-schema.js';
export { postgresExecutor };
export type { SealedSqlExecutor, SealedModelDefinition, SealedStorage } from '../../engine/sealed-types.js';
export { pgsql as pgSql } from './fragment.js';
export function bindSealed<D extends SealedModelDefinition>(options: { sealer: Sealer; definition: D; storage: SealedStorage; executor: SealedSqlExecutor }) {
  return bindEngine({ ...options, rows: new PostgresRowAccess(options.definition, options.storage) });
}

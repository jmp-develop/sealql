/** A fixed key may be loaded by the application before binding a repository. */
import { createSealer } from 'sealql';
import { bindSealed } from 'sealql/postgres';
import { definition, storage, poolExecutor } from './standard-raw.js';
import type { Pool } from 'pg';

export function bindWithKey(pool: Pool, key: Uint8Array) {
  const sealer = createSealer({ key });
  return { sealer, notes: bindSealed({ sealer, definition, storage, executor: poolExecutor(pool) }) };
}

/** Exact count scans and verifies candidates up to the explicit bound. */
export async function countMatching(pool: Pool, key: Uint8Array, scopeId: string) {
  const { notes } = bindWithKey(pool, key);
  return notes.forScope({ scopeId }).count({ match: f => f.body.contains('ell'), maxCandidates: 10000 });
}

/** Condition and projection fields share one bounded authentication pool. */
export async function findMatching(pool: Pool, key: Uint8Array, scopeId: string) {
  const { notes } = bindWithKey(pool, key);
  return notes.forScope({ scopeId }).findMany({ match: f => f.body.contains('ell'), limit: 20, budgets: { decryptConcurrency: 64 } });
}

/** Authenticate an already fetched raw JOIN projection with a bounded field pool. */
export async function decryptJoinedNotes(pool: Pool, key: Uint8Array, scopeId: string, rows: readonly Record<string, unknown>[]) {
  const { notes } = bindWithKey(pool, key);
  return notes.forScope({ scopeId }).decryptRows({ rows,
    mapping: { scope: 'scope_id', row: 'id', revision: 'revision', fields: { body: 'body_ct' }, public: { status: 'status' } },
    select: { body: true, status: true }, budgets: { decryptConcurrency: 64 } });
}

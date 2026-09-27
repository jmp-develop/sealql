/** Raw PostgreSQL example. Apply reviewed `ddl` separately before setup. */
import type { Pool, PoolClient } from 'pg';
import { createSealer } from 'sealql';
import { bindSealed, definePostgresStorage, defineSealedModel, pgSql, postgresExecutor, type SealedSqlExecutor } from 'sealql/postgres';

const model = defineSealedModel({
  id: 'raw_note', identity: { scope: 'uuid', row: 'uuid', revision: 'bigint' },
  // substring: true stores skip grams by default; use { skipGrams: false } to opt out.
  fields: { body: { type: 'text', nullable: false, search: { exact: true, substring: true } } },
  public: { status: { type: 'text', nullable: false, maxBytes: 32 } },
});
export const { definition, storage, ddl } = definePostgresStorage(model, {
  table: 'raw_note', identity: { scope: 'scope_id', row: 'id', revision: 'revision' },
  fields: { body: 'body_ct' }, public: { status: 'status' },
});

function onClient(client: PoolClient): SealedSqlExecutor {
  const tx: SealedSqlExecutor = {
    query: async statement => {
      const result = await client.query(statement.text, statement.values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    transaction: fn => fn(tx),
  };
  return tx;
}
export function poolExecutor(pool: Pool): SealedSqlExecutor {
  return postgresExecutor({
    query: async statement => {
      const result = await pool.query(statement.text, statement.values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    transaction: async fn => {
      const client = await pool.connect();
      let callbackFinished = false;
      try {
        await client.query('begin isolation level read committed');
        const result = await fn(onClient(client));
        callbackFinished = true;
        await client.query('commit');
        return result;
      } catch (error) {
        try { await client.query('rollback'); } catch { /* connection may be gone */ }
        if (callbackFinished) throw new Error('Commit outcome unknown; reconcile before retry');
        throw error;
      } finally { client.release(); }
    },
  });
}

export function setup(pool: Pool, rootKey: Uint8Array) {
  const sealer = createSealer({ key: rootKey });
  const binding = { sealer, definition, storage, executor: poolExecutor(pool) };
  return { sealer, notes: bindSealed(binding) };
}

export async function example(pool: Pool, rootKey: Uint8Array, scopeId: string, id: string) {
  const { sealer, notes } = setup(pool, rootKey);
  const scoped = notes.forScope({ scopeId });
  await scoped.insert({ id, data: { body: 'hello', status: 'open' } });
  const page = await scoped.findMany({ match: f => f.body.contains('ell'), select: { body: true }, limit: 20 });
  const advanced = await scoped.searchWithQuery({
    queryId: 'raw-note-status', queryVersion: 1, parameters: { status: 'open' },
    match: f => f.body.contains('ell'), select: { body: true },
    extra: { status: { maxBytes: 32 } }, limit: 20,
    fetchCandidates: async plan => {
      const parts = plan.sql({ alias: 'n' });
      const statement = pgSql`select ${parts.selection},"n"."status" as "status" from "raw_note" as "n" where ${parts.where} and "n"."status"=${'open'} order by ${parts.orderBy} limit ${parts.limit}`.compile();
      return parts.decodeRows((await poolExecutor(pool).query(statement)).rows);
    },
  });
  return { page, advanced };
}

/** Bind the same physical client inside an application's existing transaction. */
export async function insertInCallerTransaction(client: PoolClient, rootKey: Uint8Array, scopeId: string, id: string) {
  const sealer = createSealer({ key: rootKey });
  const executor = postgresExecutor(onClient(client));
  const notes = bindSealed({ sealer, definition, storage, executor });
  return notes.forScope({ scopeId }).insert({ id, data: { body: 'inside caller transaction', status: 'open' } });
}

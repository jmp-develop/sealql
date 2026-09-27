/** Install the plaintext fixture's required extension only on the owned disposable cluster. */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439, 'Wrong port');
  await pool.query('create extension if not exists pg_trgm');
  console.log('pg_trgm ready');
} finally { await pool.end(); }

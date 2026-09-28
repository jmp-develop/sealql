/** One-time read-only dump of bench_realistic_100k.customers plaintext into .local (gitignored) for in-memory research. */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

assert(existsSync('.local/research/db-free.flag'), 'DB busy: flag missing');
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=300000' });
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const cols = (await pool.query(`select column_name from information_schema.columns where table_schema='bench_realistic_100k' and table_name='customers' order by ordinal_position`)).rows.map(r => r.column_name);
  console.log(cols.join(','));
  const fields = ['name', 'phone', 'address', 'memo', 'email', 'company'];
  const rows = (await pool.query(`select id::text, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id`)).rows;
  writeFileSync('.local/research/r2-fixture.json', JSON.stringify(rows));
  console.log('rows', rows.length);
} finally { await pool.end(); }

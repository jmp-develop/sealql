import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  for (const table of ['customers', 'tickets']) {
    const cols = (await pool.query(`select column_name,data_type from information_schema.columns where table_schema='bench_realistic_100k' and table_name=$1 order by ordinal_position`, [table])).rows;
    const count = (await pool.query(`select count(*)::int n from bench_realistic_100k.${table}`)).rows[0].n;
    console.log(JSON.stringify({ table, count, cols }));
  }
  console.log(JSON.stringify({ schemas: (await pool.query("select nspname from pg_namespace where nspname like 'native_verify_%' order by 1")).rows }));
  console.log(JSON.stringify({ ticketIndexes:(await pool.query(`select schemaname,tablename,indexname,indexdef from pg_indexes
    where (schemaname='bench_realistic_100k' and tablename='tickets')
       or (schemaname='bench_standard_next_100k' and tablename='tickets_skip')
       or (schemaname='native_verify_main' and tablename='tickets') order by schemaname,indexname`)).rows }));
} finally { await pool.end(); }

import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const pool = new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const database=(await pool.query('select pg_database_size(current_database()) bytes')).rows[0];
  const source=(await pool.query("select count(*) n from bench_realistic_100k.customers where scope_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'")).rows[0];
  const tables=(await pool.query(`select schemaname,relname,pg_total_relation_size(format('%I.%I',schemaname,relname)::regclass) bytes
    from pg_stat_user_tables where schemaname in ('bench_realistic_100k','native_verify_main','native_scale_100m')
    order by schemaname,relname`)).rows;
  console.log(JSON.stringify({databaseBytes:Number(database.bytes),sourceCustomers:Number(source.n),tables},null,2));
} finally { await pool.end(); }

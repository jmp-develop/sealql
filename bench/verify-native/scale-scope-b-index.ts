/** Add a scope/id access path to the 100m-row plain comparison table. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',
  options:'-c statement_timeout=0'});
try{
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const source=(await pool.query(`select indexname,indexdef from pg_indexes where schemaname='bench_realistic_100k'
    and tablename='customers' and indexname='customers_scope_id_id_key'`)).rows;
  assert.equal(source.length,1);
  assert.match(source[0].indexdef,/^CREATE UNIQUE INDEX customers_scope_id_id_key ON bench_realistic_100k\.customers USING btree \(scope_id, id\)$/);
  const name=source[0].indexname as string;
  const prior=(await pool.query(`select indexname from pg_indexes where schemaname='native_scale_100m'
    and tablename='customers_plain' and indexname=$1`,[name])).rows;
  assert.equal(prior.length,0,'scope index already exists');
  await pool.query("set maintenance_work_mem='4GB'");
  await pool.query('set max_parallel_maintenance_workers=8');
  const start=performance.now();
  await pool.query(`create unique index ${name} on native_scale_100m.customers_plain(scope_id,id)`);
  const elapsedMs=performance.now()-start;
  await pool.query('analyze native_scale_100m.customers_plain');
  const report={name,definition:'UNIQUE (scope_id,id) B-tree',sourceDefinition:source[0].indexdef,
    elapsedMs,maintenanceWorkMem:'4GB',maxParallelMaintenanceWorkers:8,table:'native_scale_100m.customers_plain'};
  await writeFile('bench/results/2026-09-27-native-scale-100m/scope-b/plain-scope-index.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{await pool.end();}

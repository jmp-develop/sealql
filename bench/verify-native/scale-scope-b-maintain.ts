/** Clear GIN pending writes and refresh all three table statistics after rebinding. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',
  options:'-c statement_timeout=600000'});
try{
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const rows=(await pool.query(`select indexname from pg_indexes where schemaname='native_scale_100m'
    and tablename='customers_seal_index' and indexdef like '%USING gin%'`)).rows;
  assert.equal(rows.length,1);
  const index=`native_scale_100m.${rows[0].indexname}`;
  const before=(await pool.query('select pending_pages,pending_tuples from pgstatginindex($1::regclass)',[index])).rows[0];
  if(Number(before.pending_pages)>0)await pool.query('select gin_clean_pending_list($1::regclass)',[index]);
  const after=(await pool.query('select pending_pages,pending_tuples from pgstatginindex($1::regclass)',[index])).rows[0];
  assert.equal(Number(after.pending_pages),0);
  for(const table of ['customers','customers_seal_index','customers_plain']){
    await pool.query(`analyze native_scale_100m.${table}`);
    console.log(JSON.stringify({analyzed:table}));
  }
  const report={index,pendingBefore:before,pendingAfter:after,analyzed:['customers','customers_seal_index','customers_plain']};
  await writeFile('bench/results/2026-09-27-native-scale-100m/scope-b/maintenance.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{await pool.end();}

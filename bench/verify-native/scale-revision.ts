import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const x=(await pool.query('select min(revision) min,max(revision) max from bench_realistic_100k.customers')).rows[0];
  assert.equal(String(x.min),'1');assert.equal(String(x.max),'1');
  await pool.query('alter table native_scale_100m.customers_plain add column if not exists revision bigint not null default 1');
  console.log(JSON.stringify({sourceRevisionMin:x.min,sourceRevisionMax:x.max,plainRevisionAdded:true}));
}finally{await pool.end();}

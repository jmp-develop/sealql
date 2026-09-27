/** Temporarily suspend only the scale companion's autovacuum for timed reads. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const action=process.argv[2];assert(action==='pause'||action==='restore');
const table='native_scale_100m.customers_seal_index';
const path='bench/results/2026-09-27-native-scale-100m/scope-b/autovacuum.json';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  if(action==='pause'){
    const options=(await pool.query('select reloptions from pg_class where oid=$1::regclass',[table])).rows[0].reloptions as string[]|null;
    assert(!options?.some(x=>x.startsWith('autovacuum_enabled=')),'manual autovacuum setting already exists');
    const active=(await pool.query(`select pid from pg_stat_activity where backend_type='autovacuum worker'
      and query like $1`,[`%${table}%`])).rows.map(r=>Number(r.pid));
    await pool.query(`alter table ${table} set (autovacuum_enabled=false)`);
    for(const pid of active)await pool.query('select pg_cancel_backend($1)',[pid]);
    const state={table,previousOptions:options,pausedAt:new Date().toISOString(),cancelledPids:active};
    await writeFile(path,JSON.stringify(state,null,2)+'\n');
    console.log(JSON.stringify(state));
  }else{
    const state=JSON.parse(await readFile(path,'utf8'));
    assert.equal(state.table,table);
    await pool.query(`alter table ${table} reset (autovacuum_enabled)`);
    state.restoredAt=new Date().toISOString();
    await writeFile(path,JSON.stringify(state,null,2)+'\n');
    console.log(JSON.stringify(state));
  }
}finally{await pool.end();}

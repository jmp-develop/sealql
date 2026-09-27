/** Read-only audit of the deferred ticket indexes and validated companion FK. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n),1000);
  assert(Number((await pool.query('select count(*) n from native_scale_100m.ticket_progress')).rows[0].n)>0);
  const names=async(schema:string,tables:string[])=>(await pool.query(`select tablename,indexname,indexdef
    from pg_indexes where schemaname=$1 and tablename=any($2) order by tablename,indexname`,[schema,tables])).rows;
  const base=await names('native_verify_main',['tickets','tickets_seal_index']);
  const scale=await names('native_scale_100m',['tickets','tickets_seal_index']);
  assert.deepEqual(scale.map(x=>[x.tablename,x.indexname]),base.map(x=>[x.tablename,x.indexname]));
  const plain=await names('native_scale_100m',['tickets_plain']);assert.equal(plain.length,13);
  const ginName=scale.filter(x=>x.indexname.endsWith('_gin'));assert.equal(ginName.length,1);
  const gin=(await pool.query('select pending_pages,pending_tuples from pgstatginindex($1::regclass)',
    [`native_scale_100m.${ginName[0].indexname}`])).rows[0];
  assert.equal(Number(gin.pending_pages),0);
  const fk=(await pool.query(`select conname,convalidated from pg_constraint
    where conrelid='native_scale_100m.tickets_seal_index'::regclass and contype='f'`)).rows;
  assert.equal(fk.length,1);assert.equal(fk[0].convalidated,true);
  const stats=(await pool.query(`select relname,last_vacuum,last_analyze from pg_stat_user_tables
    where schemaname='native_scale_100m' and relname=any($1) order by relname`,[['tickets','tickets_plain','tickets_seal_index']])).rows;
  assert.equal(stats.length,3);for(const s of stats){assert(s.last_vacuum);assert(s.last_analyze);}
  const result={baseIndexes:base.length,scaleIndexes:scale.length,plainIndexes:plain.length,
    productIndexNames:scale.map(x=>x.indexname),plainIndexNames:plain.map(x=>x.indexname),ginPending:gin,
    foreignKey:fk[0],stats};
  await writeFile('bench/results/2026-09-27-native-scale-100m/ticket-index-audit.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({productIndexes:scale.length,plainIndexes:plain.length,fkValidated:true,vacuumAnalyzed:true}));
}finally{await pool.end();}

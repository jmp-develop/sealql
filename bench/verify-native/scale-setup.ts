/** Create only derived heaps; business indexes and foreign keys are built after load. */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId } from './schema.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from bench_realistic_100k.customers where scope_id=$1',[scopeId])).rows[0].n),100000);
  assert.equal(Number((await pool.query('select count(*) n from native_verify_main.customers_seal_index where scope_id=$1',[scopeId])).rows[0].n),100000);
  await pool.query('create schema if not exists native_scale_100m');
  await pool.query('create table if not exists native_scale_100m.customers (like native_verify_main.customers including defaults)');
  await pool.query('create table if not exists native_scale_100m.customers_seal_index (like native_verify_main.customers_seal_index including defaults)');
  await pool.query(`create table if not exists native_scale_100m.customers_plain as
    select id,scope_id,revision,${fields.flatMap(f=>[`${f}_plain`,`${f}_norm`]).join(',')}
    from bench_realistic_100k.customers where false`);
  await pool.query(`create table if not exists native_scale_100m.progress (
    copy_no integer primary key check(copy_no between 0 and 999),
    elapsed_ms double precision not null,completed_at timestamptz not null default now())`);
  for(const t of ['customers','customers_seal_index','customers_plain']){
    const indexes=(await pool.query('select count(*) n from pg_indexes where schemaname=$1 and tablename=$2',['native_scale_100m',t])).rows[0].n;
    assert.equal(Number(indexes),0,`${t} must have no indexes during load`);
  }
  console.log(JSON.stringify({schema:'native_scale_100m',targetCopies:1000,targetRows:100000000,indexesDeferred:true}));
}finally{await pool.end();}

/** Ticket heaps are created only after the customer space checkpoint allows expansion. */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId } from './schema.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n),1000);
  assert.equal(Number((await pool.query('select count(*) n from bench_realistic_100k.tickets where scope_id=$1',[scopeId])).rows[0].n),100000);
  await pool.query('create table if not exists native_scale_100m.tickets (like native_verify_main.tickets including defaults)');
  await pool.query('create table if not exists native_scale_100m.tickets_seal_index (like native_verify_main.tickets_seal_index including defaults)');
  await pool.query(`create table if not exists native_scale_100m.tickets_plain as
    select id,scope_id,customer_id,revision,${fields.flatMap(f=>[`${f}_plain`,`${f}_norm`]).join(',')}
    from bench_realistic_100k.tickets where false`);
  await pool.query(`create table if not exists native_scale_100m.ticket_progress (
    copy_no integer primary key check(copy_no between 0 and 999),
    elapsed_ms double precision not null,completed_at timestamptz not null default now())`);
  for(const t of ['tickets','tickets_seal_index','tickets_plain'])
    assert.equal(Number((await pool.query('select count(*) n from pg_indexes where schemaname=$1 and tablename=$2',['native_scale_100m',t])).rows[0].n),0);
  console.log(JSON.stringify({ticketsReady:true,indexesDeferred:true}));
}finally{await pool.end();}

import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const p=(await pool.query(`select count(*)::int copies,min(completed_at) started,max(completed_at) latest,
    sum(elapsed_ms)::double precision load_ms from native_scale_100m.progress`)).rows[0];
  const tail=(await pool.query(`select count(*)::int copies,min(completed_at) started,max(completed_at) latest
    from (select completed_at from native_scale_100m.progress order by completed_at desc limit 20) x`)).rows[0];
  const sizes=(await pool.query(`select relname,pg_total_relation_size(format('%I.%I',schemaname,relname)::regclass) bytes
    from pg_stat_user_tables where schemaname='native_scale_100m' order by relname`)).rows;
  const fs=statfsSync('D:\\');const freeBytes=Number(fs.bavail)*Number(fs.bsize);
  const elapsedSec=p.started&&p.latest?(Date.parse(p.latest)-Date.parse(p.started))/1000:0;
  const tailSec=tail.started&&tail.latest?(Date.parse(tail.latest)-Date.parse(tail.started))/1000:0;
  const rate=tail.copies>1&&tailSec>0?(tail.copies-1)/tailSec:null;
  console.log(JSON.stringify({copies:p.copies,rows:p.copies*100000,pct:p.copies/10,
    elapsedSec,estimatedRemainingSec:rate?(1000-p.copies)/rate:null,
    databaseBytes:Number((await pool.query('select pg_database_size(current_database()) bytes')).rows[0].bytes),
    freeBytes,tables:Object.fromEntries(sizes.map(x=>[x.relname,Number(x.bytes)]))}));
}finally{await pool.end();}

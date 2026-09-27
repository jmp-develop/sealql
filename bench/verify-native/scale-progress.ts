import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { parse } from 'node:path';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
const ticketTarget=Number(process.argv[2]??1000);assert(ticketTarget===100||ticketTarget===1000);
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const p=(await pool.query(`select count(*)::int copies,min(completed_at) started,max(completed_at) latest,
    sum(elapsed_ms)::double precision load_ms from native_scale_100m.progress`)).rows[0];
  const tail=(await pool.query(`select count(*)::int copies,min(completed_at) started,max(completed_at) latest
    from (select completed_at from native_scale_100m.progress order by completed_at desc limit 20) x`)).rows[0];
  const hasTicket=(await pool.query("select to_regclass('native_scale_100m.ticket_progress') rel")).rows[0].rel;
  const ticketCopies=hasTicket?Number((await pool.query('select count(*) n from native_scale_100m.ticket_progress')).rows[0].n):0;
  const ticketTail=hasTicket?(await pool.query(`select count(*)::int copies,min(completed_at) started,max(completed_at) latest
    from (select completed_at from native_scale_100m.ticket_progress order by completed_at desc limit 20) x`)).rows[0]:null;
  const sizes=(await pool.query(`select relname,pg_total_relation_size(format('%I.%I',schemaname,relname)::regclass) bytes
    from pg_stat_user_tables where schemaname='native_scale_100m' order by relname`)).rows;
  const indexProgress=(await pool.query(`select pid,relid::regclass::text table_name,index_relid::regclass::text index_name,
    phase,blocks_total,blocks_done,tuples_total,tuples_done,partitions_total,partitions_done
    from pg_stat_progress_create_index where relid::regclass::text like 'native_scale_100m.%'`)).rows;
  const vacuumProgress=(await pool.query(`select pid,relid::regclass::text table_name,phase,
    heap_blks_total,heap_blks_scanned,heap_blks_vacuumed,index_vacuum_count
    from pg_stat_progress_vacuum where relid::regclass::text like 'native_scale_100m.%'`)).rows;
  const fs=statfsSync(parse(process.cwd()).root);const freeBytes=Number(fs.bavail)*Number(fs.bsize);
  const elapsedSec=p.started&&p.latest?(Date.parse(p.latest)-Date.parse(p.started))/1000:0;
  const tailSec=tail.started&&tail.latest?(Date.parse(tail.latest)-Date.parse(tail.started))/1000:0;
  const rate=tail.copies>1&&tailSec>0?(tail.copies-1)/tailSec:null;
  const ticketTailSec=ticketTail?.started&&ticketTail?.latest?(Date.parse(ticketTail.latest)-Date.parse(ticketTail.started))/1000:0;
  const ticketRate=ticketTail?.copies>1&&ticketTailSec>0?(ticketTail.copies-1)/ticketTailSec:null;
  console.log(JSON.stringify({copies:p.copies,rows:p.copies*100000,pct:p.copies/10,
    ticketCopies,ticketRows:ticketCopies*100000,ticketEstimatedRemainingSec:ticketRate?(ticketTarget-ticketCopies)/ticketRate:null,
    elapsedSec,estimatedRemainingSec:rate?(1000-p.copies)/rate:null,
    databaseBytes:Number((await pool.query('select pg_database_size(current_database()) bytes')).rows[0].bytes),
    freeBytes,tables:Object.fromEntries(sizes.map(x=>[x.relname,Number(x.bytes)])),indexProgress,vacuumProgress}));
}finally{await pool.end();}

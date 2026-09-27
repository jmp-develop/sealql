/** Persist small, auditable capacity snapshots at the required milestones. */
import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parse } from 'node:path';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const stage=process.argv[2];assert(['25','50','75','100','index','customer-measurement',
  'ticket25','ticket50','ticket75','ticket100','ticket-index','ticket-measurement','measurement'].includes(stage));
const ticketTarget=stage.startsWith('ticket')?Number(process.argv[3]):null;
if(ticketTarget!==null)assert(ticketTarget===100||ticketTarget===1000);
const out='bench/results/2026-09-27-native-scale-100m';const file=`${out}/checkpoints.json`;
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const p=(await pool.query(`select count(*)::int copies,min(completed_at) first,max(completed_at) latest
    from native_scale_100m.progress`)).rows[0];
  if(['25','50','75','100'].includes(stage))assert(p.copies>=Number(stage)*10);
  else assert.equal(p.copies,1000);
  const hasTicket=(await pool.query("select to_regclass('native_scale_100m.ticket_progress') rel")).rows[0].rel;
  const ticketCopies=hasTicket?Number((await pool.query('select count(*) n from native_scale_100m.ticket_progress')).rows[0].n):0;
  const ticketSpan=hasTicket?(await pool.query(`select min(completed_at) first,max(completed_at) latest
    from native_scale_100m.ticket_progress`)).rows[0]:null;
  const ticketTail=hasTicket?(await pool.query(`select count(*)::int copies,min(completed_at) first,max(completed_at) latest
    from (select completed_at from native_scale_100m.ticket_progress order by completed_at desc limit 20) x`)).rows[0]:null;
  const ticketElapsedSec=ticketSpan?.first&&ticketSpan?.latest?(Date.parse(ticketSpan.latest)-Date.parse(ticketSpan.first))/1000:0;
  const ticketTailSec=ticketTail?.first&&ticketTail?.latest?(Date.parse(ticketTail.latest)-Date.parse(ticketTail.first))/1000:0;
  const ticketRate=ticketTail?.copies>1&&ticketTailSec>0?(ticketTail.copies-1)/ticketTailSec:null;
  if(stage.startsWith('ticket')){
    const pct=stage==='ticket-index'||stage==='ticket-measurement'?100:Number(stage.slice(6));
    assert(ticketCopies>=ticketTarget!*pct/100);
  }
  const tail=(await pool.query(`select count(*)::int copies,min(completed_at) first,max(completed_at) latest
    from (select completed_at from native_scale_100m.progress order by completed_at desc limit 20) x`)).rows[0];
  const elapsedSec=p.first&&p.latest?(Date.parse(p.latest)-Date.parse(p.first))/1000:0;
  const tailSec=tail.first&&tail.latest?(Date.parse(tail.latest)-Date.parse(tail.first))/1000:0;
  const rate=tail.copies>1&&tailSec>0?(tail.copies-1)/tailSec:null;
  const fs=statfsSync(parse(process.cwd()).root);
  const sizes=(await pool.query(`select relname,pg_total_relation_size(format('%I.%I',schemaname,relname)::regclass) bytes
    from pg_stat_user_tables where schemaname='native_scale_100m' order by relname`)).rows;
  const event={stage,recordedAt:new Date().toISOString(),copies:p.copies,customerRows:p.copies*100000,
    ticketCopies,ticketRows:ticketCopies*100000,ticketTarget,
    ticketElapsedSec,ticketEstimatedRemainingSec:ticketRate&&ticketTarget!==null?(ticketTarget-ticketCopies)/ticketRate:null,
    elapsedSec,estimatedRemainingSec:rate?(1000-p.copies)/rate:null,
    databaseBytes:Number((await pool.query('select pg_database_size(current_database()) bytes')).rows[0].bytes),
    freeBytes:Number(fs.bavail)*Number(fs.bsize),tables:Object.fromEntries(sizes.map(x=>[x.relname,Number(x.bytes)]))};
  await mkdir(out,{recursive:true});let records:any[]=[];
  try{records=JSON.parse(await readFile(file,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  assert(!records.some(x=>x.stage===stage),`stage ${stage} already recorded`);
  records.push(event);await writeFile(file,JSON.stringify(records,null,2)+'\n');
  console.log(JSON.stringify(event));
}finally{await pool.end();}

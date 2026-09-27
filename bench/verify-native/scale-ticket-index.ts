/** Build ticket indexes after the selected ticket expansion finishes. */
import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { parse } from 'node:path';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { fields } from './schema.js';
import { scaleTicketsSeal, scaleSealed } from './scale-schema.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,
  options:'-c statement_timeout=0'});
const freeBytes=()=>{const fs=statfsSync(parse(process.cwd()).root);return Number(fs.bavail)*Number(fs.bsize);};
const targetCopies=Number(process.argv[2]);assert(targetCopies===100||targetCopies===1000);
const logPath='.local/scale-ticket-index.jsonl';
async function execute(name:string,sql:string){
  const before=freeBytes();
  if(before<200e9)throw Error(`DISK_STOP freeBytes=${before} before ${name}`);
  const t=performance.now();await pool.query(sql);
  const event={name,elapsedSec:+((performance.now()-t)/1000).toFixed(2),freeBytesBefore:before,freeBytesAfter:freeBytes()};
  await appendFile(logPath,JSON.stringify(event)+'\n');console.log(JSON.stringify(event));
}
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n),1000);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.ticket_progress')).rows[0].n),targetCopies);
  await pool.query("set maintenance_work_mem='1GB'");
  const indexes=(await pool.query(`select tablename,indexname,indexdef from pg_indexes
    where schemaname='native_verify_main' and tablename in ('tickets','tickets_seal_index')
    order by tablename,indexname`)).rows;
  const ordered=indexes.filter(x=>x.tablename==='tickets'&&x.indexname==='tickets_pkey')
    .concat(indexes.filter(x=>x.tablename==='tickets_seal_index'&&x.indexname==='tickets_seal_index_scope_row_uq'))
    .concat(indexes.filter(x=>x.indexname.endsWith('_bt')))
    .concat(indexes.filter(x=>x.indexname.endsWith('_gin')));
  assert.equal(ordered.length,9);
  for(const index of ordered){
    const sql=index.indexdef.replace(/^CREATE (UNIQUE )?INDEX /,'CREATE $1INDEX IF NOT EXISTS ')
      .replace(' ON native_verify_main.',' ON native_scale_100m.');
    await execute(index.indexname,sql);
  }
  const hasParentPk=Number((await pool.query(`select count(*) n from pg_constraint
    where conrelid='native_scale_100m.tickets'::regclass and contype='p'`)).rows[0].n)>0;
  if(!hasParentPk)await execute('parent primary key',
    'alter table native_scale_100m.tickets add constraint tickets_pkey primary key using index tickets_pkey');
  const hasFk=Number((await pool.query(`select count(*) n from pg_constraint
    where conrelid='native_scale_100m.tickets_seal_index'::regclass and contype='f'`)).rows[0].n)>0;
  if(!hasFk)await execute('companion foreign key',`alter table native_scale_100m.tickets_seal_index
    add constraint tickets_seal_index_row_id_tickets_id_fk foreign key (row_id)
    references native_scale_100m.tickets(id) on delete cascade not valid`);
  await execute('validate companion foreign key',`alter table native_scale_100m.tickets_seal_index
    validate constraint tickets_seal_index_row_id_tickets_id_fk`);
  await execute('plain primary index','create unique index if not exists tickets_plain_pkey on native_scale_100m.tickets_plain(id)');
  const plainIndexes=(await pool.query(`select indexname,indexdef from pg_indexes where schemaname='bench_realistic_100k'
    and tablename='tickets' and (indexname like 'tickets_%_exact' or indexname like 'tickets_%_trgm')
    order by indexname`)).rows;
  assert.equal(plainIndexes.length,fields.length*2);
  for(const index of plainIndexes){
    const sql=index.indexdef.replace(/^CREATE INDEX /,'CREATE INDEX IF NOT EXISTS ')
      .replace(' ON bench_realistic_100k.tickets ',' ON native_scale_100m.tickets_plain ');
    await execute(index.indexname,sql);
  }
  for(const statement of scaleSealed.extraMigrationSql(scaleTicketsSeal))await execute('statistics target',statement);
  for(const table of ['tickets','tickets_seal_index','tickets_plain'])
    await execute(`vacuum analyze ${table}`,`vacuum (analyze) native_scale_100m.${table}`);
  const result={finishedAt:new Date().toISOString(),indexCount:ordered.length+1+plainIndexes.length,
    foreignKey:true,freeBytes:freeBytes(),databaseBytes:Number((await pool.query('select pg_database_size(current_database()) bytes')).rows[0].bytes)};
  const out='bench/results/2026-09-27-native-scale-100m';await mkdir(out,{recursive:true});
  await writeFile(`${out}/ticket-index.json`,JSON.stringify({...result,ticketCopies:targetCopies},null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{await pool.end();}

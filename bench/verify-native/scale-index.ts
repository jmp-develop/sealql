/** Build the product and plain indexes only after all 100 million rows are loaded. */
import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { parse } from 'node:path';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { fields } from './schema.js';
import { scaleCustomersSeal, scaleSealed } from './scale-schema.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,
  options:'-c statement_timeout=0'});
const freeBytes=()=>{const fs=statfsSync(parse(process.cwd()).root);return Number(fs.bavail)*Number(fs.bsize);};
const logPath='.local/scale-index.jsonl';
async function execute(name:string,sql:string){
  const before=freeBytes();
  if(before<200e9)throw Error(`DISK_STOP freeBytes=${before} before ${name}`);
  const t=performance.now();await pool.query(sql);
  const event={name,elapsedSec:+((performance.now()-t)/1000).toFixed(2),freeBytesBefore:before,freeBytesAfter:freeBytes()};
  await appendFile(logPath,JSON.stringify(event)+'\n');console.log(JSON.stringify(event));
}
async function buildPlainIndexes(shard?:number){
  if(shard===undefined)await execute('plain primary index','create unique index if not exists customers_plain_pkey on native_scale_100m.customers_plain(id)');
  const plainIndexes=(await pool.query(`select indexname,indexdef from pg_indexes where schemaname='bench_realistic_100k'
    and tablename='customers' and (indexname like 'customers_%_exact' or indexname like 'customers_%_trgm')
    order by indexname`)).rows;
  assert.equal(plainIndexes.length,fields.length*2);
  for(const [i,index] of plainIndexes.entries()){
    if(shard!==undefined&&i%3!==shard)continue;
    const sql=index.indexdef.replace(/^CREATE INDEX /,'CREATE INDEX IF NOT EXISTS ')
      .replace(' ON bench_realistic_100k.customers ',' ON native_scale_100m.customers_plain ');
    await execute(index.indexname,sql);
  }
  return shard===undefined?plainIndexes.length:plainIndexes.filter((_:unknown,i:number)=>i%3===shard).length;
}
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n),1000);
  const shardMatch=/^plain-shard-([012])$/.exec(process.argv[2]??'');
  await pool.query(`set maintenance_work_mem='${shardMatch?'2GB':'4GB'}'`);
  await pool.query(`set max_parallel_maintenance_workers=${shardMatch?4:8}`);
  if(shardMatch){
    const shard=Number(shardMatch[1]);
    console.log(JSON.stringify({shard,plainIndexes:await buildPlainIndexes(shard),finishedAt:new Date().toISOString()}));
  }else if(process.argv[2]==='plain-only'){
    console.log(JSON.stringify({plainIndexes:await buildPlainIndexes(),finishedAt:new Date().toISOString()}));
  }else{
  const indexes=(await pool.query(`select tablename,indexname,indexdef from pg_indexes
    where schemaname='native_verify_main' and tablename in ('customers','customers_seal_index')
    order by tablename,indexname`)).rows;
  const ordered=indexes.filter(x=>x.tablename==='customers'&&x.indexname==='customers_pkey')
    .concat(indexes.filter(x=>x.tablename==='customers_seal_index'&&x.indexname==='customers_seal_index_scope_row_uq'))
    .concat(indexes.filter(x=>x.indexname.endsWith('_bt')))
    .concat(indexes.filter(x=>x.indexname.endsWith('_gin')));
  assert.equal(ordered.length,9);
  for(const index of ordered){
    const sql=index.indexdef.replace(/^CREATE (UNIQUE )?INDEX /,'CREATE $1INDEX IF NOT EXISTS ')
      .replace(' ON native_verify_main.',' ON native_scale_100m.');
    await execute(index.indexname,sql);
  }
  const hasParentPk=Number((await pool.query(`select count(*) n from pg_constraint
    where conrelid='native_scale_100m.customers'::regclass and contype='p'`)).rows[0].n)>0;
  if(!hasParentPk)await execute('parent primary key',
    'alter table native_scale_100m.customers add constraint customers_pkey primary key using index customers_pkey');
  const hasFk=Number((await pool.query(`select count(*) n from pg_constraint
    where conrelid='native_scale_100m.customers_seal_index'::regclass and contype='f'`)).rows[0].n)>0;
  if(!hasFk)await execute('companion foreign key',`alter table native_scale_100m.customers_seal_index
    add constraint customers_seal_index_row_id_customers_id_fk foreign key (row_id)
    references native_scale_100m.customers(id) on delete cascade not valid`);
  const plainCount=await buildPlainIndexes();
  for(const statement of scaleSealed.extraMigrationSql(scaleCustomersSeal))await execute('statistics target',statement);
  for(const table of ['customers','customers_seal_index','customers_plain'])
    await execute(`vacuum analyze ${table}`,`vacuum (analyze) native_scale_100m.${table}`);
  const result={finishedAt:new Date().toISOString(),indexCount:ordered.length+1+plainCount,
    foreignKey:true,freeBytes:freeBytes(),databaseBytes:Number((await pool.query('select pg_database_size(current_database()) bytes')).rows[0].bytes)};
  const out='bench/results/2026-09-27-native-scale-100m';await mkdir(out,{recursive:true});
  await writeFile(`${out}/index.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  }
}finally{await pool.end();}

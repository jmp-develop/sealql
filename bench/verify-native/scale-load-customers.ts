/** Resumable 100k-row copy transactions; public Sealer.seal binds every ciphertext to its new ID. */
import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId } from './schema.js';
import { cipher } from './tokens.js';
import { cloneId } from './scale-schema.js';

const start=Number(process.argv[2]),end=Number(process.argv[3]);
assert(Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end<=1000&&start<end);
const batchSize=1000;
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,
  options:'-c statement_timeout=120000'});
const cloneSql=(col:string)=>`(lpad(to_hex(536870912+$1),8,'0') || substring(${col}::text from 9))::uuid`;
const parentCols=['id','scope_id',...fields.map(f=>`${f}_ct`)];
const parentValues=Array.from({length:batchSize},(_,i)=>`(${Array.from({length:parentCols.length},(_,j)=>`$${i*parentCols.length+j+1}`).join(',')})`).join(',');
const ring=cipher.ring('customers');
const spec={type:'text',search:{exact:true,substring:{wordBoundary:true,skipGrams:true}}} as const;
const freeBytes=()=>{const x=statfsSync('D:\\');return Number(x.bavail)*Number(x.bsize);};
const logPath=`.local/scale-worker-${start}-${end}.jsonl`;
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from bench_realistic_100k.customers where scope_id=$1',[scopeId])).rows[0].n),100000);
  assert((await pool.query("select to_regclass('native_scale_100m.progress') rel")).rows[0].rel);
  const tokenCols=(await pool.query(`select column_name from information_schema.columns
    where table_schema='native_verify_main' and table_name='customers_seal_index'
      and column_name like 'tokens_%' order by ordinal_position`)).rows.map(r=>r.column_name as string);
  assert.equal(tokenCols.length,12);
  const source=(await pool.query(`select id,${fields.map(f=>`${f}_plain`).join(',')}
    from bench_realistic_100k.customers where scope_id=$1 order by id`,[scopeId])).rows;
  assert.equal(source.length,100000);
  const overall=performance.now();
  for(let copy=start;copy<end;copy++){
    if((await pool.query('select 1 from native_scale_100m.progress where copy_no=$1',[copy])).rowCount){
      continue;
    }
    const free=freeBytes();
    if(free<200e9)throw new Error(`DISK_STOP freeBytes=${free} copy=${copy}; ask coordinator before further load`);
    const t=performance.now(),client=await pool.connect();
    try{
      await client.query('begin');
      for(let i=0;i<source.length;i+=batchSize){
        const chunk=source.slice(i,i+batchSize);
        const prepared=await Promise.all(chunk.map(async row=>{
          const id=cloneId(row.id,copy);
          const ct=await Promise.all(fields.map(f=>cipher.seal(row[`${f}_plain`],{
            modelId:'customers',fieldId:f,keyScopeId:ring.keyScopeId,scopeId,rowId:id,spec},ring)));
          return [id,scopeId,...ct.map(x=>Buffer.from(x))];
        }));
        await client.query(`insert into native_scale_100m.customers (${parentCols.join(',')}) values ${parentValues}`,prepared.flat());
      }
      await client.query(`insert into native_scale_100m.customers_plain
        (id,scope_id,${fields.flatMap(f=>[`${f}_plain`,`${f}_norm`]).join(',')})
        select ${cloneSql('id')},scope_id,${fields.flatMap(f=>[`${f}_plain`,`${f}_norm`]).join(',')}
        from bench_realistic_100k.customers where scope_id=$2`,[copy,scopeId]);
      await client.query(`insert into native_scale_100m.customers_seal_index
        (scope_id,row_id,${tokenCols.join(',')})
        select scope_id,${cloneSql('row_id')},${tokenCols.join(',')}
        from native_verify_main.customers_seal_index where scope_id=$2`,[copy,scopeId]);
      await client.query('insert into native_scale_100m.progress(copy_no,elapsed_ms) values ($1,$2)',[copy,performance.now()-t]);
      await client.query('commit');
      const event={copy,rows:100000,elapsedSec:+((performance.now()-t)/1000).toFixed(2),
        runElapsedSec:+((performance.now()-overall)/1000).toFixed(2),freeBytesBefore:free};
      await appendFile(logPath,JSON.stringify(event)+'\n');
      if((copy-start)%25===0||copy===end-1)console.log(JSON.stringify(event));
    }catch(e){await client.query('rollback');throw e;}finally{client.release();}
  }
}finally{await pool.end();}

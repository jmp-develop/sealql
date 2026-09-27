/** 10k-row full encryption/tokenization and indexed batch load from existing fixture values. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { definePostgresStorage } from '../../src/adapters/postgres/sealed-index.js';
import { profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { binding, fields, guard, pool, schema, scopeId, sealer, source } from '../standard-next/common.js';

const output='bench/results/2026-09-27-core-verification/v3/bulk.json';
const plainName='core_v3_bulk_plain',productName='core_v3_bulk_product';
const base=binding('customers',true);
const mapping=definePostgresStorage(base.model,{schema,table:productName,identity:{scope:'scope_id',row:'id',revision:'revision'},fields:Object.fromEntries(fields.map(f=>[f,`${f}_ct`])) as Record<typeof fields[number],string>,indexTable:`${productName}_seal_index`});
const cache={profiles:new Map<string,Promise<CryptoKey>>()};
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
const placeholder=(r:number,c:number)=>`(${Array.from({length:c},(_,i)=>`$${r*c+i+1}`).join(',')})`;
const valuesSql=(rows:number,cols:number)=>Array.from({length:rows},(_,r)=>placeholder(r,cols)).join(',');
async function setup(){
  await guard();
  if(!(await pool.query('select to_regclass($1) rel',[`${schema}.${productName}`])).rows[0].rel)for(const s of mapping.ddl)await pool.query(s.text,s.values);
  if(!(await pool.query('select to_regclass($1) rel',[`${schema}.${plainName}`])).rows[0].rel){
    await pool.query(`create table ${schema}.${plainName} as select scope_id,id,revision,${fields.flatMap(f=>[`${f}_plain`,`${f}_norm`]).join(',')} from ${source}.customers where false`);
    await pool.query(`alter table ${schema}.${plainName} add primary key(scope_id,id)`);
    for(const f of fields)await pool.query(`create index ${plainName}_${f}_norm_bt on ${schema}.${plainName}(${f}_norm)`);
  }
  for(const table of [plainName,productName,`${productName}_seal_index`])assert.equal(Number((await pool.query(`select count(*) n from ${schema}.${table} where scope_id=$1`,[scopeId])).rows[0].n),0,`${table} must be empty`);
}
async function load(variant:'plain'|'product',rows:any[]){
  const started=performance.now();let prepareMs=0,sqlMs=0,sqlCalls=0;
  const parentCols=['scope_id','id','revision',...fields.map(f=>`${f}_ct`)];
  const ps=Object.entries(mapping.storage.index!.profiles!).map(([indexId,entry])=>({indexId,...entry}));
  const indexCols=['scope_id','row_id',...ps.map(p=>p.tokens)];
  const ring=sealer.ring(base.model.id);
  for(let at=0;at<rows.length;at+=100){
    const batch=rows.slice(at,at+100);
    const begin=performance.now();
    const prepared=variant==='product'?await Promise.all(batch.map(async row=>{
      const ct=await Promise.all(fields.map(f=>sealer.seal(row[`${f}_plain`],{modelId:base.model.id,fieldId:f,keyScopeId:ring.keyScopeId,scopeId,rowId:row.id,spec:base.model.fields[f]},ring)));
      const tokens=await Promise.all(ps.map(async p=>{
        const field=p.indexId.split('/')[0] as typeof fields[number];
        const profile=profiles(base.model.id,field,base.model.fields[field]).find(x=>x.indexId===p.indexId)!;
        return searchTokens(ring,scopeId,profile,searchPieces(profile,row[`${field}_plain`]),cache);
      }));return {ct,tokens};
    })):[];
    prepareMs+=performance.now()-begin;
    const client=await pool.connect();try{
      let t=performance.now();await client.query('begin');sqlMs+=performance.now()-t;sqlCalls++;
      if(variant==='plain'){
        const cols=['scope_id','id','revision',...fields.flatMap(f=>[`${f}_plain`,`${f}_norm`])];
        const values=batch.flatMap(r=>[scopeId,r.id,1,...fields.flatMap(f=>[r[`${f}_plain`],r[`${f}_norm`]])]);
        t=performance.now();await client.query(`insert into ${schema}.${plainName} (${cols.join(',')}) values ${valuesSql(batch.length,cols.length)}`,values);sqlMs+=performance.now()-t;sqlCalls++;
      }else{
        const values=batch.flatMap((r,i)=>[scopeId,r.id,1,...prepared[i].ct]);
        t=performance.now();await client.query(`insert into ${schema}.${productName} (${parentCols.join(',')}) values ${valuesSql(batch.length,parentCols.length)}`,values);sqlMs+=performance.now()-t;sqlCalls++;
        const indexValues=batch.flatMap((r,i)=>[scopeId,r.id,...prepared[i].tokens]);
        t=performance.now();await client.query(`insert into ${schema}.${productName}_seal_index (${indexCols.join(',')}) values ${valuesSql(batch.length,indexCols.length)}`,indexValues);sqlMs+=performance.now()-t;sqlCalls++;
      }
      t=performance.now();await client.query('commit');sqlMs+=performance.now()-t;sqlCalls++;
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  const totalMs=performance.now()-started;
  assert.equal(Number((await pool.query(`select count(*) n from ${schema}.${variant==='plain'?plainName:productName} where scope_id=$1`,[scopeId])).rows[0].n),rows.length);
  if(variant==='product')assert.equal(Number((await pool.query(`select count(*) n from ${schema}.${productName}_seal_index where scope_id=$1`,[scopeId])).rows[0].n),rows.length);
  if(variant==='plain')await pool.query(`truncate table ${schema}.${plainName}`);
  else await pool.query(`truncate table ${schema}.${productName}_seal_index, ${schema}.${productName}`);
  return {rows:rows.length,batchSize:100,batches:rows.length/100,totalMs,prepareMs,sqlMs,sqlCalls,rowsPerSec:rows.length/(totalMs/1000)};
}
try{
  await setup();
  const rows=(await pool.query(`select id,${fields.flatMap(f=>[`${f}_plain`,`${f}_norm`]).join(',')} from ${source}.customers where scope_id=$1 order by id limit 10000`,[scopeId])).rows;
  assert.equal(rows.length,10000);
  for(let i=0;i<2;i++){await load('plain',rows);await load('product',rows);console.error(`bulk warmup ${i+1}/2`);}
  const runs:{plain:any[];product:any[]}={plain:[],product:[]};
  for(let i=0;i<7;i++)for(const variant of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]){runs[variant].push(await load(variant,rows));console.error(`bulk ${i+1}/7 ${variant}`);}
  const summary=Object.fromEntries(Object.entries(runs).map(([variant,rs])=>[variant,Object.fromEntries((['totalMs','prepareMs','sqlMs','sqlCalls','rowsPerSec'] as const).map(k=>[k,median(rs.map(r=>r[k]))]))]));
  const result={source:`${source}.customers first 10000 rows`,plainTable:`${schema}.${plainName}`,productTable:`${schema}.${productName}`,warmup:2,alternatingRuns:7,batchSize:100,indexesPresentDuringLoad:true,mode:'product Sealer.seal + searchPieces/searchTokens + batched parent and companion INSERT; plain batched INSERT',summary,runs};
  await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(summary));
}finally{await pool.end();}

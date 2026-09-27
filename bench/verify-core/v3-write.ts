/** Repeated 1,000-row write comparison using existing fixture values only. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { bindSealed, definePostgresStorage } from '../../src/adapters/postgres/sealed-index.js';
import { binding, executor, fields, guard, pool, query, schema, scopeId, sealer, setEvents, source, type Event } from '../standard-next/common.js';

const out='bench/results/2026-09-27-core-verification/v3/write.json';
const plainName='core_v3_write_plain',productName='core_v3_write_product';
const base=binding('customers',true);
const mapping=definePostgresStorage(base.model,{schema,table:productName,identity:{scope:'scope_id',row:'id',revision:'revision'},fields:Object.fromEntries(fields.map(f=>[f,`${f}_ct`])) as Record<typeof fields[number],string>,indexTable:`${productName}_seal_index`});
const repo=bindSealed({sealer,definition:mapping.definition,storage:mapping.storage,executor:executor()}).forScope({scopeId});
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
const p95=(a:number[])=>[...a].sort((x,y)=>x-y)[Math.floor((a.length-1)*.95)];
type SourceRow={id:string;[key:string]:any};
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
async function stage(variant:'plain'|'product',rows:SourceRow[]){
  const times:Record<'insert'|'update'|'delete',number[]>={insert:[],update:[],delete:[]};
  const sql:Record<'insert'|'update'|'delete',number[]>={insert:[],update:[],delete:[]};
  const plainCols=['scope_id','id','revision',...fields.flatMap(f=>[`${f}_plain`,`${f}_norm`])];
  const insertSql=`insert into ${schema}.${plainName} (${plainCols.join(',')}) values (${plainCols.map((_,i)=>`$${i+1}`).join(',')})`;
  const measure=async(kind:'insert'|'update'|'delete',fn:()=>Promise<unknown>)=>{const ev:Event[]=[];setEvents(ev);const t=performance.now();try{await fn();}finally{setEvents(null);}times[kind].push(performance.now()-t);sql[kind].push(ev.reduce((a,x)=>a+x.sqlMs,0));};
  for(const r of rows)await measure('insert',()=>variant==='plain'
    ?query(insertSql,[scopeId,r.id,1,...fields.flatMap(f=>[r[`${f}_plain`],r[`${f}_norm`]])])
    :repo.insert({id:r.id,data:Object.fromEntries(fields.map(f=>[f,r[`${f}_plain`]]))}));
  for(let i=0;i<rows.length;i++){
    const r=rows[i],next=rows[(i+1)%rows.length];
    await measure('update',()=>variant==='plain'
      ?query(`update ${schema}.${plainName} set memo_plain=$3,memo_norm=$4,revision=2 where scope_id=$1 and id=$2 and revision=1`,[scopeId,r.id,next.memo_plain,next.memo_norm])
      :repo.update({id:r.id,expectedRevision:1n,patch:{memo:next.memo_plain}}));
  }
  for(const r of rows)await measure('delete',()=>variant==='plain'
    ?query(`delete from ${schema}.${plainName} where scope_id=$1 and id=$2 and revision=2`,[scopeId,r.id])
    :repo.delete({id:r.id,expectedRevision:2n}));
  assert.equal(Number((await pool.query(`select count(*) n from ${schema}.${variant==='plain'?plainName:productName} where scope_id=$1`,[scopeId])).rows[0].n),0);
  if(variant==='product')assert.equal(Number((await pool.query(`select count(*) n from ${schema}.${productName}_seal_index where scope_id=$1`,[scopeId])).rows[0].n),0);
  return Object.fromEntries((['insert','update','delete'] as const).map(k=>[k,{samples:rows.length,totalMs:times[k].reduce((a,b)=>a+b,0),sqlMs:sql[k].reduce((a,b)=>a+b,0),medianRowMs:median(times[k]),p95RowMs:p95(times[k]),rowsPerSec:rows.length/(times[k].reduce((a,b)=>a+b,0)/1000)}]));
}
try{
  await setup();
  const rows=(await pool.query(`select id,${fields.flatMap(f=>[`${f}_plain`,`${f}_norm`]).join(',')} from ${source}.customers where scope_id=$1 order by id limit 1000`,[scopeId])).rows;
  assert.equal(rows.length,1000);
  for(let i=0;i<2;i++){await stage('plain',rows);await stage('product',rows);console.error(`write warmup ${i+1}/2`);}
  const runs:{plain:any[];product:any[]}={plain:[],product:[]};
  for(let i=0;i<7;i++)for(const variant of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]){runs[variant].push(await stage(variant,rows));console.error(`write ${i+1}/7 ${variant}`);}
  const summary=Object.fromEntries(Object.entries(runs).map(([variant,rs])=>[variant,Object.fromEntries((['insert','update','delete'] as const).map(kind=>[kind,Object.fromEntries((['totalMs','sqlMs','medianRowMs','p95RowMs','rowsPerSec'] as const).map(metric=>[metric,median(rs.map(r=>r[kind][metric]))]))]))]));
  const result={source:`${source}.customers first 1000 rows`,plainTable:`${schema}.${plainName}`,productTable:`${schema}.${productName}`,warmup:2,alternatingRuns:7,samplesPerOperation:1000,plainIndexes:'PK plus six normalized-field B-tree indexes',productIndexes:mapping.ddl.filter(s=>/^create index/i.test(s.text)).map(s=>s.text),summary,runs};
  await writeFile(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(summary));
}finally{await pool.end();}

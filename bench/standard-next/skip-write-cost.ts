/** Compare managed write costs with skip grams off/on in the owned disposable DB. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { bindSealed, definePostgresStorage, defineSealedModel } from '../../src/adapters/postgres/sealed-index.js';
import { executor, fields, guard, pool, schema, scopeId, sealer, source } from './common.js';

const outputDir='bench/results/2026-09-27-skip-write-cost';
const count=1000;
const marker='검증전용새값';
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const sum=(values:number[])=>values.reduce((a,b)=>a+b,0);
const sizes=async(name:string)=>Number((await pool.query('select pg_total_relation_size(to_regclass($1)) n',[`${schema}.${name}`])).rows[0].n);
function make(skip:boolean){
  const table=`skip_write_probe_${skip?'on':'off'}`;
  const model=defineSealedModel({id:'realistic-customers-standard',identity:{scope:'uuid',row:'uuid',revision:'bigint'},
    fields:Object.fromEntries(fields.map(f=>[f,{type:'text' as const,nullable:false,search:{exact:true as const,substring:{wordBoundary:true,skipGrams:skip}}}])) as any});
  const binding=definePostgresStorage(model,{schema,table,identity:{scope:'scope_id',row:'id',revision:'revision'},
    fields:Object.fromEntries(fields.map(f=>[f,`${f}_ct`])) as any,indexTable:`${table}_seal_index`});
  return {name:skip?'skip_on':'skip_off',table,binding,repo:bindSealed({sealer,definition:binding.definition,storage:binding.storage,executor:executor()}).forScope({scopeId})};
}
const variants=[make(false),make(true)];
const times=Object.fromEntries(variants.map(v=>[v.name,{insert:[] as number[],update:[] as number[],delete:[] as number[]}])) as Record<string,{insert:number[];update:number[];delete:number[]}>;
const order=(i:number)=>i%2?variants.slice().reverse():variants;
async function hits(v:ReturnType<typeof make>,value:string){
  const items:any[]=[];let cursor:string|undefined;
  do {const page=await v.repo.findMany({match:f=>(f as any).memo.eq(value),select:{memo:true},limit:200,cursor,
    budgets:{maxCandidates:2000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024,resultBytes:32*1024*1024}});
    items.push(...page.items);cursor=page.nextCursor??undefined;
  }while(cursor);
  return items;
}
try{
  await guard();
  await mkdir(outputDir,{recursive:true});
  for(const v of variants){
    if(!(await pool.query('select to_regclass($1) rel',[`${schema}.${v.table}`])).rows[0].rel)
      for(const stmt of v.binding.ddl)await pool.query(stmt.text,stmt.values);
    const residual=(await pool.query(`select id,revision from ${schema}.${v.table} where scope_id=$1`,[scopeId])).rows;
    for(const row of residual)await v.repo.delete({id:row.id,expectedRevision:BigInt(row.revision)});
    assert.equal(Number((await pool.query(`select count(*) n from ${schema}.${v.table}`)).rows[0].n),0);
  }
  const sourceRows=(await pool.query(`select id,${fields.map(f=>`${f}_plain`).join(',')} from ${source}.customers where scope_id=$1 order by id limit ${count}`,[scopeId])).rows;
  assert.equal(sourceRows.length,count);
  const baseline=Object.fromEntries(await Promise.all(variants.map(async v=>[v.name,await sizes(`${v.table}_seal_index`)])));
  for(let i=0;i<count;i++)for(const v of order(i)){
    const row=sourceRows[i],data=Object.fromEntries(fields.map(f=>[f,row[`${f}_plain`]]));
    const start=performance.now();await v.repo.insert({id:row.id,data});times[v.name].insert.push(performance.now()-start);
  }
  const afterInsert=Object.fromEntries(await Promise.all(variants.map(async v=>[v.name,await sizes(`${v.table}_seal_index`)])));
  const tokens=[];
  for(const v of variants){
    const companion=v.binding.storage.index!;
    const columns=Object.values(companion.profiles!).map(p=>p.tokens);
    const parts=columns.map(col=>`coalesce(cardinality("${col}"),0)`);
    const sub=Object.values(companion.profiles!).filter(p=>p.mode==='substring').map(p=>`coalesce(cardinality("${p.tokens}"),0)`);
    const row=(await pool.query(`select avg(${parts.join('+')}) total,avg(${sub.join('+')}) substring from ${schema}.${companion.name} where scope_id=$1`,[scopeId])).rows[0];
    tokens.push({variant:v.name,meanAll:Number(row.total),meanSubstring:Number(row.substring)});
  }
  for(let i=0;i<count;i++)for(const v of order(i+1)){
    const start=performance.now();await v.repo.update({id:sourceRows[i].id,expectedRevision:1n,patch:{memo:marker} as any});times[v.name].update.push(performance.now()-start);
  }
  const afterUpdate=[];
  for(const v of variants){
    const updated=await hits(v,marker);assert.equal(updated.length,count);
    assert(updated.every(row=>row.memo===marker));
    const old=await hits(v,sourceRows[0].memo_plain);
    assert(!old.some(row=>row.id===sourceRows[0].id));
    afterUpdate.push({variant:v.name,newHits:updated.length,oldIdHits:old.filter(row=>row.id===sourceRows[0].id).length});
  }
  for(let i=0;i<count;i++)for(const v of order(i)){
    const start=performance.now();await v.repo.delete({id:sourceRows[i].id,expectedRevision:2n});times[v.name].delete.push(performance.now()-start);
  }
  const afterDelete=[];
  for(const v of variants){
    const found=await hits(v,marker);assert.equal(found.length,0);
    const parent=Number((await pool.query(`select count(*) n from ${schema}.${v.table} where scope_id=$1`,[scopeId])).rows[0].n);
    const companion=Number((await pool.query(`select count(*) n from ${schema}.${v.table}_seal_index where scope_id=$1`,[scopeId])).rows[0].n);
    assert.equal(parent,0);assert.equal(companion,0);
    afterDelete.push({variant:v.name,newHits:0,parentRows:parent,companionRows:companion});
  }
  const summary=Object.fromEntries(variants.map(v=>[v.name,Object.fromEntries(Object.entries(times[v.name]).map(([op,values])=>[op,{medianMs:percentile(values,0.5),p95Ms:percentile(values,0.95),totalMs:sum(values)}]))]));
  const report={samplesPerVariant:count,order:'per source row, alternating first variant; update reverses first variant; same 1000 source rows',baselineCompanionBytes:baseline,afterInsertCompanionBytes:afterInsert,
    companionGrowthBytes:Object.fromEntries(variants.map(v=>[v.name,afterInsert[v.name]-baseline[v.name]])),tokens,afterUpdate,afterDelete,summary,runs:times};
  await writeFile(`${outputDir}/write-cost.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,runs:undefined}));
}finally{await pool.end();}

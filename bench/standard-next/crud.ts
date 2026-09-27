import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { bindSealed, definePostgresStorage, defineSealedModel } from '../../src/adapters/postgres/sealed-index.js';
import { executor, fields, guard, pool, schema, scopeId, sealer, source } from './common.js';

const model=defineSealedModel({id:'realistic-customers-standard',identity:{scope:'uuid',row:'uuid',revision:'bigint'},
  fields:Object.fromEntries(fields.map(f=>[f,{type:'text' as const,nullable:false,search:{exact:true as const,substring:{wordBoundary:true,skipGrams:false}}}])) as any});
const b=definePostgresStorage(model,{schema,table:'crud_probe',identity:{scope:'scope_id',row:'id',revision:'revision'},
  fields:Object.fromEntries(fields.map(f=>[f,`${f}_ct`])) as any,indexTable:'crud_probe_seal_index'});
const repo=bindSealed({sealer,definition:b.definition,storage:b.storage,executor:executor()}).forScope({scopeId});
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
try{
  await guard();
  if(!(await pool.query('select to_regclass($1) rel',[`${schema}.crud_probe`])).rows[0].rel)for(const stmt of b.ddl)await pool.query(stmt.text,stmt.values);
  const residual=(await pool.query(`select id,revision from ${schema}.crud_probe where scope_id=$1`,[scopeId])).rows;
  for(const row of residual)await repo.delete({id:row.id,expectedRevision:BigInt(row.revision)});
  const sourceRows=(await pool.query(`select id,${fields.map(f=>`${f}_plain`).join(',')} from ${source}.customers where scope_id=$1 order by id limit 1000`,[scopeId])).rows;
  assert.equal(sourceRows.length,1000);
  const times:{insert:number[];update:number[];delete:number[]}={insert:[],update:[],delete:[]};
  for(const row of sourceRows){const data=Object.fromEntries(fields.map(f=>[f,row[`${f}_plain`]]));
    const t=performance.now();await repo.insert({id:row.id,data});times.insert.push(performance.now()-t);
  }
  const marker='검증전용새값';
  for(const row of sourceRows){const t=performance.now();await repo.update({id:row.id,expectedRevision:1n,patch:{memo:marker} as any});times.update.push(performance.now()-t);}
  const updatedItems:any[]=[];let cursor:string|undefined;
  do{const page=await repo.findMany({match:f=>(f as any).memo.eq(marker),select:{memo:true},limit:200,cursor,budgets:{maxCandidates:2000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024,resultBytes:32*1024*1024}});
    updatedItems.push(...page.items);cursor=page.nextCursor??undefined;
  }while(cursor);
  assert.equal(updatedItems.length,1000);
  const old=await repo.findMany({match:f=>(f as any).memo.eq(sourceRows[0].memo_plain),select:{memo:true},limit:200,budgets:{maxCandidates:2000}});
  assert.equal(old.items.some(row=>row.id===sourceRows[0].id),false);
  for(const row of sourceRows){const t=performance.now();await repo.delete({id:row.id,expectedRevision:2n});times.delete.push(performance.now()-t);}
  const afterDelete=await repo.findMany({match:f=>(f as any).memo.eq(marker),select:{memo:true},limit:20});assert.equal(afterDelete.items.length,0);
  const report={samples:1000,medianMs:Object.fromEntries(Object.entries(times).map(([k,v])=>[k,median(v)])),totalMs:Object.fromEntries(Object.entries(times).map(([k,v])=>[k,v.reduce((a,b)=>a+b,0)])),postUpdateHits:updatedItems.length,postDeleteHits:afterDelete.items.length,runs:times};
  await writeFile('bench/results/2026-09-27-standard-next/crud.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({samples:1000,medianMs:report.medianMs,postUpdateHits:1000,postDeleteHits:0}));
}finally{await pool.end();}

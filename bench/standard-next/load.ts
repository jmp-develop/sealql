/** Full disposable fixture load. Uses the product sealer/searchTokens with batched SQL writes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { binding, fields, guard, pool, schema, scopeId, sealer, source, tables, type Table } from './common.js';

const resultDir='bench/results/2026-09-27-standard-next';
const batches=Number(process.argv[2] ?? '0');
const limit=batches>0?batches*100:Infinity;
const stats:Record<string,unknown>={mode:'public DDL, product Sealer.seal + searchPieces/searchTokens, batched parent and companion INSERT; indexes built after load',tables:{}};
const tokenCache={profiles:new Map<string,Promise<CryptoKey>>()};
function valuesSql(rows:number,cols:number,start=1) { return Array.from({length:rows},(_,r)=>`(${Array.from({length:cols},(_,c)=>`$${start+r*cols+c}`).join(',')})`).join(','); }
async function insertBatch(table:Table, skip:boolean, rows:any[], crypt?:any[]) {
  const b=binding(table,skip), suffix=skip?'_skip':'';
  const ps=Object.entries(b.storage.index!.profiles!).map(([indexId,entry])=>({indexId,...entry}));
  const parentCols=['scope_id','id','revision',...(table==='tickets'?['customer_id']:[]),...fields.map(f=>`${f}_ct`)];
  const idxCols=['scope_id','row_id',...ps.map(p=>p.tokens)];
  const ring=sealer.ring(b.model.id), cache=tokenCache;
  const prepared=await Promise.all(rows.map(async(row,i)=>{
    const ct=crypt?.[i]??await Promise.all(fields.map(f=>sealer.seal(row[`${f}_plain`],{modelId:b.model.id,fieldId:f,keyScopeId:ring.keyScopeId,scopeId,rowId:row.id,spec:b.model.fields[f]},ring)));
    const tokens=await Promise.all(ps.map(async p=>{
      const field=p.indexId.split('/')[0] as typeof fields[number];
      const profile=profiles(b.model.id,field,b.model.fields[field]).find(x=>x.indexId===p.indexId)!;
      return searchTokens(ring,scopeId,profile,searchPieces(profile,row[`${field}_plain`]),cache);
    }));
    return {ct,tokens};
  }));
  const client=await pool.connect(); try {
    await client.query('begin');
    const parentValues=rows.flatMap((r,i)=>[scopeId,r.id,1,...(table==='tickets'?[r.customer_id]:[]),...prepared[i].ct]);
    await client.query(`insert into ${schema}.${table}${suffix} (${parentCols.join(',')}) values ${valuesSql(rows.length,parentCols.length)} on conflict do nothing`,parentValues);
    const indexValues=rows.flatMap((r,i)=>[scopeId,r.id,...prepared[i].tokens]);
    await client.query(`insert into ${schema}.${table}${suffix}_seal_index (${idxCols.join(',')}) values ${valuesSql(rows.length,idxCols.length)} on conflict do nothing`,indexValues);
    await client.query('commit');
  } catch(e) { await client.query('rollback'); throw e; } finally { client.release(); }
  return prepared.map(x=>x.ct);
}
try {
  await guard();
  await mkdir(resultDir,{recursive:true});
  const exists=(await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount;
  if (!exists) await pool.query(`create schema ${schema}`);
  for (const table of tables) {
    for (const skip of [false,true]) {
      const b=binding(table,skip), name=`${table}${skip?'_skip':''}`;
      if (!(await pool.query('select to_regclass($1) as rel',[`${schema}.${name}`])).rows[0].rel) {
        for (const stmt of b.ddl.filter(x=>/^create table/i.test(x.text))) await pool.query(stmt.text,stmt.values);
      }
    }
    const start=performance.now(); let loaded=0;
    while(loaded<limit) {
      const rows=(await pool.query(`select id,${table==='tickets'?'customer_id,':''}${fields.map(f=>`${f}_plain`).join(',')} from ${source}.${table} where scope_id=$1 and id > least(coalesce((select id from ${schema}.${table} order by id desc limit 1), '00000000-0000-0000-0000-000000000000'::uuid),coalesce((select id from ${schema}.${table}_skip order by id desc limit 1), '00000000-0000-0000-0000-000000000000'::uuid)) order by id limit 100`,[scopeId])).rows;
      if(!rows.length)break;
      const ct=await insertBatch(table,false,rows);
      await insertBatch(table,true,rows,ct);
      loaded+=rows.length;
      if(loaded%1000===0) console.log(JSON.stringify({table,loaded,elapsedSec:Math.round((performance.now()-start)/1000)}));
    }
    const count=Number((await pool.query(`select count(*) n from ${schema}.${table}`)).rows[0].n);
    const skipCount=Number((await pool.query(`select count(*) n from ${schema}.${table}_skip`)).rows[0].n);
    assert.equal(count,skipCount);
    (stats.tables as any)[table]={rows:count,loadedThisRun:loaded,elapsedMs:performance.now()-start,rowsPerSec:loaded/((performance.now()-start)/1000)};
    if(count===100000)for(const skip of [false,true]) {
      const b=binding(table,skip);
      for(const stmt of b.ddl.filter(x=>!/^create table/i.test(x.text))) {
        try { await pool.query(stmt.text,stmt.values); } catch(e:any) { if(e.code!=='42P07')throw e; }
      }
      await pool.query(`analyze ${schema}.${table}${skip?'_skip':''}`);
      await pool.query(`analyze ${schema}.${table}${skip?'_skip':''}_seal_index`);
    }
  }
  await writeFile(`${resultDir}/load.json`,JSON.stringify(stats,null,2)+'\n');
} finally { await pool.end(); }

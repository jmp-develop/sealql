/** Function-only repeat/near-miss comparison; isolated schemas, caller-owned lock. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
import {stampMigrationSql} from '../../src/core/stamp-sql.js';
import {stampMigrationSql as previousSql} from '../../.local/r9-review-before/dist/core/stamp-sql.js';
import {profiles,compactText} from '../../src/core/search-tokens.js';
import {positionProof} from '../../src/core/search-stamps.js';
import {compileStampQuery,keyArray,patternProgram} from '../../src/core/stamp-query.js';
assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-review-impl task_5488e89a7f87 ctx_c242d343601f');
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1});
await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
const out='bench/results/2026-09-29-r9-review';mkdirSync(out,{recursive:true});
const schemas=['before','after','qualified'].map(v=>`test_r9_review_${v}_${process.pid}`),created:string[]=[];
try{
 for(const [i,schema]of schemas.entries()){
  assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
  await pool.query(`create schema ${schema}`);created.push(schema);
  for(let sql of (i===0?previousSql:stampMigrationSql)(schema)){
   if(i===2)sql=sql.replace(' set search_path = pg_catalog','').replace(/(?<![\w.])(cardinality|array_position|array_lower|octet_length|array_fill|array_append|encode|substr|sha256|int4send)\(/g,'pg_catalog.$1(');
   await pool.query(sql);
  }
 }
 const source=(await pool.query('select memo_plain from bench_realistic_100k.customers order by id limit 1')).rows[0].memo_plain as string;
 const profile=profiles('review','body',{type:'text',search:{substring:true}})[0],ring={keyScopeId:'global',key:new Uint8Array(32).fill(67)};
 const [a,b]=[...new Set(Array.from(compactText(source,profile)))],pair=a+b;
 const cases=[
  {name:'short-hit',value:source,term:Array.from(compactText(source,profile)).slice(0,2).join(''),like:false},
  {name:'short-miss',value:source,term:pair.repeat(3),like:false},
  {name:'repeat-near-contains',value:pair.repeat(1000)+b+b+pair.repeat(1000),term:a+b+b+a,like:false},
  {name:'repeat-near-like',value:pair.repeat(1000)+b+b+pair.repeat(1000),term:pair.repeat(128)+a+b+b+a,like:true},
  {name:'long-literal-like',value:pair.repeat(700)+b+b+pair.repeat(700),term:pair.repeat(1023)+a+b+b+a,like:true},
 ];
 const results:any[]=[];
 for(const c of cases){
  const value=compactText(c.value,profile),expected=value.includes(c.term),proof=await positionProof(ring,profile,'s',c.value,'compact2'),single=await positionProof(ring,profile,'s',c.value,'single1');
  const q=await compileStampQuery(ring,profile,'s',{op:c.like?'like':'contains',value:c.like?`%${c.term}%`:c.term});
  const row:any={name:c.name,length:Array.from(value).length,queryLength:Array.from(c.term).length,expected,runs:[[],[],[]],timeouts:{}};
  for(let round=-2;round<7;round++)for(const i of Array.from({length:schemas.length},(_,j)=>(round+2+j)%schemas.length)){
   if(row.timeouts[i])continue;
   // Test-side timeout bounds the superseded quadratic implementation, not the product API.
   await pool.query(`set statement_timeout=${i===0?1500:45000}`);
   const args=c.like?[keyArray(q.keys),q.kinds,i===0?JSON.stringify(q.pattern):patternProgram(q.pattern!),proof.length,proof.salt,proof.stamps.map(String),proof.offsets,single.salt,single.stamps.map(String),single.offsets]:
    [keyArray(q.keys),q.offsets,q.length,proof.length,proof.salt,proof.stamps.map(String),proof.offsets,0];
   const types=c.like?['bytea[]','integer[]',i===0?'jsonb':'integer[]','integer','bytea','bigint[]','integer[]','bytea','bigint[]','integer[]']:['bytea[]','integer[]','integer','integer','bytea','bigint[]','integer[]','integer'];
   const sql=`select ${schemas[i]}.sealql_match_${c.like?'like':'positions'}(${types.map((t,k)=>`$${k+1}::${t}`).join(',')}) value`;
   const start=performance.now();try{
    const response=await pool.query(sql,args);const ms=performance.now()-start;assert.equal(response.rows[0].value,expected);
    if(round>=0)row.runs[i].push(ms);
   }catch(error:any){if(i===0&&error.code==='57014')row.timeouts[i]={limitMs:1500,message:'Superseded function timed out; no median claimed.'};else throw error;}
  }
  row.medians=row.runs.map((runs:number[])=>runs.length===7?runs.slice().sort((a,b)=>a-b)[3]:null);results.push(row);console.log(JSON.stringify(row));
  writeFileSync(`${out}/functions.json`,JSON.stringify({protocol:'Two warmups, seven alternating rounds; SQL request/response ms, one candidate per call; before/after/qualified-no-SET order. Fixture-derived repeats; original function timeout is explicitly censored.',results},null,2));
 }
}finally{await pool.query('set statement_timeout=0');for(const schema of created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}

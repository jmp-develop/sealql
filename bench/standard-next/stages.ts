/** Additive stage timing for a single candidate batch, using the same product compiler, SQL adapter, sealer and verifier. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PostgresRowAccess } from '../../src/adapters/postgres/sealed-row.js';
import { candidateStatement } from '../../src/adapters/postgres/search-sql.js';
import { compileSearch, verifySearch, type CompiledSearch, type SearchNode } from '../../src/core/search-predicate.js';
import { profiles } from '../../src/core/search-tokens.js';
import { binding, executor, fields, guard, pool, query, scopeId, sealer, source } from './common.js';

const cases=[
  {name:'exact_common',node:{op:'eq',field:'company',value:'서울서비스 담당'} as SearchNode,plain:'company_norm=$2',params:['서울서비스담당']},
  {name:'sub_mid',node:{op:'contains',field:'address',value:'세종대로'} as SearchNode,plain:"address_norm like '%'||$2||'%'",params:['세종대로']},
  {name:'or3',node:{op:'any',children:[{op:'eq',field:'phone',value:'42-5748-1542'},{op:'eq',field:'phone',value:'21-7100-5875'},{op:'contains',field:'name',value:'pshxt'}]} as SearchNode,
    plain:"(phone_norm=$2 or phone_norm=$3 or name_norm like '%'||$4||'%')",params:['42-5748-1542','21-7100-5875','pshxt']},
];
const b=binding('customers'),access=new PostgresRowAccess(b.definition,b.storage),sql=executor();
const tokenCache={profiles:new Map<string,Promise<CryptoKey>>()};
const med=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
const cond=(c:CompiledSearch):string[]=>c.op==='leaf'?[c.leaf.node.field]:[...new Set(c.children.flatMap(cond))];
async function mapped<T,R>(items:T[],fn:(x:T)=>Promise<R>){const out=new Array<R>(items.length);let pos=0;await Promise.all(Array.from({length:Math.min(64,items.length)},async()=>{while(pos<items.length){const i=pos++;out[i]=await fn(items[i]);}}));return out;}
async function run(node:SearchNode){
  const stage={prepareMs:0,tokensMs:0,dbMs:0,verifyMs:0,projectionMs:0,sqlCalls:1,candidates:0,returned:0,authenticatedFields:0};
  let t=performance.now();const ring=sealer.ring(b.model.id),stored=fields.flatMap(f=>profiles(b.model.id,f,b.model.fields[f]));stage.prepareMs=performance.now()-t;
  t=performance.now();const compiled=await compileSearch(node,b.definition,stored,ring,scopeId,tokenCache);stage.tokensMs=performance.now()-t;
  t=performance.now();const rows=await access.candidates(sql,{scopeId,fields:[...fields],public:[],limit:27,candidateSql:candidateStatement(b.definition,b.storage,scopeId,compiled)});stage.dbMs=performance.now()-t;stage.candidates=rows.length;
  const conditions=cond(compiled);
  const cache=rows.map(()=>new Map<string,Promise<unknown>>());
  const get=(i:number,f:string)=>{
    let p=cache[i].get(f);if(!p){stage.authenticatedFields++;p=sealer.open(rows[i].fields[f]!,{modelId:b.model.id,fieldId:f,keyScopeId:ring.keyScopeId,scopeId,rowId:rows[i].id,spec:b.model.fields[f as typeof fields[number]]},ring);cache[i].set(f,p);}return p;
  };
  t=performance.now();const accepted=await mapped(rows.map((_,i)=>i),async i=>{await Promise.all(conditions.map(f=>get(i,f)));return verifySearch(compiled,f=>get(i,f));});stage.verifyMs=performance.now()-t;
  t=performance.now();const keep=rows.map((_,i)=>i).filter(i=>accepted[i]).slice(0,20);
  const values=await mapped(keep,i=>Promise.all(fields.map(f=>get(i,f))));stage.projectionMs=performance.now()-t;
  const out=keep.map((i,k)=>({id:rows[i].id,...Object.fromEntries(fields.map((f,j)=>[f,values[k][j]]))}));stage.returned=out.length;
  return {stage,out};
}
try{
  await guard();const report=[];
  for(const c of cases){
    const expected=(await query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from ${source}.customers where scope_id=$1 and ${c.plain} order by id limit 20`,[scopeId,...c.params])).rows;
    const check=(out:any[])=>{assert.equal(out.length,expected.length);for(let i=0;i<out.length;i++)assert.deepEqual(out[i],expected[i]);};
    check((await run(c.node)).out);for(let i=0;i<2;i++)check((await run(c.node)).out);
    const runs:Awaited<ReturnType<typeof run>>['stage'][]=[];for(let i=0;i<7;i++){const v=await run(c.node);check(v.out);runs.push(v.stage);}
    const summary=Object.fromEntries(Object.keys(runs[0]).map(k=>[k,med(runs.map(x=>(x as any)[k]))]));
    report.push({case:c.name,summary,runs});console.log(JSON.stringify({case:c.name,summary}));
  }
  await writeFile('bench/results/2026-09-27-standard-next/stages.json',JSON.stringify(report,null,2)+'\n');
}finally{await pool.end();}

/** Product API comparison on the same owned 100k fixture; no protected schema writes. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {Pool,Client} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {assertDisposable} from '../../test/disposable.js';
import {BASE_CASES} from '../research-task4/cases.js';
import {fields,plainWhere,type Node} from '../verify-native/r8-cases.js';
import {stampMigrationSql} from '../../src/core/stamp-sql.js';
import {stampMigrationSql as beforeSql} from '../../.local/r9-review-before/dist/core/stamp-sql.js';
assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-review-impl task_5488e89a7f87 ctx_c242d343601f');
const S='test_r9_performance_main',scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',out='bench/results/2026-09-29-r9-review';mkdirSync(out,{recursive:true});
const admin=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1});
await assertDisposable(admin);assert.equal(Number((await admin.query('show port')).rows[0].port),56439);
const handles:any[]=[],records:any[]=[];
try{
 for(const variant of ['before','after','qualified']){
  const root=variant==='before'?'../../.local/r9-review-before/dist':'../../dist';
  const {createSealer}=await import(root+'/index.js'),{createSealed}=await import(root+'/adapters/drizzle/v0.45/index.js');
  const suffix=variant==='after'?'':variant+'_';
  for(let sql of (variant==='before'?beforeSql:stampMigrationSql)(S).filter((s:string)=>s.startsWith('create'))){
   sql=sql.replaceAll('sealql_',`sealql_${suffix}`);
   if(variant==='qualified')sql=sql.replace(' set search_path = pg_catalog','').replace(/(?<![\w.])(cardinality|array_position|array_lower|octet_length|array_fill|array_append|encode|substr|sha256|int4send)\(/g,'pg_catalog.$1(');
   await admin.query(sql);
  }
  let events:{ms:number;rows:number}[]=[];let lastQueries:{text:string;params:any[]}[]=[];
  class MeasuredClient extends Client {query(...args:any[]):any{
    const input=args[0],text=(typeof input==='string'?input:input.text).replaceAll('sealql_',`sealql_${suffix}`);
    const params=typeof input==='string'?args[1]:(input.values??args[1]);lastQueries.push({text,params});
    args[0]=typeof input==='string'?text:{...input,text};const start=performance.now();let once=false;
    const done=(r:any)=>{if(!once){events.push({ms:performance.now()-start,rows:r?.rows?.length??0});once=true;}return r;};
    const ci=args.findIndex(x=>typeof x==='function');if(ci>=0){const cb=args[ci];args[ci]=(e:any,r:any)=>{done(r);cb(e,r);};}
    const result=(Client.prototype.query as any).apply(this,args);return ci<0&&result?.then?result.then(done):result;
  }}
  const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,Client:MeasuredClient} as any);
  const sealed=createSealed({sealer:createSealer({key:new Uint8Array(32).fill(93)})}),cols:any={id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull()};
  for(const f of fields)cols[f]=sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:{wordBoundary:true}}});
  const table=pgSchema(S).table('customers',cols),seal=sealed.register(table,{row:'id',scope:'scopeId'});
  handles.push({variant,pool,sealed,table,seal,db:drizzle(pool),reset:()=>{events=[];lastQueries=[];},metrics:()=>({sqlMs:events.reduce((n,e)=>n+e.ms,0),sqlRequests:events.length,appRows:events.reduce((n,e)=>n+e.rows,0)}),queries:()=>lastQueries});
 }
 const match=(n:Node,m:any):any=>'all'in n?m.and(...n.all.map(c=>match(c,m))):'any'in n?m.or(...n.any.map(c=>match(c,m))):m[n.field][n.op](n.value);
 for(const name of ['exact_common','sub_common_memo','starts','ends','and2','and6','or2','sub45'])for(const mode of ['count','list']){
  const c=BASE_CASES.find(c=>c.name===name)!,params:unknown[]=[scope],where=plainWhere(c.node,params);
  const truth=(await admin.query(`select ${mode==='count'?'count(*)::int n':`id,${fields.map(f=>`${f}_norm as ${f}`).join(',')}`} from research_u.customers_plain where scope_id=$1 and ${where}${mode==='list'?' order by id limit 300':''}`,params)).rows;
  const row:any={name,mode,runs:Object.fromEntries(handles.map(h=>[h.variant,[]])),summary:{},plans:{}};
  for(let round=-2;round<7;round++)for(const h of [...handles.slice((round+2)%handles.length),...handles.slice(0,(round+2)%handles.length)]){
   h.reset();const start=performance.now();const response=mode==='count'?await h.sealed.count(h.db,h.seal,{scope,match:(m:any)=>match(c.node,m)}):await h.sealed.findMany(h.db,h.seal,{scope,match:(m:any)=>match(c.node,m),limit:300});
   const metric={totalMs:performance.now()-start,...h.metrics()};
   if(mode==='count')assert.equal(response,truth[0].n);else assert.deepEqual(response.items.map((r:any)=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,r[f]]))})),truth);
   if(round>=0)row.runs[h.variant].push(metric);
  }
  for(const h of handles){
   const runs=row.runs[h.variant];row.summary[h.variant]=Object.fromEntries(Object.keys(runs[0]).map(k=>[k,runs.map((r:any)=>r[k]).sort((a:number,b:number)=>a-b)[3]]));
   if(mode==='list'&&name==='sub_common_memo'){
    const q=h.queries()[0];row.plans[h.variant]=(await admin.query('explain(analyze,buffers,format json) '+q.text,q.params)).rows[0]['QUERY PLAN'];
   }
  }
  records.push(row);console.log(JSON.stringify({name,mode,summary:row.summary}));
  writeFileSync(`${out}/search.json`,JSON.stringify({protocol:'Same 100k product table/API/keys; before a15f85a vs after vs fully function-qualified no-SET candidate. Two warmups and seven alternating rounds; full six-field values and IDs checked.',records},null,2));
 }
}finally{for(const h of handles)await h.pool.end();await admin.end();}

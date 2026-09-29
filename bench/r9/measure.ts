/** R9 product / task-4 reference / plaintext: two warmups, seven alternating rounds. */
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {writeFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {Pool,Client} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../../src/index.js';
import {createSealed} from '../../src/adapters/drizzle/v0.45/index.js';
import {assertDisposable} from '../../test/disposable.js';
import {candidate} from '../research-unified/b-product.js';
import {B_SCOPE,normalize,verification} from '../research-unified/b-codec.js';
import {BASE_CASES} from '../research-task4/cases.js';
import {fields,plainWhere,condition,type Node} from '../verify-native/r8-cases.js';

const layout=process.argv[2];assert.ok(layout==='sorted'||layout==='random');
const S='test_r9_performance_main',OUT='bench/results/2026-09-29-r9',lock='.local/research/measure.lock';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,idleTimeoutMillis:0});
await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
const cipher=createSealer({key:new Uint8Array(32).fill(93)}),sealed=createSealed({sealer:cipher}),cols:any={id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull()};
for(const f of fields)cols[f]=sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:{wordBoundary:true}}});
const table=pgSchema(S).table('customers',cols),seal=sealed.register(table,{row:'id',scope:'scopeId'}),db=drizzle(pool);
const match=(n:Node,m:any):any=>'all'in n?m.and(...n.all.map(c=>match(c,m))):'any'in n?m.or(...n.any.map(c=>match(c,m))):m[n.field][n.op](n.value);
async function clauses(node:Node,params:unknown[]):Promise<{cand:string;full:string}>{
 if('all'in node||'any'in node){const out=[];for(const child of 'all'in node?node.all:node.any)out.push(await clauses(child,params));const op='all'in node?' AND ':' OR ';return {cand:'('+out.map(p=>p.cand).join(op)+')',full:'('+out.map(p=>p.full).join(op)+')'};}
 const cand=await candidate(node,'customers',params,'j');if(node.field==='company'&&node.op==='eq')params[params.length-1]=String((BigInt(String(params.at(-1)))>>30n)&3n);
 let judge:string;
 if(node.op==='eq')judge=verification(node,'customers',params,'j');else{
  const chars=Array.from(normalize(node.value)),offs:number[]=[];for(let i=0;i+2<=chars.length;i+=2)offs.push(i);if(offs.at(-1)!==chars.length-2)offs.push(chars.length-2);
  const ks=offs.map(i=>{params.push(createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers',node.field,'pb1b-w2-n2',chars.slice(i,i+2).join('')].join('\0')).digest());return `$${params.length}::bytea`;});
  judge=`research_u.pb_4_match(ARRAY[${ks.join(',')}],ARRAY[${offs.join(',')}],${chars.length},j.n_${node.field},j.psalt_${node.field},j.stamps_${node.field},j.positions_${node.field},${node.op==='startsWith'?1:node.op==='endsWith'?2:0})`;
 }
 return {cand,full:`(${cand} AND ${judge})`};
}
type Path='plain'|'research'|'product';
async function run(path:Path,node:Node,mode:'count'|'list'){
 if(path==='product'){
  if(mode==='count')return sealed.count(db,seal,{scope:B_SCOPE,match:m=>match(node,m)});
  const page=await sealed.findMany(db,seal,{scope:B_SCOPE,match:m=>match(node,m),limit:300});
  return page.items.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(String(r[f]))]))}));
 }
 const params:unknown[]=[B_SCOPE];let query:string;
 if(path==='plain'){const where=plainWhere(node,params);query=`select ${mode==='count'?'count(*)::int n':`id,${fields.map(f=>`${f}_norm as ${f}`).join(',')}`} from research_u.customers_plain where scope_id=$1 and ${where}${mode==='list'?' order by id limit 300':''}`;}
 else {const {cand,full}=await clauses(node,params);query=mode==='count'?`select count(*)::int n from research_u.pb_4_final j where j.scope_id=$1 and ${full}`:
  `with matched as materialized(select j.id from(select j.* from research_u.pb_4_final j where j.scope_id=$1 and ${cand} order by j.id offset 0)j where ${full} order by j.id limit 300) select p.id,${fields.map(f=>`p.${f}_ct`).join(',')} from matched m join native_verify_main.customers p on p.id=m.id and p.scope_id=$1 order by p.id`;}
 const rows=(await pool.query(query,params)).rows;
 if(mode==='count')return Number(rows[0].n);if(path==='plain')return rows;
 return Promise.all(rows.map(async r=>({id:r.id,...Object.fromEntries(await Promise.all(fields.map(async f=>[f,normalize(String(await cipher.open(r[f+'_ct'],{modelId:'customers',fieldId:f,keyScopeId:'global',scopeId:B_SCOPE,rowId:r.id,spec:{type:'text'}},cipher.ring('customers'))))])))})));
}
let events:{ms:number;rows:number}[]|undefined,opens=0;
const original=cipher.open.bind(cipher);cipher.open=async(...args)=>{opens++;return original(...args);};
const query=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){const start=performance.now();let recorded=false;const done=(r:any)=>{if(!recorded){recorded=true;events?.push({ms:performance.now()-start,rows:r?.rows?.length??0});}return r;};const ci=args.findIndex(a=>typeof a==='function');if(ci>=0){const cb=args[ci];args[ci]=(e:any,r:any)=>{done(r);cb(e,r);};}const r=(query as any).apply(this,args);return ci<0&&r?.then?r.then(done):r;};
const median=(v:number[])=>v.slice().sort((a,b)=>a-b)[v.length>>1];
writeFileSync(lock,`r9-final ${process.pid}`,{flag:'wx'});mkdirSync(OUT,{recursive:true});
try{
 for(const sql of sealed.extraMigrationSql(seal))await pool.query(sql);
 const metadata=(await pool.query("select pg_backend_pid() pid,version(),(select datcollate from pg_database where datname=current_database()) locale,current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') parallel_workers")).rows[0];
 const correlation=(await pool.query("select tablename,attname,correlation from pg_stats where schemaname=$1 and attname in ('id','row_id')",[S])).rows;
 const result:any={layout,metadata,correlation,protocol:'First measured call, two warmups, seven alternating rounds; same IDs and normalized six-field projection asserted every call. Protected reference layout is unchanged.',rows:[],at:new Date().toISOString()};
 const paths:Path[]=['plain','research','product'];
 for(const name of ['exact_common','sub_common_memo','starts','ends','and2','and6','or2','sub45'])for(const mode of ['count','list']as const){
  const c=BASE_CASES.find(c=>c.name===name)!,expected=await run('plain',c.node,mode),record:any={name,condition:condition(c.node),mode,returned:mode==='count'?1:(expected as any[]).length,first:{},runs:{plain:[],research:[],product:[]},summary:{}};
  for(let round=-3;round<7;round++)for(const path of [...paths.slice((round+3)%3),...paths.slice(0,(round+3)%3)]){
   events=[];opens=0;const start=performance.now(),value=await run(path,c.node,mode),totalMs=performance.now()-start;
   const metric={totalMs,sqlMs:events.reduce((n,e)=>n+e.ms,0),sqlRequests:events.length,appRows:events.reduce((n,e)=>n+e.rows,0),opens};events=undefined;
   assert.deepEqual(value,expected,`${name}/${mode}/${path}`);
   if(path==='product')assert.equal(opens,mode==='count'?0:record.returned*6);
   if(round===-3)record.first[path]=metric;if(round>=0)record.runs[path].push(metric);
  }
  for(const path of paths)record.summary[path]=Object.fromEntries(Object.keys(record.runs[path][0]).map(key=>[key,median(record.runs[path].map((r:any)=>r[key]))]));
  result.rows.push(record);writeFileSync(`${OUT}/performance-${layout}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({name,mode,summary:record.summary}));
 }
}finally{unlinkSync(lock);await pool.end();}

/** Physical-layout write overhead, using identical fixture values and the same current API. */
import assert from 'node:assert/strict';
import {writeFileSync,unlinkSync} from 'node:fs';
import {Pool,Client} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../../src/index.js';
import {createSealed} from '../../src/adapters/drizzle/v0.45/index.js';
import {assertDisposable} from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1});
await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
const fields=['name','phone','address','memo','email','company'],paths=['test_r9_performance','test_r9_performance_main'],lock='.local/research/measure.lock';
const handles=paths.map(schema=>{
 const sealed=createSealed({sealer:createSealer({key:new Uint8Array(32).fill(93)})}),cols:any={id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull()};
 for(const f of fields)cols[f]=sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:{wordBoundary:true}}});
 const table=pgSchema(schema).table('customers',cols);return {schema,sealed,seal:sealed.register(table,{row:'id',scope:'scopeId'}),table};
});
writeFileSync(lock,`r9-write ${process.pid}`,{flag:'wx'});
let events:number[]|undefined;const query=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){const start=performance.now();let once=false;const done=(r:any)=>{if(!once){events?.push(performance.now()-start);once=true;}return r;};const ci=args.findIndex(a=>typeof a==='function');if(ci>=0){const cb=args[ci];args[ci]=(e:any,r:any)=>{done(r);cb(e,r);};}const p=(query as any).apply(this,args);return ci<0&&p?.then?p.then(done):p;};
try{
 const source=(await pool.query(`select id,scope_id,${fields.map(f=>`${f}_norm as ${f}`).join(',')} from research_u.customers_plain order by id limit 16`)).rows;
 const db=drizzle(pool),runs:any=[[],[]];
 for(let round=-2;round<7;round++)for(const i of round%2?[1,0]:[0,1]){
  const h=handles[i];events=[];const start=performance.now();
  for(const row of source)await h.sealed.update(db,h.seal,{id:row.id,scopeId:row.scope_id},Object.fromEntries(fields.map(f=>[f,row[f]])));
  const metric={totalMs:performance.now()-start,sqlMs:events.reduce((n,x)=>n+x,0),sqlRequests:events.length};events=undefined;
  if(round>=0)runs[i].push(metric);
  for(const row of source){const page=await h.sealed.findMany(db,h.seal,{scope:row.scope_id,match:(m:any)=>m.phone.eq(row.phone),limit:1});assert.equal(page.items[0]?.id,row.id);for(const f of fields)assert.equal(page.items[0]?.[f],row[f]);}
 }
 const median=(xs:number[])=>xs.slice().sort((a,b)=>a-b)[xs.length>>1];
 const summary=handles.map((h,i)=>({schema:h.schema,rowsPerRound:16,runs:runs[i],medians:Object.fromEntries(Object.keys(runs[i][0]).map(k=>[k,median(runs[i].map((x:any)=>x[k]))]))}));
 writeFileSync('bench/results/2026-09-29-r9/writes.json',JSON.stringify({protocol:'Two warmups, seven alternating rounds; same current product, same 16 rows and six values, one transaction per row. Aggregate physical change, not an isolated index-only estimate.',summary},null,2));
 console.log(JSON.stringify(summary.map(x=>({...x,runs:undefined}))));
}finally{unlinkSync(lock);await pool.end();}

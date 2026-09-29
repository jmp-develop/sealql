/** Read-only diagnosis/paired API benchmark on the independently loaded original fixture. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {Pool,Client} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {assertDisposable} from '../../test/disposable.js';
import {BASE_CASES} from '../research-task4/cases.js';
import {fields,type Node} from '../verify-native/r8-cases.js';
assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-email-fix task_159e253bad34');
const OUT='bench/results/2026-09-29-r9-email-limit';mkdirSync(OUT,{recursive:true});
const scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let queries:{text:string;params:any[];ms:number;rows:number}[]=[];
class MeasuredClient extends Client {query(...args:any[]):any {
 const input=args[0],text=typeof input==='string'?input:input.text,params=typeof input==='string'?args[1]:(input.values??args[1]);
 const start=performance.now();let done=false;const record=(r:any)=>{if(!done){queries.push({text,params,ms:performance.now()-start,rows:r?.rows?.length??0});done=true;}return r;};
 const callback=args.findIndex(x=>typeof x==='function');if(callback>=0){const cb=args[callback];args[callback]=(e:any,r:any)=>{record(r);cb(e,r);};}
 const result=(Client.prototype.query as any).apply(this,args);return callback<0&&result?.then?result.then(record):result;
}}
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,Client:MeasuredClient,idleTimeoutMillis:0,options:'-c default_transaction_read_only=on'} as any);
await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
const normalize=(s:string)=>s.normalize('NFC').replace(/[！-～]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xff01+0x21)).replace(/[A-Z]/g,c=>c.toLowerCase()).replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g,'');
const plain=(n:Node,r:any):boolean=>'all'in n?n.all.every(c=>plain(c,r)):'any'in n?n.any.some(c=>plain(c,r)):n.op==='eq'?r[n.field]===normalize(n.value):r[n.field][n.op==='contains'?'includes':n.op](normalize(n.value));
const match=(n:Node,m:any):any=>'all'in n?m.and(...n.all.map(c=>match(c,m))):'any'in n?m.or(...n.any.map(c=>match(c,m))):m[n.field][n.op](n.value);
const median=(xs:number[])=>xs.slice().sort((a,b)=>a-b)[xs.length>>1];
try {
 const session=(await pool.query("select pg_backend_pid() pid,current_setting('work_mem') work_mem,current_setting('default_transaction_read_only') read_only")).rows[0];
 assert.equal((await pool.query('select count(*)::int n from test_r9_verify_main.customers')).rows[0].n,100000);
 const source=(await pool.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;
 const data=source.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));
 const handles:any[]=[];
 for(const variant of process.argv.includes('--order-parity')?['explicit','default']:['before','after','default']) {
  const root=variant==='before'?'../../.local/r9-email-before/dist':'../../dist';
  const {createSealer}=await import(root+'/index.js'),{createSealed}=await import(root+'/adapters/drizzle/v0.45/index.js');
  const cipher=createSealer({key:new Uint8Array(32).fill(93)});let opens=0;const open=cipher.open.bind(cipher);cipher.open=async(...args:any[])=>{opens++;return open(...args);};
  const sealed=createSealed({sealer:cipher}),cols:any={id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull()};
  for(const f of fields)cols[f]=sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:{wordBoundary:true}}});
  const table=pgSchema('test_r9_verify_main').table('customers',cols),seal=sealed.register(table,{row:'id',scope:'scopeId'});
  handles.push({variant,sealed,table,seal,reset:()=>{opens=0;queries=[];},opens:()=>opens});
 }
 const db=drizzle(pool),cases=[...BASE_CASES.filter(c=>['exact_common','sub_common_memo','sub_rare','starts','ends','and2','and6','or2','sub45'].includes(c.name)),{name:'affix_endsWith_email',node:{field:'email',op:'endsWith',value:'est'} as Node}];
 const invoke=async(h:any,node:Node,mode:string,explicit=true)=>{
  h.reset();const start=performance.now();
  const response=mode==='count'?await h.sealed.count(db,h.seal,{scope,match:(m:any)=>match(node,m)}):await h.sealed.findMany(db,h.seal,{scope,match:(m:any)=>match(node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),...(explicit?{orderBy:{column:h.table.id,direction:'asc'}}:{}),limit:300});
  const captured=queries.slice(),metric={totalMs:performance.now()-start,sqlMs:captured.reduce((n,q)=>n+q.ms,0),sqlCalls:captured.length,appRows:captured.reduce((n,q)=>n+q.rows,0),opens:h.opens()};
  return {value:mode==='count'?response:response.items.map((r:any)=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))})),metric,query:captured[0]};
 };
 if(process.argv.includes('--cursor-only')) {
  const c=cases.find(c=>c.name==='ends')!,expected=data.filter(r=>plain(c.node,r));
  const [before,after]=handles;
  const options=(h:any)=>({scope,match:(m:any)=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:h.table.id,direction:'asc'},limit:300});
  const first=await before.sealed.findMany(db,before.seal,options(before));assert.ok(first.nextCursor);
  const next=await after.sealed.findMany(db,after.seal,{...options(after),cursor:first.nextCursor});
  assert.deepEqual(next.items.map((r:any)=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))})),expected.slice(300,600));
  const result={session,oldExplicitCursorAccepted:true,secondPageRows:next.items.length,plaintextEqual:true};
  writeFileSync(`${OUT}/cursor.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 } else if(process.argv.includes('--diagnose')) {
  const plans:any[]=[];
  for(const c of cases.filter(c=>c.node&&'field'in c.node&&c.node.field==='email'))for(const explicit of [true,false]) {
   const out=await invoke(handles[0],c.node,'list',explicit);assert.deepEqual(out.value,data.filter(r=>plain(c.node,r)).slice(0,300));
   const plan=(await pool.query('explain(analyze,buffers,format json) '+out.query.text,out.query.params)).rows[0]['QUERY PLAN'];
   plans.push({name:c.name,explicit,metric:out.metric,sql:out.query.text,plan});
   console.log(JSON.stringify({name:c.name,explicit,metric:out.metric}));
  }
  writeFileSync(`${OUT}/diagnosis.json`,JSON.stringify({session,plans},null,2));
 } else {
  const records:any[]=[];
  for(const c of process.argv.includes('--affix-only')?cases.filter(c=>['ends','affix_endsWith_email'].includes(c.name)):cases)for(const mode of process.argv.includes('--affix-only')||process.argv.includes('--order-parity')?['list']:['count','list']) {
   const matches=data.filter(r=>plain(c.node,r)),expected=mode==='count'?matches.length:matches.slice(0,300);
   const paths=mode==='count'?handles.filter(h=>h.variant!=='default'):handles;
   const row:any={name:c.name,node:c.node,mode,matches:matches.length,runs:Object.fromEntries(paths.map(h=>[h.variant,[]])),summary:{},plans:{},sql:{}};
   for(let round=-2;round<7;round++)for(const h of [...paths.slice((round+2)%paths.length),...paths.slice(0,(round+2)%paths.length)]) {
    const out=await invoke(h,c.node,mode,h.variant!=='default');assert.deepEqual(out.value,expected,`${c.name}/${mode}/${h.variant}`);
    assert.equal(out.metric.opens,mode==='count'?0:(expected as any[]).length*6);
    if(round>=0)row.runs[h.variant].push(out.metric);
    if(round===6){row.sql[h.variant]=out.query.text;row.plans[h.variant]=(await pool.query('explain(analyze,buffers,format json) '+out.query.text,out.query.params)).rows[0]['QUERY PLAN'];}
   }
   for(const h of paths)row.summary[h.variant]=Object.fromEntries(Object.keys(row.runs[h.variant][0]).map(k=>[k,median(row.runs[h.variant].map((r:any)=>r[k]))]));
   if(mode==='count')assert.equal(row.sql.before,row.sql.after,'page planning must not change count SQL');
   if(mode==='list'&&(row.sql.after??row.sql.explicit)&&row.sql.default){assert.equal(row.sql.after??row.sql.explicit,row.sql.default,'default and explicit identity order must emit identical SQL');row.identicalSql=true;}
   records.push(row);writeFileSync(`${OUT}/${process.argv.includes('--order-parity')?'order-parity':'comparison'}.json`,JSON.stringify({session,protocol:'Read-only original 100k fixture, identical physical PostgreSQL session, explicit id ascending (or --order-parity default-order control), two warmups/seven alternating rounds; independent original-value normalization oracle; EXPLAIN separately after final samples.',records},null,2));
   console.log(JSON.stringify({name:c.name,mode,summary:row.summary}));
  }
 }
 assert.equal((await pool.query('select pg_backend_pid() pid')).rows[0].pid,session.pid);
}finally{await pool.end();}

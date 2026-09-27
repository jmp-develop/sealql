import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { normalizeText } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { scopeId } from './schema.js';
import { scaleCustomersSeal, scaleSealed } from './scale-schema.js';

const cases = [
  {name:'exact_mid',field:'company',op:'eq',term:'서울서비스 중앙지사'},
  {name:'sub_rare',field:'memo',op:'contains',term:'푸른달'},
  {name:'zero',field:'memo',op:'contains',term:'없는표식'},
] as const;
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=600000'});
const db=drizzle(pool), original=Client.prototype.query;
let events: {ms:number;rows:number}[]|null=null;
(Client.prototype as any).query=function(...args:any[]){
  const start=performance.now(), record=(r:any)=>{events?.push({ms:performance.now()-start,rows:r?.rows?.length??0});return r;};
  const cbIndex=args.findIndex(x=>typeof x==='function');
  if(cbIndex>=0){const cb=args[cbIndex];args[cbIndex]=(e:any,r:any)=>{if(!e)record(r);cb(e,r);};}
  const r=(original as any).apply(this,args);return cbIndex<0&&r?.then?r.then(record):r;
};
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n),1000);
  const report=[];
  for(const c of cases){
    const n=normalizeText(c.term,'legacy-text-v1');
    const plain=async()=>Number((await pool.query(`select count(*) n from native_scale_100m.customers_plain where scope_id=$1 and ${c.field}_norm ${c.op==='eq'?'= $2':"like '%'||$2||'%'"}`,[scopeId,n])).rows[0].n);
    const product=()=>scaleSealed.count(db,scaleCustomersSeal,{scope:scopeId,match:m=>(m as any)[c.field][c.op](c.term),maxCandidates:20000,
      budgets:{deadlineMs:30000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024}});
    const productOutcome=async()=>{try{return {kind:'value',value:await product()};}catch(e:any){
      assert.equal(e?.code,'LIMIT_EXCEEDED',c.name);return {kind:'LIMIT_EXCEEDED'};
    }};
    const expected=await plain(),first=await productOutcome();
    if(first.kind==='value')assert.equal(first.value,expected,c.name);
    for(let i=0;i<2;i++){assert.equal(await plain(),expected);assert.deepEqual(await productOutcome(),first);}
    const runs:{plain:any[];product:any[]}={plain:[],product:[]};
    for(let i=0;i<7;i++)for(const path of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]){
      const ev:{ms:number;rows:number}[]=[];events=ev;const start=performance.now();
      let outcome:any;try{outcome=await (path==='plain'?plain().then(value=>({kind:'value',value})):productOutcome());}finally{events=null;}
      if(path==='plain')assert.equal(outcome.value,expected);else assert.deepEqual(outcome,first);
      runs[path].push({totalMs:performance.now()-start,sqlMs:ev.reduce((a,x)=>a+x.ms,0),sqlCalls:ev.length,
        candidates:path==='product'?ev.reduce((a,x)=>a+x.rows,0):0,returned:outcome.kind==='value'?outcome.value:null,
        outcome:outcome.kind});
    }
    const summary=Object.fromEntries(Object.entries(runs).map(([path,rs])=>[path,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates','returned'].map(k=>[k,median(rs.map(r=>r[k]))]))]));
    report.push({case:c.name,expected,productOutcome:first,summary,runs});console.log(JSON.stringify({case:c.name,productOutcome:first,summary}));
    await writeFile('bench/results/2026-09-27-native-scale-100m/count.json',JSON.stringify(report,null,2)+'\n');
  }
}finally{Client.prototype.query=original;await pool.end();}

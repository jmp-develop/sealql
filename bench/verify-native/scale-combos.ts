/** Five existing AND/OR predicates, one 200-row page and one exact count each. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { normalizeText } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId } from './schema.js';
import { scaleCustomersSeal, scaleSealed } from './scale-schema.js';

type Field = typeof fields[number];
type Leaf = { op: 'eq' | 'contains'; field: Field; value: string };
type Node = Leaf | { all: Node[] } | { any: Node[] };
const L = (op: Leaf['op'], field: Field, value: string): Leaf => ({ op, field, value });
// Copied verbatim from scale-matrix.ts; changes to that matrix require a new measurement.
const cases: { name: string; node: Node }[] = [
  { name:'and2', node:{ all:[L('eq','company','서울서비스 담당'),L('contains','memo','서비스')] } },
  { name:'and4', node:{ all:[L('eq','company','서울서비스 담당'),L('contains','address','서울'),L('contains','memo','상담'),L('contains','email','service')] } },
  { name:'and6', node:{ all:[L('contains','name','민서'),L('contains','phone','-5'),L('contains','address','서울'),L('contains','memo','서비스'),L('contains','email','test'),L('eq','company','서울서비스 담당')] } },
  { name:'or2', node:{ any:[L('eq','company','서울서비스 담당'),L('contains','memo','푸른달')] } },
  { name:'or3', node:{ any:[L('eq','phone','42-5748-1542'),L('eq','phone','21-7100-5875'),L('contains','name','pshxt')] } },
];
const out='bench/results/2026-09-27-native-scale-100m';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:4,
  options:'-c statement_timeout=0'});
const db=drizzle(pool);
type Event={start:number;end:number;rows:number;sql:string};
let events:Event[]|null=null;
const original=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){
  const start=performance.now(), sql=typeof args[0]==='string'?args[0]:args[0]?.text??'';
  const record=(result:any)=>{events?.push({start,end:performance.now(),rows:result?.rows?.length??0,sql});return result;};
  const callback=args.findIndex(x=>typeof x==='function');
  if(callback>=0){const cb=args[callback];args[callback]=(err:any,result:any)=>{record(result);cb(err,result);};}
  const result=(original as any).apply(this,args);
  return callback<0&&result?.then?result.then(record,(err:any)=>{record(null);throw err;}):result;
};
function where(n:Node,p:unknown[]):string{
  if('all' in n)return '('+n.all.map(x=>where(x,p)).join(' and ')+')';
  if('any' in n)return '('+n.any.map(x=>where(x,p)).join(' or ')+')';
  const v=normalizeText(n.value,'legacy-text-v1');assert(!/[%_\\]/.test(v));p.push(v);
  return `${n.field}_norm ${n.op==='eq'?'=':"like '%'||"}$${p.length}${n.op==='eq'?'':"||'%'"}`;
}
function match(n:Node,m:any):any{
  if('all' in n)return m.and(...n.all.map(x=>match(x,m)));
  if('any' in n)return m.or(...n.any.map(x=>match(x,m)));
  return m[n.field][n.op](n.value);
}
type Outcome={kind:'value';value:any}|{kind:'error';code:string;message:string};
async function measure(fn:()=>Promise<any>){
  const ev:Event[]=[];events=ev;const start=performance.now();let outcome:Outcome;
  try{outcome={kind:'value',value:await fn()};}
  catch(e:any){outcome={kind:'error',code:String(e?.code??e?.name??'ERROR'),message:String(e?.message??e)};}
  finally{events=null;}
  const end=performance.now(),sqlMs=ev.reduce((s,e)=>s+e.end-e.start,0);
  const preMs=ev.length?ev[0].start-start:end-start;
  const postMs=ev.length?end-ev.at(-1)!.end:0;
  return {outcome,totalMs:end-start,preMs,sqlMs,betweenSqlMs:Math.max(0,end-start-preMs-sqlMs-postMs),postMs,
    sqlCalls:ev.length,candidates:ev.reduce((s,e)=>s+e.rows,0),sql:ev.map(e=>e.sql)};
}
const median=(v:number[])=>[...v].sort((a,b)=>a-b)[v.length>>1];
const metrics=['totalMs','preMs','sqlMs','betweenSqlMs','postMs','sqlCalls','candidates'] as const;
function summary(runs:any[]){return Object.fromEntries(metrics.map(k=>[k,median(runs.map(r=>r[k]))]));}
function checkRows(actual:any[],expected:any[],label:string){
  assert.equal(actual.length,expected.length,`${label}/length`);
  for(let i=0;i<actual.length;i++){
    assert.equal(actual[i].id,expected[i].id,`${label}/id/${i}`);
    for(const f of fields)assert.equal(actual[i][f],expected[i][f],`${label}/${f}/${i}`);
  }
}
const budgets={batch:2000,maxCandidates:20000,fetchBytes:32*1024*1024,
  decryptedBytes:32*1024*1024,resultBytes:32*1024*1024,deadlineMs:30000,decryptConcurrency:64};
try{
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n),1000);
  const report:any[]=[];
  for(const c of cases){
    const sourceParams:unknown[]=[scopeId],sourceWhere=where(c.node,sourceParams);
    const source=Number((await pool.query(`select count(*) n from bench_realistic_100k.customers where scope_id=$1 and ${sourceWhere}`,sourceParams)).rows[0].n);
    const expectedMatches=source*1000;
    const params:unknown[]=[scopeId],condition=where(c.node,params);
    const plainFind=()=>pool.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from native_scale_100m.customers_plain where scope_id=$1 and ${condition} order by id limit 200`,params).then(r=>r.rows);
    const sealedFind=()=>scaleSealed.findMany(db,scaleCustomersSeal,{scope:scopeId,match:m=>match(c.node,m),
      columns:Object.fromEntries(fields.map(f=>[f,true])) as any,limit:200,
      budgets:{maxCandidates:20000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024,
        resultBytes:32*1024*1024,deadlineMs:30000}}).then(r=>r.items);
    const warmup:any={plain:[],product:[]};
    for(let i=0;i<2;i++){
      warmup.plain.push(await measure(plainFind));
      warmup.product.push(await measure(sealedFind));
    }
    const runs:{plain:any[];product:any[]}={plain:[],product:[]};
    let expectedRows:any[]|null=null;
    for(let i=0;i<7;i++)for(const path of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]){
      const result=await measure(path==='plain'?plainFind:sealedFind);
      if(result.outcome.kind==='value'){
        if(path==='plain'){
          if(expectedRows)checkRows(result.outcome.value,expectedRows,`${c.name}/plain/${i}`);
          else expectedRows=result.outcome.value;
        }else if(expectedRows)checkRows(result.outcome.value,expectedRows,`${c.name}/product/${i}`);
      }
      runs[path].push({...result,returned:result.outcome.kind==='value'?result.outcome.value.length:null,
        outcome:result.outcome.kind==='value'?{kind:'value'}:result.outcome});
    }
    assert(expectedRows,`${c.name}/plain produced no rows result`);
    for(const r of warmup.product)if(r.outcome.kind==='value')checkRows(r.outcome.value,expectedRows,`${c.name}/warmup`);
    const find={mode:'findMany',searchRows:100000000,expectedMatches,returned:expectedRows.length,
      plain:summary(runs.plain),product:summary(runs.product),runs,
      productErrors:runs.product.filter(x=>x.outcome.kind==='error').map(x=>x.outcome),
      rule:'warmup2_alternating7_median'};
    const plainCount=await measure(()=>pool.query(`select count(*) n from native_scale_100m.customers_plain where scope_id=$1 and ${condition}`,params).then(r=>Number(r.rows[0].n)));
    if(plainCount.outcome.kind==='value')assert.equal(plainCount.outcome.value,expectedMatches,`${c.name}/scale count`);
    const productCount=await measure(()=>scaleSealed.count(db,scaleCustomersSeal,{scope:scopeId,match:m=>match(c.node,m),
      maxCandidates:1000000,budgets}));
    if(plainCount.outcome.kind==='value'&&productCount.outcome.kind==='value')
      assert.equal(productCount.outcome.value,plainCount.outcome.value,`${c.name}/count`);
    const count={mode:'count',searchRows:100000000,expectedMatches,
      returned:productCount.outcome.kind==='value'?productCount.outcome.value:null,
      plain:{...plainCount,outcome:plainCount.outcome.kind==='value'?{kind:'value',value:plainCount.outcome.value}:plainCount.outcome},
      product:{...productCount,outcome:productCount.outcome.kind==='value'?{kind:'value',value:productCount.outcome.value}:productCount.outcome},
      rule:'single_no_warmup',maxCandidates:1000000,budgets};
    report.push({case:c.name,sourceMatches:source,find,count});
    await writeFile(`${out}/combo-results.json`,JSON.stringify({schema:'native_scale_100m',copies:1000,
      source:'bench_realistic_100k',conditionsFrom:'bench/verify-native/scale-matrix.ts',report},null,2)+'\n');
    console.log(JSON.stringify({case:c.name,expectedMatches,find:{plain:find.plain,product:find.product,errors:find.productErrors},
      count:{plain:count.plain.totalMs,product:count.product.totalMs,outcome:count.product.outcome}}));
  }
}finally{Client.prototype.query=original;await pool.end();}

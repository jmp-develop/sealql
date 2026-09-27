import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId } from './schema.js';
import { scaleCustomers, scaleCustomersSeal, scaleSealed } from './scale-schema.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=600000'});
const db=drizzle(pool),original=Client.prototype.query;
let events:{ms:number;rows:number;sql:string}[]|null=null;
(Client.prototype as any).query=function(...args:any[]){
  const start=performance.now(),sql=typeof args[0]==='string'?args[0]:args[0]?.text??'';
  const record=(r:any)=>{events?.push({ms:performance.now()-start,rows:r?.rows?.length??0,sql});return r;};
  const i=args.findIndex(x=>typeof x==='function');if(i>=0){const cb=args[i];args[i]=(e:any,r:any)=>{if(!e)record(r);cb(e,r);};}
  const r=(original as any).apply(this,args);return i<0&&r?.then?r.then(record):r;
};
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
type Row={id:string;scope_id:string;[key:string]:string};
const productValue=(r:Row)=>({id:r.id,scopeId:r.scope_id,...Object.fromEntries(fields.map(f=>[f,r[`${f}_plain`]]))});
async function clear(){
  await pool.query('delete from native_scale_100m.customers_plain where id=any($1::uuid[])',[writeIds]);
  await pool.query('delete from native_scale_100m.customers where id=any($1::uuid[])',[writeIds]);
}
let writeIds:string[]=[];
async function timed(fn:()=>Promise<any>){const ev:{ms:number;rows:number;sql:string}[]=[];events=ev;const start=performance.now();
  try{await fn();const data=ev.filter(x=>!/^(begin|commit|rollback)$/i.test(x.sql.trim()));
    return{totalMs:performance.now()-start,sqlMs:ev.reduce((s,x)=>s+x.ms,0),sqlCalls:ev.length,
      dataSqlMs:data.reduce((s,x)=>s+x.ms,0),dataCalls:data.length,
      txnSqlMs:ev.filter(x=>/^(begin|commit|rollback)$/i.test(x.sql.trim())).reduce((s,x)=>s+x.ms,0)};}
  finally{events=null;}}
async function stage(path:'plain'|'product',rows:Row[]){
  await clear();
  const plainCols=['scope_id','id',...fields.flatMap(f=>[`${f}_plain`,`${f}_norm`])];
  const one=`insert into native_scale_100m.customers_plain(${plainCols.join(',')}) values(${plainCols.map((_,i)=>`$${i+1}`).join(',')})`;
  const samples:any={};
  samples.insert=await timed(async()=>{
    for(const r of rows)path==='plain'
      ?await pool.query(one,[r.scope_id,r.id,...fields.flatMap(f=>[r[`${f}_plain`],r[`${f}_norm`]])])
      :await scaleSealed.insert(db,scaleCustomersSeal,productValue(r) as any);
  });
  samples.update=await timed(async()=>{
    for(let i=0;i<rows.length;i++){
      const r=rows[i],next=rows[(i+1)%rows.length];
      if(path==='plain')await pool.query('update native_scale_100m.customers_plain set memo_plain=$3,memo_norm=$4 where scope_id=$1 and id=$2',
        [r.scope_id,r.id,next.memo_plain,next.memo_norm]);
      else await scaleSealed.update(db,scaleCustomersSeal,{id:r.id,scopeId:r.scope_id},{memo:next.memo_plain});
    }
  });
  samples.delete=await timed(async()=>{
    for(const r of rows)path==='plain'
      ?await pool.query('delete from native_scale_100m.customers_plain where scope_id=$1 and id=$2',[r.scope_id,r.id])
      :await db.delete(scaleCustomers).where(eq(scaleCustomers.id,r.id));
  });
  assert.equal(Number((await pool.query(`select count(*) n from native_scale_100m.${path==='plain'?'customers_plain':'customers'} where id=any($1::uuid[])`,[writeIds])).rows[0].n),0);
  return samples;
}
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n),1000);
  const rows=(await pool.query(`select id,scope_id,${fields.flatMap(f=>[`${f}_plain`,`${f}_norm`]).join(',')} from bench_realistic_100k.customers
    where scope_id=$1 order by id limit 1000`,[scopeId])).rows as Row[];assert.equal(rows.length,1000);
  for(const row of rows)row.id='30000000'+row.id.slice(8);
  writeIds=rows.map(r=>r.id);
  await clear();
  for(let i=0;i<2;i++){await stage('plain',rows);await stage('product',rows);console.log(`warmup ${i+1}/2`);}
  const runs:{plain:any[];product:any[]}={plain:[],product:[]};
  for(let i=0;i<7;i++)for(const path of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]){
    runs[path].push(await stage(path,rows));console.log(`run ${i+1}/7 ${path}`);
  }
  const summary=Object.fromEntries(Object.entries(runs).map(([p,rs])=>[p,Object.fromEntries(['insert','update','delete'].map(op=>[op,
    Object.fromEntries(['totalMs','sqlMs','sqlCalls','dataSqlMs','dataCalls','txnSqlMs'].map(k=>[k,median(rs.map(r=>r[op][k]))]))]))]));
  await writeFile('bench/results/2026-09-27-native-scale-100m/write.json',JSON.stringify({rows:1000,warmup:2,alternatingRuns:7,summary,runs},null,2)+'\n');
  console.log(JSON.stringify(summary));
  // One batch per path, repeated with the same derived rows.
  const batch:{plain:any[];product:any[]}={plain:[],product:[]};
  const batchPlain=async()=>{
    const columns=['scope_id','id',...fields.flatMap(f=>[`${f}_plain`,`${f}_norm`])], params=rows.flatMap(r=>[r.scope_id,r.id,...fields.flatMap(f=>[r[`${f}_plain`],r[`${f}_norm`]])]);
    const width=columns.length,values=rows.map((_,i)=>`(${columns.map((_,j)=>`$${i*width+j+1}`).join(',')})`).join(',');
    await pool.query(`insert into native_scale_100m.customers_plain(${columns.join(',')}) values ${values}`,params);
  };
  for(let i=0;i<9;i++)for(const path of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]){
    await clear();const result=await timed(path==='plain'?batchPlain:()=>scaleSealed.insert(db,scaleCustomersSeal,rows.map(productValue) as any));
    const n=Number((await pool.query(`select count(*) n from native_scale_100m.${path==='plain'?'customers_plain':'customers'} where id=any($1::uuid[])`,[writeIds])).rows[0].n);assert.equal(n,1000);
    if(i>=2)batch[path].push(result);console.log(`batch ${i+1}/9 ${path}`);
  }
  await clear();
  const batchSummary=Object.fromEntries(Object.entries(batch).map(([p,rs])=>[p,Object.fromEntries(['totalMs','sqlMs','sqlCalls','dataSqlMs','dataCalls','txnSqlMs'].map(k=>[k,median(rs.map(r=>r[k]))]))]));
  await writeFile('bench/results/2026-09-27-native-scale-100m/write-batch.json',JSON.stringify({rows:1000,warmup:2,alternatingRuns:7,summary:batchSummary,runs:batch},null,2)+'\n');
  console.log(JSON.stringify(batchSummary));
}finally{Client.prototype.query=original;await pool.end();}

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { assertDisposable } from '../../test/disposable.js';
import { customersWrite, customersWriteSeal, fields, sealed, scopeId } from './schema.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
const db=drizzle(pool),original=Client.prototype.query;
type Event={sql:string;ms:number;rows:number};let events:Event[]|null=null;
(Client.prototype as any).query=function(...args:any[]){
  const started=performance.now(),sql=typeof args[0]==='string'?args[0]:args[0]?.text??'';
  const record=(r:any)=>{events?.push({sql,ms:performance.now()-started,rows:r?.rows?.length??0});return r;};
  const i=args.findIndex(x=>typeof x==='function');if(i>=0){const cb=args[i];args[i]=(err:any,r:any)=>{if(!err)record(r);cb(err,r);};}
  const r=(original as any).apply(this,args);return i<0&&r?.then?r.then(record):r;
};
async function trace(fn:()=>Promise<unknown>){const ev:Event[]=[];events=ev;const t=performance.now();
  try{await fn();return{totalMs:performance.now()-t,sqlMs:ev.reduce((s,x)=>s+x.ms,0),sqlCalls:ev.length,events:ev};}
  finally{events=null;}}
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  for(const t of ['customers_write','customers_write_seal_index','customers_write_plain'])
    assert.equal(Number((await pool.query(`select count(*) n from native_verify_main.${t}`)).rows[0].n),0);
  const rows=(await pool.query(`select id,scope_id,${fields.flatMap(f=>[`${f}_plain`,`${f}_norm`]).join(',')}
    from bench_realistic_100k.customers where scope_id=$1 order by id limit 2`,[scopeId])).rows;
  assert.equal(rows.length,2);const r=rows[0],next=rows[1];
  const plainCols=['scope_id','id',...fields.flatMap(f=>[`${f}_plain`,`${f}_norm`])],plainVals=[scopeId,r.id,...fields.flatMap(f=>[r[`${f}_plain`],r[`${f}_norm`]])];
  const plainInsert=`insert into native_verify_main.customers_write_plain(${plainCols.join(',')}) values(${plainCols.map((_,i)=>`$${i+1}`).join(',')})`;
  const product={id:r.id,scopeId,...Object.fromEntries(fields.map(f=>[f,r[`${f}_plain`]]))};
  const result={
    plainInsert:await trace(()=>pool.query(plainInsert,plainVals)),
    productInsert:await trace(()=>sealed.insert(db,customersWriteSeal,product as any)),
    plainUpdate:await trace(()=>pool.query('update native_verify_main.customers_write_plain set memo_plain=$3,memo_norm=$4 where scope_id=$1 and id=$2',
      [scopeId,r.id,next.memo_plain,next.memo_norm])),
    productUpdate:await trace(()=>sealed.update(db,customersWriteSeal,{id:r.id,scopeId},{memo:next.memo_plain})),
    plainDelete:await trace(()=>pool.query('delete from native_verify_main.customers_write_plain where scope_id=$1 and id=$2',[scopeId,r.id])),
    productDelete:await trace(()=>db.delete(customersWrite).where(eq(customersWrite.id,r.id))),
  };
  assert.equal(Number((await pool.query('select count(*) n from native_verify_main.customers_write')).rows[0].n),0);
  assert.equal(Number((await pool.query('select count(*) n from native_verify_main.customers_write_seal_index')).rows[0].n),0);
  await writeFile('bench/results/2026-09-27-native-verification/v3/write-roundtrip.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([k,v])=>[k,{sqlCalls:v.sqlCalls,totalMs:v.totalMs,
    sqlMs:v.sqlMs,sql:v.events.map(e=>e.sql.replace(/\s+/g,' ').slice(0,200))}]))));
}finally{Client.prototype.query=original;await pool.end();}

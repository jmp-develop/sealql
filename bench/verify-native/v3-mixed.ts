import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias, pgSchema, uuid } from 'drizzle-orm/pg-core';
import { normalizeText } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { customers, customersSeal, fields, sealed, scopeId } from './schema.js';

const pub=[`p.name_norm<>''`,`p.phone_norm>'1'`,`p.phone_norm<'9'`,`p.address_norm<>'x'`,`p.email_norm like '%.test'`,`char_length(p.name_norm)>2`,`char_length(p.memo_norm)<200`,`p.company_norm<>'none'`,`p.id<>'00000000-0000-0000-0000-000000000000'`,`p.revision>=1`,
  `left(p.phone_norm,1) in ('1','2','3','4','5','6','7','8','9')`,`p.address_norm not like '%xyz%'`,`p.email_norm not like 'zz%'`,`p.name_norm not like '%@%'`,`p.memo_norm<>''`,`p.company_norm not like '%xyz%'`,`char_length(p.address_norm)>5`,`char_length(p.email_norm)>5`,
  `p.phone_norm not like '%abc%'`,`p.name_norm<>'관리자'`,`p.revision<1000`,`p.scope_id is not null`,`p.email_norm<>'a@b.c'`,`p.address_norm<>'서울'`];
const enc=[{field:'name',op:'contains',term:'민서'},{field:'phone',op:'contains',term:'-5'},{field:'address',op:'contains',term:'서울'},{field:'memo',op:'contains',term:'서비스'},{field:'email',op:'contains',term:'test'},{field:'company',op:'eq',term:'서울서비스 담당'}] as const;
const source=pgSchema('bench_realistic_100k').table('customers',{id:uuid('id').primaryKey()});
const p=alias(source,'p');
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
const db=drizzle(pool), original=Client.prototype.query;
let events:{ms:number;rows:number;text:string}[]|null=null;
(Client.prototype as any).query=function(...args:any[]){
  const start=performance.now(), text=typeof args[0]==='string'?args[0]:args[0]?.text??'';
  const record=(r:any)=>{events?.push({ms:performance.now()-start,rows:r?.rows?.length??0,text});return r;};
  const i=args.findIndex(x=>typeof x==='function');if(i>=0){const cb=args[i];args[i]=(e:any,r:any)=>{if(!e)record(r);cb(e,r);};}
  const r=(original as any).apply(this,args);return i<0&&r?.then?r.then(record):r;
};
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
const norm=(x:string)=>normalizeText(x,'legacy-text-v1');
const plain=async()=>{const args=[scopeId,...enc.map(x=>norm(x.term))], w=enc.map((x,i)=>x.op==='eq'?`p.${x.field}_norm=$${i+2}`:`p.${x.field}_norm like '%'||$${i+2}||'%'`).join(' and ');
  return (await pool.query(`select p.id,${fields.map(f=>`p.${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers p
    where p.scope_id=$1 and ${pub.join(' and ')} and ${w} order by p.id limit 20`,args)).rows;};
const product=async()=>{const page=await sealed.search(db,{scope:scopeId,match:{c:[customersSeal,m=>m.and(
  ...enc.map(x=>(m as any)[x.field][x.op](x.term)),m.sql(sql.raw(pub.join(' and '))))]},limit:20,
  query:({where,after,orderBy,flags,limit})=>db.select({c:customers,...flags}).from(customers)
    .innerJoin(p,eq(customers.id,p.id)).where(and(where,after)).orderBy(...orderBy).limit(limit)});
  return page.items.map(x=>({id:x.c.id,...Object.fromEntries(fields.map(f=>[f,(x.c as any)[f]]))}));};
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_verify_main.customers')).rows[0].n),100000);
  const expected=await plain();assert.deepEqual(await product(),expected);
  for(let i=0;i<2;i++){assert.deepEqual(await plain(),expected);assert.deepEqual(await product(),expected);}
  const runs:{plain:any[];product:any[]}={plain:[],product:[]};
  for(let i=0;i<7;i++)for(const path of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]){
    const ev:{ms:number;rows:number;text:string}[]=[];events=ev;const start=performance.now();let rows:any[];
    try{rows=await (path==='plain'?plain():product());}finally{events=null;}
    assert.deepEqual(rows,expected);runs[path].push({totalMs:performance.now()-start,sqlMs:ev.reduce((s,x)=>s+x.ms,0),sqlCalls:ev.length,
      candidates:path==='product'?ev.reduce((s,x)=>s+x.rows,0):0,returned:rows.length,sql:ev.map(x=>x.text)});
  }
  const summary=Object.fromEntries(Object.entries(runs).map(([path,rs])=>[path,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates','returned'].map(k=>[k,median(rs.map(r=>r[k]))]))]));
  console.log(JSON.stringify(summary));await writeFile('bench/results/2026-09-27-native-verification/v3/mixed.json',JSON.stringify({plainConditions:24,sealedConditions:6,summary,runs},null,2)+'\n');
}finally{Client.prototype.query=original;await pool.end();}

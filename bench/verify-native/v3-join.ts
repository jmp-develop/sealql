import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { normalizeText } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { customers, customersSeal, fields, sealed, scopeId, tickets, ticketsSeal } from './schema.js';

const cases=[
  {name:'join_rare',ticket:{field:'memo',op:'contains',term:'푸른달'},customer:{field:'memo',op:'contains',term:'푸른달'}},
  {name:'join_broad',ticket:{field:'memo',op:'contains',term:'서비스'},customer:{field:'company',op:'eq',term:'서울서비스 담당'}},
  {name:'join_zero',ticket:{field:'memo',op:'contains',term:'없는표식'},customer:{field:'company',op:'eq',term:'서울서비스 담당'}},
] as const;
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
function flat(row:any){return {id:row.t.id,...Object.fromEntries(fields.flatMap(f=>[[`t_${f}`,row.t[f]],[`c_${f}`,row.c[f]]]))};}
function same(a:any[],b:any[],label:string){assert.equal(a.length,b.length,`${label}/count`);for(let i=0;i<a.length;i++)assert.deepEqual(flat(a[i]),b[i],`${label}/${i}`);}
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  for(const table of ['customers','tickets'])assert.equal(Number((await pool.query(`select count(*) n from native_verify_main.${table}`)).rows[0].n),100000);
  const report=[];
  for(const c of cases){
    const pred=(a:string,x:typeof c.ticket|typeof c.customer,ph:string)=>x.op==='eq'?`${a}.${x.field}_norm=${ph}`:`${a}.${x.field}_norm like '%'||${ph}||'%'`;
    const plain=async()=>(await pool.query(`select t.id,${fields.map(f=>`t.${f}_plain t_${f},c.${f}_plain c_${f}`).join(',')}
      from bench_realistic_100k.tickets t join bench_realistic_100k.customers c on c.scope_id=t.scope_id and c.id=t.customer_id
      where t.scope_id=$1 and ${pred('t',c.ticket,'$2')} and ${pred('c',c.customer,'$3')} order by t.id limit 20`,
      [scopeId,normalizeText(c.ticket.term,'legacy-text-v1'),normalizeText(c.customer.term,'legacy-text-v1')])).rows;
    const product=async()=>{const page=await sealed.search(db,{scope:scopeId,
      match:{t:[ticketsSeal,m=>(m as any)[c.ticket.field][c.ticket.op](c.ticket.term)],
        c:[customersSeal,m=>(m as any)[c.customer.field][c.customer.op](c.customer.term)]},
      limit:20,query:({where,after,orderBy,flags,limit})=>db.select({t:tickets,c:customers,...flags}).from(tickets)
        .innerJoin(customers,eq(tickets.customerId,customers.id)).where(and(where,after)).orderBy(...orderBy).limit(limit)});
      return page.items;};
    const expected=await plain();same(await product(),expected,`${c.name}/first`);
    for(let i=0;i<2;i++){same(await product(),expected,`${c.name}/warmup`);assert.deepEqual(await plain(),expected);}
    const runs:{plain:any[];product:any[]}={plain:[],product:[]};
    for(let i=0;i<7;i++)for(const path of (i%2?['product','plain']:['plain','product']) as ('plain'|'product')[]){
      const ev:{ms:number;rows:number;text:string}[]=[];events=ev;const start=performance.now();
      let rows:any[];try{rows=await (path==='plain'?plain():product());}finally{events=null;}
      if(path==='plain')assert.deepEqual(rows,expected);else same(rows,expected,`${c.name}/${i}`);
      runs[path].push({totalMs:performance.now()-start,sqlMs:ev.reduce((s,x)=>s+x.ms,0),sqlCalls:ev.length,
        candidates:path==='product'?ev.reduce((s,x)=>s+x.rows,0):0,returned:rows.length,sql:ev.map(x=>x.text)});
    }
    const summary=Object.fromEntries(Object.entries(runs).map(([p,rs])=>[p,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates','returned'].map(k=>[k,median(rs.map(r=>r[k]))]))]));
    report.push({case:c.name,expected:expected.length,summary,runs});console.log(JSON.stringify({case:c.name,summary}));
    await writeFile('bench/results/2026-09-27-native-verification/v3/join.json',JSON.stringify(report,null,2)+'\n');
  }
}finally{Client.prototype.query=original;await pool.end();}

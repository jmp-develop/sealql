process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE='customers_skip_product_multi';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { normalizeText, profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { binding, fields, guard, pool, query, schema, scopeId, sealer, setEvents, source, type Event } from '../standard-next/common.js';

type Condition={field:'memo'|'company';op:'contains'|'eq';term:string};
const cases=[
  {name:'join_rare',ticket:{field:'memo',op:'contains',term:'푸른달'},customer:{field:'memo',op:'contains',term:'푸른달'}},
  {name:'join_broad',ticket:{field:'memo',op:'contains',term:'서비스'},customer:{field:'company',op:'eq',term:'서울서비스 담당'}},
  {name:'join_zero',ticket:{field:'memo',op:'contains',term:'없는표식'},customer:{field:'company',op:'eq',term:'서울서비스 담당'}},
] as const satisfies {name:string;ticket:Condition;customer:Condition}[];
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
const select=Object.fromEntries(fields.map(f=>[f,true]));
let opens=0;const originalOpen=sealer.open.bind(sealer);sealer.open=async(...args)=>{opens++;return originalOpen(...args);};
function check(row:any,c:Condition){const v=normalizeText(row[c.field],'legacy-text-v1'),term=normalizeText(c.term,'legacy-text-v1');return c.op==='eq'?v===term:v.includes(term);}
async function plain(c:typeof cases[number]){
  const p:unknown[]=[scopeId,normalizeText(c.ticket.term,'legacy-text-v1'),normalizeText(c.customer.term,'legacy-text-v1')];
  const pred=(a:string,x:Condition,ph:string)=>x.op==='eq'?`${a}.${x.field}_norm=${ph}`:`${a}.${x.field}_norm like '%'||${ph}||'%'`;
  return (await query(`select t.id,${fields.map(f=>`t.${f}_plain t_${f},c.${f}_plain c_${f}`).join(',')} from ${source}.tickets t join ${source}.customers c on c.scope_id=t.scope_id and c.id=t.customer_id where t.scope_id=$1 and ${pred('t',c.ticket,'$2')} and ${pred('c',c.customer,'$3')} order by t.id limit 20`,p)).rows;
}
const tokenCache={profiles:new Map<string,Promise<CryptoKey>>()};
async function token(table:'tickets'|'customers',c:Condition,skip:boolean){
  const b=binding(table,skip),mode=c.op==='eq'?'exact':'substring';
  const profile=profiles(b.model.id,c.field,b.model.fields[c.field]).find(p=>p.mode===mode)!;
  const ring=sealer.ring(b.model.id);
  return {column:b.storage.index!.profiles![profile.indexId].tokens,tokens:await searchTokens(ring,scopeId,profile,searchPieces(profile,c.term,c.op==='eq'?'write':'contains'),tokenCache)};
}
async function encrypted(c:typeof cases[number],skip:boolean){
  const [tt,ct]=await Promise.all([token('tickets',c.ticket,skip),token('customers',c.customer,skip)]);
  const ticketTable=skip?'tickets_skip':'tickets',customerTable=skip?'customers_skip_product_multi':'customers';const out:any[]=[];let after:string|undefined,candidates=0,sqlCalls=0;
  const tb=binding('tickets',skip).repo,cb=binding('customers',skip).repo;
  while(out.length<20){
    const p:unknown[]=[scopeId,tt.tokens,ct.tokens],more=after?` and t.id>$${p.push(after)}`:'';
    const rows=(await query(`select t.scope_id t_scope,t.id t_id,t.revision t_revision,c.scope_id c_scope,c.id c_id,c.revision c_revision,${fields.map(f=>`t.${f}_ct t_${f},c.${f}_ct c_${f}`).join(',')} from ${schema}.${ticketTable} t join ${schema}.${customerTable} c on c.scope_id=t.scope_id and c.id=t.customer_id where t.scope_id=$1 and t.id in (select row_id from ${schema}.${ticketTable}_seal_index where scope_id=$1 and ${tt.column} @> $2::bigint[]) and c.id in (select row_id from ${schema}.${customerTable}_seal_index where scope_id=$1 and ${ct.column} @> $3::bigint[])${more} order by t.id limit 40`,p)).rows;
    sqlCalls++;candidates+=rows.length;if(!rows.length)break;
    const mapping=(prefix:'t'|'c')=>({scope:`${prefix}_scope`,row:`${prefix}_id`,revision:`${prefix}_revision`,fields:Object.fromEntries(fields.map(f=>[f,`${prefix}_${f}`]))});
    const [tickets,customers]=await Promise.all([tb.decryptRows({rows,mapping:mapping('t'),select}),cb.decryptRows({rows,mapping:mapping('c'),select})]);
    for(let i=0;i<rows.length&&out.length<20;i++)if(check(tickets[i],c.ticket)&&check(customers[i],c.customer)){
      out.push({id:rows[i].t_id,...Object.fromEntries(fields.flatMap(f=>[[`t_${f}`,tickets[i]![f]],[`c_${f}`,customers[i]![f]]]))});
    }
    after=rows.at(-1).t_id;if(rows.length<40)break;
  }
  return {rows:out,candidates,sqlCalls};
}
function same(a:any[],b:any[],label:string){assert.equal(a.length,b.length,`${label}/length`);for(let i=0;i<a.length;i++)assert.deepEqual(a[i],b[i],`${label}/${i}`);}
try{
  await guard();const report=[];
  for(const c of cases){
    const expected=await plain(c);same((await encrypted(c,true)).rows,expected,`${c.name}/product`);
    for(let i=0;i<2;i++){await plain(c);await encrypted(c,true);}
    const runs:Record<string,any[]>={plain:[],product:[]};
    for(let i=0;i<7;i++)for(const name of i%2?['product','plain']:['plain','product']){
      const ev:Event[]=[];setEvents(ev);opens=0;const t=performance.now();let result:{rows:any[];candidates:number;sqlCalls:number};
      try{result=name==='plain'?{rows:await plain(c),candidates:0,sqlCalls:1}:await encrypted(c,true);}finally{setEvents(null);}
      same(result.rows,expected,`${c.name}/${name}/${i}`);
      runs[name].push({totalMs:performance.now()-t,sqlMs:ev.reduce((s,e)=>s+e.sqlMs,0),sqlCalls:result.sqlCalls,candidates:result.candidates,authenticatedFields:opens,returned:result.rows.length});
    }
    const summary=Object.fromEntries(Object.entries(runs).map(([name,rs])=>[name,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates','authenticatedFields','returned'].map(k=>[k,median(rs.map(x=>x[k]))]))]));
    report.push({case:c.name,rows:expected.length,summary,runs});console.log(JSON.stringify({case:c.name,summary}));
    await writeFile('bench/results/2026-09-27-core-verification/v3/join.json',JSON.stringify(report,null,2)+'\n');
  }
}finally{await pool.end();}

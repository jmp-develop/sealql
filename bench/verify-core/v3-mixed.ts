process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE='customers_skip_product_multi';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { normalizeText, profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { binding, fields, guard, pool, query, schema, scopeId, sealer, setEvents, source, type Event } from '../standard-next/common.js';

const pub=[`p.name_norm<>''`,`p.phone_norm>'1'`,`p.phone_norm<'9'`,`p.address_norm<>'x'`,`p.email_norm like '%.test'`,`char_length(p.name_norm)>2`,`char_length(p.memo_norm)<200`,`p.company_norm<>'none'`,`p.id<>'00000000-0000-0000-0000-000000000000'`,`p.revision>=1`,
  `left(p.phone_norm,1) in ('1','2','3','4','5','6','7','8','9')`,`p.address_norm not like '%xyz%'`,`p.email_norm not like 'zz%'`,`p.name_norm not like '%@%'`,`p.memo_norm<>''`,`p.company_norm not like '%xyz%'`,`char_length(p.address_norm)>5`,`char_length(p.email_norm)>5`,
  `p.phone_norm not like '%abc%'`,`p.name_norm<>'관리자'`,`p.revision<1000`,`p.scope_id is not null`,`p.email_norm<>'a@b.c'`,`p.address_norm<>'서울'`];
const enc=[{field:'name',op:'contains',term:'민서'},{field:'phone',op:'contains',term:'-5'},{field:'address',op:'contains',term:'서울'},{field:'memo',op:'contains',term:'서비스'},{field:'email',op:'contains',term:'test'},{field:'company',op:'eq',term:'서울서비스 담당'}] as const;
const select=Object.fromEntries(fields.map(f=>[f,true]));
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
const tokenCache={profiles:new Map<string,Promise<CryptoKey>>()};
let opens=0;const originalOpen=sealer.open.bind(sealer);sealer.open=async(...args)=>{opens++;return originalOpen(...args);};
async function plain(){
  const p:unknown[]=[scopeId,...enc.map(x=>normalizeText(x.term,'legacy-text-v1'))];
  const w=enc.map((x,i)=>x.op==='eq'?`p.${x.field}_norm=$${i+2}`:`p.${x.field}_norm like '%'||$${i+2}||'%'`).join(' and ');
  return (await query(`select p.id,${fields.map(f=>`p.${f}_plain as ${f}`).join(',')} from ${source}.customers p where p.scope_id=$1 and ${pub.join(' and ')} and ${w} order by p.id limit 20`,p)).rows;
}
async function encrypted(skip:boolean){
  const b=binding('customers',skip),ring=sealer.ring(b.model.id),table=skip?'customers_skip_product_multi':'customers';
  const tokens=await Promise.all(enc.map(async x=>{
    const profile=profiles(b.model.id,x.field,b.model.fields[x.field]).find(p=>p.mode===(x.op==='eq'?'exact':'substring'))!;
    return {column:b.storage.index!.profiles![profile.indexId].tokens,values:await searchTokens(ring,scopeId,profile,searchPieces(profile,x.term,x.op==='eq'?'write':'contains'),tokenCache)};
  }));
  let after:string|undefined,candidates=0,sqlCalls=0;const out:any[]=[];
  while(out.length<20){
    const p:unknown[]=[scopeId,...tokens.map(x=>x.values)];
    const w=tokens.map((x,i)=>`i.${x.column} @> $${i+2}::bigint[]`).join(' and ');
    const extra=after?` and s.id>$${p.push(after)}`:'';
    const rows=(await query(`select s.scope_id,s.id,s.revision,${fields.map(f=>`s.${f}_ct`).join(',')} from ${schema}.${table} s join ${source}.customers p on p.scope_id=s.scope_id and p.id=s.id where s.scope_id=$1 and ${pub.join(' and ')} and s.id in (select i.row_id from ${schema}.${table}_seal_index i where i.scope_id=$1 and ${w})${extra} order by s.id limit 40`,p)).rows;
    sqlCalls++;candidates+=rows.length;if(!rows.length)break;
    const values=await b.repo.decryptRows({rows,mapping:{scope:'scope_id',row:'id',revision:'revision',fields:Object.fromEntries(fields.map(f=>[f,`${f}_ct`]))},select});
    for(const item of values){if(!item)continue;
      if(enc.every(x=>{const a=normalizeText(String(item[x.field]),'legacy-text-v1'),term=normalizeText(x.term,'legacy-text-v1');return x.op==='eq'?a===term:a.includes(term);})){
        out.push({id:item.id,...Object.fromEntries(fields.map(f=>[f,item[f]]))});if(out.length===20)break;
      }
    }
    after=rows.at(-1).id;if(rows.length<40)break;
  }
  return {rows:out,candidates,sqlCalls};
}
function same(actual:any[],expected:any[],label:string){assert.equal(actual.length,expected.length,`${label}/count`);for(let i=0;i<actual.length;i++)assert.deepEqual(actual[i],expected[i],`${label}/${i}`);}
try{
  await guard();const expected=await plain();same((await encrypted(true)).rows,expected,'product');
  for(let i=0;i<2;i++){await plain();await encrypted(true);}
  const runs:Record<string,any[]>={plain:[],product:[]};
  for(let i=0;i<7;i++)for(const name of i%2?['product','plain']:['plain','product']){
    const ev:Event[]=[];setEvents(ev);opens=0;const start=performance.now();let r:{rows:any[];candidates:number;sqlCalls:number};
    try{r=name==='plain'?{rows:await plain(),candidates:0,sqlCalls:1}:await encrypted(true);}finally{setEvents(null);}
    same(r.rows,expected,`${name}/${i}`);runs[name].push({totalMs:performance.now()-start,sqlMs:ev.reduce((s,x)=>s+x.sqlMs,0),sqlCalls:r.sqlCalls,candidates:r.candidates,authenticatedFields:opens,returned:r.rows.length});
  }
  const summary=Object.fromEntries(Object.entries(runs).map(([name,rs])=>[name,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates','authenticatedFields','returned'].map(k=>[k,median(rs.map(x=>x[k]))]))]));
  await writeFile('bench/results/2026-09-27-core-verification/v3/mixed.json',JSON.stringify({plainFilters:pub.length,encryptedFilters:enc.length,rows:expected.length,summary,runs},null,2)+'\n');console.log(JSON.stringify(summary));
}finally{await pool.end();}

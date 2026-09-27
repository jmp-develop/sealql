import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { normalizeText, normalizeWords } from '../../src/core/search-tokens.js';
import { binding, events, fields, guard, pool, query, schema, scopeId, sealer, setEvents, source, type Event } from './common.js';

type Field=typeof fields[number];
type Leaf={op:'eq'|'contains'|'startsWith'|'endsWith';field:Field;value:string};
type Node=Leaf|{all:Node[]}|{any:Node[]};
const L=(op:Leaf['op'],field:Field,value:string):Leaf=>({op,field,value});
export const cases:{name:string;node:Node;limit?:number;drain?:boolean;respectWords?:boolean}[]=[
  {name:'exact_common',node:L('eq','company','서울서비스 담당')},
  {name:'exact_mid',node:L('eq','company','서울서비스 중앙지사')},
  {name:'exact_one',node:L('eq','phone','42-5748-1542')},
  {name:'exact_zero',node:L('eq','phone','99-0000-0000')},
  {name:'sub2_common',node:L('contains','company','서비')},
  {name:'sub_mid',node:L('contains','address','세종대로')},
  {name:'sub_mid_space',node:L('contains','address','세종대로 25')},
  {name:'sub_rare',node:L('contains','memo','푸른달')},
  {name:'sub_long',node:L('contains','memo','상세 안내와 확인 내용 상세 안내와')},
  {name:'sub_name_suffix',node:L('contains','name','pshxt')},
  {name:'sub_zero',node:L('contains','memo','없는표식')},
  {name:'starts',node:L('startsWith','address','서울')},
  {name:'ends',node:L('endsWith','email','biz.test')},
  {name:'and2',node:{all:[L('eq','company','서울서비스 담당'),L('contains','memo','서비스')]}},
  {name:'and4',node:{all:[L('eq','company','서울서비스 담당'),L('contains','address','서울'),L('contains','memo','상담'),L('contains','email','service')]}},
  {name:'and6',node:{all:[L('contains','name','민서'),L('contains','phone','-5'),L('contains','address','서울'),L('contains','memo','서비스'),L('contains','email','test'),L('eq','company','서울서비스 담당')]}},
  {name:'or2',node:{any:[L('eq','company','서울서비스 담당'),L('contains','memo','푸른달')]}},
  {name:'or3',node:{any:[L('eq','phone','42-5748-1542'),L('eq','phone','21-7100-5875'),L('contains','name','pshxt')]}},
  {name:'drain101',node:L('contains','memo','푸른달'),limit:200,drain:true},
  {name:'word_boundary',node:L('contains','memo','서비스 상담'),respectWords:true},
  {name:'word_inside_longer',node:L('contains','memo','비스 상'),respectWords:true},
];
const select=Object.fromEntries(fields.map(f=>[f,true]));
function plainWhere(n:Node,p:unknown[]):string{
  if('all'in n)return `(${n.all.map(x=>plainWhere(x,p)).join(' and ')})`;
  if('any'in n)return `(${n.any.map(x=>plainWhere(x,p)).join(' or ')})`;
  const v=normalizeText(n.value,'legacy-text-v1');assert(!/[%_\\]/.test(v));p.push(v);const ph=`$${p.length}`;
  return n.op==='eq'?`${n.field}_norm=${ph}`:n.op==='contains'?`${n.field}_norm like '%'||${ph}||'%'`:n.op==='startsWith'?`${n.field}_norm like ${ph}||'%'`:`${n.field}_norm like '%'||${ph}`;
}
async function plain(c:typeof cases[number]){
  if(c.respectWords){
    const p:unknown[]=[scopeId],where=plainWhere(c.node,p);
    const rows=(await query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from ${source}.customers where scope_id=$1 and ${where} order by id`,p)).rows;
    return rows.filter(r=>normalizeWords(r.memo).includes(normalizeWords((c.node as Leaf).value))).slice(0,c.limit??20);
  }
  const out:any[]=[];let after:string|undefined;const limit=c.limit??20;
  do{
    const p:unknown[]=[scopeId], where=plainWhere(c.node,p), extra=after?` and id>$${p.push(after)}`:'';
    const rows=(await query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from ${source}.customers where scope_id=$1 and ${where}${extra} order by id limit ${limit}`,p)).rows;
    out.push(...rows); if(!c.drain||rows.length<limit)break;after=rows.at(-1).id;
  }while(true);return out;
}
function match(n:Node,f:any,respectWords=false):any{
  if('all'in n)return f.all(...n.all.map(x=>match(x,f,respectWords)));
  if('any'in n)return f.any(...n.any.map(x=>match(x,f,respectWords)));
  return n.op==='contains'&&respectWords?f[n.field].contains(n.value,{respectWords:true}):f[n.field][n.op](n.value);
}
function encrypted(skip:boolean,c:typeof cases[number]){
  const repo=binding('customers',skip).repo;
  return async()=>{const out:any[]=[];let cursor:string|undefined;const limit=c.limit??20;
    do {const page=await repo.findMany({match:f=>match(c.node,f,c.respectWords),select,limit,cursor,
      budgets:{maxCandidates:20000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024,resultBytes:32*1024*1024,deadlineMs:30000}});
      out.push(...page.items); if(!c.drain||!page.nextCursor)break;cursor=page.nextCursor;
    }while(true);return out;
  };
}
let opens=0,openMs=0;const originalOpen=sealer.open.bind(sealer);
sealer.open=async(...args)=>{opens++;const t=performance.now();try{return await originalOpen(...args);}finally{openMs+=performance.now()-t;}};
async function measure(fn:()=>Promise<any[]>){
  const ev:Event[]=[];setEvents(ev);opens=0;openMs=0;const start=performance.now();
  try {const rows=await fn();return {totalMs:performance.now()-start,rows,sqlCalls:ev.length,sqlMs:ev.reduce((s,x)=>s+x.sqlMs,0),candidates:ev.filter(x=>/ in \(select |with sample|_seal_index/i.test(x.text)).reduce((s,x)=>s+x.rows,0),authenticatedFields:opens,openCumulativeMs:openMs};}
  finally{setEvents(null);}
}
const median=(arr:number[])=>[...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)];
function same(actual:any[],expected:any[],label:string){
  assert.equal(actual.length,expected.length,`${label} row count`);
  for(let i=0;i<actual.length;i++){
    assert.equal(actual[i].id,expected[i].id,`${label} id ${i}`);
    for(const f of fields)assert.equal(actual[i][f],expected[i][f],`${label} ${f} ${i}`);
  }
}
try{
  await guard();const outputDir=process.env.SEALQL_BENCH_OUTPUT_DIR??'bench/results/2026-09-27-standard-next-sqlplan';await mkdir(outputDir,{recursive:true});
  const report:any[]=[];
  for(const c of cases.filter(c=>!process.argv[2]||new RegExp(process.argv[2]).test(c.name))){
    const paths:Record<string,()=>Promise<any[]>>=process.env.SEALQL_BENCH_SKIP_ONLY==='1'
      ? {plain:()=>plain(c),skip:encrypted(true,c)}
      : {plain:()=>plain(c),next:encrypted(false,c),skip:encrypted(true,c)};
    const expected=await plain(c);
    for(const [name,fn] of Object.entries(paths))same((await fn()),expected,`${c.name}/${name}`);
    for(let i=0;i<2;i++)for(const fn of Object.values(paths))await fn();
    const runs:Record<string,any[]>=Object.fromEntries(Object.keys(paths).map(name=>[name,[]]));
    for(let i=0;i<7;i++)for(const name of i%2?Object.keys(paths).reverse():Object.keys(paths)){
      const v=await measure(paths[name]);same(v.rows,expected,`${c.name}/${name}/run${i}`);
      runs[name].push({...v,rows:undefined,returned:v.rows.length});
    }
    const summary=Object.fromEntries(Object.entries(runs).map(([name,rs])=>[name,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates','authenticatedFields','openCumulativeMs','returned'].map(k=>[k,median(rs.map(x=>x[k]))]))]));
    const row={case:c.name,rows:expected.length,summary,runs};report.push(row);console.log(JSON.stringify({case:c.name,summary}));
    await writeFile(`${outputDir}/matrix${process.argv[2]?'-smoke':''}.json`,JSON.stringify(report,null,2)+'\n');
  }
}finally{await pool.end();}

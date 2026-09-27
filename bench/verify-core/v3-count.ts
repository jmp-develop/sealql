import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { normalizeText } from '../../src/core/search-tokens.js';
import { binding, guard, pool, query, scopeId, source, sealer, setEvents, type Event } from '../standard-next/common.js';

const cases=[
  {name:'exact_mid',field:'company',op:'eq',term:'서울서비스 중앙지사'},
  {name:'sub_rare',field:'memo',op:'contains',term:'푸른달'},
  {name:'zero',field:'memo',op:'contains',term:'없는표식'},
] as const;
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
let opens=0;const originalOpen=sealer.open.bind(sealer);sealer.open=async(...args)=>{opens++;return originalOpen(...args);};
const report=[];
try{
  await guard();const outputDir='bench/results/2026-09-27-core-verification/v3';await mkdir(outputDir,{recursive:true});
  for(const c of cases){
    const predicate=c.op==='eq'?`${c.field}_norm=$2`:`${c.field}_norm like '%'||$2||'%'`;
    const plain=async()=>Number((await query(`select count(*) n from ${source}.customers where scope_id=$1 and ${predicate}`,[scopeId,normalizeText(c.term,'legacy-text-v1')])).rows[0].n);
    const product=binding('customers',true).repo;
    const enc=()=>product.count({match:f=>c.op==='eq'?(f as any)[c.field].eq(c.term):(f as any)[c.field].contains(c.term),maxCandidates:110000,budgets:{deadlineMs:30000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024}});
    const paths={plain,product:enc},expected=await plain();
    for(const [name,fn] of Object.entries(paths))assert.equal(await fn(),expected,`${c.name}/${name}`);
    for(let i=0;i<2;i++)for(const fn of Object.values(paths))await fn();
    const runs:Record<string,any[]>={plain:[],product:[]};
    for(let i=0;i<7;i++)for(const name of i%2?['product','plain']:['plain','product']){
      const ev:Event[]=[];setEvents(ev);opens=0;const start=performance.now();let value:number;
      try{value=await paths[name as keyof typeof paths]();}finally{setEvents(null);}
      assert.equal(value,expected);runs[name].push({totalMs:performance.now()-start,sqlMs:ev.reduce((s,x)=>s+x.sqlMs,0),sqlCalls:ev.length,candidates:name==='plain'?0:ev.reduce((s,x)=>s+x.rows,0),authenticatedFields:opens,returned:value});
    }
    const summary=Object.fromEntries(Object.entries(runs).map(([name,rs])=>[name,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates','authenticatedFields','returned'].map(k=>[k,median(rs.map(x=>x[k]))]))]));
    report.push({case:c.name,count:expected,summary,runs});console.log(JSON.stringify({case:c.name,count:expected,summary}));
    await writeFile(`${outputDir}/count-detail.json`,JSON.stringify(report,null,2)+'\n');
  }
}finally{await pool.end();}

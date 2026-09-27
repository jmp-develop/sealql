import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { normalizeText } from '../../src/core/search-tokens.js';
import { binding, guard, pool, query, scopeId, source, setEvents, type Event } from './common.js';

const cases=[
  {name:'exact_mid',field:'company',op:'eq',term:'서울서비스 중앙지사'},
  {name:'sub_rare',field:'memo',op:'contains',term:'푸른달'},
  {name:'zero',field:'memo',op:'contains',term:'없는표식'},
] as const;
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
const report=[];
try{
  await guard();const outputDir=process.env.SEALQL_BENCH_OUTPUT_DIR??'bench/results/2026-09-27-standard-next-sqlplan';await mkdir(outputDir,{recursive:true});
  for(const c of cases){
    const predicate=c.op==='eq'?`${c.field}_norm=$2`:`${c.field}_norm like '%'||$2||'%'`;
    const plain=async()=>Number((await query(`select count(*) n from ${source}.customers where scope_id=$1 and ${predicate}`,[scopeId,normalizeText(c.term,'legacy-text-v1')])).rows[0].n);
    const next=binding('customers').repo,skip=binding('customers',true).repo;
    const enc=(repo:typeof next)=>()=>repo.count({match:f=>c.op==='eq'?(f as any)[c.field].eq(c.term):(f as any)[c.field].contains(c.term),maxCandidates:110000,budgets:{deadlineMs:30000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024}});
    const paths={plain,next:enc(next),skip:enc(skip)},expected=await plain();
    for(const [name,fn] of Object.entries(paths))assert.equal(await fn(),expected,`${c.name}/${name}`);
    for(let i=0;i<2;i++)for(const fn of Object.values(paths))await fn();
    const runs:Record<string,any[]>={plain:[],next:[],skip:[]};
    for(let i=0;i<7;i++)for(const name of i%2?['skip','next','plain']:['plain','next','skip']){
      const ev:Event[]=[];setEvents(ev);const start=performance.now();let value:number;
      try{value=await paths[name as keyof typeof paths]();}finally{setEvents(null);}
      assert.equal(value,expected);runs[name].push({totalMs:performance.now()-start,sqlMs:ev.reduce((s,x)=>s+x.sqlMs,0),sqlCalls:ev.length,candidates:ev.reduce((s,x)=>s+x.rows,0)});
    }
    const summary=Object.fromEntries(Object.entries(runs).map(([name,rs])=>[name,Object.fromEntries(['totalMs','sqlMs','sqlCalls','candidates'].map(k=>[k,median(rs.map(x=>x[k]))]))]));
    report.push({case:c.name,count:expected,summary,runs});console.log(JSON.stringify({case:c.name,count:expected,summary}));
    await writeFile(`${outputDir}/count.json`,JSON.stringify(report,null,2)+'\n');
  }
}finally{await pool.end();}

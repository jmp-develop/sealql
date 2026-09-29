/** Focused A/LIKE check. B is deferred; protected tables/functions are read-only. */
import {readFileSync,writeFileSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/node-postgres';
import {connect,scope,fields,normalize,assert,type Node} from './common.js';
import {oracle,normalizedRows,match} from './oracle.js';
import {sealed,customers,customersSeal} from './product.js';
import {measured,summarize,type Statement} from './instrument.js';
import {firstOccurrenceVariant} from './next-candidates.js';

assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-final-return');
const pool=await connect(),db=drizzle(pool),out='bench/results/2026-09-29-final-impl/next-candidates-check.json';
const result:any={started:new Date().toISOString(),complete:false,rows:[],errors:[],B:'Deferred by coordinator; no clones, storage ALTER or VACUUM',protocol:'One physical connection; two warmups and seven alternating measured rounds; full normalized projection oracle; A EXPLAIN before timing; no product DB mutations'};
const save=()=>writeFileSync(out,JSON.stringify(result,null,2)+'\n');
try{
 const pid=(await pool.query('select pg_backend_pid() pid')).rows[0].pid;result.pid=pid;
 const data=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));
 const cases=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8'));
 const jobs:{name:string;node:Node;nullInput?:boolean;likeOnly?:boolean}[]=[
  ...['sub_mid','word_boundary','ends','sub_rare','zero_fragment','sub_long','sub45','like_suffix2plus'].map(name=>cases.find((c:any)=>c.name===name)),
  {name:'NULL',node:{field:'memo',op:'contains',value:'서비스상담'},nullInput:true},
  {name:'like_general_runs',node:{field:'email',op:'like',value:'%te%st'},likeOnly:true},
  {name:'like_general_underscore',node:{field:'email',op:'like',value:'%te__'},likeOnly:true},
 ];
 for(const job of jobs)for(const mode of ['count','list300']){
  const truth=job.nullInput?[]:data.filter(r=>oracle(job.node,r)),expected=mode==='count'?truth.length:truth.slice(0,300);
  const paths=job.likeOnly?['product']:['product','A'];
  const record:any={name:job.name,node:job.node,mode,expectedCount:truth.length,nullInput:!!job.nullInput,runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{},plans:{}};
  const queries=new Map<string,Statement[]>();
  const run=async(path:string)=>{
   const r=await measured(async()=>mode==='count'?sealed.count(db,customersSeal,{scope,match:m=>match(job.node,m)}):(await sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(job.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any)).items,s=>{
    let text=s.text;
    // NULL normalized-length input tests the strict proof's SQL three-valued
    // behavior on real candidates, without mutating a protected companion.
    if(job.nullInput){const changed=text.replace(/("sealql_match_positions"\([^,]+,[^,]+,[^,]+,)[^,]+,/g,'$1NULL::integer,');assert.notEqual(changed,text);text=changed;}
    if(path==='A'){const q=firstOccurrenceVariant({text,params:s.values});return {text:q.text,values:q.params};}
    return {...s,text};
   });
   assert.deepEqual(r.pids,[pid]);
   if(mode==='count')assert.equal(r.value,expected);else assert.deepEqual(normalizedRows(r.value),expected);
   queries.set(path,r.queries);return r;
  };
  // Inspect A's SubPlan before any warmups/recorded timings.
  for(const path of paths){await run(path);record.plans[path]=[];for(const q of queries.get(path)!){const p=(await pool.query('explain (analyze,buffers,verbose,format json) '+q.text,q.values)).rows[0]['QUERY PLAN'];record.plans[path].push({sql:q.text,sqlBytes:Buffer.byteLength(q.text),plan:p});}}
  result.rows.push(record);save();
  for(let round=-2;round<7;round++)for(const path of round%2?[...paths].reverse():paths){const r=await run(path);if(round>=0)record.runs[path].push(r.metric);}
  for(const path of paths)record.summary[path]=summarize(record.runs[path]);
  save();console.log(JSON.stringify({name:job.name,mode,hits:truth.length,sqlMs:Object.fromEntries(paths.map(p=>[p,record.summary[p].sqlMs])),totalMs:Object.fromEntries(paths.map(p=>[p,record.summary[p].totalMs]))}));
 }
 result.complete=true;result.finished=new Date().toISOString();save();
}catch(error){result.errors.push(String(error));save();throw error;}finally{await pool.end();}

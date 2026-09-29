/** Seven coordinator-selected diagnoses. Read-only source tables; owned temp inputs only. */
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/node-postgres';
import {connect,scope,fields,assert,normalize,median,type Node,type Leaf} from './common.js';
import {compile} from './research-query.js';
import {candidateTokensAsync,positionalKey} from './research-codec.js';
import {sealed,customers,customersSeal} from './product.js';
import {match} from './oracle.js';
import {measured,type Statement} from './instrument.js';

const OUT='bench/results/2026-09-29-final-impl/root-causes.json';
if(existsSync(OUT))copyFileSync(OUT,OUT.replace('.json','-initial-no-stats.json'));
assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-final-return');
const result:any={started:new Date().toISOString(),complete:false,errors:[],plans:[],functions:[],
  protocol:'EXPLAIN ANALYZE BUFFERS VERBOSE once per selected query; function statistics deltas without resetting shared statistics; identical materialized research arrays, two warmups and seven alternating function rounds'};
const save=()=>{mkdirSync('bench/results/2026-09-29-final-impl',{recursive:true});writeFileSync(OUT,JSON.stringify(result,null,2)+'\n');};
const cases=JSON.parse(readFileSync('bench/final-return/../../bench/results/2026-09-29-final-return/cases.json','utf8'));
const jobs=[['sub_mid','count'],['word_boundary','count'],['ends','count'],['starts','count'],['zero_and_common2','count'],['or_and_mix','list300'],['and4','list300']];
const pool=await connect(),db=drizzle(pool);
const statsSQL=`select funcid::text,schemaname,funcname,calls,total_time,self_time from pg_stat_user_functions
 where (schemaname='research_u' and funcname='pb_4_match') or (schemaname='test_final_return_product' and funcname like 'sealql_%')`;
async function stats(){await pool.query('select pg_stat_clear_snapshot()');return (await pool.query(statsSQL)).rows;}
async function flush(){await pool.query('select pg_stat_force_next_flush()');}
function difference(before:any[],after:any[]){return after.flatMap(a=>{const b=before.find(b=>b.funcid===a.funcid);const calls=Number(a.calls)-Number(b?.calls??0);return calls?[{schema:a.schemaname,name:a.funcname,calls,totalMs:a.total_time-(b?.total_time??0),selfMs:a.self_time-(b?.self_time??0)}]:[];});}
async function tracked(query:Statement){
 // Capturing through the public driver's error path can retire its connection.
 // Apply tracking after capture, on the physical connection used for this query.
 await pool.query("set track_functions='pl'");
 await flush();const before=await stats(),start=performance.now();const response=await pool.query(query.text,query.values),sqlMs=performance.now()-start;
 await flush();const after=await stats();return {response,sqlMs,functions:difference(before,after)};
}
async function productQuery(node:Node,mode:string):Promise<Statement>{
 const captured:Statement[]=[];
 try{await measured(async()=>mode==='count'?sealed.count(db,customersSeal,{scope,match:(m:any)=>match(node,m)}):sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any),s=>{captured.push(s);throw Error('CAPTURE_ONLY');});}
 catch(error){if(captured.length!==1)throw error;}
 assert.equal(captured.length,1);return captured[0];
}
const leaves=(node:Node):Leaf[]=>'all'in node?node.all.flatMap(leaves):'any'in node?node.any.flatMap(leaves):[node];
try{
 await pool.query("set track_functions='pl'");
 result.session=(await pool.query("select pg_backend_pid() pid,current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') parallel_workers,current_setting('track_functions') track_functions")).rows[0];save();
 for(const [name,mode]of jobs){
  const c=cases.find((c:any)=>c.name===name);assert(c);
  const research=await compile(c.node,mode),product=await productQuery(c.node,mode);
  for(const [path,q]of [['research',{text:research.text,values:research.params}],['product',product]] as const){
   const out=await tracked({text:'explain (analyze,buffers,verbose,format json) '+q.text,values:q.values});
   result.plans.push({name,mode,path,sql:q.text,sqlMs:out.sqlMs,functions:out.functions,plan:out.response.rows[0]['QUERY PLAN']});save();
   console.log(JSON.stringify({phase:'plan',name,mode,path,ms:out.sqlMs,functions:out.functions}));
  }
 }
 const unique=new Map<string,{leaf:Leaf;cases:string[]}>();
 for(const [name]of jobs)for(const leaf of leaves(cases.find((c:any)=>c.name===name).node))if(leaf.op!=='eq'){
  const id=JSON.stringify(leaf),entry=unique.get(id);if(entry)entry.cases.push(name);else unique.set(id,{leaf,cases:[name]});
 }
 for(const {leaf,cases:caseNames}of unique.values()){
  assert(fields.includes(leaf.field as any));const f=leaf.field,tokens=await candidateTokensAsync(f,leaf.value,leaf.op);
  await pool.query('drop table if exists pg_temp.sealql_root_inputs');
  await pool.query(`create temp table sealql_root_inputs as select n_${f} n,psalt_${f} salt,stamps_${f} stamps,positions_${f} positions from research_u.pb_4_final where scope_id=$1 and cs_${f} @> $2::bigint[] order by id limit 1024`,[scope,tokens]);
  const input=(await pool.query('select count(*)::int rows,avg(n) mean_length,max(n) max_length,avg(cardinality(stamps)) mean_stamps from pg_temp.sealql_root_inputs')).rows[0];
  const chars=Array.from(normalize(leaf.value)),offs:number[]=[];for(let i=0;i+2<=chars.length;i+=2)offs.push(i);if(offs.at(-1)!==chars.length-2)offs.push(chars.length-2);
  const keys=offs.map(i=>positionalKey(f,chars.slice(i,i+2).join(''))),values:any[]=[...keys,offs,chars.length,leaf.op==='startsWith'?1:leaf.op==='endsWith'?2:0];
  const args=`array[${keys.map((_,i)=>'$'+(i+1)+'::bytea').join(',')}],$${keys.length+1}::integer[],$${keys.length+2}::integer,n,salt,stamps,positions,$${keys.length+3}::integer`;
  const paths=['research_u.pb_4_match','test_final_return_product.sealql_match_positions','test_final_return_product.sealql_match_positions_bench_checks','test_final_return_product.sealql_match_positions_bench_noset'];
  const record:any={leaf,cases:caseNames,input,offsets:offs,runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{}};let expected:number|undefined;
  for(let round=-2;round<7;round++)for(let k=0;k<paths.length;k++){
   const path=paths[(k+round+2)%paths.length];
   const out=await tracked({text:`select count(*) filter(where ${path}(${args}))::int matches from pg_temp.sealql_root_inputs`,values});
   const matches=out.response.rows[0].matches;if(expected===undefined)expected=matches;else assert.equal(matches,expected,`${JSON.stringify(leaf)}/${path}`);
   const fn=out.functions.find(f=>`${f.schema}.${f.name}`===path);assert.equal(fn?.calls??0,input.rows,`function stats calls: ${path}`);
   if(round>=0)record.runs[path].push({sqlMs:out.sqlMs,calls:fn?.calls??0,selfMs:fn?.selfMs??0,matches,perCallUs:input.rows?1000*fn!.selfMs/input.rows:null});
  }
  for(const path of paths){const runs=record.runs[path];record.summary[path]={sqlMs:median(runs.map((r:any)=>r.sqlMs)),selfMs:median(runs.map((r:any)=>r.selfMs)),calls:input.rows,perCallUs:input.rows?median(runs.map((r:any)=>r.perCallUs)):null,matches:expected};}
  result.functions.push(record);save();console.log(JSON.stringify({phase:'functions',leaf,summary:record.summary}));
 }
 result.complete=true;result.finished=new Date().toISOString();save();
}catch(error){result.errors.push(String(error));save();throw error;}finally{await pool.end();}

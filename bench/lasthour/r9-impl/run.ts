/** Five query-side paths on the shared, disposable last-hour fixture. */
import {transform,candidateCount,helperSql} from './variants.js';
import {readFileSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/node-postgres';
import {connect,save,fields,scope,schema,assert,normalize,acquire,release,OUT,type Case} from './common.js';
import {customers,customersSeal,sealed} from '../v-astra/product.js';
import {measured,summarize,type Statement} from '../../final-return/instrument.js';
import {oracle,normalizedRows,plainWhere,match,koreanLike} from '../../final-return/oracle.js';
const cases:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8'));assert.equal(cases.length,55);
cases.push({name:'like_general_segments',node:{field:'email',op:'like',value:'%te%st'}},{name:'like_general_underscore',node:{field:'email',op:'like',value:'%te__'}});
const priority=['zero_fragment_long','sub45','zero_or_all','zero_and_common2','zero_and_common3','sub_zero','sub_rare','affix_startsWith_email'];
const ordered=[...priority.map(name=>cases.find(c=>c.name===name)!),...cases.filter(c=>!priority.includes(c.name))];
const jobs=ordered.flatMap(c=>['count','list300'].map(mode=>({...c,mode})));
const paths=['plain','P0','P1','P2','P3','P4'];
const load=JSON.parse(readFileSync('bench/results/2026-09-29-lasthour/v-astra/load.json','utf8'));assert(load.complete&&load.loaded===100000,'Wait for v-astra load completion');
const result:any={started:new Date().toISOString(),complete:false,rows:[],plans:[],errors:[],load,paths,protocol:'Same physical connection; first separate + warmup2 + rotating7; plaintext oracle every run',settings:{work_mem:'4MB',max_parallel_workers_per_gather:4,P0:'current/auto',P1:'cap3/auto',P2:'cap3+noninline rest/auto',P3:'P2/workers4',P4:'current/workers4'},scopeRows:100000,helperSql,selection:'Candidate-array indices0,floor((N-1)/2),N-1, at most3; all other keys and exact predicates unchanged',candidateMeaning:'Separate untimed full-scope candidate count before proof, cap3 before rest and after rest; not application transfer'};
acquire();let pool:Awaited<ReturnType<typeof connect>>|undefined;
try{
 pool=await connect();const db=drizzle(pool),pid=(await pool.query('select pg_backend_pid() pid')).rows[0].pid;
 for(const table of ['customers','customers_seal_index'])await pool.query(`vacuum (analyze) ${schema}.${table}`);result.preparation='VACUUM (ANALYZE) after v-astra handoff, before comparisons';await pool.query(helperSql);save('helper',{sql:helperSql});
 result.session=(await pool.query("select pg_backend_pid() pid,current_setting('work_mem') initial_work_mem,current_setting('max_parallel_workers_per_gather') initial_gather,current_setting('max_parallel_workers') max_parallel_workers,current_setting('max_worker_processes') max_worker_processes,current_setting('min_parallel_table_scan_size') min_parallel_table_scan_size,current_setting('parallel_setup_cost') parallel_setup_cost,current_setting('parallel_tuple_cost') parallel_tuple_cost,current_setting('parallel_leader_participation') parallel_leader_participation,current_setting('jit') jit,current_setting('jit_above_cost') jit_above_cost,(select datcollate from pg_database where datname=current_database()) locale")).rows[0];
 await pool.query('set max_parallel_workers_per_gather=4');result.fixedMaxGather=4;
 result.relation=(await pool.query('select relpages,reltuples,reloptions,pg_total_relation_size(oid) bytes from pg_class where oid=$1::regclass',[schema+'.customers_seal_index'])).rows[0];
 result.idCorrelation=(await pool.query("select tablename,attname,correlation from pg_stats where schemaname=$1 and ((tablename='customers' and attname='id') or (tablename='customers_seal_index' and attname='row_id'))",[schema])).rows;
 const raw=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows,data=raw.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));assert.equal(data.length,100000);
 await pool.query("set work_mem='4MB'");let lastParallel:string|undefined;
 async function configure(path:string){const parallel=path==='P3'||path==='P4'?'4':'auto';if(lastParallel!==parallel){await pool!.query(`alter table ${schema}.customers_seal_index ${parallel==='auto'?'reset (parallel_workers)':'set (parallel_workers=4)'}`);lastParallel=parallel;}}
 const candidateCache=new Map<string,any>();
 for(const c of jobs){const truth=data.filter(r=>oracle(c.node,r)),expected=c.mode==='count'?truth.length:truth.slice(0,300),record:any={...c,hits:truth.length,returned:c.mode==='count'?1:Math.min(300,truth.length),cLocaleKoreanLike:koreanLike(c.node),first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{}};
  const queries=new Map<string,Statement[]>();
  if(!candidateCache.has(c.name)){
   const captured=await measured(()=>sealed.count(db,customersSeal,{scope,match:m=>match(c.node,m)}));assert.equal(captured.queries.length,1);
   const q0=captured.queries[0],counts:any={};
   for(const path of ['P0','P1','P2']){const q=candidateCount(transform(path)?.(q0)??q0);counts[path]=Number((await pool.query(q.text,q.values)).rows[0].count);assert(counts[path]>=truth.length);}assert(counts.P1>=counts.P0);assert.equal(counts.P2,counts.P0);counts.P3=counts.P2;counts.P4=counts.P0;
   candidateCache.set(c.name,{counts,tokenLengths:[...q0.text.matchAll(/@>\s*\$(\d+)::bigint\[\]/g)].map(m=>{const v=q0.values[Number(m[1])-1];return Array.isArray(v)?v.length:String(v).slice(1,-1).split(',').filter(Boolean).length;})});
  }
  record.candidates=candidateCache.get(c.name).counts;record.tokenLengths=candidateCache.get(c.name).tokenLengths;
  // Williams ordering balances every directed preceding-path pair over six rounds.
  // The seventh reverses the base order; unlike cyclic rotation, P0 does not always follow plain.
  for(let round=-3;round<7;round++){const base=[0,1,5,2,4,3],order=round===6?[...base].reverse():base.map(i=>(i+(round+6)%6)%6);record.orders??=[];record.orders.push({round,paths:order.map(i=>paths[i])});for(const path of order.map(i=>paths[i])){await configure(path);result.active={name:c.name,mode:c.mode,path,round};const out=await measured(async()=>{
    if(path==='plain'){const params:unknown[]=[scope],where=plainWhere(c.node,params);const q=await pool!.query(`select ${c.mode==='count'?'count(*)::int n':`id,${fields.map(f=>f+'_norm as '+f).join(',')}`} from bench_realistic_100k.customers where scope_id=$1 and ${where}${c.mode==='count'?'':' order by id limit 300'}`,params);return c.mode==='count'?q.rows[0].n:q.rows;}
    if(c.mode==='count')return sealed.count(db,customersSeal,{scope,match:m=>match(c.node,m)});
    return (await sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any)).items;
   },transform(path));assert.deepEqual(out.pids,[pid]);assert.deepEqual(c.mode==='count'?out.value:normalizedRows(out.value),expected,`${c.name}/${c.mode}/${path}: plaintext oracle`);assert.equal(out.metric.opens,path==='plain'||c.mode==='count'?0:record.returned*6);if(round===-3)record.first[path]=out.metric;if(round>=0)record.runs[path].push(out.metric);queries.set(path,out.queries);}}
  for(const path of paths)record.summary[path]=summarize(record.runs[path]);result.rows.push(record);save('measure',result);console.log(JSON.stringify({done:result.rows.length,total:jobs.length,name:c.name,mode:c.mode,sql:Object.fromEntries(paths.map(p=>[p,record.summary[p].sqlMs]))}));
  for(const path of paths.filter(p=>p!=='plain')){await configure(path);const plans=[];for(const q of queries.get(path)!){plans.push({sql:q.text,plan:(await pool.query('explain (analyze,buffers,verbose,format json) '+q.text,q.values)).rows[0]['QUERY PLAN']});}result.plans.push({name:c.name,mode:c.mode,path,plans});}save('measure',result);
 }
 assert.equal(result.rows.length,jobs.length);assert.equal((await pool.query('select pg_backend_pid() pid')).rows[0].pid,pid);result.complete=true;
}catch(e){result.errors.push(String(e));throw e;}finally{result.finished=new Date().toISOString();try{save('measure',result);}finally{try{if(pool){try{await pool.query(`alter table ${schema}.customers_seal_index reset (parallel_workers)`);}finally{await pool.end();}}}finally{release();}}}
console.log('COMPLETE: 114 jobs x P0-P4 plus plain, every result matches plaintext');

/** Table-wide parallel policy/work_mem factorial, one physical session, no product patches. */
import {readFileSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/node-postgres';
import {connect,save,fields,scope,schema,assert,normalize,acquire,release,OUT,type Case} from './common.js';
import {customers,customersSeal,sealed} from './product.js';
import {measured,summarize,type Statement} from '../../final-return/instrument.js';
import {oracle,normalizedRows,plainWhere,match,koreanLike} from '../../final-return/oracle.js';
const historical=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/remeasure.json','utf8'));
const cases:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8'));
const heavy=historical.rows.filter((r:any)=>r.mode==='count'&&r.summary.product.sqlMs>200).map((r:any)=>({name:r.name,node:r.node}));assert.equal(heavy.length,9);
const general:Case[]=[{name:'like_general_segments',node:{field:'email',op:'like',value:'%te%st'}},{name:'like_general_underscore',node:{field:'email',op:'like',value:'%te__'}}];
const guardNames=['sub_rare','sub_zero','affix_startsWith_email','or3','and6','sub_common_memo'];
const listNames=['sub_common_memo','ends','or6','sub_rare'];
const jobs=[...[...heavy,...general].map(c=>({...c,mode:'count',group:'target'})),...guardNames.map(name=>({...cases.find(c=>c.name===name)!,mode:'count',group:'guard'})),...[...listNames.map(name=>cases.find(c=>c.name===name)!),...general].map(c=>({...c,mode:'list300',group:'guard'}))];
assert(jobs.every(j=>j.node));
const paths=['plain','auto4','parallel4','auto32','parallel32'];
const result:any={started:new Date().toISOString(),complete:false,rows:[],plans:[],errors:[],protocol:'Same physical PostgreSQL connection, first separate + warmup2 + rotating7; all counts and full list projections compared with raw fixture; settings DDL outside timings',paths,settings:{auto4:{parallel_workers:'auto',work_mem:'4MB'},parallel4:{parallel_workers:4,work_mem:'4MB'},auto32:{parallel_workers:'auto',work_mem:'32MB'},parallel32:{parallel_workers:4,work_mem:'32MB'}},scopeRows:100000,storageChanges:'Only table parallel_workers reloption on owned schema, no row rewrite; reset in finally',candidateCounts:'Not returned to application; exact/lossy heap blocks and plan row counts recorded separately'};
assert.equal(JSON.parse(readFileSync(`${OUT}/query-tuning/load.json`,'utf8')).complete,true,'Finish background loading before timing');
acquire();let pool:Awaited<ReturnType<typeof connect>>|undefined;
try{
 pool=await connect();const db=drizzle(pool),pid=(await pool.query('select pg_backend_pid() pid')).rows[0].pid;
 for(const table of ['customers','customers_seal_index'])await pool.query(`vacuum (analyze) ${schema}.${table}`);result.preparation='VACUUM (ANALYZE) owned parent and companion before measurements';
 result.session=(await pool.query("select pg_backend_pid() pid,current_setting('work_mem') initial_work_mem,current_setting('max_parallel_workers_per_gather') initial_gather,current_setting('max_parallel_workers') max_parallel_workers,current_setting('max_worker_processes') max_worker_processes,current_setting('min_parallel_table_scan_size') min_parallel_table_scan_size,current_setting('parallel_setup_cost') parallel_setup_cost,current_setting('parallel_tuple_cost') parallel_tuple_cost,current_setting('parallel_leader_participation') parallel_leader_participation,current_setting('jit') jit,current_setting('jit_above_cost') jit_above_cost,(select datcollate from pg_database where datname=current_database()) locale")).rows[0];
 await pool.query('set max_parallel_workers_per_gather=4');result.fixedMaxGather=4;
 result.relation=(await pool.query('select relpages,reltuples,reloptions,pg_total_relation_size(oid) bytes from pg_class where oid=$1::regclass',[schema+'.customers_seal_index'])).rows[0];
 result.idCorrelation=(await pool.query("select tablename,attname,correlation from pg_stats where schemaname=$1 and ((tablename='customers' and attname='id') or (tablename='customers_seal_index' and attname='row_id'))",[schema])).rows;
 const raw=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows,data=raw.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));assert.equal(data.length,100000);
 let lastParallel:string|undefined,lastMem:string|undefined;
 async function configure(path:string){const parallel=path.startsWith('parallel')?'4':'auto',mem=path.endsWith('32')?'32MB':'4MB';if(lastParallel!==parallel){await pool!.query(`alter table ${schema}.customers_seal_index ${parallel==='auto'?'reset (parallel_workers)':'set (parallel_workers=4)'}`);lastParallel=parallel;}if(lastMem!==mem){await pool!.query(`set work_mem='${mem}'`);lastMem=mem;}}
 for(const c of jobs){const truth=data.filter(r=>oracle(c.node,r)),expected=c.mode==='count'?truth.length:truth.slice(0,300),record:any={...c,hits:truth.length,returned:c.mode==='count'?1:Math.min(300,truth.length),cLocaleKoreanLike:koreanLike(c.node),first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{}};
  const queries=new Map<string,Statement[]>();
  for(let round=-3;round<7;round++){const offset=(round+3)%paths.length;for(const path of [...paths.slice(offset),...paths.slice(0,offset)]){await configure(path);result.active={name:c.name,mode:c.mode,path,round};const out=await measured(async()=>{
    if(path==='plain'){const params:unknown[]=[scope],where=plainWhere(c.node,params);const q=await pool!.query(`select ${c.mode==='count'?'count(*)::int n':`id,${fields.map(f=>f+'_norm as '+f).join(',')}`} from bench_realistic_100k.customers where scope_id=$1 and ${where}${c.mode==='count'?'':' order by id limit 300'}`,params);return c.mode==='count'?q.rows[0].n:q.rows;}
    if(c.mode==='count')return sealed.count(db,customersSeal,{scope,match:m=>match(c.node,m)});
    return (await sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any)).items;
   });assert.deepEqual(out.pids,[pid]);assert.deepEqual(c.mode==='count'?out.value:normalizedRows(out.value),expected,`${c.name}/${c.mode}/${path}: plaintext oracle`);assert.equal(out.metric.opens,path==='plain'||c.mode==='count'?0:record.returned*6);if(round===-3)record.first[path]=out.metric;if(round>=0)record.runs[path].push(out.metric);queries.set(path,out.queries);}}
  for(const path of paths)record.summary[path]=summarize(record.runs[path]);result.rows.push(record);save('query-tuning','measure',result);console.log(JSON.stringify({done:result.rows.length,total:jobs.length,name:c.name,mode:c.mode,sql:Object.fromEntries(paths.map(p=>[p,record.summary[p].sqlMs]))}));
  for(const path of paths.filter(p=>p!=='plain')){await configure(path);const plans=[];for(const q of queries.get(path)!){plans.push({sql:q.text,plan:(await pool.query('explain (analyze,buffers,verbose,format json) '+q.text,q.values)).rows[0]['QUERY PLAN']});}result.plans.push({name:c.name,mode:c.mode,path,plans});}save('query-tuning','measure',result);
 }
 assert.equal(result.rows.length,jobs.length);assert.equal((await pool.query('select pg_backend_pid() pid')).rows[0].pid,pid);result.complete=true;
}catch(e){result.errors.push(String(e));throw e;}finally{result.finished=new Date().toISOString();save('query-tuning','measure',result);try{if(pool){try{await pool.query(`alter table ${schema}.customers_seal_index reset (parallel_workers)`);}finally{await pool.end();}}}finally{release();}}
console.log('COMPLETE followup tuning');

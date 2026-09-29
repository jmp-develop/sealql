/** Focused adoption check before the verifier's final three-path run. */
import {readFileSync,writeFileSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/node-postgres';
import {connect,scope,fields,normalize,assert} from './common.js';
import {compile} from './research-query.js';
import {oracle,normalizedRows,match} from './oracle.js';
import {sealed,customers,customersSeal} from './product.js';
import {measured,summarize,type Statement} from './instrument.js';
import {stampMigrationSql} from '../../src/core/stamp-sql.js';
assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-final-return');
const pool=await connect(),db=drizzle(pool),schema=`test_final_adopt_${process.pid}`;
let created=false;
const result:any={started:new Date().toISOString(),complete:false,rows:[],errors:[],protocol:'Two warmups, seven alternating rounds, same physical connection; source product table/functions untouched; new product functions in owned temporary schema'};
const rare=process.argv.includes('--rare');
const save=()=>writeFileSync(`bench/results/2026-09-29-final-impl/${rare?'adopt-rare-check':'adopt-check'}.json`,JSON.stringify(result,null,2)+'\n');
try{
 assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);await pool.query(`create schema ${schema}`);created=true;
 for(const sql of stampMigrationSql(schema))await pool.query(sql);
 await pool.query(`alter function ${schema}.sealql_match_positions(bytea[],integer[],integer,integer,bytea,bigint[],integer[],integer) cost 100`);
 const positionSql=stampMigrationSql(schema).find(sql=>sql.startsWith(`create or replace function "${schema}".sealql_match_positions(`))!;
 await pool.query(positionSql.replaceAll('sealql_match_positions','sealql_match_positions_cost1900').replace(/language plpgsql cost [0-9]+/,'language plpgsql cost 1900'));
 const pid=(await pool.query('select pg_backend_pid() pid')).rows[0].pid;result.pid=pid;
 const data=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));
 const cases=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8'));
 const jobs=rare?['sub_rare','affix_startsWith_email','sub_zero','or3'].flatMap(name=>[[name,'count'],[name,'list300']]):[['sub_common_memo','count'],['sub_mid','count'],['word_boundary','count'],['ends','count'],['starts','count'],['zero_and_common2','count'],['sub_rare','count'],['sub_zero','count'],['and2_or_and2','list300'],['or_and_mix','list300'],['and4','list300'],['exact_common','list300']];
 for(const [name,mode]of jobs){
  const node=cases.find((c:any)=>c.name===name).node,truth=data.filter(r=>oracle(node,r)),expected=mode==='count'?truth.length:truth.slice(0,300),rq=await compile(node,mode),record:any={name,mode,runs:{research:[],product:[],product_cost1900:[]},summary:{},plans:{}};
  const queries=new Map<string,Statement[]>();
  for(let round=-2;round<7;round++)for(let i=0;i<3;i++){
   const order=round%2?['research','product_cost1900','product']:['research','product','product_cost1900'];
   const path=order[(i+round+2)%3];
   const out=await measured(async()=>{
    if(path==='research'){const rows=(await pool.query(rq.text,rq.params)).rows;return mode==='count'?rows[0].n:rows;}
    return mode==='count'?sealed.count(db,customersSeal,{scope,match:m=>match(node,m)}):(await sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any)).items;
   },path!=='research'?s=>({...s,text:s.text.replaceAll('"test_final_return_product"."sealql_',`"${schema}"."sealql_`).replaceAll('sealql_match_positions',path==='product_cost1900'?'sealql_match_positions_cost1900':'sealql_match_positions')}):undefined);
   assert.deepEqual(out.pids,[pid]);
   if(mode==='count')assert.equal(out.value,expected);else if(path==='research')assert.deepEqual(out.value.map((r:any)=>r.id),(expected as any[]).map(r=>r.id));else assert.deepEqual(normalizedRows(out.value),expected);
   if(path!=='research'&&mode==='count')assert(!out.queries.some(q=>q.text.includes('"customers"')),'Pure secure count must not read parent');
   if(round>=0)record.runs[path].push(out.metric);queries.set(path,out.queries);
  }
  for(const path of ['research','product','product_cost1900']){
   record.summary[path]=summarize(record.runs[path]);record.plans[path]=[];
   for(const q of queries.get(path)!)record.plans[path].push({sql:q.text,plan:(await pool.query('explain (analyze,buffers,verbose,format json) '+q.text,q.values)).rows[0]['QUERY PLAN']});
  }
  result.rows.push(record);save();console.log(JSON.stringify({name,mode,sqlMs:Object.fromEntries(Object.entries(record.summary).map(([p,s]:[string,any])=>[p,s.sqlMs]))}));
 }
 result.complete=true;result.finished=new Date().toISOString();save();
}catch(error){result.errors.push(String(error));save();throw error;}finally{if(created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}

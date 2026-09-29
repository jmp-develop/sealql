/** Old/new LIKE functions on identical protected rows, one connection. */
import {readFileSync,writeFileSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/node-postgres';
import {connect,scope,fields,normalize,assert,type Node} from './common.js';
import {oracle,normalizedRows,match} from './oracle.js';
import {sealed,customers,customersSeal} from './product.js';
import {measured,summarize,type Statement} from './instrument.js';
import {stampMigrationSql} from '../../src/core/stamp-sql.js';
assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-final-return');
const pool=await connect(),db=drizzle(pool),schema=`test_like_measure_${process.pid}`,out='bench/results/2026-09-29-final-impl/like-segments-check.json';
let created=false;
const result:any={started:new Date().toISOString(),complete:false,rows:[],errors:[],protocol:'One physical connection, two warmups/seven alternating rounds; API SQL/full time and full normalized projection oracle; protected product rows/functions untouched'};
const save=()=>writeFileSync(out,JSON.stringify(result,null,2)+'\n');
try{
 assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
 await pool.query(`create schema ${schema}`);created=true;
 for(const sql of stampMigrationSql(schema))await pool.query(sql);
 const pid=(await pool.query('select pg_backend_pid() pid')).rows[0].pid;result.pid=pid;
 const data=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));
 for(const pattern of ['%est','%te%st','%te__'])for(const mode of ['count','list300']){
  const node:Node={field:'email',op:'like',value:pattern},truth=data.filter(r=>oracle(node,r)),expected=mode==='count'?truth.length:truth.slice(0,300);
  const paths=['old','segments'],record:any={pattern,mode,hits:truth.length,runs:{old:[],segments:[]},summary:{},plans:{}};
  const queries=new Map<string,Statement[]>();
  for(let round=-2;round<7;round++)for(const path of round%2?[...paths].reverse():paths){
   const r=await measured(async()=>mode==='count'?sealed.count(db,customersSeal,{scope,match:m=>match(node,m)}):(await sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any)).items,
     path==='segments'?s=>({...s,text:s.text.replaceAll('"test_final_return_product"."sealql_',`"${schema}"."sealql_`)}):undefined);
   assert.deepEqual(r.pids,[pid]);if(mode==='count')assert.equal(r.value,expected);else assert.deepEqual(normalizedRows(r.value),expected);
   if(round>=0)record.runs[path].push(r.metric);queries.set(path,r.queries);
  }
  for(const path of paths){record.summary[path]=summarize(record.runs[path]);record.plans[path]=[];for(const q of queries.get(path)!)record.plans[path].push({sql:q.text,plan:(await pool.query('explain (analyze,buffers,verbose,format json) '+q.text,q.values)).rows[0]['QUERY PLAN']});}
  result.rows.push(record);save();console.log(JSON.stringify({pattern,mode,hits:truth.length,sqlMs:Object.fromEntries(paths.map(p=>[p,record.summary[p].sqlMs]))}));
 }
 result.complete=true;result.finished=new Date().toISOString();save();
}catch(error){result.errors.push(String(error));save();throw error;}finally{if(created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}

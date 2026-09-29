/** Same-array comparison after product adoption; source schemas remain read-only. */
import {readFileSync,writeFileSync} from 'node:fs';
import {connect,scope,normalize,median,assert,type Leaf} from './common.js';
import {candidateTokensAsync,positionalKey} from './research-codec.js';
import {stampMigrationSql} from '../../src/core/stamp-sql.js';
assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-final-return');
const pool=await connect(),schema=`test_final_functions_${process.pid}`;
let created=false;
const result:any={started:new Date().toISOString(),rows:[],complete:false};
try{
 assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
 await pool.query(`create schema ${schema}`);created=true;for(const sql of stampMigrationSql(schema))await pool.query(sql);
 await pool.query("set track_functions='pl'");
 const leaves:Leaf[]=JSON.parse(readFileSync('bench/results/2026-09-29-final-impl/root-causes.json','utf8')).functions.map((f:any)=>f.leaf);
 for(const leaf of leaves){
  const f=leaf.field;assert(['address','memo','email','company'].includes(f));
  const tokens=await candidateTokensAsync(f,leaf.value,leaf.op);
  await pool.query('drop table if exists pg_temp.sealql_cost_inputs');
  await pool.query(`create temp table sealql_cost_inputs as select n_${f} n,psalt_${f} salt,stamps_${f} stamps,positions_${f} positions from research_u.pb_4_final where scope_id=$1 and cs_${f} @> $2::bigint[] order by id limit 1024`,[scope,tokens]);
  const inputCount=(await pool.query('select count(*)::int n from pg_temp.sealql_cost_inputs')).rows[0].n;
  const chars=Array.from(normalize(leaf.value)),offs:number[]=[];for(let i=0;i+2<=chars.length;i+=2)offs.push(i);if(offs.at(-1)!==chars.length-2)offs.push(chars.length-2);
  const keys=offs.map(i=>positionalKey(f,chars.slice(i,i+2).join(''))),values:any[]=[...keys,offs,chars.length,leaf.op==='startsWith'?1:leaf.op==='endsWith'?2:0];
  const args=`array[${keys.map((_,i)=>'$'+(i+1)+'::bytea').join(',')}],$${keys.length+1}::integer[],$${keys.length+2}::integer,n,salt,stamps,positions,$${keys.length+3}::integer`;
  const paths=['research_u.pb_4_match',`${schema}.sealql_match_positions`],runs:any[][]=[[],[]];let expected:number|undefined;
  for(let round=-2;round<7;round++)for(let k=0;k<2;k++){
   const index=(k+round+2)%2,path=paths[index];await pool.query('begin');
   const before=(await pool.query('select calls::int,self_time from pg_stat_xact_user_functions where schemaname=$1 and funcname=$2',path.split('.'))).rows[0];
   const start=performance.now(),rows=(await pool.query(`select count(*) filter(where ${path}(${args}))::int matches from pg_temp.sealql_cost_inputs`,values)).rows,sqlMs=performance.now()-start;
   const fn=(await pool.query('select calls::int,self_time from pg_stat_xact_user_functions where schemaname=$1 and funcname=$2',path.split('.'))).rows[0];await pool.query('commit');
   if(expected===undefined)expected=rows[0].matches;else assert.equal(rows[0].matches,expected);
   const calls=fn.calls-(before?.calls??0),selfMs=fn.self_time-(before?.self_time??0);
   assert.equal(calls,inputCount);if(round>=0)runs[index].push({sqlMs,calls,selfMs,perCallUs:1000*selfMs/calls});
  }
  const summary=runs.map(rs=>({sqlMs:median(rs.map(r=>r.sqlMs)),perCallUs:median(rs.map(r=>r.perCallUs)),calls:rs[0].calls}));
  const row={leaf,matches:expected,runs,summary,ratio:summary[1].perCallUs/summary[0].perCallUs};result.rows.push(row);console.log(JSON.stringify({leaf,summary,ratio:row.ratio}));
 }
 result.complete=true;
}finally{result.finished=new Date().toISOString();writeFileSync('bench/results/2026-09-29-final-impl/function-cost.json',JSON.stringify(result,null,2)+'\n');if(created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}

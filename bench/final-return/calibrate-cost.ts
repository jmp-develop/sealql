/** Calibrate a single planner COST against PostgreSQL's unit-cost int4 addition. */
import {readFileSync,writeFileSync} from 'node:fs';
import {connect,assert,median} from './common.js';
import {stampMigrationSql} from '../../src/core/stamp-sql.js';
import {candidateTokensAsync,positionalKey} from './research-codec.js';
import {scope,normalize} from './common.js';
assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-final-return');
const pool=await connect(),schema=`test_cost_units_${process.pid}`,n=250000,ops=32,out:any={n,ops,runs:{base:[],addition:[],proof:[]}};
let created=false;
try{
 await pool.query(`create schema ${schema}`);created=true;for(const s of stampMigrationSql(schema))await pool.query(s);
 await pool.query('set jit=off');await pool.query("set track_functions='pl'");
 out.session=(await pool.query("select pg_backend_pid() pid,current_setting('jit') jit,(select procost from pg_proc where oid='pg_catalog.int4pl(integer,integer)'::regprocedure) operator_cost")).rows[0];
 let expression='x';for(let i=0;i<ops;i++)expression=`(${expression}+1)`;
 // Same session and the same real arrays for the representative two-window proof.
 const value='세종대로',chars=Array.from(normalize(value)),keys=[positionalKey('address',chars.slice(0,2).join('')),positionalKey('address',chars.slice(2,4).join(''))];
 const tokens=await candidateTokensAsync('address',value,'contains');
 await pool.query('create temp table cost_inputs as select n_address n,psalt_address salt,stamps_address stamps,positions_address positions from research_u.pb_4_final where scope_id=$1 and cs_address @> $2::bigint[] order by id limit 1024',[scope,tokens]);
 for(let round=-2;round<7;round++){
  for(const path of round%2?['addition','base']:['base','addition']){
   const start=performance.now(),r=(await pool.query(`select sum(${path==='base'?'x':expression})::text value from generate_series(1,$1::integer) g(x)`,[n])).rows[0];
   const sqlMs=performance.now()-start;assert.equal(BigInt(r.value),BigInt(n)*(BigInt(n)+1n)/2n+(path==='base'?0n:BigInt(n*ops)));
   if(round>=0)out.runs[path].push(sqlMs);
  }
  const stats=async()=>{const r=(await pool.query('select calls::int,self_time from pg_stat_xact_user_functions where schemaname=$1 and funcname=$2',[schema,'sealql_match_positions'])).rows[0];return r??{calls:0,self_time:0};};
  const before=await stats();
  const r=(await pool.query(`select count(*) filter(where ${schema}.sealql_match_positions(array[$1::bytea,$2::bytea],array[0,2],4,n,salt,stamps,positions,0))::int matches from cost_inputs`,keys)).rows[0];assert.equal(r.matches,1024);
  const after=await stats(),calls=after.calls-before.calls;assert.equal(calls,1024);
  if(round>=0)out.runs.proof.push(1000*(after.self_time-before.self_time)/calls);
 }
 out.baseMs=median(out.runs.base);out.additionMs=median(out.runs.addition);
 out.operatorUs=(out.additionMs-out.baseMs)*1000/(n*ops);assert(out.operatorUs>0);
 out.proofUs=median(out.runs.proof);out.ratio=out.proofUs/out.operatorUs;
 out.selectedCost=Math.ceil(out.ratio/100)*100;out.rule='Same-session proof self-time / incremental int4 addition time; round upward to the next 100 cost units, before observing query plans at that cost';
 out.complete=true;writeFileSync('bench/results/2026-09-29-final-impl/calibrate-cost.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
}finally{if(created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}

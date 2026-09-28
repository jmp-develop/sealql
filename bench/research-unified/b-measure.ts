import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {B_CASES,describe,type BCase} from './b-cases.js';
import {S,OUT,pool,lock,unlock,save,measured,summarize,plain,runB,compile} from './b-runtime.js';
const phase=process.argv[2]??'all';assert(['all','counts','lists','join','long','plans','sizes'].includes(phase));
const result:any[]=[];
try{await lock();
if(phase==='sizes'){
 const rows=(await pool.query(`SELECT relname,pg_relation_size(relid)::text heap,pg_indexes_size(relid)::text indexes,pg_total_relation_size(relid)::text total FROM pg_stat_user_tables WHERE schemaname=$1 AND relname=ANY($2::text[]) ORDER BY relname`,[S,['customers_plain','tickets_plain','customers_ct','tickets_ct','b_customers_tags','b_tickets_tags']])).rows;
 const counts=Object.fromEntries(await Promise.all(rows.map(async r=>[r.relname,Number((await pool.query(`SELECT count(*)::int n FROM ${S}.${r.relname}`)).rows[0].n)])));
 save('sizes',rows.map(r=>({...r,rows:counts[r.relname]})));
}else if(phase==='plans'){
 const plans=[];for(const name of ['exact_common_list_20','and6_list_20','and2_list_20','or2_list_20']){const c=B_CASES.find(c=>c.name===name)!;const q=await compile(c);const plan=(await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+q.text,q.params)).rows[0]['QUERY PLAN'];plans.push({name,condition:describe(c),sql:q.text,plan});}save('plans',plans);
}else{
const selected=B_CASES.filter(c=>!c.mode.startsWith('join')&&(phase==='all'||phase==='counts'&&c.mode==='count'&&c.name!=='sub45'||phase==='lists'&&c.mode==='find'||phase==='join'&&c.mode==='sum'||phase==='long'&&c.name==='sub45'));
const truthFile=`${OUT}/m2-fable-truth.json`,sharedTruth=existsSync(truthFile)?JSON.parse(readFileSync(truthFile,'utf8')):null;
for(const c of selected){const row:any={label:`${c.mode} ${c.name}`,name:c.name,condition:describe(c),mode:c.mode,limit:c.limit,targetRows:100000,joinTargetRows:c.mode.startsWith('join')?100000:undefined,projection:c.mode==='joinFind'?['ticket.memo','customer.name','customer.phone','customer.address','customer.memo','customer.email','customer.company']:c.mode==='find'?['name','phone','address','memo','email','company']:[],semantics:c.sourceRespectWords?'shared normalized-substring baseline; word-boundary semantics NOT exercised':undefined,first:{},runs:{plain:[],B:[]},failed:{}};
 result.push(row);
 try{
   const expected=await plain(c);const countCase={...c,mode:c.mode.startsWith('join')?'joinCount':'count',limit:undefined} as BCase;
   row.actualMatches=await plain(countCase);row.truth=Array.isArray(expected)?expected.length:expected;row.resultRows=Array.isArray(expected)?expected.length:1;row.dbCandidates=await runB(c,true);
   const reference=Array.isArray(sharedTruth)?sharedTruth.find((x:any)=>x.name===c.name):null;if(reference&&c.mode==='count')assert.equal(row.truth,reference.count,'shared truth mismatch');
   for(let i=-3;i<7;i++)for(const path of (i%2?['B','plain']:['plain','B']) as ('plain'|'B')[]){
     const stat=await measured(()=>path==='plain'?plain(c):runB(c));
     if(i===-3){const {value,...metrics}=stat;row.first[path]=metrics;}
     try{assert.deepEqual(stat.value,expected,`${c.name}/${path}/${i}: full values and ID order`);}catch(e){row.observedMismatch={path,expected:Array.isArray(expected)?expected.length:expected,actual:Array.isArray(stat.value)?stat.value.length:stat.value};throw e;}
     const {value,...metrics}=stat;if(i>=0)row.runs[path].push(metrics);
   }
   row.summary={plain:summarize(row.runs.plain),B:summarize(row.runs.B)};
   row.medians={plain:row.summary.plain.totalMs,B:row.summary.B.totalMs};row.dbMedians={plain:row.summary.plain.dbMs,B:row.summary.B.dbMs};
   row.ratios={plain:1,B:row.medians.B/row.medians.plain};row.sqlRatios={plain:1,B:row.dbMedians.B/row.dbMedians.plain};
   row.meta=Object.fromEntries(['plain','B'].map(path=>{const s=row.summary[path];const scalar=!(c.mode==='find'||c.mode==='joinFind');return[path,{app:s.rowsToApp,recordApp:scalar?0:s.rowsToApp,scalarRows:scalar?1:0,decrypts:s.openCount,sql:s.sqlCalls}];}));
   console.log(c.name,row.actualMatches,JSON.stringify(row.medians));
 }catch(e:any){row.failed.B=e.message;row.medians={};row.dbMedians={};console.error('FAILED',c.name,e.message);}
 save(phase,result);
}
}
}finally{unlock();await pool.end();}

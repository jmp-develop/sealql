import type {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {assert,readFileSync,fields,scope,schema,locked,save} from './common.js';
import {sealed,customers,customersSeal} from './product.js';
import {oracle,plainWhere,match,normalizedRows,koreanLike} from '../final-return/oracle.js';
import {condition,type Case} from '../final-return/common.js';
import {measured,summarize} from '../final-return/instrument.js';
export async function headRecheck(pool:Pool,data:any[],commit:string){await locked(async()=>{
 const db=drizzle(pool),result:any={commit,started:new Date().toISOString(),complete:false,rows:[],errors:[],functionInstall:sealed.extraMigrationSql(customersSeal)};
 for(const sql of result.functionInstall)await pool.query(sql);for(const table of ['customers','customers_seal_index','customers_plain'])await pool.query(`analyze ${schema}.${table}`);
 await pool.query('set max_parallel_workers_per_gather=2');result.session=(await pool.query('select pg_backend_pid() pid')).rows[0];
 const all:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8')),old=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/remeasure.json','utf8'));assert.equal(all.length,55);result.priorCommit=old.commit;
 const jobs=[...all.map(c=>({...c,mode:'count'})),...all.filter(c=>c.name.startsWith('like_')).map(c=>({...c,mode:'list300'}))];assert.equal(jobs.length,58);
 for(const c of jobs){const truth=data.filter(r=>oracle(c.node,r)),expected=c.mode==='count'?truth.length:truth.slice(0,300),r:any={name:c.name,mode:c.mode,condition:condition(c.node),matches:truth.length,cLocaleKoreanLike:koreanLike(c.node),runs:{plain:[],product:[]},first:{},summary:{},sql:{}};
  for(let round=-3;round<7;round++)for(const path of round%2===0?['product','plain']:['plain','product']){const out=await measured(async()=>{if(path==='product')return c.mode==='count'?sealed.count(db,customersSeal,{scope,match:(m:any)=>match(c.node,m)}):(await sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any)).items;const params:unknown[]=[scope],where=plainWhere(c.node,params);const rows=(await pool.query(`select ${c.mode==='count'?'count(*)::int n':`id,${fields.map(f=>f+'_norm as '+f).join(',')}`} from ${schema}.customers_plain where scope_id=$1 and ${where}${c.mode==='count'?'':' order by id limit 300'}`,params)).rows;return c.mode==='count'?rows[0].n:rows;});assert.deepEqual(out.pids,[result.session.pid]);assert.deepEqual(c.mode==='count'?out.value:normalizedRows(out.value),expected,`${c.name}/${c.mode}/${path}`);assert.equal(out.metric.opens,path==='plain'||c.mode==='count'?0:(expected as any[]).length*6);if(round===-3){r.first[path]=out.metric;r.sql[path]=out.queries.map(q=>q.text);}if(round>=0)r.runs[path].push(out.metric);}
  for(const path of ['plain','product'])r.summary[path]=summarize(r.runs[path]);const prior=old.rows.find((x:any)=>x.name===c.name&&x.mode===c.mode);assert(prior);r.prior={product:prior.summary.product,research:prior.summary.research};r.priorProductSqlChange=r.summary.product.sqlMs/prior.summary.product.sqlMs-1;r.priorProductTotalChange=r.summary.product.totalMs/prior.summary.product.totalMs-1;result.rows.push(r);save('head-recheck',result);console.log(JSON.stringify({headRecheck:result.rows.length,name:c.name,mode:c.mode,sqlMs:r.summary.product.sqlMs}));
 }result.complete=true;result.finished=new Date().toISOString();save('head-recheck',result);
});}

import type {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {schema,scope,assert,readFileSync,save,locked,status} from './common.js';
import {sealed,customersSeal} from './product.js';
import {oracle,plainWhere,match,koreanLike} from '../final-return/oracle.js';
import {condition,type Case} from '../final-return/common.js';
import {measured,summarize,type Statement} from '../final-return/instrument.js';
const historical:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8'));
export const cases:Case[]=[{name:'memo_service',node:{field:'memo',op:'contains',value:'서비스'}},{name:'email_suffix',node:{field:'email',op:'endsWith',value:'biz.test'}},{name:'memo_consult',node:{field:'memo',op:'contains',value:'서비스 상담'}},{name:'company_common',node:{field:'company',op:'eq',value:'서울서비스 담당'}},historical.find(c=>c.name==='or6')!,{name:'rare',node:{field:'memo',op:'contains',value:'푸른달'}}];
assert(cases.every(Boolean));
export async function measureScale(pool:Pool,data:any[],scale:number,result:any){await locked(async()=>{
 const db=drizzle(pool),pid=(await pool.query('select pg_backend_pid() pid')).rows[0].pid;if(result.pid)assert.equal(result.pid,pid);else result.pid=pid;
 const plans:any[]=[];result.cases=cases;result.settings=(await pool.query("select current_setting('max_parallel_workers') max_parallel_workers,current_setting('max_worker_processes') max_worker_processes,current_setting('work_mem') work_mem,(select datcollate from pg_database where datname=current_database()) locale")).rows[0];
 for(const c of cases){const expectedBase=data.filter(r=>oracle(c.node,r)).length,expected=expectedBase*(scale/100000),paths=[2,4,8].flatMap(parallel=>['plain','product'].map(path=>({parallel,path,key:path+parallel}))),first:any={},runs:any=Object.fromEntries(paths.map(p=>[p.key,[]])),queries=new Map<string,Statement[]>();
  for(let round=-3;round<7;round++){const offset=(round+3)%paths.length;for(const p of [...paths.slice(offset),...paths.slice(0,offset)]){await pool.query('set max_parallel_workers_per_gather='+p.parallel);const out=await measured(async()=>{if(p.path==='product')return sealed.count(db,customersSeal,{scope,match:m=>match(c.node,m)});const params:unknown[]=[scope],where=plainWhere(c.node,params);return (await pool.query(`select count(*)::int n from ${schema}.customers_plain where scope_id=$1 and ${where}`,params)).rows[0].n;});assert.deepEqual(out.pids,[pid]);assert.equal(out.value,expected,`${scale}/${c.name}/${p.key}: original oracle × factor`);assert.equal(out.metric.opens,0);assert.equal(out.metric.appRows,1);if(round===-3)first[p.key]=out.metric;if(round>=0)runs[p.key].push(out.metric);queries.set(p.key,out.queries);}}
  for(const parallel of [2,4,8]){const summary={plain:summarize(runs['plain'+parallel]),product:summarize(runs['product'+parallel])};result.rows.push({scale,name:c.name,condition:condition(c.node),node:c.node,parallel,expectedBase,expected,matchRatio:expected/scale,cLocaleKoreanLike:koreanLike(c.node),first:{plain:first['plain'+parallel],product:first['product'+parallel]},runs:{plain:runs['plain'+parallel],product:runs['product'+parallel]},summary});for(const path of ['plain','product'])plans.push({scale,name:c.name,parallel,path,queries:queries.get(path+parallel)});}
  save('measure',result);console.log(JSON.stringify({scale,name:c.name,expected,sql:Object.fromEntries([2,4,8].map(p=>[p,result.rows.find((r:any)=>r.scale===scale&&r.name===c.name&&r.parallel===p).summary.product.sqlMs]))}));
 }
 for(const p of plans){await pool.query('set max_parallel_workers_per_gather='+p.parallel);const explained=[];for(const q of p.queries)explained.push({sql:q.text,plan:(await pool.query('explain (analyze,buffers,format json) '+q.text,q.values)).rows[0]['QUERY PLAN']});result.plans.push({scale:p.scale,name:p.name,parallel:p.parallel,path:p.path,plans:explained});save('measure',result);}
 status('100만 count 규모별 측정 진행',`${scale}행의6조건×병렬도2/4/8을 같은 연결에서 평문·제품 예열2/교차7로 완료했고 매회 원본 oracle×${scale/100000}과 일치했습니다.`);
 });}

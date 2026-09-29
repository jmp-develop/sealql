import {writeFileSync,readFileSync} from 'node:fs';
import {connect,scope,fields,assert} from './common.js';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sealed,customers,customersSeal} from './product.js';
import {match} from './oracle.js';
import {measured,type Statement} from './instrument.js';
import {functionVariant} from './variants.js';
assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-final-return');
const p=await connect(),db=drizzle(p),out:any={plans:[]};
try{
 out.functions=(await p.query("select n.nspname,p.proname,p.procost,p.proparallel,p.provolatile,p.proisstrict,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='research_u' and proname='pb_4_match') or (n.nspname='test_final_return_product' and proname like 'sealql_match_positions%')")).rows;
 out.indexes=(await p.query("select schemaname,tablename,indexname,indexdef,pg_relation_size(quote_ident(schemaname)||'.'||quote_ident(indexname)) bytes from pg_indexes where (schemaname='research_u' and tablename='pb_4_final') or (schemaname='test_final_return_product' and tablename='customers_seal_index')")).rows;
 const cases=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8'));
 for(const name of ['sub_mid','starts']){
  let q:Statement|undefined;const node=cases.find((c:any)=>c.name===name).node;
  try{await measured(()=>sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any),s=>{q=s;throw Error('CAPTURE_ONLY');});}catch(error){if(!q)throw error;}
  for(const path of ['product','checks-off','qualified-no-set','product-warm'] as const){
   const query=path==='product'||path==='product-warm'?{text:q!.text,params:q!.values}:functionVariant('test_final_return_product',path).rewrite({text:q!.text,params:q!.values});
   const plan=(await p.query('explain (analyze,buffers,verbose,format json) '+query.text,query.params)).rows[0]['QUERY PLAN'];out.plans.push({name,path,plan});
  }
 }
 writeFileSync('bench/results/2026-09-29-final-impl/root-focus-warm.json',JSON.stringify(out,null,2)+'\n');
 console.log(JSON.stringify({functions:out.functions,plans:out.plans.map((x:any)=>({name:x.name,path:x.path,ms:x.plan[0]['Execution Time']}))}));
}finally{await p.end();}

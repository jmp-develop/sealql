import {drizzle} from 'drizzle-orm/node-postgres';
import {acquire,release,connect,save,assert,readFileSync,OUT,scope,fields} from './common.js';
import {sealed,customersSeal,customers} from './product.js';
import {match,normalizedRows,oracle} from './oracle.js';
import {normalize} from './common.js';
import {prepareVariants} from './variant-adapter.js';
import {measured} from './instrument.js';
acquire();const pool=await connect(),db=drizzle(pool);
try{
 const measurement=JSON.parse(readFileSync(`${OUT}/measure.json`,'utf8'));assert.equal(measurement.complete,true,'No additional DB work during rotating measurements');
 const variants=await prepareVariants(pool),cases=JSON.parse(readFileSync(`${OUT}/cases.json`,'utf8'));
 const data=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));
 const focuses=[...['sub_common_memo','and2'].map(name=>({name,mode:'count',variant:'v4a_seal_count'})),...['and2','or_and_mix','and3_or_rare'].map(name=>({name,mode:'list300',variant:'v4d_research_fallback'})),...['sub_mid','starts','coarse_rare_and_memo'].map(name=>({name,mode:'list300',variant:'v4b_qualified_no_set'})),{name:'ends',mode:'count',variant:'v4b_qualified_no_set'}];
 const result:any={complete:false,commit:measurement.commit,at:new Date().toISOString(),pid:(await pool.query('select pg_backend_pid() pid')).rows[0].pid,note:'Additional focused EXPLAIN after all timed measurements; separate physical connection, same settings/data; no p50 timing claims',plans:[]};
 for(const focus of focuses){const c=cases.find((c:any)=>c.name===focus.name);assert(c);const truth=data.filter(r=>oracle(c.node,r)),expected=focus.mode==='count'?truth.length:truth.slice(0,300),variant=variants.find(v=>v.name===focus.variant)!;assert(variant);await variant.beforeCase?.(c.node);
  for(const path of ['product',focus.variant]){const out=await measured(()=>focus.mode==='count'?sealed.count(db,customersSeal,{scope,match:m=>match(c.node,m)}):sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any).then(r=>r.items),path==='product'?undefined:s=>variant.rewrite(s,{node:c.node,mode:focus.mode}));assert.deepEqual(focus.mode==='count'?out.value:normalizedRows(out.value),expected);
   const plans=[];for(const q of out.queries)plans.push({sql:q.text,plan:(await pool.query('explain (analyze,buffers,format json) '+q.text,q.values)).rows[0]['QUERY PLAN']});result.plans.push({...focus,path,plans});save('plans-focus',result);
  }console.log(JSON.stringify({focus:focus.name,mode:focus.mode,variant:focus.variant}));
 }
 result.complete=true;save('plans-focus',result);
}finally{await pool.end();release();}

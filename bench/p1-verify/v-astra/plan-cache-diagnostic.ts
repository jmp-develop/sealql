/** Requested follow-up of the apparent unchanged-query regression. */
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {connect,save,fields,scope,assert,normalize,acquire,release,OUT} from './common.js';
import {customers,customersSeal,sealed,cipher,productSchema} from './product.js';
import {measured,summarize,instrumentSealer,lastSQL} from './instrument.js';
import {oracle,normalizedRows,plainWhere,match} from '../../final-return/oracle.js';
const original=JSON.parse(readFileSync(`${OUT}/measure.json`,'utf8'));assert(original.complete);
const c=original.rows.find((r:any)=>r.name==='zero_and_common2'&&r.mode==='list300'&&r.group==='core');assert(c);
const oldCore=await import(new URL('../../../.local/p1-verify-7c14bda/dist/index.js',import.meta.url).href),oldAdapter=await import(new URL('../../../.local/p1-verify-7c14bda/dist/adapters/drizzle/v0.45/index.js',import.meta.url).href);
const oldCipher=oldCore.createSealer({key:new Uint8Array(32).fill(93)}),oldSealed=oldAdapter.createSealed({sealer:oldCipher});
const oldCustomers=pgSchema(productSchema).table('customers',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,oldSealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:true}})]))}),oldSeal=oldSealed.register(oldCustomers,{row:'id',scope:'scopeId'});
instrumentSealer(cipher);instrumentSealer(oldCipher);assert.deepEqual(oldSealed.extraMigrationSql(oldSeal),sealed.extraMigrationSql(customersSeal));
const result:any={started:new Date().toISOString(),complete:false,name:c.name,node:c.node,original:c.summary,orders:c.orders.filter((o:any)=>o.round>=0),queries:{},plans:{},runs:{plain:[],old:[],new:[]},errors:[],protocol:'After complete primary matrix. Capture actual SQL/params; EXPLAIN each statement once per product path; warmup2; additional7 in exactly original measured path orders.'};
const driverEvents:any[]=[];let driverPath:string|undefined;
const instrumentedQuery=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){if(driverPath){const config=typeof args[0]==='string'?{}:args[0];driverEvents.push({path:driverPath,shape:typeof args[0],argumentCount:args.length,secondIsArray:Array.isArray(args[1]),name:config.name??null,rowMode:config.rowMode??null,queryMode:config.queryMode??null,callback:args.some(a=>typeof a==='function'),customTypes:!!config.types,pid:this.processID,configKeys:Object.keys(config).sort()});}return (instrumentedQuery as any).apply(this,args);};
acquire();let pool:Awaited<ReturnType<typeof connect>>|undefined;
try{
 pool=await connect();const db=drizzle(pool),pid=(await pool.query('select pg_backend_pid() pid')).rows[0].pid;
 await pool.query("set work_mem='4MB'");await pool.query('set max_parallel_workers_per_gather=4');
 const raw=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows,rawById=new Map(raw.map(r=>[r.id,r]));
 const truth=raw.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))})).filter(r=>oracle(c.node,r)).slice(0,300);
 async function call(path:string){driverPath=path;const out=await measured(async()=>{if(path==='plain'){const params:unknown[]=[scope],where=plainWhere(c.node,params);return (await pool!.query(`select id,${fields.map(f=>f+'_norm as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 and ${where} order by id limit 300`,params)).rows;}const api=path==='old'?oldSealed:sealed,seal=path==='old'?oldSeal:customersSeal,table=path==='old'?oldCustomers:customers;return (await api.findMany(db,seal,{scope,match:(m:any)=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:table.id,direction:'asc'},limit:300} as any)).items;});driverPath=undefined;assert.deepEqual(out.pids,[pid]);assert.deepEqual(normalizedRows(out.value),truth);assert.equal(out.metric.opens,path==='plain'?0:truth.length*6);if(path!=='plain')for(const row of out.value)for(const f of fields)assert.equal(row[f],rawById.get(row.id)![f]);return out;}

 result.initialPrepared=(await pool.query('select name,statement,parameter_types,generic_plans,custom_plans from pg_prepared_statements')).rows;
 for(const path of ['old','new'])result.queries[path]=(await call(path)).queries;
 result.sqlIdentical=isDeepStrictEqual(result.queries.old.map((q:any)=>q.text),result.queries.new.map((q:any)=>q.text));result.paramsIdentical=isDeepStrictEqual(result.queries.old.map((q:any)=>q.values),result.queries.new.map((q:any)=>q.values));
 result.modes={};
 for(const mode of ['auto','force_custom_plan']){
  await pool.query('set plan_cache_mode='+mode);
  const runs:any={plain:[],old:[],new:[]};
  for(const order of c.orders.filter((o:any)=>o.round===-2||o.round===-1))for(const path of order.paths)await call(path);
  for(const order of result.orders)for(const path of order.paths){const out=await call(path);runs[path].push(out.metric);}
  result.modes[mode]={runs,summary:Object.fromEntries(['plain','old','new'].map(path=>[path,summarize(runs[path])])),prepared:(await pool.query('select name,statement,parameter_types,generic_plans,custom_plans from pg_prepared_statements')).rows};
 }
 result.driverEvents=driverEvents;
 // Execute identical captured SQL directly, alternating labels, without product preparation.
 result.direct={};
 for(const mode of ['auto','force_custom_plan']){
  await pool.query('set plan_cache_mode='+mode);const runs:any={old:[],new:[]};
  for(let round=-2;round<7;round++)for(const path of (round%2?['new','old']:['old','new'])){const q=result.queries[path][0],out=await measured(async()=>{const v=await pool!.query({text:q.text,rowMode:'array'},q.values);assert.equal(v.rows.length,0);});if(round>=0)runs[path].push(out.metric);}
  result.direct[mode]={runs,summary:Object.fromEntries(['old','new'].map(path=>[path,summarize(runs[path])]))};
 }
 await pool.query('set plan_cache_mode=force_custom_plan');
 const q=result.queries.old[0];
 result.customPlan=(await pool.query('explain (analyze,buffers,verbose,format json) '+q.text,q.values)).rows[0]['QUERY PLAN'];
 result.genericPlan=(await pool.query('explain (generic_plan,verbose,format json) '+q.text)).rows[0]['QUERY PLAN'];
 result.finalPrepared=(await pool.query('select name,statement,parameter_types,generic_plans,custom_plans from pg_prepared_statements')).rows;
 result.complete=true;
}catch(e:any){result.errors.push({message:String(e),cause:e.cause?String(e.cause):undefined,lastSQL});throw e;}finally{result.finished=new Date().toISOString();try{save('plan-cache-diagnostic',result);}finally{try{if(pool)await pool.end();}finally{release();}}}
console.log(JSON.stringify({complete:result.complete,sqlIdentical:result.sqlIdentical,paramsIdentical:result.paramsIdentical,modes:result.modes,direct:result.direct,driverShapes:[...new Set(driverEvents.map(e=>JSON.stringify({...e,path:undefined})))]}));

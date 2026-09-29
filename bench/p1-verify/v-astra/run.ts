/** Independent public-API comparison of preserved baseline and P1. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {connect,save,fields,scope,assert,normalize,acquire,release,OUT,type Case} from './common.js';
import {customers,customersSeal,sealed,cipher,productSchema} from './product.js';
import {measured,summarize,instrumentSealer,lastSQL} from './instrument.js';
import {oracle,normalizedRows,plainWhere,match,koreanLike} from '../../final-return/oracle.js';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const baseline=JSON.parse(readFileSync(`${OUT}/baseline-build.json`,'utf8'));
for(const f of baseline.files)assert.equal(hash(readFileSync(`.local/p1-verify-7c14bda/dist/${f.file}`)),f.sha256);
const oldCore=await import(new URL('../../../.local/p1-verify-7c14bda/dist/index.js',import.meta.url).href);
const oldAdapter=await import(new URL('../../../.local/p1-verify-7c14bda/dist/adapters/drizzle/v0.45/index.js',import.meta.url).href);
const oldCipher=oldCore.createSealer({key:new Uint8Array(32).fill(93)}),oldSealed=oldAdapter.createSealed({sealer:oldCipher});
const oldCustomers=pgSchema(productSchema).table('customers',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,oldSealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:true}})]))});
const oldSeal=oldSealed.register(oldCustomers,{row:'id',scope:'scopeId'});
instrumentSealer(cipher);instrumentSealer(oldCipher);
const oldMigration=oldSealed.extraMigrationSql(oldSeal),newMigration=sealed.extraMigrationSql(customersSeal);
assert.deepEqual(oldMigration,newMigration,'Shared schema requires identical function DDL');
const cases:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8'));assert.equal(cases.length,55);
const jobs=[...cases.flatMap(c=>['count','list300'].map(mode=>({...c,mode,group:'core'}))),...cases.filter(c=>c.name.startsWith('like_')).map(c=>({...c,mode:'list300',group:'literalLikeRepeat'})),...([{name:'like_general_segments',node:{field:'email',op:'like',value:'%te%st'}},{name:'like_general_underscore',node:{field:'email',op:'like',value:'%te__'}}] as Case[]).map(c=>({...c,mode:'list300',group:'generalLike'})),...['exact_common','sub_rare','exact_one'].map(name=>({...cases.find(c=>c.name===name)!,mode:'listAll',group:'wholeList'}))];assert.equal(jobs.length,118);
const paths=['plain','old','new'],orders=[[0,1,2],[1,2,0],[2,0,1],[2,1,0],[0,2,1],[1,0,2]];
const edges=new Map<string,number>();for(const order of orders)for(let i=1;i<3;i++){const edge=`${order[i-1]}${order[i]}`;edges.set(edge,(edges.get(edge)??0)+1);}assert.equal(edges.size,6);assert([...edges.values()].every(n=>n===2));
const load=JSON.parse(readFileSync(`${OUT}/load.json`,'utf8'));assert(load.complete&&load.loaded===100000);
const result:any={started:new Date().toISOString(),complete:false,rows:[],errors:[],load,paths,commits:{old:'7c14bda',new:'638f9c2'},baselineBuildVerifiedFiles:baseline.files.length,functionDdl:{identical:true,oldSha256:hash(JSON.stringify(oldMigration)),newSha256:hash(JSON.stringify(newMigration))},protocol:'Same physical connection; separate first run, warmup2, measured7. First six measured rounds use Williams orders; seventh order rotates by job. Oracle every run. Literal LIKE repeats reported separately.',totalJobs:jobs.length};
acquire();let pool:Awaited<ReturnType<typeof connect>>|undefined;
try{
 pool=await connect();const db=drizzle(pool),pid=(await pool.query('select pg_backend_pid() pid')).rows[0].pid;
 for(const sql of (Array.isArray(newMigration)?newMigration:[newMigration]))await pool.query(sql);
 await pool.query(`alter table ${productSchema}.customers_seal_index reset (parallel_workers)`);
 for(const table of ['customers','customers_seal_index'])await pool.query(`vacuum (analyze) ${productSchema}.${table}`);
 await pool.query("set work_mem='4MB'");await pool.query('set max_parallel_workers_per_gather=4');
 result.session=(await pool.query("select pg_backend_pid() pid,current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') gather,current_setting('max_parallel_workers') max_parallel_workers,current_setting('parallel_setup_cost') parallel_setup_cost,current_setting('parallel_tuple_cost') parallel_tuple_cost,current_setting('jit') jit,(select datcollate from pg_database where datname=current_database()) locale")).rows[0];
 const raw=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;
 const data=raw.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))})),rawById=new Map(raw.map(r=>[r.id,r]));assert.equal(data.length,100000);
 for(const table of ['customers','customers_seal_index'])assert.equal(Number((await pool.query(`select count(*) n from ${productSchema}.${table}`)).rows[0].n),100000);
 save('measure',result);
 for(const [jobIndex,c] of jobs.entries()){
  const truth=data.filter(r=>oracle(c.node,r)),expected=c.mode==='count'?truth.length:c.mode==='listAll'?truth:truth.slice(0,300),returned=c.mode==='count'?1:(expected as any[]).length;
  const record:any={...c,hits:truth.length,returned,cLocaleKoreanLike:koreanLike(c.node),first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{},orders:[],sql:{},tokenLengths:{}};
  for(let round=-3;round<7;round++){
   const order=orders[round<0?(jobIndex+round+6)%6:round===6?jobIndex%6:(round+jobIndex)%6];record.orders.push({round,paths:order.map(i=>paths[i])});
   for(const path of order.map(i=>paths[i])){
    result.active={jobIndex,name:c.name,mode:c.mode,group:c.group,path,round};
    const out=await measured(async()=>{
     if(path==='plain'){const params:unknown[]=[scope],where=plainWhere(c.node,params);const q=await pool!.query(`select ${c.mode==='count'?'count(*)::int n':`id,${fields.map(f=>f+'_norm as '+f).join(',')}`} from bench_realistic_100k.customers where scope_id=$1 and ${where}${c.mode==='count'?'':` order by id${c.mode==='list300'?' limit 300':''}`}`,params);return c.mode==='count'?q.rows[0].n:q.rows;}
     const api=path==='old'?oldSealed:sealed,seal=path==='old'?oldSeal:customersSeal,table=path==='old'?oldCustomers:customers;
     if(c.mode==='count')return api.count(db,seal,{scope,match:(m:any)=>match(c.node,m)});
     return (await api.findMany(db,seal,{scope,match:(m:any)=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:table.id,direction:'asc'},...(c.mode==='list300'?{limit:300}:{})} as any)).items;
    });
    assert.deepEqual(out.pids,[pid]);assert.deepEqual(c.mode==='count'?out.value:normalizedRows(out.value),expected,`${c.name}/${c.mode}/${path}: normalized oracle`);
    if(path!=='plain'&&c.mode!=='count')for(const row of out.value)for(const f of fields)assert.equal(row[f],rawById.get(row.id)![f],`${path}/${f}: raw roundtrip`);
    assert.equal(out.metric.opens,path==='plain'||c.mode==='count'?0:returned*6);
    if(round===-3){record.first[path]=out.metric;record.sql[path]=out.queries.map(q=>q.text);record.tokenLengths[path]=out.queries.flatMap(q=>[...q.text.matchAll(/@>\s*\$(\d+)::bigint\[\]/g)].map(m=>{const v=q.values[Number(m[1])-1];return Array.isArray(v)?v.length:String(v).slice(1,-1).split(',').filter(Boolean).length;}));if(path==='new')assert(record.tokenLengths[path].every((n:number)=>n<=3),'P1 at most three candidate tokens');}
    if(round>=0)record.runs[path].push(out.metric);
   }
  }
  for(const path of paths)record.summary[path]=summarize(record.runs[path]);result.rows.push(record);save('measure',result);console.log(JSON.stringify({done:result.rows.length,total:jobs.length,name:c.name,mode:c.mode,sql:Object.fromEntries(paths.map(p=>[p,record.summary[p].sqlMs]))}));
 }
 assert.equal(result.rows.length,jobs.length);assert.equal((await pool.query('select pg_backend_pid() pid')).rows[0].pid,pid);result.complete=true;delete result.active;
}catch(e:any){result.errors.push({message:String(e),cause:e.cause?String(e.cause):undefined,lastSQL});throw e;}finally{result.finished=new Date().toISOString();try{save('measure',result);}finally{try{if(pool)await pool.end();}finally{release();}}}
console.log('COMPLETE: 118 jobs x three paths; every result matches plaintext and raw field values');

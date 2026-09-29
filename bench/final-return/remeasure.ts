import {execFileSync} from 'node:child_process';
import {existsSync,copyFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,relative} from 'node:path';
import {getTableColumns} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/node-postgres';
import {acquire,release,connect,save,fields,scope,assert,readFileSync,OUT,normalize,condition,type Case} from './common.js';
import {compile} from './research-query.js';
import {oracle,normalizedRows,plainWhere,match,koreanLike} from './oracle.js';
import {cipher,sealed,customers,customersSeal,productSchema} from './product.js';
import {measured,summarize,lastSQL} from './instrument.js';
const deadline=Date.parse('2026-09-29T08:48:00Z'),result:any={started:new Date().toISOString(),deadline:new Date(deadline).toISOString(),complete:false,errors:[],rows:[],protocol:'55 counts + 3 LIKE lists only; same connection, first separate, warmup2, rotating7; raw fixture oracle every execution'};
class Deadline extends Error{}
const checkTime=()=>{if(Date.now()>=deadline)throw new Deadline('Coordinator cutoff reached');};
let current:any;
acquire();const pool=await connect(),db=drizzle(pool);
try{
 checkTime();const requested=process.argv[process.argv.indexOf('--commit')+1];assert(process.argv.includes('--commit')&&/^[0-9a-f]{7,40}$/.test(requested));
 result.commit=execFileSync('git',['rev-parse',requested],{encoding:'utf8'}).trim();result.head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 if(process.env.SEALQL_PINNED_BUILD){const build=resolve(process.env.SEALQL_PINNED_BUILD),entry=relative(build,fileURLToPath(import.meta.url)).replaceAll('\\','/');assert.equal(entry,'bench/final-return/remeasure.ts');result.build=JSON.parse(readFileSync(build+'/build-provenance.json','utf8'));assert.equal(result.build.commit,result.commit);}else execFileSync('git',['diff','--exit-code',requested,'--','src','package.json','tsconfig.json'],{encoding:'utf8'});
 if(existsSync(`${OUT}/remeasure.json`))copyFileSync(`${OUT}/remeasure.json`,`${OUT}/remeasure-prior-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
 const load=JSON.parse(readFileSync(`${OUT}/product-load.json`,'utf8'));assert.equal(load.complete,true);result.dataCommit=load.commit;
 const actual=(await pool.query('select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attname',[productSchema+'.customers_seal_index'])).rows.map(r=>r.attname);assert.deepEqual(actual,Object.values(getTableColumns(customersSeal)).map(c=>c.name).sort());
 result.functionInstall=sealed.extraMigrationSql(customersSeal);for(const sql of result.functionInstall){checkTime();await pool.query(sql);}for(const table of ['customers','customers_seal_index'])await pool.query(`analyze ${productSchema}.${table}`);
 result.session=(await pool.query("select pg_backend_pid() pid,current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') parallel_workers,(select datcollate from pg_database where datname=current_database()) locale")).rows[0];save('remeasure',result);
 const data=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));assert.equal(data.length,100000);
 const cases:Case[]=JSON.parse(readFileSync(`${OUT}/cases.json`,'utf8'));assert.equal(cases.length,55);const likes=cases.filter(c=>c.name.startsWith('like_'));assert.equal(likes.length,3);
 const jobs=[...cases.map(c=>({...c,mode:'count'})),...likes.map(c=>({...c,mode:'list300'}))];
 for(const c of jobs){
  checkTime();await pool.query(`set statement_timeout=${Math.max(1,Math.min(120000,deadline-Date.now()))}`);
  const truth=data.filter(r=>oracle(c.node,r)),expected=c.mode==='count'?truth.length:truth.slice(0,300),paths=['plain','research','product'];
  current={name:c.name,condition:condition(c.node),node:c.node,mode:c.mode,matches:truth.length,returned:c.mode==='count'?1:(expected as any[]).length,cLocaleKoreanLike:koreanLike(c.node),paths,first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{},sql:{}};
  const run=async(path:string)=>{
   if(path==='plain'){const params:unknown[]=[scope],where=plainWhere(c.node,params),rows=(await pool.query(`select ${c.mode==='count'?'count(*)::int n':`id,${fields.map(f=>f+'_norm as '+f).join(',')}`} from research_u.customers_plain where scope_id=$1 and ${where}${c.mode==='count'?'':' order by id limit 300'}`,params)).rows;return c.mode==='count'?rows[0].n:rows;}
   if(path==='research'){const q=await compile(c.node,c.mode),rows=(await pool.query(q.text,q.params)).rows;if(c.mode==='count')return rows[0].n;return Promise.all(rows.map(async r=>({id:r.id,...Object.fromEntries(await Promise.all(fields.map(async f=>[f,await cipher.open(r[f+'_ct'],{modelId:'customers',fieldId:f,keyScopeId:'global',scopeId:scope,rowId:r.id,spec:{type:'text'}},cipher.ring('customers'))])))})));}
   if(c.mode==='count')return sealed.count(db,customersSeal,{scope,match:m=>match(c.node,m)});
   return (await sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},limit:300} as any)).items;
  };
  for(let round=-3;round<7;round++){const offset=(round+3)%3;for(const path of [...paths.slice(offset),...paths.slice(0,offset)]){checkTime();result.active={name:c.name,mode:c.mode,path,round};const out=await measured(()=>run(path));assert.deepEqual(out.pids,[result.session.pid]);assert.deepEqual(c.mode==='count'?out.value:normalizedRows(out.value),expected,`${c.name}/${c.mode}/${path}: oracle`);assert.equal(out.metric.opens,path==='plain'||c.mode==='count'?0:current.returned*6);if(round===-3){current.first[path]=out.metric;current.sql[path]=out.queries.map(q=>q.text);}if(round>=0)current.runs[path].push(out.metric);}}
  for(const path of paths)current.summary[path]=summarize(current.runs[path]);const p=current.summary.product,r=current.summary.research;p.sqlRatio=p.sqlMs/r.sqlMs;p.totalRatio=p.totalMs/r.totalMs;p.sqlPass=p.sqlMs<=r.sqlMs*1.1||p.sqlMs-r.sqlMs<=1;p.totalPass=p.totalMs<=r.totalMs*1.1||p.totalMs-r.totalMs<=1;p.overOneSecond=p.sqlMs>1000||p.totalMs>1000;
  result.rows.push(current);current=undefined;save('remeasure',result);console.log(JSON.stringify({done:result.rows.length,name:c.name,mode:c.mode,productSQL:p.sqlMs,researchSQL:r.sqlMs}));
  const milestone=new Map([[15,25],[29,50],[44,75],[58,100]]).get(result.rows.length);if(milestone)execFileSync('rtk',['proxy','orca','orchestration','send','--from','term_2207b6c8-c853-4009-869e-e401f52ddd8e','--to','term_be20cdd8-e2cf-4cef-be5b-574b2d2a0233','--type','status','--subject',`최종 보완 측정 ${milestone}%`,'--body',`${result.commit.slice(0,7)} count55+LIKE목록3 중 ${result.rows.length}/58개 완료, 모든 실행 oracle 일치.`],{stdio:'inherit'});
 }
 assert.equal(result.rows.length,58);assert.equal(result.rows.filter((r:any)=>r.mode==='count').length,55);assert.equal((await pool.query('select pg_backend_pid() pid')).rows[0].pid,result.session.pid);result.complete=true;
}catch(error){let timeout=false;for(let e:any=error;e;e=e.cause)if(e.code==='57014')timeout=true;if(error instanceof Deadline||(Date.now()>=deadline&&timeout)){result.cutoffReached=true;result.partialJob=current;}else{result.errors.push(String(error));result.failure={...result.active,sql:lastSQL,causes:[]};for(let e:any=error;e;e=e.cause)result.failure.causes.push({name:e.name,message:e.message,code:e.code});throw error;}}
finally{result.finished=new Date().toISOString();save('remeasure',result);await pool.end();release();}

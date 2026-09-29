import {drizzle} from 'drizzle-orm/node-postgres';
import {acquire,release,connect,save,fields,scope,assert,readFileSync,OUT,normalize,condition,type Case} from './common.js';
import {compile} from './research-query.js';
import {oracle,normalizedRows,plainWhere,match,koreanLike} from './oracle.js';
import {cipher,sealed,customers,customersSeal,productSchema} from './product.js';
import {measured,summarize,lastSQL,type Statement} from './instrument.js';
import {execFileSync} from 'node:child_process';
import {getTableColumns} from 'drizzle-orm';
import {existsSync,copyFileSync} from 'node:fs';
const result:any={started:new Date().toISOString(),complete:false,errors:[],rows:[],protocol:'Same physical PostgreSQL connection; first call separate, two warmups, seven rotating rounds; raw fixture oracle every execution'};
const stopFile='.local/research/final-return-stop';let stopRequested=false;process.on('SIGINT',()=>{stopRequested=true;});process.on('SIGTERM',()=>{stopRequested=true;});assert(!existsSync(stopFile),'Clear previous owned stop request before starting');
acquire();const pool=await connect(),db=drizzle(pool);
try{
 const productLoad=JSON.parse(readFileSync(`${OUT}/product-load.json`,'utf8'));assert.equal(productLoad.complete,true);result.dataCommit=productLoad.commit;
 const requested=process.argv[process.argv.indexOf('--commit')+1];assert(process.argv.includes('--commit')&&/^[0-9a-f]{7,40}$/.test(requested),'Explicit final implementation commit required');result.head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();result.commit=execFileSync('git',['rev-parse',requested],{encoding:'utf8'}).trim();execFileSync('git',['diff','--exit-code',requested,'HEAD','--','src','package.json','tsconfig.json'],{encoding:'utf8'});
 const actual=(await pool.query('select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attname',[productSchema+'.customers_seal_index'])).rows.map(r=>r.attname);assert.deepEqual(actual,Object.values(getTableColumns(customersSeal)).map(c=>c.name).sort(),'Existing product data requires same column format');
 result.functionInstall=sealed.extraMigrationSql(customersSeal);for(const sql of result.functionInstall)await pool.query(sql);for(const table of ['customers','customers_seal_index'])await pool.query(`analyze ${productSchema}.${table}`);result.installedAt=new Date().toISOString();
 if(existsSync(`${OUT}/measure.json`))copyFileSync(`${OUT}/measure.json`,`${OUT}/measure-prior-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
 result.session=(await pool.query("select pg_backend_pid() pid,current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') parallel_workers,(select datcollate from pg_database where datname=current_database()) locale")).rows[0];
 result.variants=[];result.protocol='Final three paths only; same physical connection; first separate, warmup2, rotating7; every execution checked against raw oracle';save('measure',result);
 const source=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;
 assert.equal(source.length,100000);const data:any[]=source.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));
 const cases:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-task4/cases.json','utf8')).map(({name,node}:Case)=>({name,node}));assert.equal(cases.length,52);
 const email=Array.from(data[0].email);assert(email.length>=8);const prefix=email.slice(0,3).join(''),suffix=email.slice(-3).join(''),middle=email.slice(2,5).join('');assert(!/[%_\\]/.test(prefix+suffix+middle));
 cases.push({name:'like_prefix2plus',node:{field:'email',op:'like',value:prefix+'%'}},{name:'like_suffix2plus',node:{field:'email',op:'like',value:'%'+suffix}},{name:'like_contains2plus',node:{field:'email',op:'like',value:'%'+middle+'%'}});save('cases',cases);
 result.likeBaseline='Three LIKE patterns are exactly equivalent to prefix/suffix/contains in historical task4; every literal run has >=2 Unicode characters; no general historical LIKE capability claimed';
 const pendingPlans:{name:string;mode:string;path:string;queries:Statement[]}[]=[];
 const jobs=[...cases.map(c=>({...c,modes:['count','list300']})),...cases.filter(c=>['exact_common','sub_rare','exact_one'].includes(c.name)).map(c=>({...c,modes:['listAll']}))];
 for(const c of jobs){
  const truth=data.filter(r=>oracle(c.node,r));
  for(const mode of c.modes){
   const expected=mode==='count'?truth.length:mode==='list300'?truth.slice(0,300):truth;
   const paths=['plain','research','product'],lastQueries=new Map<string,Statement[]>();
   const record:any={name:c.name,condition:condition(c.node),node:c.node,mode,matches:truth.length,returned:mode==='count'?1:(expected as any[]).length,cLocaleKoreanLike:koreanLike(c.node),paths,first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{},sql:{}};
   const run=async(path:string)=>{
    if(path==='plain'){const params:unknown[]=[scope],where=plainWhere(c.node,params),rows=(await pool.query(`select ${mode==='count'?'count(*)::int n':`id,${fields.map(f=>f+'_norm as '+f).join(',')}`} from research_u.customers_plain where scope_id=$1 and ${where}${mode==='count'?'':' order by id'}${mode==='list300'?' limit 300':''}`,params)).rows;return mode==='count'?rows[0].n:rows;}
    if(path==='research'){const q=await compile(c.node,mode),rows=(await pool.query(q.text,q.params)).rows;if(mode==='count')return rows[0].n;return Promise.all(rows.map(async r=>({id:r.id,...Object.fromEntries(await Promise.all(fields.map(async f=>[f,await cipher.open(r[f+'_ct'],{modelId:'customers',fieldId:f,keyScopeId:'global',scopeId:scope,rowId:r.id,spec:{type:'text'}},cipher.ring('customers'))])))})));}
    if(mode==='count')return sealed.count(db,customersSeal,{scope,match:m=>match(c.node,m)});
    return (await sealed.findMany(db,customersSeal,{scope,match:(m:any)=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:customers.id,direction:'asc'},...(mode==='list300'?{limit:300}:{})} as any)).items;
   };
   for(let round=-3;round<7;round++){
    const offset=(round+3)%paths.length,order=[...paths.slice(offset),...paths.slice(0,offset)];
    for(const path of order){result.active={name:c.name,mode,path,round};const out=await measured(()=>run(path));
     assert.deepEqual(out.pids,[result.session.pid],`${c.name}/${mode}/${path}: physical connection changed`);
     assert.deepEqual(mode==='count'?out.value:normalizedRows(out.value),expected,`${c.name}/${mode}/${path}: oracle mismatch`);
     assert.equal(out.metric.opens,path==='plain'||mode==='count'?0:record.returned*6,`${path}: authenticated field count`);
     if(round===-3){record.first[path]=out.metric;record.sql[path]=out.queries.map(q=>q.text);}if(round>=0)record.runs[path].push(out.metric);lastQueries.set(path,out.queries);
    }
   }
   for(const path of paths){record.summary[path]=summarize(record.runs[path]);if(path==='plain'||path==='research')continue;const p=record.summary[path],r=record.summary.research;record.summary[path].sqlRatio=p.sqlMs/r.sqlMs;record.summary[path].totalRatio=p.totalMs/r.totalMs;record.summary[path].sqlPass=p.sqlMs<=r.sqlMs*1.1||p.sqlMs-r.sqlMs<=1;record.summary[path].totalPass=p.totalMs<=r.totalMs*1.1||p.totalMs-r.totalMs<=1;record.summary[path].overOneSecond=p.sqlMs>1000||p.totalMs>1000;
    if(!record.summary[path].sqlPass||!record.summary[path].totalPass||record.summary[path].overOneSecond)pendingPlans.push({name:c.name,mode,path,queries:lastQueries.get(path)!});
   }
   result.rows.push(record);save('measure',result);console.log(JSON.stringify({done:result.rows.length,name:c.name,mode,matches:truth.length,sql:Object.fromEntries(paths.map(p=>[p,record.summary[p].sqlMs]))}));
   const milestone=new Map([[29,25],[57,50],[85,75],[113,100]]).get(result.rows.length);if(milestone)execFileSync('rtk',['proxy','orca','orchestration','send','--from','term_2207b6c8-c853-4009-869e-e401f52ddd8e','--to','term_be20cdd8-e2cf-4cef-be5b-574b2d2a0233','--type','status','--subject',`최종 조회 ${milestone}%`,`--body`,`${result.commit.slice(0,7)} 3경로 ${result.rows.length}/113개 완료, 모든 실행 oracle 일치; 측정 락 유지 중입니다.`],{stdio:'inherit'});
  }
  if(stopRequested||existsSync(stopFile)){result.stoppedByCoordinator=true;result.stopReason='Stopped after completing current condition';break;}
 }
 if(!result.stoppedByCoordinator){
 assert.equal(result.rows.length,113);assert.equal(result.rows.filter((r:any)=>r.mode==='count').length,55);assert.equal(result.rows.filter((r:any)=>r.mode==='list300').length,55);
 const plans:any[]=[];for(const pending of pendingPlans){const plansForPath=[];for(const q of pending.queries)plansForPath.push({sql:q.text,plan:(await pool.query('explain (analyze,buffers,format json) '+q.text,q.values)).rows[0]['QUERY PLAN']});plans.push({name:pending.name,mode:pending.mode,path:pending.path,plans:plansForPath});save('plans',plans);}
 assert.equal((await pool.query('select pg_backend_pid() pid')).rows[0].pid,result.session.pid);result.complete=true;
 }result.finished=new Date().toISOString();save('measure',result);
}catch(error){result.errors.push(String(error));result.failure={...result.active,sql:lastSQL,causes:[]};for(let e:any=error;e;e=e.cause)result.failure.causes.push({name:e.name,message:e.message,code:e.code});save('measure',result);throw error;}finally{await pool.end();release();}

import {acquire,release,connect,model,save,archive,fields,sealed,scope,assert,drizzle,normalize,words,readFileSync,condition,match,plainWhere,normalizedRows,measured,summarize,OUT,type Case,type Node} from './common.js';
import {oracle,koreanLike} from './oracle.js';

const h=model('test_r9_verify_main'),paths=['plain','product'] as const;
acquire();const pool=await connect(),db=drizzle(pool);
archive('measure');
const result:any={started:new Date().toISOString(),protocol:'Separate first call, two warmups, seven alternating rounds; every result asserted against independently normalized original fixture',rows:[],errors:[],complete:false};
try{
 const load=JSON.parse(readFileSync(`${OUT}/load.json`,'utf8'));assert.equal(load.complete,true);assert.equal(load.loaded,100000);
 result.commit=JSON.parse(readFileSync(`${OUT}/install.json`,'utf8')).commit;
 result.sourceHash=load.sourceHash;result.session=(await pool.query("select pg_backend_pid() pid,current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') parallel_workers,(select datcollate from pg_database where datname=current_database()) locale")).rows[0];
 const source=(await pool.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;
 assert.equal(source.length,100000);
 const data=source.map(r=>({id:r.id,norm:Object.fromEntries(fields.map(f=>[f,normalize(r[f])])),word:Object.fromEntries(fields.map(f=>[f,words(r[f])]))}));
 const cases:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-task4/cases.json','utf8'));assert.equal(cases.length,52);
 for(const c of cases)if(c.respectWords){assert('field'in c.node);c.node={...c.node,respectWords:true};}
 const email=Array.from(data[0].norm.email);assert(email.length>6);const prefix=email.slice(0,2).join('');assert(!/[%_\\]/.test(email.join('')));
 cases.push({name:'like_prefix',node:{field:'email',op:'like',value:prefix+'%'}},{name:'like_underscore',node:{field:'email',op:'like',value:prefix+'_'+email.slice(3,5).join('')+'%'}},{name:'like_singleton',node:{field:'email',op:'like',value:prefix+'%'+email.at(-1)}},{name:'respect_words',node:{field:'memo',op:'contains',value:'서비스 상담',respectWords:true}});
 save('cases',cases);
 for(const c of cases){
  const matching=data.filter(r=>oracle(c.node,r)),expectedRows=matching.map(r=>({id:r.id,...r.norm}));
  let whereNode=c.node;
  // The old plaintext table is compact. Prove dataset-specific equivalence before
  // using its indexed compact predicate for the words timing baseline.
  if('respectWords'in c.node&&c.node.respectWords){
   const compactNode={...(c.node as any),respectWords:false};
   const compactIds=data.filter(r=>oracle(compactNode,r)).map(r=>r.id);
   assert.deepEqual(compactIds,matching.map(r=>r.id),'Words plaintext timing needs another oracle plan when compact results differ');whereNode=compactNode;
   result.wordsBaselines??=[];const evidence={name:c.name,equivalentIds:matching.length,meaning:'For this fixed fixture only, compact predicate yields exactly the same IDs as raw normalized-words oracle; no general semantic equivalence claimed'};result.wordsBaselines.push(evidence);if(c.name==='respect_words')result.wordsBaseline=evidence;
  }
  const modes=['count','list300',...(['exact_common','sub_rare','exact_one'].includes(c.name)?['listAll']:[])];
  for(const mode of modes){
   const expected=mode==='count'?matching.length:mode==='list300'?expectedRows.slice(0,300):expectedRows;
   const params:unknown[]=[scope],where=plainWhere(whereNode,params);
   const text=`select ${mode==='count'?'count(*)::text n':`id,${fields.map(f=>`${f}_norm as ${f}`).join(',')}`} from research_u.customers_plain where scope_id=$1 and ${where}${mode==='count'?'':' order by id'}${mode==='list300'?' limit 300':''}`;
   const run=async(path:typeof paths[number])=>{
    if(path==='plain'){const rows=(await pool.query(text,params)).rows;return mode==='count'?Number(rows[0].n):rows;}
    if(mode==='count')return sealed.count(db,h.seal,{scope,match:m=>match(c.node,m)});
    return (await sealed.findMany(db,h.seal,{scope,match:m=>match(c.node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),orderBy:{column:h.table.id,direction:'asc'},...(mode==='list300'?{limit:300}:{})} as any)).items;
   };
   const record:any={name:c.name,node:c.node,condition:condition(c.node),mode,matches:matching.length,returned:mode==='count'?1:(expected as any[]).length,first:{},runs:{plain:[],product:[]},summary:{},sql:{},cLocaleKoreanLike:koreanLike(c.node)};
   for(let round=-3;round<7;round++)for(const path of (round+3)%2?[...paths].reverse():paths){
    const out=await measured(()=>run(path));assert.deepEqual(out.pids,[result.session.pid],`physical session changed: ${c.name}/${mode}`);
    const value=mode==='count'?out.value:normalizedRows(out.value);assert.deepEqual(value,expected,`${c.name}/${mode}/${path} original-fixture oracle mismatch`);
    if(path==='product'){assert.equal(out.metric.opens,mode==='count'?0:record.returned*6);if(mode==='count')assert.equal(out.metric.sqlCalls,1);}
    if(round===-3){record.first[path]=out.metric;record.sql[path]=out.sql;}if(round>=0)record.runs[path].push(out.metric);
   }
   for(const path of paths)record.summary[path]=summarize(record.runs[path]);record.summary.ratio=record.summary.product.totalMs/record.summary.plain.totalMs;
   result.rows.push(record);save('measure',result);console.log(JSON.stringify({done:result.rows.length,name:c.name,mode,matches:matching.length,summary:record.summary}));
  }
 }
 assert.equal(result.rows.filter((r:any)=>r.mode==='count').length,56);assert.equal(result.rows.filter((r:any)=>r.mode==='list300').length,56);assert.equal(result.rows.filter((r:any)=>r.mode==='listAll').length,3);
 result.complete=true;result.finished=new Date().toISOString();save('measure',result);
}catch(error){result.errors.push({at:new Date().toISOString(),message:String(error)});save('measure',result);throw error;}finally{await pool.end();release();}

/** Research task4: isolated six-field occurrence stamps, coarse company exact tokens. */
import assert from 'node:assert/strict';
import {createHmac,hash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {Pool,Client} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {createSealer,Sealer} from 'sealql';
import {assertDisposable} from '../../test/disposable.js';
import {sealed,customersSeal} from '../verify-native/schema.js';
import {fields,condition,plainWhere,type Node,type Case} from '../verify-native/r8-cases.js';
import {B_SCOPE,normalize,verification} from '../research-unified/b-codec.js';
import {candidate,sourceTokenColumn} from '../research-unified/b-product.js';
import {BASE_CASES,CASE_GROUPS} from './cases.js';

const S='research_u',OUT='bench/results/2026-09-29-task4',LOCK='.local/research/measure.lock',owner=`m1-astra-task4 ${process.pid}`;
const phase=process.argv[2]??'load';assert(['load','measure','metadata','smoke','plans'].includes(phase));
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});
const db=drizzle(pool),bodySealer=createSealer({key:Buffer.alloc(32,93)});
const paths=['plain','A','B','improved','final'] as const;type Path=typeof paths[number];
const tables={B:'b_customers_tags',improved:'pb_4_improved',final:'pb_4_final'};
const deadline=()=>assert(Date.now()<Date.parse('2026-09-28T22:48:00Z'),'task4 completion deadline');
function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
function positionalKey(field:string,piece:string){return createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers',field,'pb1b-w2-n2',piece].join('\0')).digest();}
function encode(field:string,text:string,cache:Map<string,Buffer>){
 const chars=Array.from(normalize(text)),salt=randomBytes(16),seen=new Map<string,number>(),pairs:{s:bigint;p:number}[]=[];
 for(let p=0;p+2<=chars.length;p++){const piece=chars.slice(p,p+2).join(''),cacheId=field+'\0'+piece;let k=cache.get(cacheId);if(!k){k=positionalKey(field,piece);cache.set(cacheId,k);}const occurrence=(seen.get(piece)??0)+1;seen.set(piece,occurrence);const b=Buffer.alloc(4);b.writeUInt32BE(occurrence);pairs.push({s:hash('sha256',Buffer.concat([k,salt,b]),'buffer').readBigInt64BE(),p});}
 pairs.sort((a,b)=>a.s<b.s?-1:a.s>b.s?1:0);for(let i=1;i<pairs.length;i++)assert.notEqual(pairs[i-1].s,pairs[i].s,'within-field stamp collision');
 return {salt:salt.toString('hex'),n:chars.length,s:pairs.map(x=>String(x.s)),p:pairs.map(x=>x.p)};
}
const FUNCTION_SQL=`CREATE FUNCTION research_u.pb_4_match(ks bytea[],offs int[],qlen int,n int,salt bytea,stamps bigint[],positions int[],affix int) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
 DECLARE first_i int:=1; i int; wi int; idx int; p int; target_p int; got_p int; tag bigint; ok bool;
 BEGIN
  IF n<qlen THEN RETURN false;END IF;
  LOOP
   tag:=(('x'||encode(substr(sha256(ks[1]||salt||int4send(first_i)),1,8),'hex'))::bit(64)::bigint);
   idx:=array_position(stamps,tag);IF idx IS NULL THEN RETURN false;END IF;
   p:=positions[idx];IF p>n-qlen THEN RETURN false;END IF;
   IF affix=1 AND p>0 THEN RETURN false;END IF;
   IF affix=2 AND p<n-qlen THEN first_i:=first_i+1;CONTINUE;END IF;
   ok:=true;
   IF cardinality(ks)>1 THEN FOR wi IN 2..cardinality(ks) LOOP
    target_p:=p+offs[wi];i:=1;
    LOOP
     tag:=(('x'||encode(substr(sha256(ks[wi]||salt||int4send(i)),1,8),'hex'))::bit(64)::bigint);
     idx:=array_position(stamps,tag);IF idx IS NULL THEN ok:=false;EXIT;END IF;
     got_p:=positions[idx];IF got_p>=target_p THEN ok:=got_p=target_p;EXIT;END IF;i:=i+1;
    END LOOP;
    IF NOT ok THEN EXIT;END IF;
   END LOOP;END IF;
   IF ok THEN RETURN true;END IF;first_i:=first_i+1;
  END LOOP;
 END $fn$`;
async function acquire(){writeFileSync(LOCK,owner+' '+new Date().toISOString(),{flag:'wx'});}
async function load(){
 for(const t of ['pb_4_improved','pb_4_final'])assert.equal((await pool.query('SELECT to_regclass($1) r',[S+'.'+t])).rows[0].r,null,'existing table must not be overwritten');
 assert.equal((await pool.query("SELECT to_regprocedure('research_u.pb_4_match(bytea[],integer[],integer,integer,bytea,bigint[],integer[],integer)') r")).rows[0].r,null);
 await pool.query(FUNCTION_SQL);
 await pool.query(`CREATE TABLE ${S}.pb_4_improved(id uuid PRIMARY KEY,scope_id uuid NOT NULL,${fields.flatMap(f=>[`ce_${f} bigint[] NOT NULL`,`cs_${f} bigint[] NOT NULL`,`salt_${f} bytea NOT NULL`,`jx_${f} bigint NOT NULL`,`psalt_${f} bytea NOT NULL`,`n_${f} int NOT NULL`,`stamps_${f} bigint[] NOT NULL`,`positions_${f} int[] NOT NULL`]).join(',')})`);
 const started=performance.now(),report:any={started:new Date().toISOString(),rows:0,encodeMs:0,insertMs:0,source:'research_u.customers_plain + b_customers_tags',width:2,fields};let last:string|undefined;
 while(report.rows<100000){deadline();const rows=(await pool.query(`SELECT id,scope_id,${fields.map(f=>f+'_norm').join(',')} FROM ${S}.customers_plain WHERE scope_id=$1${last?' AND id>$2::uuid':''} ORDER BY id LIMIT 500`,last?[B_SCOPE,last]:[B_SCOPE])).rows;assert(rows.length);const cache=new Map<string,Buffer>(),t=performance.now();const values=rows.map(r=>({id:r.id,v:Object.fromEntries(fields.map(f=>[f,encode(f,r[f+'_norm'],cache)]))}));report.encodeMs+=performance.now()-t;
  const ti=performance.now();await pool.query(`INSERT INTO ${S}.pb_4_improved SELECT b.id,b.scope_id,${fields.flatMap(f=>[`b.ce_${f}`,`b.cs_${f}`,`b.salt_${f}`,`b.jx_${f}`,`decode(x->'v'->'${f}'->>'salt','hex')`,`(x->'v'->'${f}'->>'n')::int`,`ARRAY(SELECT jsonb_array_elements_text(x->'v'->'${f}'->'s')::bigint)`,`ARRAY(SELECT jsonb_array_elements_text(x->'v'->'${f}'->'p')::int)`]).join(',')} FROM jsonb_array_elements($1::jsonb) x JOIN ${S}.b_customers_tags b ON b.id=(x->>'id')::uuid AND b.scope_id=$2`,[JSON.stringify(values),B_SCOPE]);report.insertMs+=performance.now()-ti;
  report.rows+=rows.length;last=rows.at(-1).id;report.loadMs=performance.now()-started;save('load',report);if(report.rows%5000===0)console.log('load',report.rows,Math.round(report.loadMs),new Date().toISOString());
 }
 const tf=performance.now();await pool.query(`CREATE TABLE ${S}.pb_4_final AS SELECT id,scope_id,${fields.flatMap(f=>[f==='company'?`ARRAY[((ce_company[1]>>30)&3)::bigint] ce_company`:`ce_${f}`,`cs_${f}`,`salt_${f}`,`jx_${f}`,`psalt_${f}`,`n_${f}`,`stamps_${f}`,`positions_${f}`]).join(',')} FROM ${S}.pb_4_improved`);await pool.query(`ALTER TABLE ${S}.pb_4_final ADD PRIMARY KEY(id)`);report.finalCopyMs=performance.now()-tf;
 report.indexMs={};for(const table of ['pb_4_improved','pb_4_final']){const t=performance.now();await pool.query(`CREATE UNIQUE INDEX ${table}_scope_row ON ${S}.${table}(scope_id,id)`);for(const f of fields)await pool.query(`CREATE INDEX ${table}_${f}_exact ON ${S}.${table}(scope_id,(ce_${f}[1]),id)`);await pool.query(`CREATE INDEX ${table}_gin ON ${S}.${table} USING gin(${fields.map(f=>'cs_'+f).join(',')})`);await pool.query(`ANALYZE ${S}.${table}`);report.indexMs[table]=performance.now()-t;}
 report.finished=new Date().toISOString();report.totalMs=performance.now()-started;save('load',report);
}
async function clauses(node:Node,path:'B'|'improved'|'final',params:unknown[],verify=true):Promise<{cand:string;full:string}>{
 if('all'in node||'any'in node){const op='all'in node?' AND ':' OR ',items='all'in node?node.all:node.any,out=[];for(const c of items)out.push(await clauses(c,path,params,verify));return {cand:'('+out.map(x=>x.cand).join(op)+')',full:'('+out.map(x=>x.full).join(op)+')'};}
 const cand=await candidate(node,'customers',params,'j');
 if(path==='final'&&node.field==='company'&&node.op==='eq'){const original=BigInt(String(params.at(-1)));params[params.length-1]=String((original>>30n)&3n);}
 if(!verify)return {cand,full:cand};
 let judge:string;
 if(path==='B'||node.op==='eq')judge=verification(node,'customers',params,'j');
 else{
  const chars=Array.from(normalize(node.value));assert(chars.length>=2);const offsets:number[]=[];for(let i=0;i+2<=chars.length;i+=2)offsets.push(i);if(offsets.at(-1)!==chars.length-2)offsets.push(chars.length-2);
  const ks=offsets.map(i=>{params.push(positionalKey(node.field,chars.slice(i,i+2).join('')));return `$${params.length}::bytea`;});const f=node.field,affix=node.op==='startsWith'?1:node.op==='endsWith'?2:0;
  judge=`${S}.pb_4_match(ARRAY[${ks.join(',')}],ARRAY[${offsets.join(',')}],${chars.length},j.n_${f},j.psalt_${f},j.stamps_${f},j.positions_${f},${affix})`;
 }
 return {cand,full:`(${cand} AND ${judge})`};
}
async function compile(path:Exclude<Path,'A'>,node:Node,mode:'count'|'list',onlyCandidates=false){
 const params:unknown[]=[B_SCOPE];if(path==='plain'){const where=plainWhere(node,params);return {text:`SELECT ${mode==='count'?'count(*)::int n':`id,${fields.map(f=>f+'_norm '+f).join(',')}`} FROM ${S}.customers_plain WHERE scope_id=$1 AND ${where}${mode==='list'?' ORDER BY id LIMIT 300':''}`,params};}
 const {cand,full}=await clauses(node,path,params,!onlyCandidates),table=`${S}.${tables[path]}`;
 if(mode==='count'||onlyCandidates)return {text:`SELECT count(*)::int n FROM ${table} j WHERE j.scope_id=$1 AND ${onlyCandidates?cand:full}`,params};
 return {text:`WITH matched AS MATERIALIZED (SELECT j.id FROM (SELECT j.* FROM ${table} j WHERE j.scope_id=$1 AND ${cand} ORDER BY j.id OFFSET 0) j WHERE ${full} ORDER BY j.id LIMIT 300) SELECT p.id,${fields.map(f=>`p.${f}_ct`).join(',')} FROM matched m JOIN native_verify_main.customers p ON p.id=m.id AND p.scope_id=$1 ORDER BY p.id`,params};
}
function matchOf(n:Node,m:any):any{if('all'in n)return m.and(...n.all.map(c=>matchOf(c,m)));if('any'in n)return m.or(...n.any.map(c=>matchOf(c,m)));return m[n.field][n.op](n.value);}
function normalizedRows(rows:any[]){return rows.map(r=>({id:String(r.id),...Object.fromEntries(fields.map(f=>[f,normalize(String(r[f]))]))}));}
async function run(path:Path,node:Node,mode:'count'|'list'){
 if(path==='A'){
  if(mode==='count')return Number(await sealed.count(db,customersSeal,{scope:B_SCOPE,match:(m:any)=>matchOf(node,m)} as any));
  const r:any=await sealed.findMany(db,customersSeal,{scope:B_SCOPE,match:(m:any)=>matchOf(node,m),columns:Object.fromEntries(fields.map(f=>[f,true])),limit:300} as any);return normalizedRows(r.items);
 }
 const q=await compile(path,node,mode),rows=(await pool.query(q.text,q.params)).rows;if(mode==='count')return Number(rows[0].n);if(path==='plain')return rows;
 return Promise.all(rows.map(async r=>({id:r.id,...Object.fromEntries(await Promise.all(fields.map(async f=>[f,normalize(String(await bodySealer.open(r[f+'_ct'],{modelId:'customers',fieldId:f,keyScopeId:'global',scopeId:B_SCOPE,rowId:r.id,spec:{type:'text'}},bodySealer.ring('customers'))))])))})));
}
type Event={s:number;e:number;rows:number;text:string};let events:Event[]|null=null,opens=0;
const originalQuery=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){const s=performance.now(),text=typeof args[0]==='string'?args[0]:args[0]?.text??'';let recorded=false;const record=(r:any)=>{if(!recorded){recorded=true;events?.push({s,e:performance.now(),rows:r?.rows?.length??0,text});}return r;};const ci=args.findIndex(a=>typeof a==='function');if(ci>=0){const cb=args[ci];args[ci]=(err:any,r:any)=>{record(r);cb(err,r);};}const r=(originalQuery as any).apply(this,args);return ci<0&&r?.then?r.then(record):r;};
const originalOpen=Sealer.prototype.open;Sealer.prototype.open=function(...args:Parameters<Sealer['open']>){opens++;return originalOpen.apply(this,args);};
async function measured(fn:()=>Promise<any>){events=[];opens=0;const start=performance.now();try{const value=await fn(),end=performance.now(),ev:Event[]=[...events].sort((a,b)=>a.s-b.s);let wall=0,right=-Infinity;for(const e of ev){wall+=Math.max(0,e.e-Math.max(e.s,right));right=Math.max(right,e.e);}const pre=ev.length?ev[0].s-start:end-start,post=ev.length?end-right:0;return {value,metric:{pre,db:ev.reduce((n,e)=>n+e.e-e.s,0),between:Math.max(0,end-start-pre-wall-post),post,total:end-start,sql:ev.length,appRows:ev.reduce((n,e)=>n+e.rows,0),decrypts:opens},sqlTexts:ev.map(e=>e.text)};}finally{events=null;}}
async function metadata(){
 const names=[['research_u','customers_plain'],['native_verify_main','customers'],['native_verify_main','customers_seal_index'],['research_u','b_customers_tags'],['research_u','pb_4_improved'],['research_u','pb_4_final']];const result:any={at:new Date().toISOString(),tables:[],session:(await pool.query("SELECT pg_backend_pid() pid,version() version,(SELECT datcollate FROM pg_database WHERE datname=current_database()) lc_collate,current_setting('work_mem') work_mem,current_setting('max_parallel_workers_per_gather') workers")).rows[0]};
 for(const [schema,table] of names){const full=schema+'.'+table;if(!(await pool.query('SELECT to_regclass($1) r',[full])).rows[0].r)continue;const scopes=(await pool.query(`SELECT scope_id,count(*)::int rows FROM ${full} GROUP BY scope_id ORDER BY scope_id`)).rows,sizes=(await pool.query('SELECT pg_relation_size($1)::text heap,pg_indexes_size($1)::text indexes,pg_total_relation_size($1)::text total',[full])).rows[0],indexes=(await pool.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname',[schema,table])).rows;result.tables.push({schema,table,rows:scopes.reduce((n,r)=>n+r.rows,0),scopeCount:scopes.length,scopes,sizes,indexes});}
 const mismatch=(await pool.query(`SELECT count(*)::int n FROM ((SELECT id,scope_id FROM ${S}.customers_plain EXCEPT SELECT id,scope_id FROM native_verify_main.customers) UNION ALL (SELECT id,scope_id FROM native_verify_main.customers EXCEPT SELECT id,scope_id FROM ${S}.customers_plain)) x`)).rows[0].n;assert.equal(mismatch,0);result.identityMismatch=mismatch;save('metadata',result);return result;
}
async function prepareCases(){
 if(existsSync(OUT+'/cases.json'))return JSON.parse(readFileSync(OUT+'/cases.json','utf8')) as Case[];
 const distribution=(await pool.query(`SELECT ce_company[1] bucket,count(*)::int rows FROM ${S}.pb_4_final GROUP BY ce_company[1] ORDER BY rows DESC`)).rows;const target=String(distribution[0].bucket);let chosen:any;
 for(let i=0;i<10000;i++){const value='없는회사'+i,params:unknown[]=[];await candidate({field:'company',op:'eq',value},'customers',params);const token=BigInt(String(params[0]));if(String((token>>30n)&3n)!==target)continue;const zero=(await pool.query(`SELECT count(*)::int n FROM ${S}.customers_plain WHERE scope_id=$1 AND company_norm=$2`,[B_SCOPE,normalize(value)])).rows[0].n;if(zero===0){chosen={value,token:String(token),bucket:target,candidates:distribution[0].rows,plain:0};break;}}
 assert(chosen);save('adversarial',{...chosen,distribution});
 const first=(await pool.query(`SELECT ${fields.map(f=>f+'_norm').join(',')} FROM ${S}.customers_plain WHERE scope_id=$1 ORDER BY id LIMIT 1`,[B_SCOPE])).rows[0];
 const cases:Case[]=[{name:'coarse_company_zero',node:{field:'company',op:'eq',value:chosen.value}},
 {name:'coarse_rare_and_memo',node:{all:[{field:'company',op:'eq',value:'서울서비스 중앙지사'},{field:'memo',op:'contains',value:'서비스'}]}},
 {name:'coarse_zero_and_memo',node:{all:[{field:'company',op:'eq',value:chosen.value},{field:'memo',op:'contains',value:'서비스'}]}},...BASE_CASES];
 for(const field of fields)for(const op of ['startsWith','endsWith'] as const){const chars=Array.from(String(first[field+'_norm']));assert(chars.length>=2);cases.push({name:`affix_${op}_${field}`,node:{field,op,value:(op==='startsWith'?chars.slice(0,3):chars.slice(-3)).join('')}});}
 save('cases',cases);save('case-groups',{base:Object.fromEntries(Object.entries(CASE_GROUPS).map(([k,v])=>[k,v.map(c=>c.name)])),extras:cases.filter(c=>!BASE_CASES.some(b=>b.name===c.name)).map(c=>c.name)});return cases;
}
async function candidates(node:Node){const out:any={};for(const path of ['B','improved','final'] as const){const q=await compile(path,node,'count',true);out[path]=Number((await pool.query(q.text,q.params)).rows[0].n);}const params:unknown[]=[B_SCOPE];let where=await candidate(node,'customers',params,'j');for(const f of fields){where=where.replaceAll(`j.ce_${f}`,`j.${sourceTokenColumn('customers',f,true)}`).replaceAll(`j.cs_${f}`,`j.${sourceTokenColumn('customers',f,false)}`);}out.A=Number((await pool.query(`SELECT count(*)::int n FROM native_verify_main.customers_seal_index j WHERE j.scope_id=$1 AND ${where}`,params)).rows[0].n);return out;}
const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
async function measure(smoke=false){
 const reviewPath='.local/research/task4-review-m1-fable.md';const review=existsSync(reviewPath)?readFileSync(reviewPath,'utf8'):'User explicitly waived premeasurement review wait; coordinator reviews script directly.';
 const meta=await metadata(),cases=await prepareCases(),result:any=!smoke&&existsSync(OUT+'/measure.json')?JSON.parse(readFileSync(OUT+'/measure.json','utf8')):{started:new Date().toISOString(),session:meta.session,review,paths,rows:[],errors:[],plans:[],semantics:'normalized substring (spaces removed), normalized six-field projection; shared native row-bound ciphertext'};
 result.segments??=[{pid:result.session.pid,started:result.started,A:{warmups:2,repeats:7}}];if(!result.segments.some((s:any)=>s.pid===meta.session.pid))result.segments.push({pid:meta.session.pid,started:new Date().toISOString(),A:{warmups:1,repeats:3},otherPaths:{warmups:2,repeats:7}});save(smoke?'smoke':'measure',result);
 const selected=smoke?cases.filter(c=>['coarse_company_zero','starts','ends','sub45','exact_one'].includes(c.name)):cases;
 for(const mode of ['count','list'] as const)for(const c of selected){const previous=result.rows.find((r:any)=>r.name===c.name&&r.mode===mode);if(previous&&paths.every(p=>previous.summary[p]||previous.failed[p])){console.log('resume skip',c.name,mode);continue;}if(previous)result.rows.splice(result.rows.indexOf(previous),1);deadline();const truth=await run('plain',c.node,'count'),truthList=mode==='list'?await run('plain',c.node,'list'):[],cand=await candidates(c.node);
  {const expected=mode==='count'?truth:truthList,row:any={name:c.name,condition:condition(c.node),node:c.node,mode,session:meta.session.pid,protocol:{A:{warmups:1,repeats:3},others:{warmups:2,repeats:7}},targetRows:100000,matches:truth,returned:mode==='count'?1:(truthList as any[]).length,candidates:{plain:truth,...cand},first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),failed:{},summary:{}};result.rows.push(row);
   for(let round=-3;round<(smoke?-2:7);round++){const offset=(round+3)%paths.length;for(const path of [...paths.slice(offset),...paths.slice(0,offset)]){if(row.failed[path]||path==='A'&&(round===-1||round>=3))continue;deadline();try{const out=await measured(()=>run(path,c.node,mode));assert.deepEqual(out.value,expected,'count or ordered IDs/normalized six-field projection mismatch');if(round===-3)row.first[path]=out.metric;if(round>=0)row.runs[path].push(out.metric);row.lastSqlTexts=undefined;}catch(e:any){row.failed[path]={at:new Date().toISOString(),round,message:e.message.slice(0,700)};result.errors.push({name:c.name,mode,path,...row.failed[path]});console.error('FAILED',c.name,mode,path,e.message.slice(0,180));}}}
   for(const path of paths)if(!row.failed[path]&&row.runs[path].length===(path==='A'?3:7)){row.summary[path]=Object.fromEntries(Object.keys(row.runs[path][0]).map(k=>[k,median(row.runs[path].map((v:any)=>v[k]))]));row.summary[path].ratio=row.summary[path].total/row.summary.plain.total;row.summary[path].sqlRatio=row.summary[path].db/row.summary.plain.db;}
   console.log(c.name,mode,'truth',truth,JSON.stringify(Object.fromEntries(Object.entries(row.summary).map(([p,v]:any)=>[p,Math.round(v.total)]))),new Date().toISOString());save(smoke?'smoke':'measure',result);
  }
 }
 if(!smoke){const slow=result.rows.filter((r:any)=>r.summary.final).sort((a:any,b:any)=>b.summary.final.db-a.summary.final.db).slice(0,5);for(const row of slow){deadline();const q=await compile('final',row.node,row.mode);result.plans.push({name:row.name,mode:row.mode,path:'final',sql:q.text,plan:(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.text,q.params)).rows[0]['QUERY PLAN']});}}
 assert.equal((await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid,meta.session.pid);result.finished=new Date().toISOString();save(smoke?'smoke':'measure',result);
}
async function partialPlans(){
 const result=JSON.parse(readFileSync(OUT+'/measure.json','utf8'));assert.equal(result.plans.length,0,'do not repeat collected plans');
 const pid=(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 for(const row of result.rows.filter((r:any)=>r.summary.final).sort((a:any,b:any)=>b.summary.final.db-a.summary.final.db).slice(0,5)){
  assert(Date.now()<Date.parse('2026-09-28T22:11:55Z'),'plans deadline');const q=await compile('final',row.node,row.mode);result.plans.push({name:row.name,mode:row.mode,path:'final',sql:q.text,session:pid,partialCompletedCasesOnly:true,plan:(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.text,q.params)).rows[0]['QUERY PLAN']});save('measure',result);
 }
}
let held=false;
try{await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);await acquire();held=true;console.log('lock',owner,new Date().toISOString());if(phase==='load')await load();else if(phase==='metadata')await metadata();else if(phase==='plans')await partialPlans();else await measure(phase==='smoke');}
catch(e:any){save(phase+'-error',{at:new Date().toISOString(),message:e.message,stack:e.stack});throw e;}
finally{if(held&&existsSync(LOCK)&&readFileSync(LOCK,'utf8').startsWith(owner))unlinkSync(LOCK);await pool.end();}

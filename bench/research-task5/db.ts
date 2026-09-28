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


const S='research_u',OUT='bench/results/2026-09-29-task5',LOCK='.local/research/measure.lock',owner=`m1-astra-task5 ${process.pid}`;
const phase=process.argv[2]??'load';assert(['load','measure','metadata','smoke','plans'].includes(phase));
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});
const db=drizzle(pool),bodySealer=createSealer({key:Buffer.alloc(32,93)});
const paths=['plain','final','coarse3','direct'] as const;type Path=typeof paths[number];
const tables={final:'pb_4_final',coarse3:'pb_5_coarse3',direct:'pb_4_final'};
const deadline=()=>assert(Date.now()<Date.parse('2026-09-28T23:09:00Z'),'task4 completion deadline');
function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
function positionalKey(field:string,piece:string){return createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers',field,'pb1b-w2-n2',piece].join('\0')).digest();}
async function acquire(){writeFileSync(LOCK,owner+' '+new Date().toISOString(),{flag:'wx'});}
async function clauses(node:Node,path:'final'|'coarse3'|'direct',params:unknown[],verify=true):Promise<{cand:string;full:string}>{
 if('all'in node||'any'in node){const op='all'in node?' AND ':' OR ',items='all'in node?node.all:node.any,out=[];for(const c of items)out.push(await clauses(c,path,params,verify));return {cand:'('+out.map(x=>x.cand).join(op)+')',full:'('+out.map(x=>x.full).join(op)+')'};}
 const cand=await candidate(node,'customers',params,'j');
 if(node.field==='company'&&node.op==='eq'){const original=BigInt(String(params.at(-1)));params[params.length-1]=String(path==='coarse3'?(original>>29n)&7n:(original>>30n)&3n);}
 if(!verify)return {cand,full:cand};
 let judge:string;
 if(node.op==='eq')judge=verification(node,'customers',params,'j');
 else{
  const chars=Array.from(normalize(node.value));assert(chars.length>=2);const offsets:number[]=[];for(let i=0;i+2<=chars.length;i+=2)offsets.push(i);if(offsets.at(-1)!==chars.length-2)offsets.push(chars.length-2);
  const ks=offsets.map(i=>{params.push(positionalKey(node.field,chars.slice(i,i+2).join('')));return `$${params.length}::bytea`;});const f=node.field,affix=node.op==='startsWith'?1:node.op==='endsWith'?2:0;
  judge=`${S}.${path==='direct'?'pb_5_match_direct':'pb_4_match'}(ARRAY[${ks.join(',')}],ARRAY[${offsets.join(',')}],${chars.length},j.n_${f},j.psalt_${f},j.stamps_${f},j.positions_${f},${affix})`;
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
 const q=await compile(path,node,mode),rows=(await pool.query(q.text,q.params)).rows;if(mode==='count')return Number(rows[0].n);if(path==='plain')return rows;
 return Promise.all(rows.map(async r=>({id:r.id,...Object.fromEntries(await Promise.all(fields.map(async f=>[f,normalize(String(await bodySealer.open(r[f+'_ct'],{modelId:'customers',fieldId:f,keyScopeId:'global',scopeId:B_SCOPE,rowId:r.id,spec:{type:'text'}},bodySealer.ring('customers'))))])))})));
}
type Event={s:number;e:number;rows:number;text:string;pid:number};let events:Event[]|null=null,opens=0;
const originalQuery=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){const s=performance.now(),text=typeof args[0]==='string'?args[0]:args[0]?.text??'';let recorded=false;const record=(r:any)=>{if(!recorded){recorded=true;events?.push({s,e:performance.now(),rows:r?.rows?.length??0,text,pid:this.processID});}return r;};const ci=args.findIndex(a=>typeof a==='function');if(ci>=0){const cb=args[ci];args[ci]=(err:any,r:any)=>{record(r);cb(err,r);};}const r=(originalQuery as any).apply(this,args);return ci<0&&r?.then?r.then(record):r;};
const originalOpen=Sealer.prototype.open;Sealer.prototype.open=function(...args:Parameters<Sealer['open']>){opens++;return originalOpen.apply(this,args);};
async function measured(fn:()=>Promise<any>){events=[];opens=0;const start=performance.now();try{const value=await fn(),end=performance.now(),ev:Event[]=[...events].sort((a,b)=>a.s-b.s);let wall=0,right=-Infinity;for(const e of ev){wall+=Math.max(0,e.e-Math.max(e.s,right));right=Math.max(right,e.e);}const pre=ev.length?ev[0].s-start:end-start,post=ev.length?end-right:0;return {value,metric:{pre,db:ev.reduce((n,e)=>n+e.e-e.s,0),between:Math.max(0,end-start-pre-wall-post),post,total:end-start,sql:ev.length,appRows:ev.reduce((n,e)=>n+e.rows,0),decrypts:opens},sqlTexts:ev.map(e=>e.text),pids:[...new Set(ev.map(e=>e.pid))]};}finally{events=null;}}
const DIRECT_SQL=`CREATE FUNCTION research_u.pb_5_match_direct(ks bytea[],offs int[],qlen int,n int,salt bytea,stamps bigint[],positions int[],affix int) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
 DECLARE p int; target_p int; target_tag bigint; tag bigint; wi int; i int; idx int; found bool;
 BEGIN
 IF affix=0 THEN RETURN research_u.pb_4_match(ks,offs,qlen,n,salt,stamps,positions,affix);END IF;
 IF n<qlen THEN RETURN false;END IF;
 p:=CASE WHEN affix=1 THEN 0 ELSE n-qlen END;
 FOR wi IN 1..cardinality(ks) LOOP
  target_p:=p+offs[wi];idx:=array_position(positions,target_p);IF idx IS NULL THEN RETURN false;END IF;
  target_tag:=stamps[idx];found:=false;
  FOR i IN 1..target_p+1 LOOP
   tag:=(('x'||encode(substr(sha256(ks[wi]||salt||int4send(i)),1,8),'hex'))::bit(64)::bigint);
   IF tag=target_tag THEN found:=true;EXIT;END IF;
   IF i=target_p+1 THEN RETURN false;END IF;
   idx:=array_position(stamps,tag);IF idx IS NULL OR positions[idx]>target_p THEN RETURN false;END IF;
  END LOOP;
  IF NOT found THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
 END $fn$`;
async function load(){
 assert.equal((await pool.query("SELECT to_regclass('research_u.pb_5_coarse3') r")).rows[0].r,null);
 assert.equal((await pool.query("SELECT to_regprocedure('research_u.pb_5_match_direct(bytea[],integer[],integer,integer,bytea,bigint[],integer[],integer)') r")).rows[0].r,null);
 const t=performance.now();await pool.query(DIRECT_SQL);
 await pool.query(`CREATE TABLE ${S}.pb_5_coarse3 AS SELECT id,scope_id,${fields.flatMap(f=>[f==='company'?`ARRAY[((ce_company[1]>>29)&7)::bigint] ce_company`:`ce_${f}`,`cs_${f}`,`salt_${f}`,`jx_${f}`,`psalt_${f}`,`n_${f}`,`stamps_${f}`,`positions_${f}`]).join(',')} FROM ${S}.pb_4_improved`);
 await pool.query(`ALTER TABLE ${S}.pb_5_coarse3 ADD PRIMARY KEY(id)`);
 await pool.query(`CREATE UNIQUE INDEX pb_5_coarse3_scope_row ON ${S}.pb_5_coarse3(scope_id,id)`);
 for(const f of fields)await pool.query(`CREATE INDEX pb_5_coarse3_${f}_exact ON ${S}.pb_5_coarse3(scope_id,(ce_${f}[1]),id)`);
 await pool.query(`CREATE INDEX pb_5_coarse3_gin ON ${S}.pb_5_coarse3 USING gin(${fields.map(f=>'cs_'+f).join(',')})`);
 await pool.query(`ANALYZE ${S}.pb_5_coarse3`);save('load',{at:new Date().toISOString(),totalMs:performance.now()-t});
}
async function prepare(){
 const all:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-task4/cases.json','utf8'));
 const distribution=(await pool.query(`SELECT ce_company[1] bucket,count(*)::int rows FROM ${S}.pb_5_coarse3 GROUP BY ce_company[1] ORDER BY rows DESC,bucket`)).rows;
 let chosen:any;for(let i=0;i<10000;i++){const value='없는회사'+i,params:unknown[]=[];await candidate({field:'company',op:'eq',value},'customers',params);if(((BigInt(String(params[0]))>>29n)&7n)!==BigInt(distribution[0].bucket))continue;assert.equal((await pool.query(`SELECT count(*)::int n FROM ${S}.customers_plain WHERE company_norm=$1`,[normalize(value)])).rows[0].n,0);chosen={value,bucket:distribution[0].bucket,candidates:distribution[0].rows};break;}assert(chosen);
 const coarse=all.filter(c=>['coarse_company_zero','coarse_zero_and_memo','coarse_rare_and_memo','exact_common','exact_mid','or2','or4'].includes(c.name));
 for(const c of coarse){if(c.name==='coarse_company_zero')c.node={field:'company',op:'eq',value:chosen.value};if(c.name==='coarse_zero_and_memo')c.node={all:[{field:'company',op:'eq',value:chosen.value},{field:'memo',op:'contains',value:'서비스'}]};}
 const affix=all.filter(c=>c.name.startsWith('affix_')||['starts','ends'].includes(c.name));assert.equal(coarse.length,7);assert.equal(affix.length,14);
 save('cases',{coarse,affix});save('adversarial',{chosen,distribution});return {coarse,affix};
}
const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
async function measure(){
 const cases=await prepare(),session=(await pool.query("SELECT pg_backend_pid() pid,version() version,(SELECT datcollate FROM pg_database WHERE datname=current_database()) lc_collate,current_setting('work_mem') work_mem")).rows[0];
 const result:any={started:new Date().toISOString(),session,protocol:{warmups:2,repeats:7,first:1},rows:[],tables:[],errors:[]};
 for(const t of ['research_u.customers_plain','research_u.pb_4_final','research_u.pb_5_coarse3','native_verify_main.customers'])result.tables.push({table:t,...(await pool.query(`SELECT count(*)::int rows,pg_total_relation_size($1)::text bytes FROM ${t}`,[t])).rows[0]});
 for(const mode of ['count','list'] as const)for(const group of ['coarse','affix'] as const)for(const c of cases[group]){
  deadline();const ps:Path[]=group==='coarse'?['plain','final','coarse3']:['plain','final','direct'];
  const truth=await run('plain',c.node,'count'),expected=mode==='count'?truth:await run('plain',c.node,'list');
  const row:any={group,name:c.name,node:c.node,condition:condition(c.node),mode,matches:truth,targetRows:100000,returned:mode==='count'?1:(expected as any[]).length,candidates:{plain:truth},first:{},runs:Object.fromEntries(ps.map(p=>[p,[]])),summary:{},pids:[]};
  for(const p of ps.filter(p=>p!=='plain')){const q=await compile(p,c.node,'count',true);row.candidates[p]=Number((await pool.query(q.text,q.params)).rows[0].n);}
  for(let round=-3;round<7;round++){const offset=(round+3)%ps.length;for(const p of [...ps.slice(offset),...ps.slice(0,offset)]){deadline();const out=await measured(()=>run(p,c.node,mode));assert.deepEqual(out.value,expected,`${c.name}/${mode}/${p} plaintext mismatch`);assert.deepEqual(out.pids,[session.pid],'physical session changed');if(round===-3)row.first[p]=out.metric;if(round>=0)row.runs[p].push(out.metric);}}
  for(const p of ps){assert.equal(row.runs[p].length,7);row.summary[p]=Object.fromEntries(Object.keys(row.runs[p][0]).map(k=>[k,median(row.runs[p].map((r:any)=>r[k]))]));row.summary[p].ratio=row.summary[p].total/row.summary.plain.total;row.summary[p].sqlRatio=row.summary[p].db/row.summary.plain.db;}
  row.pids=[session.pid];result.rows.push(row);save('measure',result);console.log(group,c.name,mode,truth,JSON.stringify(Object.fromEntries(ps.map(p=>[p,Math.round(row.summary[p].db)]))),new Date().toISOString());
 }
 assert.equal((await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid,session.pid);result.finished=new Date().toISOString();save('measure',result);
}
let held=false;
try{await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);await acquire();held=true;if(phase==='load')await load();else await measure();}
catch(e:any){save(phase+'-error',{at:new Date().toISOString(),message:e.message,stack:e.stack});throw e;}
finally{if(held&&existsSync(LOCK)&&readFileSync(LOCK,'utf8').startsWith(owner))unlinkSync(LOCK);await pool.end();}

/** Task3 research only. New tables only; preserved for reruns. */
import assert from 'node:assert/strict';
import {createHmac,randomInt} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
import {B_SCOPE,normalize,verification} from '../research-unified/b-codec.js';
import {candidate} from '../research-unified/b-product.js';
import type {Node} from '../verify-native/r8-cases.js';

const OUT='bench/results/2026-09-28-task3', S='research_u';
const lockPath='.local/research/measure.lock', owner=`m1-astra-task3 ${process.pid}`;
const deadline=Date.parse('2026-09-28T22:08:00Z');
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,options:'-c statement_timeout=90000'});
const paths=['plain','B_original','B16','k2','k4','m8'] as const;
type Path=typeof paths[number];
const tables:Record<Path,string>={plain:'pb_3_plain',B_original:'b_customers_tags',B16:'pb_3_b16',k2:'pb_3_k2',k4:'pb_3_k4',m8:'pb_3_m8'};
const common:Node={field:'company',op:'eq',value:'서울서비스 담당'};
const cases:{name:string;node:Node;expected?:number}[]=[
 {name:'common',node:common,expected:28331},
 {name:'rare',node:{field:'company',op:'eq',value:'서울서비스 중앙지사'},expected:1770},
 {name:'and2',node:{all:[common,{field:'memo',op:'contains',value:'서비스'}]}},
 {name:'or2',node:{any:[common,{field:'memo',op:'contains',value:'푸른달'}]}},
];
const fingerprint=(token:string)=>Number((BigInt.asUintN(64,BigInt(token))>>16n)&65535n);
function variants(fp:number){return Array.from({length:8},(_,v)=>createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers','company','task3-contention8',fp,v].join('\0')).digest().readUInt16BE());}
const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
function save(name:string,value:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(value,null,2)+'\n');}
function checkTime(){assert(Date.now()<deadline,'task3 deadline reached');}
function plainNode(n:Node,params:unknown[]):string{
 if('all'in n)return '('+n.all.map(c=>plainNode(c,params)).join(' AND ')+')';
 if('any'in n)return '('+n.any.map(c=>plainNode(c,params)).join(' OR ')+')';
 const value=normalize(n.value);params.push(n.op==='eq'?value:'%'+value.replace(/[\\%_]/g,'\\$&')+'%');
 return `j.${n.field}_norm ${n.op==='eq'?'=':'LIKE'} $${params.length}`;
}
async function clauses(n:Node,path:Path,params:unknown[]):Promise<{cand:string;full:string}>{
 if('all'in n||'any'in n){const children='all'in n?n.all:n.any,op='all'in n?' AND ':' OR ';const parts=[];for(const child of children)parts.push(await clauses(child,path,params));return {cand:'('+parts.map(p=>p.cand).join(op)+')',full:'('+parts.map(p=>p.full).join(op)+')'};}
 let cand=await candidate(n,'customers',params,'j');
 if(n.field==='company'&&path!=='B_original'){
  const fp=fingerprint(String(params.pop()));
  const value=path==='k2'?fp>>>14:path==='k4'?fp>>>12:path==='m8'?[...new Set(variants(fp))]:fp;
  params.push(value);cand=path==='m8'?`j.company_token=ANY($${params.length}::bigint[])`:`j.company_token=$${params.length}::bigint`;
 }
 const verify=verification(n,'customers',params,'j');
 return {cand,full:`(${cand} AND ${verify})`};
}
async function compile(path:Path,node:Node,mode:'count'|'list',onlyCandidates=false){
 const params:unknown[]=[B_SCOPE];let cand:string,full:string;
 if(path==='plain'){cand=full=plainNode(node,params);}else({cand,full}=await clauses(node,path,params));
 const from=`${S}.${tables[path]}`;
 let text:string;
 if(onlyCandidates||mode==='count')text=`SELECT count(*)::int n FROM ${from} j WHERE j.scope_id=$1 AND ${onlyCandidates?cand:full}`;
 else if(path==='plain')text=`SELECT j.id FROM ${from} j WHERE j.scope_id=$1 AND ${full} ORDER BY j.id LIMIT 300`;
 else text=`SELECT j.id FROM (SELECT j.* FROM ${from} j WHERE j.scope_id=$1 AND ${cand} ORDER BY j.id OFFSET 0) j WHERE ${full} ORDER BY j.id LIMIT 300`;
 // Candidate-only SQL does not use verifier parameters; compact the parameter positions.
 if(onlyCandidates&&path!=='plain'){
  const used=new Set([...text.matchAll(/\$(\d+)/g)].map(m=>Number(m[1])));
  const usedParams:unknown[]=[];const remap=new Map<number,number>();
  for(let i=1;i<=params.length;i++)if(used.has(i)){remap.set(i,usedParams.push(params[i-1]));}
  text=text.replace(/\$(\d+)/g,(_,n)=>'$'+remap.get(Number(n)));return {text,params:usedParams};
 }
 return {text,params};
}
async function run(path:Path,node:Node,mode:'count'|'list'){
 const t0=performance.now(),q=await compile(path,node,mode),t1=performance.now();const result=await pool.query(q.text,q.params),t2=performance.now();
 const value=mode==='count'?Number(result.rows[0].n):result.rows.map(r=>r.id);const t3=performance.now();
 return {value,sqlMs:t2-t1,totalMs:t3-t0,prepareMs:t1-t0,postMs:t3-t2,rows:result.rows.length,sqlCalls:1,authenticatedFields:0};
}
async function load(){
 const started=new Date().toISOString();
 for(const t of ['pb_3_plain','pb_3_b16','pb_3_k2','pb_3_k4','pb_3_m8'])assert.equal((await pool.query('SELECT to_regclass($1) r',[S+'.'+t])).rows[0].r,null,`existing table ${t}; use measure phase instead`);
 await pool.query(`CREATE TABLE ${S}.pb_3_plain AS SELECT id,scope_id,company_norm,memo_norm FROM ${S}.customers_plain`);
 await pool.query(`CREATE TABLE ${S}.pb_3_b16 AS SELECT id,scope_id,((ce_company[1]>>16)&65535)::bigint company_token,salt_company,jx_company,cs_memo,salt_memo,jt_memo FROM ${S}.b_customers_tags`);
 for(const k of [2,4]){checkTime();await pool.query(`CREATE TABLE ${S}.pb_3_k${k} AS SELECT id,scope_id,(company_token>>${16-k})::bigint company_token,salt_company,jx_company,cs_memo,salt_memo,jt_memo FROM ${S}.pb_3_b16`);console.log('created k',k,new Date().toISOString());}
 await pool.query(`CREATE TABLE ${S}.pb_3_m8 (LIKE ${S}.pb_3_b16 INCLUDING ALL)`);
 const source=(await pool.query(`SELECT id,company_token FROM ${S}.pb_3_b16 ORDER BY id`)).rows;
 const mappings=source.map(r=>({id:r.id,token:variants(Number(r.company_token))[randomInt(8)]}));
 // The transient mapping is sent to SQL but never persisted as a reverse lookup table.
 for(let i=0;i<mappings.length;i+=5000){checkTime();await pool.query(`INSERT INTO ${S}.pb_3_m8 SELECT b.id,b.scope_id,x.token,b.salt_company,b.jx_company,b.cs_memo,b.salt_memo,b.jt_memo FROM ${S}.pb_3_b16 b JOIN jsonb_to_recordset($1::jsonb) AS x(id uuid,token bigint) ON x.id=b.id`,[JSON.stringify(mappings.slice(i,i+5000))]);}
 for(const path of paths.filter(p=>p!=='B_original')){
  checkTime();const table=tables[path];await pool.query(`ALTER TABLE ${S}.${table} ADD PRIMARY KEY(id)`);
  await pool.query(`CREATE INDEX ${table}_scope_id ON ${S}.${table}(scope_id,id)`);
  await pool.query(`CREATE INDEX ${table}_company ON ${S}.${table}(scope_id,${path==='plain'?'company_norm':'company_token'},id)`);
  await pool.query(`CREATE INDEX ${table}_memo ON ${S}.${table} USING gin(${path==='plain'?'memo_norm gin_trgm_ops':'cs_memo'})`);
  await pool.query(`ANALYZE ${S}.${table}`);console.log('indexed',path,new Date().toISOString());
 }
 save('load',{started,finished:new Date().toISOString(),rows:source.length,tableNames:tables,contention:'HMAC-SHA256(fixed research key, scope/table/field/task3-contention8/base16/variant), first16 bits; randomInt(8) per row'});
}
async function measure(){
 const result:any={started:new Date().toISOString(),pid:(await pool.query('SELECT pg_backend_pid() n')).rows[0].n,conditions:cases,paths,rows:[],meta:[],plans:[],limitations:['List returns ordered IDs only, not materialized customer fields.','Two-field controlled auxiliaries are separate from the existing six-field B table.','Security attacks, managed writes, and concurrent modifications are not tested.']};
 save('measure',result);
 for(const c of cases){
  const truth=(await run('plain',c.node,'count')).value;if(c.expected!==undefined)assert.equal(truth,c.expected);
  const candidates:any={};for(const p of paths){const q=await compile(p,c.node,'count',true);candidates[p]=Number((await pool.query(q.text,q.params)).rows[0].n);}
  for(const mode of ['count','list'] as const){
   checkTime();const expected=(await run('plain',c.node,mode)).value;
   const entry:any={name:c.name,mode,matches:truth,candidates,first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{}};result.rows.push(entry);
   for(let round=-3;round<7;round++){
    const offset=(round+3)%paths.length;const ordered=[...paths.slice(offset),...paths.slice(0,offset)];
    for(const path of ordered){checkTime();const {value,...metrics}=await run(path,c.node,mode);assert.deepEqual(value,expected,`${c.name}/${mode}/${path}/round${round}`);if(round===-3)entry.first[path]=metrics;if(round>=0)entry.runs[path].push(metrics);}
   }
   for(const p of paths)entry.summary[p]=Object.fromEntries(Object.keys(entry.runs[p][0]).map(k=>[k,median(entry.runs[p].map((r:any)=>r[k]))]));
   for(const p of paths){entry.summary[p].sqlRatio=entry.summary[p].sqlMs/entry.summary.plain.sqlMs;entry.summary[p].totalRatio=entry.summary[p].totalMs/entry.summary.plain.totalMs;}
   save('measure',result);console.log(c.name,mode,JSON.stringify(Object.fromEntries(paths.map(p=>[p,entry.summary[p].sqlMs]))),new Date().toISOString());
  }
 }
 for(const path of paths){const table=tables[path];const count=(await pool.query(`SELECT count(*)::int n,count(*) FILTER(WHERE scope_id=$1)::int scoped FROM ${S}.${table}`,[B_SCOPE])).rows[0];const sizes=(await pool.query(`SELECT pg_relation_size($1)::text heap,pg_indexes_size($1)::text indexes,pg_total_relation_size($1)::text total`,[S+'.'+table])).rows[0];result.meta.push({path,table,...count,...sizes});}
 result.distribution=(await pool.query(`SELECT p.company_norm,count(*)::int rows,b.company_token,k2.company_token k2,k4.company_token k4,count(DISTINCT m.company_token)::int observed_m8 FROM ${S}.pb_3_plain p JOIN ${S}.pb_3_b16 b USING(id) JOIN ${S}.pb_3_k2 k2 USING(id) JOIN ${S}.pb_3_k4 k4 USING(id) JOIN ${S}.pb_3_m8 m USING(id) WHERE p.scope_id=$1 GROUP BY p.company_norm,b.company_token,k2.company_token,k4.company_token ORDER BY rows DESC`,[B_SCOPE])).rows;
 for(const c of cases)for(const mode of ['count','list'] as const)for(const path of paths){checkTime();const q=await compile(path,c.node,mode);const plan=(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.text,q.params)).rows[0]['QUERY PLAN'];result.plans.push({name:c.name,mode,path,sql:q.text,plan});}
 result.finished=new Date().toISOString();result.pidEnd=(await pool.query('SELECT pg_backend_pid() n')).rows[0].n;assert.equal(result.pid,result.pidEnd);save('measure',result);
}
let held=false;
try{
 await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);
 writeFileSync(lockPath,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;
 console.log('lock acquired',owner,new Date().toISOString());
 const phase=process.argv[2]??'all';assert(['all','load','measure'].includes(phase));
 if(phase==='all'||phase==='load')await load();
 if(phase==='all'||phase==='measure')await measure();
}catch(e:any){save('error',{time:new Date().toISOString(),message:e.message,stack:e.stack});throw e;}
finally{if(held&&existsSync(lockPath)&&readFileSync(lockPath,'utf8').startsWith(owner))unlinkSync(lockPath);await pool.end();}

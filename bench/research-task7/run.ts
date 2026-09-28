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


const S='research_u',OUT='bench/results/2026-09-29-task7',LOCK='.local/research/measure.lock',owner=`m1-astra-task7 ${process.pid}`;
const phase=process.argv[2]??'load';assert(['load','measure','metadata','smoke','plans'].includes(phase));
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});
const db=drizzle(pool),bodySealer=createSealer({key:Buffer.alloc(32,93)});
const paths=['plain','final','tag'] as const;type Path=typeof paths[number]|'A';
const tables={final:'pb_4_final',tag:'pb_7_base'};
// The deadline is a reporting checkpoint; preserve progress and finish the requested comparisons.
const deadline=()=>{};
function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
function positionalKey(field:string,piece:string){return createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers',field,'pb1b-w2-n2',piece].join('\0')).digest();}
async function clauses(node:Node,path:'final'|'tag',params:unknown[],verify=true):Promise<{cand:string;full:string}>{
 if('all'in node||'any'in node){const op='all'in node?' AND ':' OR ',items='all'in node?node.all:node.any,out=[];for(const c of items)out.push(await clauses(c,path,params,verify));return {cand:'('+out.map(x=>x.cand).join(op)+')',full:'('+out.map(x=>x.full).join(op)+')'};}
 if(path==='tag'&&node.field==='company'&&node.op==='eq'){params.push(companyToken(node.value));const i=params.length;const cand=`j.id IN (SELECT c.id FROM research_u.pb_7_ctag c WHERE c.tag8=ANY(ARRAY(SELECT substr(sha256($${i}::bytea||int4send(g)),1,8) FROM generate_series(1,coalesce((SELECT n FROM research_u.pb_7_esc WHERE tok=sha256($${i}::bytea||'esc'::bytea)),0)) g)))`;return {cand,full:cand};}
 const cand=await candidate(node,'customers',params,'j');
 if(path==='final'&&node.field==='company'&&node.op==='eq'){const original=BigInt(String(params.at(-1)));params[params.length-1]=String((original>>30n)&3n);}
 if(!verify)return {cand,full:cand};
 let judge:string;
 if(node.op==='eq')judge=verification(node,'customers',params,'j');
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
type Event={s:number;e:number;rows:number;text:string;pid:number};let events:Event[]|null=null,opens=0;
const originalQuery=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){const s=performance.now(),text=typeof args[0]==='string'?args[0]:args[0]?.text??'';let recorded=false;const record=(r:any)=>{if(!recorded){recorded=true;events?.push({s,e:performance.now(),rows:r?.rows?.length??0,text,pid:this.processID});}return r;};const ci=args.findIndex(a=>typeof a==='function');if(ci>=0){const cb=args[ci];args[ci]=(err:any,r:any)=>{record(r);cb(err,r);};}const r=(originalQuery as any).apply(this,args);return ci<0&&r?.then?r.then(record):r;};
const originalOpen=Sealer.prototype.open;Sealer.prototype.open=function(...args:Parameters<Sealer['open']>){opens++;return originalOpen.apply(this,args);};
async function measured(fn:()=>Promise<any>){events=[];opens=0;const start=performance.now();try{const value=await fn(),end=performance.now(),ev:Event[]=[...events].sort((a,b)=>a.s-b.s);let wall=0,right=-Infinity;for(const e of ev){wall+=Math.max(0,e.e-Math.max(e.s,right));right=Math.max(right,e.e);}const pre=ev.length?ev[0].s-start:end-start,post=ev.length?end-right:0;return {value,metric:{pre,db:ev.reduce((n,e)=>n+e.e-e.s,0),between:Math.max(0,end-start-pre-wall-post),post,total:end-start,sql:ev.length,appRows:ev.reduce((n,e)=>n+e.rows,0),decrypts:opens},sqlTexts:ev.map(e=>e.text),pids:[...new Set(ev.map(e=>e.pid))]};}finally{events=null;}}
const companyToken=(v:string)=>hash('sha256',Buffer.concat([Buffer.alloc(32,7),Buffer.from(['customers','company','e',normalize(v)].join('\0'))]),'buffer');
async function load(){
 for(const t of ['pb_7_base','pb_7_ctag','pb_7_esc'])assert.equal((await pool.query('SELECT to_regclass($1) r',[S+'.'+t])).rows[0].r,null);
 const started=performance.now();
 const cols=['id','scope_id',...fields.flatMap(f=>['ce','cs','salt','jx','psalt','n','stamps','positions'].filter(p=>f!=='company'||!['ce','salt','jx'].includes(p)).map(p=>p+'_'+f))];
 await pool.query(`CREATE TABLE ${S}.pb_7_base AS SELECT ${cols.join(',')} FROM ${S}.pb_4_improved`);await pool.query(`ALTER TABLE ${S}.pb_7_base ADD PRIMARY KEY(id)`);await pool.query(`CREATE UNIQUE INDEX pb_7_base_scope_row ON ${S}.pb_7_base(scope_id,id)`);
 for(const f of fields.filter(f=>f!=='company'))await pool.query(`CREATE INDEX pb_7_base_${f}_exact ON ${S}.pb_7_base(scope_id,(ce_${f}[1]),id)`);
 await pool.query(`CREATE INDEX pb_7_base_gin ON ${S}.pb_7_base USING gin(${fields.map(f=>'cs_'+f).join(',')})`);
 await pool.query(`CREATE TABLE ${S}.pb_7_ctag(tag8 bytea NOT NULL,id uuid PRIMARY KEY)`);await pool.query(`CREATE INDEX pb_7_ctag_tag ON ${S}.pb_7_ctag(tag8,id)`);await pool.query(`CREATE TABLE ${S}.pb_7_esc(tok bytea PRIMARY KEY,n int NOT NULL)`);
 const companies=(await pool.query(`SELECT company_norm,count(*)::int n FROM ${S}.customers_plain GROUP BY company_norm`)).rows;
 for(const r of companies){const tok=companyToken(r.company_norm);await pool.query(`INSERT INTO ${S}.pb_7_esc VALUES(sha256($1::bytea||'esc'::bytea),$2)`,[tok,r.n]);await pool.query(`INSERT INTO ${S}.pb_7_ctag SELECT substr(sha256($1::bytea||int4send((row_number() OVER(ORDER BY id))::int)),1,8),id FROM ${S}.customers_plain WHERE company_norm=$2`,[tok,r.company_norm]);}
 for(const t of ['pb_7_base','pb_7_ctag','pb_7_esc'])await pool.query(`ANALYZE ${S}.${t}`);save('load',{at:new Date().toISOString(),ms:performance.now()-started,companies:companies.length});
}
const med=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
const result:any=existsSync(OUT+'/measure.json')?JSON.parse(readFileSync(OUT+'/measure.json','utf8')):{started:new Date().toISOString(),rows:[],errors:[],protocol:{A:{warmups:1,repeats:3},others:{warmups:2,repeats:7},first:1},tables:[]};
async function measure(){
 const pid=(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid;result.segments??=[{pid:result.pid,started:result.started}];if(result.pid!==pid)result.segments.push({pid,started:new Date().toISOString()});if(result.error){result.errors.push(result.error);delete result.error;}for(const r of result.rows)r.pid??=result.pid;result.pid=pid;const cases:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-task4/cases.json','utf8'));assert.equal(cases.length,52);save('cases',cases);
 for(const table of ['research_u.customers_plain','native_verify_main.customers','native_verify_main.customers_seal_index','research_u.pb_4_final','research_u.pb_7_base','research_u.pb_7_ctag','research_u.pb_7_esc'])result.tables.push({table,...(await pool.query(`SELECT count(*)::int rows,pg_total_relation_size($1)::text bytes FROM ${table}`,[table])).rows[0]});save('measure',result);
 for(const mode of ['count','list'] as const)for(const c of cases){const old=result.rows.find((r:any)=>r.name===c.name&&r.mode===mode);if(old&&paths.every(p=>old.summary[p]))continue;if(old)result.rows.splice(result.rows.indexOf(old),1);deadline();const truth=await run('plain',c.node,'count'),expected=mode==='count'?truth:await run('plain',c.node,'list'),row:any={pid,name:c.name,node:c.node,condition:condition(c.node),mode,matches:truth,returned:mode==='count'?1:(expected as any[]).length,candidates:{plain:truth},runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{},first:{}};
  for(const p of ['final','tag'] as const){const q=await compile(p,c.node,'count',true);row.candidates[p]=(await pool.query(q.text,q.params)).rows[0].n;}
  const ap:unknown[]=[B_SCOPE];let aw=await candidate(c.node,'customers',ap,'j');for(const f of fields)aw=aw.replaceAll(`j.ce_${f}`,`j.${sourceTokenColumn('customers',f,true)}`).replaceAll(`j.cs_${f}`,`j.${sourceTokenColumn('customers',f,false)}`);row.candidates.A=(await pool.query(`SELECT count(*)::int n FROM native_verify_main.customers_seal_index j WHERE scope_id=$1 AND ${aw}`,ap)).rows[0].n;
  result.rows.push(row);for(let round=-3;round<7;round++){const off=(round+3)%paths.length;for(const p of [...paths.slice(off),...paths.slice(0,off)]){deadline();const out=await measured(()=>run(p,c.node,mode));assert.deepEqual(out.value,expected,`${c.name}/${mode}/${p}`);assert.deepEqual(out.pids,[pid]);if(round===-3)row.first[p]=out.metric;if(round>=0)row.runs[p].push(out.metric);}}
  for(const p of paths){row.summary[p]=Object.fromEntries(Object.keys(row.runs[p][0]).map(k=>[k,med(row.runs[p].map((v:any)=>v[k]))]));row.summary[p].ratio=row.summary[p].total/row.summary.plain.total;row.summary[p].sqlRatio=row.summary[p].db/row.summary.plain.db;}
  save('measure',result);console.log(c.name,mode,JSON.stringify(Object.fromEntries(paths.map(p=>[p,Math.round(row.summary[p].total)]))),new Date().toISOString());
 }
 assert.equal((await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid,pid);result.finished=new Date().toISOString();save('measure',result);
}
async function plans(){const cases:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-task4/cases.json','utf8')),out=[];for(const name of ['exact_common','and4'])for(const path of ['final','tag'] as const){const c=cases.find(c=>c.name===name)!;const q=await compile(path,c.node,'count');out.push({name,path,sql:q.text,plan:(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.text,q.params)).rows[0]['QUERY PLAN']});}save('plans',out);}
let held=false;try{await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);writeFileSync(LOCK,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;if(phase==='load')await load();else if(phase==='plans')await plans();else await measure();}catch(e:any){result.error={at:new Date().toISOString(),message:e.message,stack:e.stack};save(phase==='load'?'load-error':'measure',result);throw e;}finally{if(held&&existsSync(LOCK)&&readFileSync(LOCK,'utf8').startsWith(owner))unlinkSync(LOCK);await pool.end();}

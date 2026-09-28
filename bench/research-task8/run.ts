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


const S='research_u',OUT='bench/results/2026-09-29-task8',LOCK='.local/research/measure.lock',owner=`m1-astra-task8 ${process.pid}`;
const phase=process.argv[2]??'measure';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});
const db=drizzle(pool),bodySealer=createSealer({key:Buffer.alloc(32,93)});
const paths=['plain','final','tag','better'] as const;type Path=typeof paths[number];
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
 if(path==='better')return compileBetter(node,mode,onlyCandidates);
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
const companyToken=(v:string)=>hash('sha256',Buffer.concat([Buffer.alloc(32,7),Buffer.from(['customers','company','e',normalize(v)].join('\0'))]),'buffer');
type Strategy='adaptive'|'set'|'direct';let strategy:Strategy='adaptive',threshold=4096;
const collect=(n:Node,out=new Set<string>())=>{if('all'in n)n.all.forEach(x=>collect(x,out));else if('any'in n)n.any.forEach(x=>collect(x,out));else if(n.field==='company'&&n.op==='eq')out.add(normalize(n.value));return [...out];};
async function ledger(node:Node){const values=collect(node),keys=values.map(v=>hash('sha256',Buffer.concat([companyToken(v),Buffer.from('esc')]),'buffer'));const rows=(await pool.query('SELECT encode(tok,\'hex\') tok,n FROM research_u.pb_7_esc WHERE tok=ANY($1::bytea[])',[keys])).rows;return new Map(values.map((v,i)=>[v,Number(rows.find(r=>r.tok===keys[i].toString('hex'))?.n??0)]));}
function exactPosition(value:string,params:unknown[]){const cs=Array.from(normalize(value));assert(cs.length>=2);const offsets:number[]=[];for(let i=0;i+2<=cs.length;i+=2)offsets.push(i);if(offsets.at(-1)!==cs.length-2)offsets.push(cs.length-2);const keys=offsets.map(i=>{params.push(positionalKey('company',cs.slice(i,i+2).join('')));return `$${params.length}::bytea`;});return `(j.n_company=${cs.length} AND research_u.pb_4_match(ARRAY[${keys.join(',')}],ARRAY[${offsets.join(',')}],${cs.length},j.n_company,j.psalt_company,j.stamps_company,j.positions_company,1))`;}
function dnf(n:Node):Node[][]{if('any'in n)return n.any.flatMap(dnf);if('all'in n){let groups:Node[][]=[[]];for(const child of n.all){const next=dnf(child);groups=groups.flatMap(g=>next.map(h=>[...g,...h]));assert(groups.length<=64,'DNF expansion bound');}return groups;}return [[n]];}
async function compileBetter(node:Node,mode:'count'|'list',onlyCandidates=false){
 const ns=await ledger(node),params:unknown[]=[B_SCOPE],ctes:string[]=[],setNames=new Map<string,string>(),decisions:any[]=[];
 async function walk(n:Node,underAnd=false):Promise<{cand:string;full:string;direct:boolean}>{
  if('all'in n||'any'in n){const isAnd='all'in n,children:{cand:string;full:string;direct:boolean}[]=[];for(const child of isAnd?n.all:(n as {any:Node[]}).any)children.push(await walk(child,underAnd||isAnd));const op=isAnd?' AND ':' OR ';const cand='('+children.map(c=>c.cand).join(op)+')';let full='('+children.map(c=>c.full).join(op)+')';
   if(isAnd&&children.some(c=>c.direct)&&children.some(c=>!c.direct)){const cheap=children.filter(c=>!c.direct).map(c=>c.full).join(' AND '),expensive=children.filter(c=>c.direct).map(c=>c.full).join(' AND ');full=`(CASE WHEN ${cheap} THEN ${expensive} ELSE false END)`;}
   return {cand,full,direct:children.some(c=>c.direct)};
  }
  if(n.field!=='company'||n.op!=='eq'){const c=await clauses(n,'tag',params,!onlyCandidates);return {...c,direct:false};}
  const value=normalize(n.value),num=ns.get(value)!;assert(Number.isSafeInteger(num)&&num>=0);if(num===0){decisions.push({value,n:num,route:'empty'});return {cand:'FALSE',full:'FALSE',direct:false};}
  const direct=strategy==='direct'||strategy==='adaptive'&&num>threshold&&(underAnd||mode==='list');decisions.push({value,n:num,route:direct?'position':'set',underAnd});
  if(direct){const cand=`j.n_company=${Array.from(value).length}`;return {cand,full:onlyCandidates?cand:exactPosition(value,params),direct:true};}
  let name=setNames.get(value);if(!name){name='company_ids_'+setNames.size;setNames.set(value,name);params.push(companyToken(value));const i=params.length;
   ctes.push(`${name} AS MATERIALIZED (SELECT c.id FROM (SELECT substr(sha256($${i}::bytea||int4send(g)),1,8) tag8 FROM generate_series(1,${num}) g) wanted JOIN research_u.pb_7_ctag c ON c.tag8=wanted.tag8)`);
  }
  const cand=`j.id IN (SELECT id FROM ${name})`;return {cand,full:cand,direct:false};
 }
 // Count OR branches as unions of indexed ID sets; avoid fetching broad base rows for rare OR leaves.
 const groups=dnf(node);
 if(mode==='count'&&!onlyCandidates&&groups.length>1){const selects:string[]=[];for(const group of groups){const c=await walk(group.length===1?group[0]:{all:group});selects.push(`SELECT j.id FROM research_u.pb_7_base j WHERE scope_id=$1 AND ${c.direct?`(${c.cand} AND ${c.full})`:c.full}`);}return {text:`${ctes.length?'WITH '+ctes.join(',')+' ':''}SELECT count(*)::int n FROM (${selects.join(' UNION ')}) matched`,params,decisions};}
 // Parameter appends are sequential because each returned placeholder refers to this shared array.
 const c=await walk(node),prefix=ctes.length?'WITH '+ctes.join(',')+' ':'';
 if(mode==='count'||onlyCandidates)return {text:`${prefix}SELECT count(*)::int n FROM research_u.pb_7_base j WHERE scope_id=$1 AND ${onlyCandidates?c.cand:c.direct?`(${c.cand} AND ${c.full})`:c.full}`,params,decisions};
 const matched=`matched AS MATERIALIZED (SELECT j.id FROM (SELECT j.* FROM research_u.pb_7_base j WHERE scope_id=$1 AND ${c.cand} ORDER BY j.id OFFSET 0) j WHERE ${c.full} ORDER BY j.id LIMIT 300)`;
 return {text:`WITH ${[...ctes,matched].join(',')} SELECT p.id,${fields.map(f=>'p.'+f+'_ct').join(',')} FROM matched m JOIN native_verify_main.customers p ON p.id=m.id AND p.scope_id=$1 ORDER BY p.id`,params,decisions};
}
const med=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
async function schema(){const tables=['pb_7_base','pb_7_ctag','pb_7_esc'];return {columns:(await pool.query("SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='research_u' AND table_name=ANY($1) ORDER BY table_name,ordinal_position",[tables])).rows,indexes:(await pool.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='research_u' AND tablename=ANY($1) ORDER BY tablename,indexname",[tables])).rows};}
const result:any={started:new Date().toISOString(),protocol:{first:1,warmups:2,repeats:7},rows:[],calibration:[],plans:[]};
async function calibrate(){
 const companies=(await pool.query('SELECT company_norm,count(*)::int n FROM research_u.customers_plain GROUP BY company_norm ORDER BY n,company_norm')).rows;
 const picks=[companies[0],companies[4],companies.find(r=>r.company_norm===normalize('서울서비스 중앙지사'))!,companies[8],companies[12],companies.at(-2),companies.at(-1)];
 for(const company of picks)for(const shape of ['and_common','and_selective','list'] as const){const eq:Node={field:'company',op:'eq',value:company.company_norm},node:Node=shape==='list'?eq:{all:[eq,...(shape==='and_common'?[{field:'memo',op:'contains',value:'서비스'}]:[{field:'address',op:'contains',value:'서울'},{field:'memo',op:'contains',value:'상담'},{field:'email',op:'contains',value:'service'}]) as Node[]]},mode=shape==='list'?'list':'count';const expected=await run('plain',node,mode),row:any={company:company.company_norm,n:company.n,shape,node,mode,runs:{set:[],direct:[]},summary:{}};
  for(let round=-3;round<7;round++)for(const st of round%2?['set','direct']:['direct','set']){strategy=st as Strategy;const out=await measured(()=>run('better',node,mode));assert.deepEqual(out.value,expected);assert.deepEqual(out.pids,[result.pid]);if(round>=0)row.runs[st].push(out.metric);}
  for(const st of ['set','direct'])row.summary[st]={db:med(row.runs[st].map((v:any)=>v.db)),total:med(row.runs[st].map((v:any)=>v.total))};result.calibration.push(row);save('measure',result);console.log('calibrate',company.n,shape,row.summary);
 }
 const thresholds=[0,512,1024,2048,4096,8192,16384,32768,100000];result.thresholdScores=thresholds.map(t=>({threshold:t,sumSql:result.calibration.reduce((sum:number,r:any)=>sum+r.summary[r.n>t?'direct':'set'].db,0)})).sort((a:any,b:any)=>a.sumSql-b.sumSql);threshold=result.thresholdScores[0].threshold;strategy='adaptive';result.threshold=threshold;save('measure',result);
}
async function measure(){
 result.pid=(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid;result.schemaBefore=await schema();await calibrate();
 const all:Case[]=JSON.parse(readFileSync('bench/results/2026-09-29-task7/cases.json','utf8')),indices=[1,2,3,4,10,11,12,13,15,18,19,25,26,27,28,29,30,31,32],cases=indices.map(i=>({...all[i-1],index:i}));save('cases',cases);
 for(const mode of ['count','list'] as const)for(const c of cases){const matches=await run('plain',c.node,'count'),expected=mode==='count'?matches:await run('plain',c.node,'list'),row:any={index:c.index,name:c.name,node:c.node,condition:condition(c.node),mode,matches,returned:mode==='count'?1:(expected as any[]).length,candidates:{plain:matches},runs:Object.fromEntries(paths.map(p=>[p,[]])),first:{},summary:{}};
  for(const p of ['final','tag','better'] as const){const q=await compile(p,c.node,mode,true);row.candidates[p]=(await pool.query(q.text,q.params)).rows[0].n;}
  row.decisions=(await compileBetter(c.node,mode)).decisions;
  for(let round=-3;round<7;round++){const off=(round+3)%paths.length;for(const p of [...paths.slice(off),...paths.slice(0,off)]){const out=await measured(()=>run(p,c.node,mode));assert.deepEqual(out.value,expected,`${c.name}/${mode}/${p}`);assert.deepEqual(out.pids,[result.pid]);if(round===-3)row.first[p]=out.metric;if(round>=0)row.runs[p].push(out.metric);}}
  for(const p of paths){row.summary[p]=Object.fromEntries(Object.keys(row.runs[p][0]).map(k=>[k,med(row.runs[p].map((v:any)=>v[k]))]));row.summary[p].ratio=row.summary[p].total/row.summary.plain.total;row.summary[p].sqlRatio=row.summary[p].db/row.summary.plain.db;}result.rows.push(row);save('measure',result);console.log(c.name,mode,JSON.stringify(Object.fromEntries(paths.map(p=>[p,Math.round(row.summary[p].db)]))),new Date().toISOString());
 }
 for(const name of ['exact_common','and4','or4'])for(const mode of ['count','list'] as const){const c=cases.find(c=>c.name===name)!;for(const p of ['tag','better'] as const){const q=await compile(p,c.node,mode);result.plans.push({name,mode,path:p,sql:q.text,plan:(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.text,q.params)).rows[0]['QUERY PLAN']});}}
 result.schemaAfter=await schema();assert.deepEqual(result.schemaAfter,result.schemaBefore,'stored schema changed');assert.equal((await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid,result.pid);result.finished=new Date().toISOString();save('measure',result);
}
let held=false;try{await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);writeFileSync(LOCK,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;await pool.query('SET default_transaction_read_only=on');await measure();}catch(e:any){result.error={at:new Date().toISOString(),message:e.message,stack:e.stack};save('measure',result);throw e;}finally{if(held&&existsSync(LOCK)&&readFileSync(LOCK,'utf8').startsWith(owner))unlinkSync(LOCK);await pool.end();}

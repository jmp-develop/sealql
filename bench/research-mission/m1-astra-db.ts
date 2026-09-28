import assert from 'node:assert/strict';
import {openSync,closeSync,unlinkSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../../src/index.js';
import {createSealed,registrationOf} from '../../src/adapters/drizzle/v0.45/native.js';
import {normalizeText} from '../../src/core/search-tokens.js';
import {assertDisposable} from '../../test/disposable.js';
const schema='research_m1_astra_count',scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',n=10000;
const lock='.local/research/measure.lock';let fd:number|undefined,created=false;
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
const q=pool.query.bind(pool);let events:{sqlMs:number,rows:number}[]|null=null;
(pool as any).query=async(...args:any[])=>{const t=performance.now();const r=await (q as any)(...args);events?.push({sqlMs:performance.now()-t,rows:r.rows.length});return r;};
const norm=(s:string)=>normalizeText(s,'legacy-text-v1');
const key=Buffer.alloc(32,73);const token=(s:string)=>createHmac('sha256',key).update(s).digest().subarray(0,16);
const all=(s:string)=>{const a=Array.from(norm(s)),ps=new Set<string>();for(let i=0;i<a.length-1;i++){let p=a[i];for(let j=i+1;j<a.length;j++){p+=a[j];ps.add(p);}}return [...ps];};
const median=(a:number[])=>[...a].sort((a,b)=>a-b)[a.length>>1];
try{
 await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
 fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({owner:'m1-astra',task:'exact-count-prototypes',started:new Date().toISOString()}));
 assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
 await pool.query(`create schema ${schema}`);created=true;
 const sealer=createSealer({key:Buffer.alloc(32,93)}),sealed=createSealed({sealer});
 const table=pgSchema(schema).table('customers',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),company:sealed.text('company',{search:{exact:true}}),memo:sealed.text('memo',{search:{substring:true}})});
 const seal=sealed.register(table,{row:'id',scope:'scopeId'}),db=drizzle(pool),profiles=Object.values(registrationOf(seal).storage.index!.profiles!);
 await pool.query(`create table ${schema}.customers(id uuid primary key,scope_id uuid not null,company_ct bytea not null,memo_ct bytea not null)`);
 await pool.query(`create table ${schema}.customers_seal_index(scope_id uuid not null,row_id uuid not null,${profiles.map(p=>`"${p.tokens}" bigint[]`).join(',')},unique(scope_id,row_id),foreign key(row_id) references ${schema}.customers(id) on delete cascade)`);
 for(const p of profiles)await pool.query(p.mode==='substring'?`create index on ${schema}.customers_seal_index using gin("${p.tokens}")`:`create index on ${schema}.customers_seal_index(scope_id,("${p.tokens}"[1]),row_id)`);
 await pool.query(`create table ${schema}.plain as select id,scope_id,company_plain,company_norm,memo_plain,memo_norm from bench_realistic_100k.customers where scope_id=$1 order by id limit $2`,[scope,n]);
 const rows=(await pool.query(`select * from ${schema}.plain order by id`)).rows;assert.equal(rows.length,n);
 await pool.query(`create table ${schema}.exact_tags(id uuid primary key,scope_id uuid not null,company bytea not null,memo bytea[] not null)`);
 await pool.query(`create table ${schema}.row_tags(id uuid primary key,scope_id uuid not null,company bytea not null,memo bytea[] not null)`);
 let tags=0;for(let i=0;i<rows.length;i+=100){const chunk=rows.slice(i,i+100);await sealed.insert(db,seal,chunk.map(r=>({id:r.id,scopeId:scope,company:r.company_plain,memo:r.memo_plain})));
  const vals=chunk.map(r=>{const ts=all(r.memo_plain).map(token);tags+=ts.length;return {id:r.id,company:token('eq:'+norm(r.company_plain)).toString('hex'),memo:ts.map(t=>t.toString('hex')).sort(),bound:ts.map(t=>createHmac('sha256',t).update(`${scope}/${r.id}`).digest('hex').slice(0,32)).sort()};});
  await pool.query(`insert into ${schema}.exact_tags select x.id::uuid,$2::uuid,decode(x.company,'hex'),array(select decode(v,'hex') from unnest(x.memo) v) from jsonb_to_recordset($1::jsonb) x(id text,company text,memo text[])`,[JSON.stringify(vals),scope]);
  await pool.query(`insert into ${schema}.row_tags select x.id::uuid,$2::uuid,decode(x.company,'hex'),array(select decode(v,'hex') from unnest(x.bound) v) from jsonb_to_recordset($1::jsonb) x(id text,company text,bound text[])`,[JSON.stringify(vals),scope]);
 }
 await pool.query(`create index on ${schema}.exact_tags using gin(memo)`);await pool.query(`create index on ${schema}.exact_tags(company)`);await pool.query(`create index on ${schema}.row_tags(company)`);await pool.query(`create index on ${schema}.plain(company_norm)`);
 for(const name of ['customers','customers_seal_index','exact_tags','row_tags','plain'])await pool.query(`analyze ${schema}.${name}`);
 let opens=0;const originalOpen=sealer.open.bind(sealer);sealer.open=async(...args)=>{opens++;return originalOpen(...args);};
 const cases=[{name:'and-common',company:'서울서비스 담당',term:'서비스'},{name:'contains-common',term:'서비스'},{name:'contains-rare',term:'푸른달'},{name:'structural-zero',term:'지사담'}];
 const report:any={conditions:{rows:n,node:process.version,source:'bench_realistic_100k.customers order by id first 10000',warmups:2,repetitions:7,order:'rotated each repetition',locale:(await pool.query('select datcollate from pg_database where datname=current_database()')).rows[0],notProduction:true},storedTags:tags,cases:[]};
 for(const c of cases){const eqToken=c.company?token('eq:'+norm(c.company)):null,qt=token(norm(c.term));const padded=Buffer.alloc(64);qt.copy(padded);const ipad=Buffer.from(padded.map(x=>x^0x36)),opad=Buffer.from(padded.map(x=>x^0x5c));
  const methods:any={plain:async()=>Number((await pool.query(`select count(*) n from ${schema}.plain where ($1::text is null or company_norm=$1) and position($2 in memo_norm)>0`,[c.company?norm(c.company):null,norm(c.term)])).rows[0].n),product:()=>sealed.count(db,seal,{scope,match:m=>c.company?m.and(m.company.eq(c.company),m.memo.contains(c.term)):m.memo.contains(c.term)}),allSubstring:async()=>Number((await pool.query(`select count(*) n from ${schema}.exact_tags where ($1::bytea is null or company=$1) and memo @> array[$2::bytea]`,[eqToken,qt])).rows[0].n),rowBound:async()=>Number((await pool.query(`select count(*) n from ${schema}.row_tags where ($1::bytea is null or company=$1) and substring(sha256($3::bytea || sha256($2::bytea || convert_to(scope_id::text || '/' || id::text,'UTF8'))) from 1 for 16)=any(memo)`,[eqToken,ipad,opad])).rows[0].n)};
  const expected=await methods.plain(),runs:any=Object.fromEntries(Object.keys(methods).map(k=>[k,[]]));for(const fn of Object.values(methods) as any[])assert.equal(await fn(),expected);
  for(let i=0;i<2;i++)for(const fn of Object.values(methods) as any[])assert.equal(await fn(),expected);
  const names=Object.keys(methods);for(let i=0;i<7;i++)for(let j=0;j<names.length;j++){const name=names[(i+j)%names.length];events=[];opens=0;const t=performance.now(),count=await methods[name](),totalMs=performance.now()-t,ev=events;events=null;assert.equal(count,expected);runs[name].push({totalMs,sqlMs:ev.reduce((s,e)=>s+e.sqlMs,0),sqlCalls:ev.length,candidateRowsToApp:name==='product'?ev.reduce((s,e)=>s+e.rows,0):0,returnedSqlRows:ev.reduce((s,e)=>s+e.rows,0),authenticatedFields:opens,count});}
  const summary=Object.fromEntries(names.map(name=>[name,Object.fromEntries(Object.keys(runs[name][0]).map(k=>[k,median(runs[name].map((r:any)=>r[k]))]))]));report.cases.push({name:c.name,...c,expected,summary,runs});console.log(JSON.stringify({case:c.name,summary}));
 }
 report.storage=(await pool.query(`select c.relname,pg_relation_size(c.oid)::text heap_bytes,pg_total_relation_size(c.oid)::text total_bytes from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname=$1 and c.relkind='r' order by c.relname`,[schema])).rows;
 // Mechanically alter only the disposable candidate index, preserving original AEAD fields.
 const before=Number((await pool.query(`select count(*) n from ${schema}.exact_tags where memo @> array[$1::bytea]`,[token(norm('서비스'))])).rows[0].n);
 const nonmatch=(await pool.query(`select id from ${schema}.plain where position($1 in memo_norm)=0 limit 1`,[norm('서비스')])).rows[0].id;
 await pool.query('begin');let inflated:number;
 try{await pool.query(`update ${schema}.exact_tags set memo=array_append(memo,$1::bytea) where id=$2`,[token(norm('서비스')),nonmatch]);inflated=Number((await pool.query(`select count(*) n from ${schema}.exact_tags where memo @> array[$1::bytea]`,[token(norm('서비스'))])).rows[0].n);assert.equal(inflated,before+1);}finally{await pool.query('rollback');}
 report.integrity={proofImplemented:false,before,afterForgedTag:inflated,scalarInflationDetected:false,omissionDetected:false,rowBoundCompany:'deterministic exact company tags retained; row-bound protection applies to memo only'};
 mkdirSync('bench/results/2026-09-28-mission',{recursive:true});writeFileSync('bench/results/2026-09-28-mission/m1-astra-db.json',JSON.stringify(report,null,2)+'\n');
}finally{if(created)await pool.query(`drop schema ${schema} cascade`);await pool.end();if(fd!==undefined){closeSync(fd);unlinkSync(lock);}}

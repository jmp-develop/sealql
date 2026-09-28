import assert from 'node:assert/strict';
import {createHmac,hash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
import {candidate} from '../research-unified/b-product.js';
import {normalize,B_SCOPE} from '../research-unified/b-codec.js';
const OUT='bench/results/2026-09-29-task1';mkdirSync(OUT,{recursive:true});
const W=Number(process.argv[3]??2);assert([2,4].includes(W));const TABLE=`research_u.pb_astra_w${W}`,NAME=`pb_astra_w${W}`,prefix=W===2?'pb-astra':`pb-astra-w${W}`;
const save=(name:string,x:any)=>writeFileSync(`${OUT}/${prefix}-${name}.json`,JSON.stringify(x,null,2)+'\n');
const phase=process.argv[2]??'load';assert(['load','finish','measure','plans','short','baseline'].includes(phase));
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:2,options:'-c statement_timeout=90000'});
await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);
const lock='.local/research/measure.lock',owner=`m1-astra-pb ${process.pid}`,stop=Date.parse('2026-09-28T19:48:30Z');let held=false;
const deadline=()=>assert(Date.now()<stop,'deadline reached; preserve completed results');
const report:any={started:new Date().toISOString(),w:W,rows:0,fields:['memo','address'],scope:B_SCOPE,phase};
function key(field:string,piece:string){return createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers',field,W===2?'pb-w2':`pb-w${W}-n${Array.from(piece).length}`,piece].join('\0')).digest();}
function encode(field:string,text:string,keys:Map<string,Buffer>){const cs=Array.from(normalize(text)),salt=randomBytes(16),stamps:bigint[]=[];for(let width=2;width<=W;width++)for(let p=0;p+width<=cs.length;p++){const piece=cs.slice(p,p+width).join(''),name=field+'\0'+piece;let k=keys.get(name);if(!k){k=key(field,piece);keys.set(name,k);}const pos=Buffer.alloc(4);pos.writeUInt32BE(p);stamps.push(hash('sha256',Buffer.concat([k,salt,pos]),'buffer').readBigInt64BE());}stamps.sort((a,b)=>a<b?-1:a>b?1:0);return {salt:salt.toString('hex'),n:cs.length,stamps:stamps.map(String)};}
type Q={name:string;field:'memo'|'address';term:string};
async function compile(q:Q,mode:'count'|'list',onlyCandidates=false){
 const chars=Array.from(normalize(q.term));assert(chars.length>=2);const params:unknown[]=[B_SCOPE];
 const cand=await candidate({field:q.field,op:'contains',value:q.term},'customers',params,'j');
 const candidateParams=params.length;
 const width=Math.min(W,chars.length),offsets:number[]=[];for(let i=0;i+width<=chars.length;i+=width)offsets.push(i);if(offsets.at(-1)!==chars.length-width)offsets.push(chars.length-width);
 const tests=offsets.map(off=>{params.push(key(q.field,chars.slice(off,off+width).join('')));return `(('x'||encode(substr(sha256($${params.length}::bytea||j.salt_${q.field}||int4send(g.p+${off})),1,8),'hex'))::bit(64)::bigint)=ANY(j.stamps_${q.field})`;});
 const verify=onlyCandidates?'TRUE':`EXISTS(SELECT 1 FROM generate_series(0,j.n_${q.field}-${chars.length}) AS g(p) WHERE ${tests.join(' AND ')})`;
 const from=`(SELECT j.* FROM ${TABLE} j WHERE scope_id=$1 AND ${cand} ORDER BY id OFFSET 0) j`;
 const text=mode==='list'?`SELECT j.id FROM ${from} WHERE ${verify} ORDER BY j.id LIMIT 300`:`SELECT count(*)::int n FROM ${TABLE} j WHERE j.scope_id=$1 AND ${cand} AND ${verify}`;
 return {text,params:onlyCandidates?params.slice(0,candidateParams):params,windows:offsets.length,length:chars.length};
}
const med=(x:number[])=>[...x].sort((a,b)=>a-b)[x.length>>1];
async function timed(fn:()=>Promise<{value:any;dbMs:number}>){const t=performance.now(),r=await fn();return {value:r.value,totalMs:performance.now()-t,dbMs:r.dbMs};}
async function run(q:Q,mode:'count'|'list',path:'plain'|'position'){
 let text:string,params:unknown[];
 if(path==='plain'){text=`SELECT ${mode==='count'?'count(*)::int n':'id'} FROM research_u.pb_astra_plain WHERE scope_id=$1 AND ${q.field}_norm LIKE '%'||$2||'%'${mode==='list'?' ORDER BY id LIMIT 300':''}`;params=[B_SCOPE,normalize(q.term)];}
 else({text,params}=await compile(q,mode));
 const t=performance.now(),rows=(await pool.query(text,params)).rows,dbMs=performance.now()-t;
 return {value:mode==='count'?rows[0].n:rows.map(r=>r.id),dbMs};
}
try{
 while(true){deadline();try{writeFileSync(lock,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;break;}catch(e:any){if(e.code!=='EEXIST')throw e;console.log('waiting',readFileSync(lock,'utf8'));await new Promise(r=>setTimeout(r,10000));}}
 console.log('lock acquired',owner);
 if(phase==='baseline'){
  assert.equal((await pool.query("SELECT to_regclass('research_u.pb_astra_b') x")).rows[0].x,null);
  await pool.query('CREATE TABLE research_u.pb_astra_b AS SELECT id,scope_id,cs_memo,cs_address,salt_memo,jt_memo,jx_memo,salt_address,jt_address,jx_address FROM research_u.b_customers_tags');
  await pool.query('ALTER TABLE research_u.pb_astra_b ADD PRIMARY KEY(id)');await pool.query('CREATE INDEX pb_astra_b_gin ON research_u.pb_astra_b USING gin(cs_memo,cs_address)');await pool.query('ANALYZE research_u.pb_astra_b');
  const rows=(await pool.query('SELECT count(*)::int n FROM research_u.pb_astra_b')).rows[0].n;assert.equal(rows,100000);
  save('baseline',{rows,sizes:(await pool.query(`SELECT relname,pg_relation_size(relid)::text heap,pg_indexes_size(relid)::text indexes,pg_total_relation_size(relid)::text total FROM pg_stat_user_tables WHERE schemaname='research_u' AND relname IN('pb_astra_plain','pb_astra_b','pb_astra_w2','pb_astra_w4') ORDER BY relname`)).rows});
 }else if(phase==='load'||phase==='finish'){
  if(phase==='load'){
  assert.equal((await pool.query('SELECT to_regclass($1) x',[TABLE])).rows[0].x,null,'new tables only; existing pb table is not overwritten');
  await pool.query(`CREATE TABLE ${TABLE}(id uuid PRIMARY KEY,scope_id uuid NOT NULL,cs_memo bigint[] NOT NULL,cs_address bigint[] NOT NULL,salt_memo bytea NOT NULL,n_memo int NOT NULL,stamps_memo bigint[] NOT NULL,salt_address bytea NOT NULL,n_address int NOT NULL,stamps_address bigint[] NOT NULL)`);
  const start=performance.now();let last:string|undefined;
  while(report.rows<100000){deadline();const rows=(await pool.query(`SELECT p.id,p.scope_id,p.memo_norm,p.address_norm,b.cs_memo,b.cs_address FROM research_u.customers_plain p JOIN research_u.b_customers_tags b USING(id,scope_id) WHERE p.scope_id=$1${last?' AND p.id>$2::uuid':''} ORDER BY p.id LIMIT 1000`,last?[B_SCOPE,last]:[B_SCOPE])).rows;assert(rows.length);
   const keys=new Map<string,Buffer>(),data=rows.map(r=>({id:r.id,scope:r.scope_id,cm:r.cs_memo,ca:r.cs_address,m:encode('memo',r.memo_norm,keys),a:encode('address',r.address_norm,keys)}));
   await pool.query(`INSERT INTO ${TABLE} SELECT (x->>'id')::uuid,(x->>'scope')::uuid,ARRAY(SELECT jsonb_array_elements_text(x->'cm')::bigint),ARRAY(SELECT jsonb_array_elements_text(x->'ca')::bigint),decode(x->'m'->>'salt','hex'),(x->'m'->>'n')::int,ARRAY(SELECT jsonb_array_elements_text(x->'m'->'stamps')::bigint),decode(x->'a'->>'salt','hex'),(x->'a'->>'n')::int,ARRAY(SELECT jsonb_array_elements_text(x->'a'->'stamps')::bigint) FROM jsonb_array_elements($1::jsonb) x`,[JSON.stringify(data)]);
   report.rows+=rows.length;last=rows.at(-1)!.id;report.loadMs=performance.now()-start;save('load',report);if(report.rows%10000===0)console.log('loaded',report.rows,Math.round(report.loadMs));
  }
  const ti=performance.now();await pool.query(`CREATE INDEX ${NAME}_gin ON ${TABLE} USING gin(cs_memo,cs_address)`);await pool.query(`ANALYZE ${TABLE}`);report.indexMs=performance.now()-ti;
  }else{Object.assign(report,JSON.parse(readFileSync(`${OUT}/${prefix}-load-error.json`,'utf8')));delete report.error;report.metadataRetry=true;}
  if(!(await pool.query("SELECT to_regclass('research_u.pb_astra_plain') x")).rows[0].x){
  await pool.query('CREATE TABLE research_u.pb_astra_plain AS SELECT id,scope_id,memo_norm,address_norm FROM research_u.customers_plain');await pool.query('ALTER TABLE research_u.pb_astra_plain ADD PRIMARY KEY(id)');
  for(const field of ['memo','address']){await pool.query(`CREATE INDEX pb_astra_plain_${field}_btree ON research_u.pb_astra_plain(${field}_norm)`);await pool.query(`CREATE INDEX pb_astra_plain_${field}_trgm ON research_u.pb_astra_plain USING gin(${field}_norm gin_trgm_ops)`);}
  await pool.query('ANALYZE research_u.pb_astra_plain');
  }
  report.sizes=(await pool.query(`SELECT relname,pg_relation_size(relid)::text heap,pg_indexes_size(relid)::text indexes,pg_total_relation_size(relid)::text total,n_live_tup FROM pg_stat_user_tables WHERE schemaname='research_u' AND relname=ANY($1::text[]) ORDER BY relname`,[[NAME,'pb_astra_plain']])).rows;
  report.logical=(await pool.query(`SELECT count(*)::int rows,sum(cardinality(stamps_memo)+cardinality(stamps_address))::text positional_stamps,avg(n_memo)::float8 memo_chars,avg(n_address)::float8 address_chars FROM ${TABLE}`)).rows[0];assert.equal(report.logical.rows,100000);
  report.previousB=(await pool.query(`SELECT sum(cardinality(jt_memo)+cardinality(jt_address)+2)::text stamps FROM research_u.b_customers_tags`)).rows[0];
  const qs:Q[]=[];
  for(const field of ['memo','address'] as const){const groups=(await pool.query(`SELECT substring(${field}_norm FROM 2 FOR 10) term,count(*)::int n FROM research_u.pb_astra_plain WHERE char_length(${field}_norm)>=11 GROUP BY 1 ORDER BY n DESC,term`)).rows;assert(groups.length>=2);qs.push({name:field+'_common10',field,term:groups[0].term},{name:field+'_rare10',field,term:groups.at(-1)!.term});}
  qs.push({name:'memo_repeat45',field:'memo',term:'상세안내와확인내용'.repeat(5)});save('queries',qs);
  report.finished=new Date().toISOString();save('load',report);console.log('load done',JSON.stringify(report));
 }else{
  let qs:Q[]=JSON.parse(readFileSync(`${OUT}/${prefix}-queries.json`,'utf8'));const results:any[]=[];
  if(phase==='short')qs=qs.filter(q=>q.name==='memo_common10').flatMap(q=>[2,3].map(n=>({...q,name:'memo_short'+n,term:Array.from(q.term).slice(0,n).join('')})));
  for(const q of qs)for(const mode of ['count','list'] as const){deadline();
   const r:any={...q,mode,targetRows:100000,limit:mode==='list'?300:null,projection:mode==='list'?['id']:['count'],appDecrypts:0,first:{},runs:{plain:[],position:[]}};results.push(r);
   try{
    const compiled=await compile(q,mode);r.windows=compiled.windows;r.length=compiled.length;
    const cq=await compile(q,'count',true);r.candidates=(await pool.query(cq.text,cq.params)).rows[0].n;
    r.truth=(await run(q,'count','plain')).value;
    const expected=(await run(q,mode,'plain')).value;r.resultRows=Array.isArray(expected)?expected.length:1;
    if(phase==='plans'){r.sql=compiled.text;r.plan=(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+compiled.text,compiled.params)).rows[0]['QUERY PLAN'];}
    else{for(let round=-3;round<7;round++){deadline();for(const path of (round%2?['position','plain']:['plain','position']) as ('plain'|'position')[]){const s=await timed(()=>run(q,mode,path));assert.deepEqual(s.value,expected,'count or ordered IDs mismatch');const {value,...metric}=s;if(round===-3)r.first[path]=metric;if(round>=0)r.runs[path].push(metric);}}
     r.medians=Object.fromEntries(['plain','position'].map(p=>[p,{totalMs:med(r.runs[p].map((x:any)=>x.totalMs)),dbMs:med(r.runs[p].map((x:any)=>x.dbMs))}]));r.ratio={total:r.medians.position.totalMs/r.medians.plain.totalMs,sql:r.medians.position.dbMs/r.medians.plain.dbMs};console.log(q.name,mode,r.truth,JSON.stringify(r.medians));}
   }catch(e:any){r.error=String(e.message);save(phase,results);throw e;}save(phase,results);
  }
 }
}catch(e:any){report.error=String(e.message);save(phase+'-error',report);throw e;}
finally{await pool.end();if(held&&existsSync(lock)&&readFileSync(lock,'utf8').startsWith(owner))unlinkSync(lock);}

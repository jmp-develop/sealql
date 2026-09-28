import assert from 'node:assert/strict';
import {createHmac,hash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
import {candidate,writeTokens} from '../research-unified/b-product.js';
import {normalize,B_SCOPE} from '../research-unified/b-codec.js';
const root='bench/results/2026-09-29-task1',phase=process.argv[2],dataset=process.argv[3]??'short';
assert(['diagnose','recount','load','measure','stats','plans'].includes(phase));assert(['short','500','1000'].includes(dataset));
const save=(name:string,x:any)=>writeFileSync(`${root}/pb1d-astra-${name}.json`,JSON.stringify(x,null,2)+'\n');
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,options:'-c statement_timeout=120000'});
await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);
const lock='.local/research/measure.lock',owner=`m1-astra-pb1d ${process.pid}`;let held=false;
const deadline=()=>assert(Date.now()<Date.parse('2026-09-28T20:48:00Z'),'deadline reached');
type Q={name:string;field:'memo'|'address';term:string};type Path='plain'|'position2'|'position4'|'occurrence2'|'occurrence4'|'fast2'|'fast4';
const paths:Path[]=dataset==='short'?['plain','position2','position4','occurrence2','occurrence4','fast2','fast4']:['plain','position2','position4','fast2','fast4'];
function key(field:string,piece:string,w:number,occ:boolean){return createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers',field,occ?`pb1b-w${w}-n${Array.from(piece).length}`:w===2?'pb-w2':`pb-w${w}-n${Array.from(piece).length}`,piece].join('\0')).digest();}
function encoded(text:string,w:number,occ:boolean,cache:Map<string,Buffer>){const cs=Array.from(text),salt=randomBytes(16),pairs:{s:bigint;p:number}[]=[];for(let width=2;width<=w;width++){const counts=new Map<string,number>();for(let p=0;p+width<=cs.length;p++){const piece=cs.slice(p,p+width).join(''),id=`${w}:${occ}:${piece}`;let k=cache.get(id);if(!k){k=key('memo',piece,w,occ);cache.set(id,k);}const i=(counts.get(piece)??0)+1;counts.set(piece,i);const b=Buffer.alloc(4);b.writeUInt32BE(occ?i:p);pairs.push({s:hash('sha256',Buffer.concat([k,salt,b]),'buffer').readBigInt64BE(),p});}}pairs.sort((a,b)=>a.s<b.s?-1:a.s>b.s?1:0);for(let i=1;i<pairs.length;i++)assert.notEqual(pairs[i-1].s,pairs[i].s,'field stamp collision');return {salt:salt.toString('hex'),n:cs.length,s:pairs.map(p=>String(p.s)),p:pairs.map(p=>p.p)};}
async function compile(q:Q,mode:'count'|'list',path:Path,onlyCandidates=false,instrument=false){
 const long=dataset!=='short';if(path==='plain')return {text:`SELECT ${mode==='count'?'count(*)::int n':'id'} FROM research_u.${long?`pb_1d_plain_${dataset}`:'pb_astra_plain'} WHERE scope_id=$1 AND ${q.field}_norm LIKE '%'||$2||'%'${mode==='list'?' ORDER BY id LIMIT 300':''}`,params:[B_SCOPE,normalize(q.term).replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')]};
 const w=Number(path.at(-1)),occ=!path.startsWith('position'),fast=path.startsWith('fast'),table=long?`research_u.pb_1d_${occ?'o':'p'}${w}_${dataset}`:occ?`research_u.pb_1b_w${w}`:`research_u.pb_astra_w${w}`;
 const cs=Array.from(normalize(q.term)),width=Math.min(w,cs.length),offs:number[]=[];for(let i=0;i+width<=cs.length;i+=width)offs.push(i);if(offs.at(-1)!==cs.length-width)offs.push(cs.length-width);
 const params:unknown[]=[B_SCOPE],cand=await candidate({field:q.field,op:'contains',value:q.term},'customers',params,'j');
 if(onlyCandidates)return {text:`SELECT count(*)::int n FROM ${table} j WHERE scope_id=$1 AND ${cand}`,params};
 const ks=offs.map(off=>{params.push(key(q.field,cs.slice(off,off+width).join(''),w,occ));return `$${params.length}::bytea`;});
 const ev=occ?`research_u.${fast?'pb_1d_fast':'pb_1b_eval_native'}(ARRAY[${ks.join(',')}],ARRAY[${offs.join(',')}],${cs.length},j.n_${q.field},j.salt_${q.field},j.stamps_${q.field},j.positions_${q.field})`:'';
 const sha=instrument?'research_u.pb_1d_hash':'sha256';
 const verify=occ?`(${ev})[1]=1`:`EXISTS(SELECT 1 FROM generate_series(0,j.n_${q.field}-${cs.length}) g(p) WHERE ${ks.map((k,i)=>`(('x'||encode(substr(${sha}(${k}||j.salt_${q.field}||int4send(g.p+${offs[i]})),1,8),'hex'))::bit(64)::bigint)=ANY(j.stamps_${q.field})`).join(' AND ')})`;
 const from=`(SELECT j.* FROM ${table} j WHERE scope_id=$1 AND ${cand} ORDER BY id OFFSET 0) j`;
 return {text:mode==='list'?`SELECT j.id FROM ${from} WHERE ${verify} ORDER BY j.id LIMIT 300`:`SELECT count(*)::int n FROM ${table} j WHERE scope_id=$1 AND ${cand} AND ${verify}`,params,windows:offs.length,statsSql:occ?`SELECT count(*)::int candidates,sum(v[1])::int matches,sum(v[2])::text hashes,max(v[2])::int max_hashes,sum(v[3])::text lookups FROM (SELECT ${ev} v FROM ${table} j WHERE scope_id=$1 AND ${cand} OFFSET 0) z`:undefined};
}
async function run(q:Q,mode:'count'|'list',path:Path){const t=performance.now(),c=await compile(q,mode,path),ts=performance.now(),rows=(await pool.query(c.text,c.params)).rows,dbMs=performance.now()-ts;return {value:mode==='count'?rows[0].n:rows.map(r=>r.id),dbMs,totalMs:performance.now()-t};}
const med=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
async function hashCalls(text:string,params:unknown[]){
 await pool.query('BEGIN');try{await pool.query("SET LOCAL track_functions='all'");await pool.query('SET LOCAL max_parallel_workers_per_gather=0');
 const calls=async()=>Number((await pool.query("SELECT calls::text FROM pg_stat_xact_user_functions WHERE schemaname='research_u' AND funcname='pb_1d_hash'")).rows[0]?.calls??0);
 const initial=await calls();await pool.query('SELECT sum(length(research_u.pb_1d_hash(int4send(x)))) FROM generate_series(1,7) x');const before=await calls();assert.equal(before-initial,7,'hash counter calibration must count seven calls');
 const result=(await pool.query(text,params)).rows[0],after=await calls();await pool.query('COMMIT');return {result,calls:String(after-before),before,after,calibration:7};
 }catch(e){await pool.query('ROLLBACK');throw e;}
}
try{
 while(!held){deadline();try{writeFileSync(lock,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;}catch(e:any){if(e.code!=='EEXIST')throw e;console.log('waiting',readFileSync(lock,'utf8'));await new Promise(r=>setTimeout(r,10000));}}
 const session={...(await pool.query("SELECT pg_backend_pid() pid,version() version,current_setting('work_mem') work_mem")).rows[0],started:new Date().toISOString()};console.log('lock acquired',session.pid,phase,dataset);
 if(phase==='diagnose'||phase==='recount'){
  if(phase==='diagnose'){
  assert.equal((await pool.query("SELECT to_regprocedure('research_u.pb_1d_fast(bytea[],integer[],integer,integer,bytea,bigint[],integer[])') x")).rows[0].x,null);
  await pool.query(`CREATE FUNCTION research_u.pb_1d_fast(ks bytea[],offs int[],qlen int,n int,salt bytea,stamps bigint[],positions int[]) RETURNS int[] LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
   DECLARE first_i int:=1; i int; wi int; idx int; p int; target_p int; got_p int; tag bigint; ok bool; hashes int:=0;
   BEGIN
    IF n<qlen THEN RETURN ARRAY[0,0,0];END IF;
    LOOP
     tag:=(('x'||encode(substr(sha256(ks[1]||salt||int4send(first_i)),1,8),'hex'))::bit(64)::bigint);hashes:=hashes+1;
     idx:=array_position(stamps,tag);IF idx IS NULL THEN RETURN ARRAY[0,hashes,hashes];END IF;
     p:=positions[idx];IF p>n-qlen THEN RETURN ARRAY[0,hashes,hashes];END IF;ok:=true;
     IF cardinality(ks)>1 THEN FOR wi IN 2..cardinality(ks) LOOP
      target_p:=p+offs[wi];i:=1;
      LOOP
       tag:=(('x'||encode(substr(sha256(ks[wi]||salt||int4send(i)),1,8),'hex'))::bit(64)::bigint);hashes:=hashes+1;
       idx:=array_position(stamps,tag);IF idx IS NULL THEN ok:=false;EXIT;END IF;
       got_p:=positions[idx];IF got_p>=target_p THEN ok:=got_p=target_p;EXIT;END IF;i:=i+1;
      END LOOP;
      IF NOT ok THEN EXIT;END IF;
     END LOOP;END IF;
     IF ok THEN RETURN ARRAY[1,hashes,hashes];END IF;first_i:=first_i+1;
    END LOOP;
   END $fn$`);
  await pool.query('CREATE FUNCTION research_u.pb_1d_hash(b bytea) RETURNS bytea LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$ BEGIN RETURN sha256(b); END $$');
  }
  const qs:Q[]=JSON.parse(readFileSync(`${root}/pb-astra-queries.json`,'utf8')).filter((q:Q)=>['memo_common10','address_common10'].includes(q.name));qs.push({name:'memo_short2',field:'memo',term:'up'});const results:any[]=[];
  for(const q of qs)for(const path of paths.slice(1)){deadline();const c=await compile(q,'count',path),cq=await compile(q,'count',path,true),r:any={...q,path,session,sql:c.text,candidates:(await pool.query(cq.text,cq.params)).rows[0].n};results.push(r);r.plan=(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+c.text,c.params)).rows[0]['QUERY PLAN'];
   if(c.statsSql)r.stats=(await pool.query(c.statsSql,c.params)).rows[0];
   else{try{const ic=await compile(q,'count',path,false,true);r.hashStats=await hashCalls(ic.text,ic.params);r.instrumentedResult=r.hashStats.result;}catch(e:any){r.instrumentationError=e.message;}}
   save(phase,results);console.log(q.name,path,'hashes',r.stats?.hashes??r.hashStats?.calls,'time',r.plan[0]['Execution Time']);
  }
 }else if(phase==='load'){
  assert(dataset!=='short');const length=Number(dataset),rowsCount=1000;
  const source=(await pool.query('SELECT id,memo_norm FROM research_u.customers_plain WHERE scope_id=$1 ORDER BY id',[B_SCOPE])).rows;assert.equal(source.length,100000);
  const tables=[`pb_1d_plain_${length}`,...['p2','p4','o2','o4'].map(p=>`pb_1d_${p}_${length}`)];for(const name of tables)assert.equal((await pool.query('SELECT to_regclass($1) x',['research_u.'+name])).rows[0].x,null,'never overwrite existing table');
  await pool.query(`CREATE TABLE research_u.${tables[0]}(id uuid PRIMARY KEY,scope_id uuid NOT NULL,memo_norm text NOT NULL,source_start int NOT NULL,source_rows int NOT NULL)`);
  for(const mode of ['p2','p4','o2','o4'])await pool.query(`CREATE TABLE research_u.pb_1d_${mode}_${length}(id uuid PRIMARY KEY,scope_id uuid NOT NULL,cs_memo bigint[] NOT NULL,salt_memo bytea NOT NULL,n_memo int NOT NULL,stamps_memo bigint[] NOT NULL${mode.startsWith('o')?',positions_memo int[] NOT NULL':''})`);
  const report:any={length,rows:0,session,sourceRows:100000,source:'research_u.customers_plain derived from existing fixture',derivation:'row i starts at source index i*64 in ID order, concatenate normalized memo strings without separator and take first L Unicode codepoints',started:new Date().toISOString(),insertMs:{},hashingMs:{},tokensMs:0,plainMs:0,tableNames:tables};const start=performance.now();let firstText='';
  for(let offset=0;offset<rowsCount;offset+=25){deadline();const data:any[]=[];const caches=Object.fromEntries(['p2','p4','o2','o4'].map(m=>[m,new Map<string,Buffer>()]));
   for(let i=offset;i<Math.min(offset+25,rowsCount);i++){const si=i*64;let value='',taken=0;while(Array.from(value).length<length){assert(si+taken<source.length);value+=source[si+taken].memo_norm;taken++;}const text=Array.from(value).slice(0,length).join('');assert.equal(normalize(text),text);if(i===0)firstText=text;
    const item:any={id:source[si].id,scope:B_SCOPE,text,si,taken};const t=performance.now();item.cs=(await writeTokens('customers','memo',text)).cs;report.tokensMs+=performance.now()-t;
    for(const m of ['p2','p4','o2','o4']){const tm=performance.now();item[m]=encoded(text,Number(m[1]),m[0]==='o',caches[m]);report.hashingMs[m]=(report.hashingMs[m]??0)+performance.now()-tm;}data.push(item);
   }
   const pt=performance.now();await pool.query(`INSERT INTO research_u.${tables[0]} SELECT (x->>'id')::uuid,(x->>'scope')::uuid,x->>'text',(x->>'si')::int,(x->>'taken')::int FROM jsonb_array_elements($1::jsonb) x`,[JSON.stringify(data.map(({id,scope,text,si,taken})=>({id,scope,text,si,taken})))]);report.plainMs+=performance.now()-pt;
   for(const m of ['p2','p4','o2','o4']){const t=performance.now();await pool.query(`INSERT INTO research_u.pb_1d_${m}_${length} SELECT (x->>'id')::uuid,(x->>'scope')::uuid,ARRAY(SELECT jsonb_array_elements_text(x->'cs')::bigint),decode(x->'v'->>'salt','hex'),(x->'v'->>'n')::int,ARRAY(SELECT jsonb_array_elements_text(x->'v'->'s')::bigint)${m[0]==='o'?',ARRAY(SELECT jsonb_array_elements_text(x->\'v\'->\'p\')::int)':''} FROM jsonb_array_elements($1::jsonb) x`,[JSON.stringify(data.map(r=>({id:r.id,scope:r.scope,cs:r.cs,v:r[m]})))]);report.insertMs[m]=(report.insertMs[m]??0)+performance.now()-t;}
   report.rows+=data.length;report.wallMs=performance.now()-start;save(`load-${length}`,report);if(report.rows%100===0)console.log('loaded',length,report.rows,Math.round(report.wallMs));
  }
  report.indexMs={};for(const name of tables){const t=performance.now();if(name===tables[0]){await pool.query(`CREATE INDEX ${name}_btree ON research_u.${name}(memo_norm)`);await pool.query(`CREATE INDEX ${name}_trgm ON research_u.${name} USING gin(memo_norm gin_trgm_ops)`);}else await pool.query(`CREATE INDEX ${name}_gin ON research_u.${name} USING gin(cs_memo)`);await pool.query(`ANALYZE research_u.${name}`);report.indexMs[name]=performance.now()-t;assert.equal((await pool.query(`SELECT count(*)::int n FROM research_u.${name}`)).rows[0].n,rowsCount);}
  save(`load-${length}`,report);
  const qs:Q[]=[{name:'common10',field:'memo',term:'upportcase'},{name:'actual20',field:'memo',term:Array.from(firstText).slice(250,270).join('')},{name:'actual45',field:'memo',term:Array.from(firstText).slice(100,145).join('')},{name:'repeat45',field:'memo',term:'상세안내와확인내용'.repeat(5)},{name:'short2',field:'memo',term:'up'}];save(`queries-${length}`,qs);
 }else if(phase==='plans'){
  assert(dataset!=='short');const qs:Q[]=JSON.parse(readFileSync(`${root}/pb1d-astra-queries-${dataset}.json`,'utf8')).filter((q:Q)=>['actual20','actual45'].includes(q.name));const results:any[]=[];
  for(const q of qs)for(const p of paths.slice(1)){deadline();const c=await compile(q,'count',p);results.push({...q,path:p,session,plan:(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+c.text,c.params)).rows[0]['QUERY PLAN']});save(`plans-${dataset}`,results);}
 }else{
  const qs:Q[]=dataset==='short'?[...JSON.parse(readFileSync(`${root}/pb-astra-queries.json`,'utf8')).filter((q:Q)=>['memo_common10','address_common10'].includes(q.name)),{name:'memo_short2',field:'memo',term:'up'}]:JSON.parse(readFileSync(`${root}/pb1d-astra-queries-${dataset}.json`,'utf8'));if(dataset!=='short')qs.sort((a,b)=>Number(a.name==='repeat45')-Number(b.name==='repeat45'));const results:any[]=[];
  for(const q of qs)for(const mode of (phase==='stats'?['count']:['count','list']) as ('count'|'list')[]){deadline();const expected=(await run(q,mode,'plain')).value,r:any={...q,mode,dataset,session,appDecrypts:0,sqlCallsPerRun:1,truth:(await run(q,'count','plain')).value,resultRows:Array.isArray(expected)?expected.length:1,first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),candidates:{}};results.push(r);
   for(const p of paths.slice(1)){const c=await compile(q,'count',p,true);r.candidates[p]=(await pool.query(c.text,c.params)).rows[0].n;}assert.equal(new Set(Object.values(r.candidates)).size,1);
   if(phase==='stats'){r.stats={};for(const p of paths.slice(1)){const c=await compile(q,mode,p);if(c.statsSql){r.stats[p]=(await pool.query(c.statsSql,c.params)).rows[0];assert.equal(r.stats[p].matches,r.truth);}else{const ic=await compile(q,mode,p,false,true),h=await hashCalls(ic.text,ic.params);assert.equal(h.result.n,r.truth);r.stats[p]={...h,hashes:h.calls};}}}
   else{for(let round=-3;round<7;round++){deadline();const offset=(round+3)%paths.length,order=[...paths.slice(offset),...paths.slice(0,offset)];for(const p of order){const x=await run(q,mode,p);assert.deepEqual(x.value,expected,`${dataset} ${q.name} ${mode} ${p} mismatch`);const {value,...metric}=x;if(round===-3)r.first[p]=metric;if(round>=0)r.runs[p].push(metric);r.lastProgress={at:new Date().toISOString(),round,path:p};save(`${phase}-${dataset}`,results);}if(q.name==='repeat45')console.log('repeat45 progress',dataset,mode,round);}r.medians=Object.fromEntries(paths.map(p=>[p,{dbMs:med(r.runs[p].map((x:any)=>x.dbMs)),totalMs:med(r.runs[p].map((x:any)=>x.totalMs))}]));console.log(dataset,q.name,mode,r.truth,JSON.stringify(r.medians));}
   r.finished=new Date().toISOString();save(`${phase}-${dataset}`,results);
  }
  assert.equal((await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid,session.pid);
 }
 save('sizes',{at:new Date().toISOString(),sizes:(await pool.query("SELECT relname,pg_relation_size(relid)::text heap,pg_indexes_size(relid)::text indexes,pg_total_relation_size(relid)::text total FROM pg_stat_user_tables WHERE schemaname='research_u' AND relname LIKE 'pb_1d_%' ORDER BY relname")).rows});
}catch(e:any){save(`${phase}-${dataset}-error`,{message:e.message,at:new Date().toISOString()});throw e;}
finally{await pool.end();if(held&&existsSync(lock)&&readFileSync(lock,'utf8').startsWith(owner))unlinkSync(lock);}

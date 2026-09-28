import assert from 'node:assert/strict';
import {createHmac,hash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
import {candidate} from '../research-unified/b-product.js';
import {normalize,B_SCOPE} from '../research-unified/b-codec.js';
const root='bench/results/2026-09-29-task1',phase=process.argv[2]??'load';
assert(['load','measure','stats','native'].includes(phase));
const native=process.argv[3]==='native';
const save=(name:string,x:any)=>writeFileSync(`${root}/pb1b-astra-${name}.json`,JSON.stringify(x,null,2)+'\n');
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,options:'-c statement_timeout=90000'});
await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);
const lock='.local/research/measure.lock',owner=`m1-astra-pb1b ${process.pid}`;let held=false;
const deadline=()=>assert(Date.now()<Date.parse('2026-09-28T20:23:00Z'),'deadline reached');
type Q={name:string;field:'memo'|'address';term:string};
type Path='plain'|'position2'|'position4'|'occurrence2'|'occurrence4';
const paths:Path[]=['plain','position2','position4','occurrence2','occurrence4'];
function key(field:string,piece:string,w:number,occ:boolean){return createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers',field,occ?`pb1b-w${w}-n${Array.from(piece).length}`:w===2?'pb-w2':`pb-w${w}-n${Array.from(piece).length}`,piece].join('\0')).digest();}
function encode(field:string,text:string,w:number,cache:Map<string,Buffer>){
 const cs=Array.from(normalize(text)),salt=randomBytes(16),pairs:{s:bigint;p:number}[]=[];
 for(let width=2;width<=w;width++){const counts=new Map<string,number>();for(let p=0;p+width<=cs.length;p++){
  const piece=cs.slice(p,p+width).join(''),id=field+'\0'+piece;let k=cache.get(id);if(!k){k=key(field,piece,w,true);cache.set(id,k);}
  const i=(counts.get(piece)??0)+1;counts.set(piece,i);const ib=Buffer.alloc(4);ib.writeUInt32BE(i);
  pairs.push({s:hash('sha256',Buffer.concat([k,salt,ib]),'buffer').readBigInt64BE(),p});
 }}
 pairs.sort((a,b)=>a.s<b.s?-1:a.s>b.s?1:0);for(let i=1;i<pairs.length;i++)assert.notEqual(pairs[i].s,pairs[i-1].s,'64-bit collision within field');
 return {salt:salt.toString('hex'),n:cs.length,s:pairs.map(v=>String(v.s)),p:pairs.map(v=>v.p)};
}
async function compile(q:Q,mode:'count'|'list',path:Path,onlyCandidates=false){
 if(path==='plain')return {text:`SELECT ${mode==='count'?'count(*)::int n':'id'} FROM research_u.pb_astra_plain WHERE scope_id=$1 AND ${q.field}_norm LIKE '%'||$2||'%'${mode==='list'?' ORDER BY id LIMIT 300':''}`,params:[B_SCOPE,normalize(q.term)],windows:0};
 const w=Number(path.at(-1)),occ=path.startsWith('occurrence'),table=occ?`research_u.pb_1b_w${w}`:`research_u.pb_astra_w${w}`;
 const chars=Array.from(normalize(q.term)),width=Math.min(w,chars.length),offsets:number[]=[];
 for(let i=0;i+width<=chars.length;i+=width)offsets.push(i);if(offsets.at(-1)!==chars.length-width)offsets.push(chars.length-width);
 const params:unknown[]=[B_SCOPE],cand=await candidate({field:q.field,op:'contains',value:q.term},'customers',params,'j');
 if(onlyCandidates)return {text:`SELECT count(*)::int n FROM ${table} j WHERE scope_id=$1 AND ${cand}`,params,windows:offsets.length};
 const ks=offsets.map(off=>{params.push(key(q.field,chars.slice(off,off+width).join(''),w,occ));return `$${params.length}::bytea`;});
 const evalSql=occ?`research_u.${native?'pb_1b_eval_native':'pb_1b_eval'}(ARRAY[${ks.join(',')}],ARRAY[${offsets.join(',')}],${chars.length},j.n_${q.field},j.salt_${q.field},j.stamps_${q.field},j.positions_${q.field})`:'';
 const verify=occ?`(${evalSql})[1]=1`:`EXISTS(SELECT 1 FROM generate_series(0,j.n_${q.field}-${chars.length}) g(p) WHERE ${ks.map((k,i)=>`(('x'||encode(substr(sha256(${k}||j.salt_${q.field}||int4send(g.p+${offsets[i]})),1,8),'hex'))::bit(64)::bigint)=ANY(j.stamps_${q.field})`).join(' AND ')})`;
 const from=`(SELECT j.* FROM ${table} j WHERE scope_id=$1 AND ${cand} ORDER BY id OFFSET 0) j`;
 return {text:mode==='list'?`SELECT j.id FROM ${from} WHERE ${verify} ORDER BY j.id LIMIT 300`:`SELECT count(*)::int n FROM ${table} j WHERE scope_id=$1 AND ${cand} AND ${verify}`,params,windows:offsets.length,statsSql:occ?`SELECT count(*)::int candidates,sum((v)[1])::int matches,sum((v)[2])::text hashes,max((v)[2])::int max_hashes,sum((v)[3])::text comparisons,max((v)[3])::int max_comparisons FROM (SELECT ${evalSql} v FROM ${table} j WHERE scope_id=$1 AND ${cand} OFFSET 0) z`:undefined};
}
async function run(q:Q,mode:'count'|'list',path:Path){const start=performance.now(),c=await compile(q,mode,path),t=performance.now(),rows=(await pool.query(c.text,c.params)).rows,dbMs=performance.now()-t;return {value:mode==='count'?rows[0].n:rows.map(r=>r.id),dbMs,totalMs:performance.now()-start};}
const med=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
try{
 while(!held){deadline();try{writeFileSync(lock,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;}catch(e:any){if(e.code!=='EEXIST')throw e;console.log('waiting',readFileSync(lock,'utf8'));await new Promise(r=>setTimeout(r,10000));}}
 const session=(await pool.query('SELECT pg_backend_pid() pid,version() version,current_setting(\'work_mem\') work_mem')).rows[0];console.log('lock acquired',session);
 if(phase==='native'){
  assert.equal((await pool.query("SELECT to_regprocedure('research_u.pb_1b_eval_native(bytea[],integer[],integer,integer,bytea,bigint[],integer[])') x")).rows[0].x,null);
  const def=(await pool.query("SELECT pg_get_functiondef('research_u.pb_1b_eval(bytea[],integer[],integer,integer,bytea,bigint[],integer[])'::regprocedure) definition")).rows[0].definition as string;
  const next=def.replace('CREATE OR REPLACE FUNCTION research_u.pb_1b_eval(', 'CREATE FUNCTION research_u.pb_1b_eval_native(').replace(/lo:=1;hi:=cardinality\(stamps\);found:=0;[\s\S]*?END LOOP;/,'found:=coalesce(array_position(stamps,target),0);comparisons:=comparisons+1;');
  assert(next.includes('array_position(stamps,target)'));assert(!next.includes('WHILE lo<=hi'));await pool.query(next);save('native-function',{definition:next,created:new Date().toISOString()});
 }else if(phase==='load'){
  assert.equal((await pool.query("SELECT to_regprocedure('research_u.pb_1b_eval(bytea[],integer[],integer,integer,bytea,bigint[],integer[])') x")).rows[0].x,null);
  await pool.query(`CREATE FUNCTION research_u.pb_1b_eval(ks bytea[],offs int[],qlen int,n int,salt bytea,stamps bigint[],positions int[]) RETURNS int[] LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  DECLARE wi int; occurrence int; target bigint; lo int; hi int; mid int; found int; ps int[]; starts int[]; nexts int[]; p int; hashes int:=0; comparisons int:=0;
  BEGIN
   IF n<qlen THEN RETURN ARRAY[0,0,0]; END IF;
   FOR wi IN 1..cardinality(ks) LOOP
    ps:=ARRAY[]::int[]; occurrence:=1;
    LOOP
     target:=(('x'||encode(substr(sha256(ks[wi]||salt||int4send(occurrence)),1,8),'hex'))::bit(64)::bigint);hashes:=hashes+1;
     lo:=1;hi:=cardinality(stamps);found:=0;
     WHILE lo<=hi LOOP
      mid:=(lo+hi)/2;comparisons:=comparisons+1;
      IF stamps[mid]=target THEN found:=mid;EXIT; ELSIF stamps[mid]<target THEN lo:=mid+1;ELSE hi:=mid-1;END IF;
     END LOOP;
     IF found=0 THEN EXIT; END IF;
     ps:=array_append(ps,positions[found]);occurrence:=occurrence+1;
    END LOOP;
    IF wi=1 THEN
     starts:=ARRAY[]::int[];FOREACH p IN ARRAY ps LOOP IF p>=0 AND p<=n-qlen THEN starts:=array_append(starts,p);END IF;END LOOP;
    ELSE
     nexts:=ARRAY[]::int[];FOREACH p IN ARRAY starts LOOP IF p+offs[wi]=ANY(ps) THEN nexts:=array_append(nexts,p);END IF;END LOOP;starts:=nexts;
    END IF;
    IF cardinality(starts)=0 THEN RETURN ARRAY[0,hashes,comparisons];END IF;
   END LOOP;
   RETURN ARRAY[1,hashes,comparisons];
  END $fn$`);
  const reports:any[]=[];
  for(const w of [2,4]){
   const name=`pb_1b_w${w}`,table=`research_u.${name}`;assert.equal((await pool.query('SELECT to_regclass($1) x',[table])).rows[0].x,null);
   await pool.query(`CREATE TABLE ${table}(id uuid PRIMARY KEY,scope_id uuid NOT NULL,cs_memo bigint[] NOT NULL,cs_address bigint[] NOT NULL,salt_memo bytea NOT NULL,n_memo int NOT NULL,stamps_memo bigint[] NOT NULL,positions_memo int[] NOT NULL,salt_address bytea NOT NULL,n_address int NOT NULL,stamps_address bigint[] NOT NULL,positions_address int[] NOT NULL)`);
   const r:any={w,rows:0,session,started:new Date().toISOString()};reports.push(r);let last:string|undefined;const start=performance.now();
   while(r.rows<100000){deadline();const rows=(await pool.query(`SELECT p.id,p.scope_id,p.memo_norm,p.address_norm,b.cs_memo,b.cs_address FROM research_u.customers_plain p JOIN research_u.b_customers_tags b USING(id,scope_id) WHERE p.scope_id=$1${last?' AND p.id>$2::uuid':''} ORDER BY p.id LIMIT 1000`,last?[B_SCOPE,last]:[B_SCOPE])).rows;assert(rows.length);
    const cache=new Map<string,Buffer>(),data=rows.map(v=>({id:v.id,scope:v.scope_id,cm:v.cs_memo,ca:v.cs_address,m:encode('memo',v.memo_norm,w,cache),a:encode('address',v.address_norm,w,cache)}));
    await pool.query(`INSERT INTO ${table} SELECT (x->>'id')::uuid,(x->>'scope')::uuid,ARRAY(SELECT jsonb_array_elements_text(x->'cm')::bigint),ARRAY(SELECT jsonb_array_elements_text(x->'ca')::bigint),decode(x->'m'->>'salt','hex'),(x->'m'->>'n')::int,ARRAY(SELECT jsonb_array_elements_text(x->'m'->'s')::bigint),ARRAY(SELECT jsonb_array_elements_text(x->'m'->'p')::int),decode(x->'a'->>'salt','hex'),(x->'a'->>'n')::int,ARRAY(SELECT jsonb_array_elements_text(x->'a'->'s')::bigint),ARRAY(SELECT jsonb_array_elements_text(x->'a'->'p')::int) FROM jsonb_array_elements($1::jsonb) x`,[JSON.stringify(data)]);
    r.rows+=rows.length;last=rows.at(-1)!.id;r.loadMs=performance.now()-start;save('load',reports);if(r.rows%10000===0)console.log('loaded',w,r.rows,Math.round(r.loadMs));
   }
   const t=performance.now();await pool.query(`CREATE INDEX ${name}_gin ON ${table} USING gin(cs_memo,cs_address)`);await pool.query(`ANALYZE ${table}`);r.indexMs=performance.now()-t;
   r.logical=(await pool.query(`SELECT count(*)::int rows,sum(cardinality(stamps_memo)+cardinality(stamps_address))::text stamps,sum(cardinality(positions_memo)+cardinality(positions_address))::text positions,avg(n_memo)::float8 memo_chars,avg(n_address)::float8 address_chars FROM ${table}`)).rows[0];assert.equal(r.logical.rows,100000);save('load',reports);
  }
 }else{
  const qs:Q[]=JSON.parse(readFileSync(`${root}/pb-astra-queries.json`,'utf8'));qs.push({name:'memo_short2',field:'memo',term:'up'},{name:'memo_short3',field:'memo',term:'upp'});const results:any[]=[];
  for(const q of qs)for(const mode of (phase==='stats'?['count']:['count','list']) as ('count'|'list')[]){deadline();
   const r:any={...q,mode,targetRows:100000,limit:mode==='list'?300:null,appDecrypts:0,sqlCallsPerRun:1,projection:mode==='list'?['id']:['count'],lookup:native?'native array_position':'PLpgSQL binary search',session,first:{},runs:Object.fromEntries(paths.map(p=>[p,[]]))};results.push(r);
   r.truth=(await run(q,'count','plain')).value;const expected=(await run(q,mode,'plain')).value;r.resultRows=Array.isArray(expected)?expected.length:1;
   r.candidates={};for(const path of paths.slice(1)){const c=await compile(q,'count',path,true);r.candidates[path]=(await pool.query(c.text,c.params)).rows[0].n;}assert.equal(new Set(Object.values(r.candidates)).size,1);
   if(phase==='stats'){
    r.stats={};for(const path of ['occurrence2','occurrence4'] as Path[]){const c=await compile(q,mode,path);r.stats[path]=(await pool.query(c.statsSql!,c.params)).rows[0];assert.equal(r.stats[path].matches,r.truth);}
   }else{
    r.order=[];for(let round=-3;round<7;round++){deadline();const offset=(round+3)%paths.length,order=[...paths.slice(offset),...paths.slice(0,offset)];r.order.push({round,paths:order});
     for(const path of order){const s=await run(q,mode,path);assert.deepEqual(s.value,expected,`${q.name} ${mode} ${path} mismatch`);const {value,...metric}=s;if(round===-3)r.first[path]=metric;if(round>=0)r.runs[path].push(metric);}
    }
    r.medians=Object.fromEntries(paths.map(p=>[p,{dbMs:med(r.runs[p].map((v:any)=>v.dbMs)),totalMs:med(r.runs[p].map((v:any)=>v.totalMs))}]));
    console.log(q.name,mode,r.truth,JSON.stringify(r.medians));
   }save(phase,results);
  }
  assert.equal((await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid,session.pid,'all paths must share one backend session');
 }
 const names=['pb_astra_plain','pb_astra_w2','pb_astra_w4','pb_1b_w2','pb_1b_w4'];
 save('sizes',{at:new Date().toISOString(),sizes:(await pool.query('SELECT relname,pg_relation_size(relid)::text heap,pg_indexes_size(relid)::text indexes,pg_total_relation_size(relid)::text total FROM pg_stat_user_tables WHERE schemaname=\'research_u\' AND relname=ANY($1::text[]) ORDER BY relname',[names])).rows});
}catch(e:any){save(phase+'-error',{phase,message:e.message,at:new Date().toISOString()});throw e;}
finally{await pool.end();if(held&&existsSync(lock)&&readFileSync(lock,'utf8').startsWith(owner))unlinkSync(lock);}

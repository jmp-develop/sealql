import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { binding, scopeId, sealer } from '../standard-next/common.js';
import { normalizeText, profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';

const pool=new pg.Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
const out=new URL('../results/2026-09-27-drizzle-falsify/',import.meta.url);await mkdir(out,{recursive:true});
const result:any={cleanup:false};
try{
 await assertDisposable(pool);assert.equal((await pool.query('show port')).rows[0].port,'56439');
 const modelBinding=binding('customers');
 const model=modelBinding.model,modelId=model.id,ring=sealer.ring(modelId),keyScopeId=sealer.keyScopeId(modelId),spec=model.fields.memo;
 const profile=profiles(modelId,'memo',spec).find(p=>p.mode==='substring');assert(profile);
 const column=modelBinding.storage.index!.profiles![profile.indexId].tokens;
 const example=(await pool.query('select memo_plain from bench_realistic_100k.customers where scope_id=$1 order by id limit 1',[scopeId])).rows[0].memo_plain;
 const term=Array.from(example).slice(0,3).join('');
 const tokens=await searchTokens(ring,scopeId,profile,searchPieces(profile,term,'contains'),{profiles:new Map()});assert(tokens.length);
 await pool.query('create schema drizzle_falsify_perf');
 await pool.query(`create table drizzle_falsify_perf.rows(id uuid primary key,scope_id uuid not null,memo_ct bytea,tokens bigint[],incoming_ct bytea,incoming_tokens bigint[]);
 create function drizzle_falsify_perf.unpack() returns trigger language plpgsql as $$ begin
 if new.incoming_ct is not null then new.memo_ct=new.incoming_ct;new.incoming_ct=null;end if;
 if new.incoming_tokens is not null then new.tokens=new.incoming_tokens;new.incoming_tokens=null;end if;
 return new; end $$;
 create trigger unpack_before before insert or update on drizzle_falsify_perf.rows for each row execute function drizzle_falsify_perf.unpack();`);
 const loaded=await pool.query(`insert into drizzle_falsify_perf.rows(id,scope_id,incoming_ct,incoming_tokens)
 select p.id,p.scope_id,p.memo_ct,i.${column} from bench_standard_next_100k.customers p
 join bench_standard_next_100k.customers_seal_index i on i.scope_id=p.scope_id and i.row_id=p.id`);
 result.loaded=loaded.rowCount;
 await pool.query('create index rows_tokens_gin on drizzle_falsify_perf.rows using gin(tokens)');
 await pool.query('create index rows_scope_id on drizzle_falsify_perf.rows(scope_id,id)');
 await pool.query('analyze drizzle_falsify_perf.rows');
 const sqls={companion:`select p.id,p.memo_ct from bench_standard_next_100k.customers p where p.scope_id=$1 and p.id in
 (select row_id from bench_standard_next_100k.customers_seal_index where scope_id=$1 and ${column} @> $2::bigint[]) order by p.id limit 20`,
 inline:'select id,memo_ct from drizzle_falsify_perf.rows where scope_id=$1 and tokens @> $2::bigint[] order by id limit 20'};
 async function one(kind:'companion'|'inline'){
  const start=performance.now();const rows=(await pool.query(sqls[kind],[scopeId,tokens])).rows;const sqlMs=performance.now()-start;
  const values=await Promise.all(rows.map(async r=>sealer.open(r.memo_ct,{modelId,fieldId:'memo',keyScopeId,scopeId,rowId:r.id,spec},ring)));
  const needle=normalizeText(term,'legacy-text-v1');
  const accepted=rows.flatMap((r,i)=>normalizeText(String(values[i]),'legacy-text-v1').includes(needle)?[r.id]:[]);
  return {sqlMs,totalMs:performance.now()-start,candidates:rows.length,returned:accepted.length,authenticatedFields:rows.length,ids:rows.map(r=>r.id),accepted,values};
 }
 for(let i=0;i<2;i++){await one('companion');await one('inline');}
 const samples:any={companion:[],inline:[]};for(let i=0;i<7;i++){const order=i%2?['inline','companion']:['companion','inline'];for(const k of order){const r=await one(k as any);samples[k].push(r);}}
 for(let i=0;i<7;i++){assert.deepEqual(samples.companion[i].ids,samples.inline[i].ids);assert.deepEqual(samples.companion[i].values,samples.inline[i].values);}
 const median=(a:number[])=>[...a].sort((x,y)=>x-y)[3];
 result.query={column,term,tokens,conditions:'same scope, same memo contains tokens, id order, limit 20, memo authenticated open; 2 warmups, 7 alternating runs',samples,
 summary:Object.fromEntries(['companion','inline'].map(k=>[k,{sqlMs:median(samples[k].map((x:any)=>x.sqlMs)),totalMs:median(samples[k].map((x:any)=>x.totalMs)),candidates:samples[k][0].candidates,returned:samples[k][0].returned,authenticatedFields:samples[k][0].authenticatedFields}]))};
}catch(e:any){result.error={message:e.message,stack:e.stack,code:e.code};}
finally{try{await assertDisposable(pool);await pool.query('drop schema if exists drizzle_falsify_perf cascade');result.cleanup=true;}catch(e:any){result.cleanupError=e.message;}await pool.end();await writeFile(new URL('perf.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify({loaded:result.loaded,summary:result.query?.summary,error:result.error,cleanup:result.cleanup},null,2));if(result.error||!result.cleanup)process.exitCode=1;}

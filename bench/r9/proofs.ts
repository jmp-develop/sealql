/** Mechanical proof checks; fixture reads only, no DB mutation. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {Pool} from 'pg';
import {createSealer} from '../../src/index.js';
import {createSealed} from '../../src/adapters/drizzle/v0.45/index.js';
import {registrationOf} from '../../src/adapters/drizzle/v0.45/native.js';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {profiles,normalizeWords} from '../../src/core/search-tokens.js';
import {positionProof,stampKey,stamp,compactText} from '../../src/core/search-stamps.js';
import {utf8} from '../../src/core/bytes.js';
import {assertDisposable} from '../../test/disposable.js';

const out='bench/results/2026-09-29-r9',schema='test_r9_performance_main';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
mkdirSync(out,{recursive:true});
try{
 const fields=['name','phone','address','memo','email','company'];
 const sealed=createSealed({sealer:createSealer({key:new Uint8Array(32).fill(93)})}),cols:any={id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull()};
 for(const field of fields)cols[field]=sealed.text(field,{search:{exact:field==='company'?{bits:2}:true,substring:{wordBoundary:true}}});
 const table=pgSchema(schema).table('customers',cols),seal=sealed.register(table,{row:'id',scope:'scopeId'}),reg=registrationOf(seal);
 const expressions:string[]=[],names:string[]=[];
 for(const [id,p]of Object.entries(reg.storage.index!.profiles!))for(const [kind,columns]of Object.entries({tokens:{tokens:p.tokens},exact:p.exact,compact:p.positions,words:p.words,single:p.singles}))if(columns){
  const name=`${id}:${kind}`;names.push(name);
  expressions.push(`sum(${Object.values(columns).map(c=>`coalesce(pg_column_size("${c}"),0)`).join('+')})::text as v${names.length-1}`);
 }
 const sizes=(await pool.query(`select count(*)::int n,${expressions.join(',')} from ${schema}.customers_seal_index`)).rows[0];
 const perStream=names.map((name,i)=>({name,bytes:Number(sizes[`v${i}`]),bytesPerRow:Number(sizes[`v${i}`])/sizes.n}));
 const tables=[];for(const relation of ['test_r9_performance.customers_seal_index',`${schema}.customers_seal_index`,'research_u.pb_4_final']){
  const size=(await pool.query('select pg_relation_size($1)::text heap,pg_indexes_size($1)::text indexes,pg_total_relation_size($1)::text total',[relation])).rows[0];
  tables.push({relation,rows:sizes.n,...size,totalBytesPerRow:Number(size.total)/sizes.n});
 }
 const fixture=(await pool.query('select memo_plain from bench_realistic_100k.customers order by id limit 250')).rows.map(r=>String(r.memo_plain));
 const reviews=readFileSync('.local/ratings.txt','utf8').split(/\r?\n/).slice(1).map(line=>line.split('\t')[1]).filter((s):s is string=>!!s).slice(0,250);
 assert.equal(reviews.length,250);
 const profile=profiles('r9-memory','memo',{type:'text',search:{substring:{wordBoundary:true}}})[0];
 const ring={keyScopeId:'global',key:new Uint8Array(32).fill(71)},scope='memory';
 const attacks=[];
 for(const [corpus,values]of [['fixture',fixture],['public-review-memory-only',reviews]] as const){
  const allStamps=new Set<string>();let crossDuplicate=0,withinDuplicate=0,permutationFailure=0,knownPositions=0,knownMismatch=0,visibleSpaces=0,entries=0;
  const lengths=new Map<string,number>();
  for(const value of values){
   const compact=Array.from(compactText(value,profile)),words=Array.from(normalizeWords(value));
   visibleSpaces+=words.length-compact.length;
   lengths.set(`${compact.length}/${words.length}`,(lengths.get(`${compact.length}/${words.length}`)??0)+1);
   for(const stream of ['compact2','words2','single1']as const){
    const proof=await positionProof(ring,profile,scope,value,stream),chars=stream==='words2'?words:compact,width=stream==='single1'?1:2;
    const count=Math.max(0,chars.length-width+1);entries+=count;
    withinDuplicate+=proof.stamps.length-new Set(proof.stamps).size;
    if(proof.offsets.slice().sort((a,b)=>a-b).some((v,i)=>v!==i)||proof.offsets.length!==count)permutationFailure++;
    for(const s of proof.stamps){if(allStamps.has(String(s)))crossDuplicate++;allStamps.add(String(s));}
    if(count){
     // T4: an observed query key reveals every occurrence of that piece in this row.
     const piece=chars.slice(0,width).join(''),key=await stampKey(ring,profile,stream,scope,utf8(piece)),actual:number[]=[];
     for(let ordinal=1;ordinal<=count+1;ordinal++){const i=proof.stamps.indexOf(await stamp(key,proof.salt,ordinal));if(i<0)break;actual.push(proof.offsets[i]);}
     const expected=Array.from({length:count},(_,i)=>i).filter(i=>chars.slice(i,i+width).join('')===piece);
     knownPositions+=actual.length;if(JSON.stringify(actual)!==JSON.stringify(expected))knownMismatch++;
    }
   }
  }
  assert.equal(withinDuplicate+crossDuplicate+permutationFailure+knownMismatch,0);
  attacks.push({corpus,rows:values.length,entries,withinDuplicate,crossDuplicate,permutationFailure,observedKeyRecoveredPositions:knownPositions,observedKeyMismatch:knownMismatch,
   visibleNormalizedSpaces:visibleSpaces,uniqueLengthPairs:[...lengths.values()].filter(n=>n===1).length,
   limit:'Equality and position-set checks do not prove secrecy; lengths and normalized space counts remain visible, and observed piece keys recover occurrences.'});
 }
 const result={at:new Date().toISOString(),rows:sizes.n,perStream,tables,attacks,limits:['No full dictionary/co-occurrence/WAL attack rerun; prior token leakage remains.','No hosted service security claim.','Column sizes exclude tuple/index overhead and can reflect compression; table totals include TOAST/indexes.']};
 writeFileSync(`${out}/proofs-size.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({attacks,tables}));
}finally{await pool.end();}

/** Mechanical T4 check on existing texts; fixture reads only, reviews stay in memory. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {Pool} from 'pg';
import {getTableColumns} from 'drizzle-orm';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer,profiles,searchPieces} from '../../src/index.js';
import {createSealed} from '../../src/adapters/drizzle/v0.45/index.js';
import {positionProof,compactText,stampKey,stamp} from '../../src/core/search-stamps.js';
import {hex,utf8} from '../../src/core/bytes.js';
import {assertDisposable} from '../../test/disposable.js';

assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-final-return');
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c default_transaction_read_only=on'});
try{
 await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
 const fixture=(await pool.query('select memo_plain from bench_realistic_100k.customers order by id limit 250')).rows.map(r=>String(r.memo_plain));
 const reviews=readFileSync('.local/ratings.txt','utf8').split(/\r?\n/).slice(1).map(s=>s.split('\t')[1]).filter(Boolean).slice(0,250);
 assert.equal(fixture.length,250);assert.equal(reviews.length,250);
 const sealer=createSealer({key:new Uint8Array(32).fill(71)}),sealed=createSealed({sealer});
 const table=pgSchema('test_memory_only').table('notes',{id:uuid('id').primaryKey(),body:sealed.text('body',{search:{substring:true}})});
 const seal=sealed.register(table,{row:'id'}),columns=Object.keys(getTableColumns(seal));
 assert.equal(columns.length,7);assert.ok(columns.every(c=>!c.startsWith('single_')&&!c.startsWith('word_')));
 const profile=profiles('compact-audit','body',{type:'text',search:{substring:true}})[0],ring=sealer.ring('compact-audit');
 const attacks=[];
 for(const [corpus,values]of [['fixture',fixture],['reviews-memory-only',reviews]]as const){
  let entries=0,recovered=0;const all=new Set<string>();
  for(const value of values){
   const chars=Array.from(compactText(value,profile)),count=Math.max(0,chars.length-1);
   const proof=await positionProof(ring,profile,'memory',value,'compact2');
   assert.deepEqual(proof.offsets.slice().sort((a,b)=>a-b),Array.from({length:count},(_,i)=>i));
   assert.equal(proof.length,chars.length);assert.equal(new Set(proof.stamps).size,count);entries+=count;
   for(const tag of proof.stamps){assert.ok(!all.has(String(tag)));all.add(String(tag));}
   // Extra normalized spaces have no second stored length or boundary candidate channel.
   const spaced=Array.from(value).join(' ');
   assert.equal(compactText(spaced,profile),compactText(value,profile));
   assert.deepEqual(searchPieces(profile,spaced).map(hex),searchPieces(profile,value).map(hex));
   if(count){
    const piece=chars.slice(0,2).join(''),key=await stampKey(ring,profile,'compact2','memory',utf8(piece)),actual=[];
    for(let i=1;i<=count+1;i++){const at=proof.stamps.indexOf(await stamp(key,proof.salt,i));if(at<0)break;actual.push(proof.offsets[at]);}
    const expected=Array.from({length:count},(_,i)=>i).filter(i=>chars.slice(i,i+2).join('')===piece);
    assert.deepEqual(actual,expected);recovered+=actual.length;
   }
  }
  attacks.push({corpus,rows:values.length,entries,duplicateStamps:0,positionMismatch:0,observedKeyRecoveredPositions:recovered,observedKeyMismatch:0});
 }
 const result={columns,attacks,removedChannels:['singleton proof/key','words proof length','boundary candidate tokens'],limits:['No full dictionary/co-occurrence/WAL attack rerun.','Ciphertext lengths and compact lengths still leak; adding spaces can change ciphertext byte length.','Observed compact piece keys still recover positions; zero collisions do not prove secrecy.']};
 const out='bench/results/2026-09-29-final-impl';mkdirSync(out,{recursive:true});writeFileSync(`${out}/compact-audit.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await pool.end();}

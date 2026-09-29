/** Independent WebCrypto recomputation of random field/index samples. No DB. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {makeModels,rows,fields,norm,ring,scope} from '../models.js';
import {profiles,searchTokens,searchPieces} from '../../../src/core/search-tokens.js';
import {spec} from '../../attack-extra/codec.js';
const OUT='bench/results/2026-09-30-competitor-sim/v-astra';mkdirSync(OUT,{recursive:true});
const all=rows(),victim=all.slice(0,10000),reference=all.slice(10000,20000),hash=(v:string)=>createHash('sha256').update(v).digest('hex');
assert.equal(new Set([...victim,...reference].map(r=>r.id)).size,20000);
const sorted=[...all].sort((a,b)=>a.id.localeCompare(b.id)).map(r=>({id:r.id,scopeId:scope,...Object.fromEntries(fields.map(f=>[f,r[f]]))}));
const rawHash=hash(JSON.stringify(sorted)),prior=JSON.parse(readFileSync('bench/results/2026-09-30-p1-verify/v-astra/load.json','utf8'));
assert.equal(rawHash,prior.sourceHash,'Memory fixture replay must equal prior raw DB-read snapshot across every value');
let state=20260930;const next=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
const indices=[...new Set(Array.from({length:64},()=>Math.floor(next()*10000)))].slice(0,32);assert.equal(indices.length,32);
const bytes=(v:Uint8Array)=>Uint8Array.from(v).buffer,enc=new TextEncoder();
const root=await crypto.subtle.importKey('raw',bytes(ring.key),'HKDF',false,['deriveBits']);
const trunc=(digest:ArrayBuffer,n:number)=>{const bits=Array.from(new Uint8Array(digest),b=>b.toString(2).padStart(8,'0')).join('').slice(0,n).padEnd(Math.ceil(n/8)*8,'0');return (bits.match(/.{8}/g)??[]).map(b=>parseInt(b,2).toString(16).padStart(2,'0')).join('');};
const result:any={started:new Date().toISOString(),complete:false,reviewer:'v-astra',modelsSourceHash:hash(readFileSync('bench/competitor-sim/models.ts','utf8')),method:'WebCrypto independent HKDF/HMAC/PBKDF2 plus product WebCrypto token API; deterministic random held-out samples',sampleSeed:20260930,sampleIndices:indices,rawFixtureHash:rawHash,rawFixtureMatchesPreviousDatabaseRead:true,identityDigest:hash(JSON.stringify(all.slice(0,20000).map(r=>r.id))),victimRows:10000,referenceRows:10000,disjointIds:true,rows:[],errors:[]};
try{
 for(const field of fields)for(const model of makeModels(field,reference.map(r=>r[field]))){
  if(model.id==='CipherSweet-FIPS-fast')assert.equal(model.metadata.bits,8,'Official FIPS byte-aligned profile is fixed to 8');
  let keyBytes:ArrayBuffer|undefined,hmac:CryptoKey|undefined;
  if(model.id!=='S0'){keyBytes=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(),info:enc.encode(`competitor-sim/${model.id}/${field}`)},root,256);hmac=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:model.id==='AWS-standard'?'SHA-384':'SHA-256'},false,['sign']);}
  const fingerprints=[];
  for(const index of indices){const raw=victim[index][field],value=norm(raw);let expected:string[]=[];
   if(model.id==='S0')for(const p of profiles('customers',field,spec(field))){const ts=await searchTokens(ring,scope,p,searchPieces(p,value));expected.push(...ts.map(t=>(p.mode==='exact'?'e:':'s:')+t));}
   else if(model.id==='CipherSweet-FIPS-fast'){const password=await crypto.subtle.importKey('raw',enc.encode(value),'PBKDF2',false,['deriveBits']),digest=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-384',iterations:1,salt:keyBytes!},password,8);expected=[Buffer.from(digest).toString('hex')];}
   else if(model.id==='CipherStash-match'){
    const chars=Array.from(value.toLowerCase()),positions=new Set<string>();
    for(let start=0;start+2<chars.length;start++){const digest=await crypto.subtle.sign('HMAC',hmac!,enc.encode(chars.slice(start,start+3).join(''))),view=new DataView(digest);for(let lane=0;lane<6;lane++)positions.add(String(view.getUint16(lane*2,true)%2048));}
    expected=[...positions];
   }else{const digest=await crypto.subtle.sign('HMAC',hmac!,enc.encode(value)),n=Number(model.metadata.bits);if(model.id==='AWS-standard'){const bits=Array.from(new Uint8Array(digest).slice(0,8),b=>b.toString(2).padStart(8,'0')).join('').slice(-n);expected=[parseInt(bits,2).toString(16).padStart(Math.ceil(n/4),'0')];}else expected=[trunc(digest,n)];}
   expected=[...new Set(expected)].sort();const observed=[...model.tokens(raw)].sort();assert.deepEqual(observed,expected,`${field}/${model.id}/${index}`);
   fingerprints.push({index,tokenCount:expected.length,digest:hash(JSON.stringify(expected))});
  }
  result.rows.push({field,model:model.id,checks:indices.length,parameters:model.metadata,fingerprints});
 }
 result.complete=true;
}catch(e){result.errors.push(String(e));throw e;}finally{result.finished=new Date().toISOString();writeFileSync(`${OUT}/verify-models.json`,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({complete:true,modelFields:result.rows.length,checks:result.rows.reduce((n:number,r:any)=>n+r.checks,0),rawFixtureMatchesPreviousDatabaseRead:true}));

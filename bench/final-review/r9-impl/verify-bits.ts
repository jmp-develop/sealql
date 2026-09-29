import {readFileSync} from 'node:fs';
import {frame,u32} from '../../../src/core/bytes.js';
import {ring} from '../../attack-extra/codec.js';
import {ActiveCodec,scope} from './codec.js';
import {assert,OUT} from './common.js';
const bytes=(v:Uint8Array)=>Uint8Array.from(v).buffer;
const cases=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/cases.json','utf8'));
let cryptoChecks=0;
for(const bits of [16,14,12])for(const field of ['phone','address']){
 const codec=new ActiveCodec(field,'product',scope,bits),p=codec.p,value=cases.find((c:any)=>c.node.field===field).node.value;
 const descriptor=frame([p.modelId,p.fieldId,p.indexId,'text',u32(2),new Uint8Array(),p.normalizer,'substring',u32(bits),'skip']);
 const root=await crypto.subtle.importKey('raw',bytes(ring.key),'HKDF',false,['deriveBits']);
 const derived=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-384',salt:new Uint8Array(),info:bytes(frame(['sealql/index/v3',ring.keyScopeId,descriptor]))},root,384);
 const key=await crypto.subtle.importKey('raw',derived,{name:'HMAC',hash:'SHA-384'},false,['sign']);
 const prefix=new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes(frame(['scope',scope])))).slice(0,4);
 for(const id of codec.pieces(value)){
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes(frame(['value',scope,Buffer.from(id,'hex')]))));
  let n=0n;for(const byte of prefix)n=(n<<8n)|BigInt(byte);let low=0n;for(const byte of digest.slice(0,4))low=(low<<8n)|BigInt(byte);
  low=(low>>BigInt(32-bits))<<BigInt(32-bits);assert.equal(codec.token(id),String(BigInt.asIntN(64,(n<<32n)|low)));cryptoChecks++;
 }
}
if(process.argv.includes('--crypto-only')){console.log(`PASS: ${cryptoChecks} independent WebCrypto token checks`);process.exit(0);}
const d=JSON.parse(readFileSync(`${OUT}/bits.json`,'utf8')),prior=JSON.parse(readFileSync(`${OUT}/active-1000-both.json`,'utf8'));
assert.ok(d.complete);assert.equal(d.attack.length,36);assert.equal(d.candidates.length,55);assert.equal(d.rows,100000);assert.equal(d.validation.exactTokens,18);
for(const a of d.attack.filter((r:any)=>r.bits===16)){const p=prior.rows.find((r:any)=>r.generation==='product'&&r.scope==='same'&&r.field===a.field&&r.strategy===a.strategy&&r.inserted===a.n);assert.equal(a.values,p.values);assert.equal(a.learnedLabels,p.learnedLabels);}
for(const s of d.summary){const cs=d.candidates.map((c:any)=>c.counts[s.bits]);assert.equal(s.mean,cs.reduce((a:number,b:number)=>a+b,0)/55);assert.equal(s.max,Math.max(...cs));}
console.log(`PASS: ${cryptoChecks} independent WebCrypto token checks; 36 attacks; 55 conditions; 16-bit attack equals prior evidence; candidate aggregates`);

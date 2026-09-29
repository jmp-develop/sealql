/** Index leakage models, not interoperable SDK implementations. No DB access.
 * Official parameter review: v-astra's competitor-models.md; permanent sources below.
 * Every model receives the SAME application-normalized input (not vendor defaults).
 */
import {createHmac,hkdfSync,pbkdf2Sync} from 'node:crypto';
import {rows,fields,norm,rng,shuffled,assert,scope,ring} from '../lasthour/m1-astra/common.js';
import {Codec} from '../attack-extra/codec.js';
import {profiles,descriptorBytes,searchPieces,searchTokens} from '../../src/core/search-tokens.js';
import {frame,hex} from '../../src/core/bytes.js';
import {spec} from '../attack-extra/codec.js';
export {rows,fields,norm,rng,shuffled,assert,scope,ring,Codec};
export interface Model {
 id:string;kind:'exact'|'pieces'|'bloom';field:string;metadata:Record<string,unknown>;
 pieces(value:string):string[]; token(piece:string):string[]; tokens(value:string):string[];
 queryPieces(value:string):string[];query(value:string):string[];
}
export const unique=(xs:string[])=>[...new Set(xs)].sort();
const keyFor=(id:string,field:string)=>Buffer.from(hkdfSync('sha256',ring.key,Buffer.alloc(0),`competitor-sim/${id}/${field}`,32));
export function truncate(bytes:Uint8Array,bits:number):string {
 const b=Buffer.from(bytes.subarray(0,Math.ceil(bits/8)));if(bits%8)b[b.length-1]&=255<<(8-bits%8);return b.toString('hex');
}
/** Exact profiles have no substring query API. query() means equality there. */
export function makeModels(field:string,referenceValues:string[]):Model[] {
 const distinct=new Set(referenceValues.map(norm)).size,beaconBits=Math.max(1,Math.floor(Math.log2(distinct)-1));
 const makeExact=(id:string,bits:number,fips=false):Model=>{
  const key=keyFor(id,field),cache=new Map<string,string[]>();
  const token=(piece:string)=>{let t=cache.get(piece);if(!t){
   // AWS Beacon.dfy: HMAC-SHA384 first eight bytes, then RIGHTMOST b bits.
   t=[id==='AWS-standard'?(createHmac('sha384',key).update(piece).digest().readBigUInt64BE()&((1n<<BigInt(bits))-1n)).toString(16).padStart(Math.ceil(bits/4),'0')
    :truncate(fips?pbkdf2Sync(piece,key,1,Math.ceil(bits/8),'sha384'):createHmac('sha256',key).update(piece).digest(),bits)];cache.set(piece,t);}return t;};
  const pieces=(value:string)=>[norm(value)],tokens=(value:string)=>token(norm(value));
  return {id,field,kind:'exact',pieces,token,tokens,queryPieces:pieces,query:tokens,metadata:{bits,distinctReference:distinct,applicationNormalization:'SealQL compact text before indexing',
   hash:fips?'PBKDF2-HMAC-SHA384, password=value, salt=indexKey, iterations=1':id==='AWS-standard'?'HMAC-SHA384 first8B/rightmost b bits/ceil(b/4) hex; empty partition suffix':'HMAC-SHA256',
   source:id==='AWS-standard'?'https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/choosing-beacon-length.html':id==='CipherSweet-FIPS-fast'?'https://ciphersweet.paragonie.com/internals/blind-index':id==='Acra-CE-exact'?'https://docs.cossacklabs.com/acra/security-controls/searchable-encryption/':'https://cipherstash.com/docs/security/cryptography',
   setting:id==='AWS-standard'?'Single partition; floor(log2(U_ref)-1) guideline, not tuned/default':id==='CipherSweet-FIPS-fast'?'Explicit 8-bit, R=10000/C≈39.06 supported FIPS-fast profile, not default; byte-aligned PHP output':'Full 256-bit equality tag; no ordering',fidelity:'Documented index primitive; independent simulation field key, not SDK envelope/key derivation'}};
 };
 const codec=new Codec(field),exact=profiles('customers',field,spec(field)).find(p=>p.mode==='exact')!;
 const exactRoot=Buffer.from(hkdfSync('sha384',ring.key,Buffer.alloc(0),frame(['sealql/index/v3',ring.keyScopeId,descriptorBytes(exact)]),48));
 const prefix=BigInt(createHmac('sha384',exactRoot).update(frame(['scope',scope])).digest().readUInt32BE());
 const token=(piece:string):string[]=>{
  if(piece.startsWith('s:'))return ['s:'+codec.token(Buffer.from(piece.slice(2),'hex'))];
  const raw=createHmac('sha384',exactRoot).update(frame(['value',scope,Buffer.from(piece.slice(2),'utf8')])).digest().readUInt32BE();
  return ['e:'+String(BigInt.asIntN(64,(prefix<<32n)|BigInt((raw>>>(32-exact.bits))*2**(32-exact.bits))))];
 };
 const pieces=(value:string)=>[...codec.pieces(norm(value)).map(p=>'s:'+p),'e:'+norm(value)];
 const queryPieces=(value:string)=>codec.queryPieces(norm(value)).map(p=>'s:'+p);
 const s0:Model={id:'S0',field,kind:'pieces',pieces,token,tokens:value=>unique(pieces(value).flatMap(token)),queryPieces,
  query:value=>{const ts=unique(queryPieces(value).flatMap(token)).sort((a,b)=>BigInt(a.slice(2))<BigInt(b.slice(2))?-1:1);return ts.length<=3?ts:[ts[0],ts[Math.floor((ts.length-1)/2)],ts.at(-1)!];},
  metadata:{substringBits:16,exactBits:exact.bits,stored:'Full candidate sets plus separate salted exact/position proofs; tokens() exposes deterministic candidate sets only',proofs:'Use Codec snapshots and observed keys for T4 positional attack',source:'src/core/search-tokens.ts',fidelity:'Actual product bytes, prefixed with index-column tags for simulation'}};
 // https://cipherstash.com/docs/reference/eql/text: downcased Unicode trigrams.
 // https://github.com/cipherstash/protectphp#match-index-match: m=2048,k=6 profile.
 // cipherstash-core 0.42.3: six little-endian u16 HMAC digest lanes, modulo m.
 const bloomKey=keyFor('CipherStash-match',field),bloomCache=new Map<string,string[]>();
 const grams=(value:string)=>{const c=Array.from(norm(value).toLowerCase());return unique(Array.from({length:Math.max(0,c.length-2)},(_,i)=>c.slice(i,i+3).join('')));};
 const bloomToken=(piece:string)=>{let bits=bloomCache.get(piece);if(!bits){const h=createHmac('sha256',bloomKey).update(piece).digest();bits=unique(Array.from({length:6},(_,i)=>String(h.readUInt16LE(i*2)%2048)));bloomCache.set(piece,bits);}return bits;};
 const bloom:Model={id:'CipherStash-match',field,kind:'bloom',pieces:grams,token:bloomToken,tokens:value=>unique(grams(value).flatMap(bloomToken)),queryPieces:grams,
  query:value=>{assert.ok(Array.from(norm(value)).length>=3,'No sub-trigram queries');return unique(grams(value).flatMap(bloomToken));},
  metadata:{m:2048,k:6,gram:3,source:'https://crates.io/crates/cipherstash-core/0.42.3',semantics:'Probabilistic downcased trigram-set containment; not LIKE',fidelity:'cipherstash-core 0.42.3 HMAC-SHA256/u16LE bit placement; Stack 6a926344 ngram3/downcase/k6/m2048 defaults; independent simulation field key'}};
 return [s0,makeExact('AWS-standard',beaconBits),makeExact('CipherSweet-FIPS-fast',8,true),makeExact('CipherStash-unique',256),bloom,makeExact('Acra-CE-exact',256)];
}
export async function validateProduct(model:Model,values:string[]) {
 assert.equal(model.id,'S0');const ps=profiles('customers',model.field,spec(model.field));let checks=0;
 for(const value of values)for(const p of ps){const tokens=await searchTokens(ring,scope,p,searchPieces(p,norm(value)));assert.deepEqual(model.tokens(value).filter(t=>t.startsWith(p.mode==='exact'?'e:':'s:')).map(t=>t.slice(2)).sort(),tokens.sort());checks++;}return checks;
}

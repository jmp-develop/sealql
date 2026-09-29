/** Bulk simulator uses the current byte format; validate() compares WebCrypto product outputs. */
import {createHmac,hkdfSync,hash,randomBytes} from 'node:crypto';
import {frame,u32,utf8,hex} from '../../src/core/bytes.js';
import {codecId,codecParameters,codecVersion,type FieldSpec} from '../../src/core/field-codec.js';
import {profiles,descriptorBytes,searchPieces,searchTokens,compactText,type SearchProfile} from '../../src/core/search-tokens.js';
import {positionProof,stampKey} from '../../src/core/search-stamps.js';
import {compileStampQuery} from '../../src/core/stamp-query.js';
import {assert,scope} from './common.js';
export const ring={key:new Uint8Array(32).fill(93),keyScopeId:'global'};
export const spec=(field:string):FieldSpec=>({type:'text',search:{exact:field==='company'?{bits:2}:true,substring:true}});
export const profile=(field:string)=>profiles('customers',field,spec(field)).find(p=>p.mode==='substring')!;
export const norm=(value:string)=>compactText(value,{normalizer:'legacy-text-v1'});
export type Snapshot={salt:Buffer;n:number;stamps:bigint[];offsets:number[];tokens:string[]};
export const digest=(key:Uint8Array,salt:Uint8Array,ordinal:number)=>hash('sha256',Buffer.concat([key,salt,u32(ordinal)]),'buffer').readBigInt64BE();
export class Codec {
 readonly p:SearchProfile; private stampRoot:Buffer; private tokenRoot:Buffer;private prefix:bigint;
 private keyCache=new Map<string,Buffer>();private tokenCache=new Map<string,string>();
 constructor(readonly field:string,readonly generation:'current'|'pre-r9'='current'){this.p=profile(field);const p=this.p;
  this.stampRoot=Buffer.from(hkdfSync('sha384',ring.key,Buffer.alloc(0),frame(['sealql/search-stamp/v1',ring.keyScopeId,p.modelId,p.fieldId,codecId(p.spec),u32(codecVersion(p.spec)),codecParameters(p.spec),p.normalizer,'compact2']),32));
  const descriptor=generation==='current'?descriptorBytes(p):frame([p.modelId,p.fieldId,p.indexId,codecId(p.spec),u32(codecVersion(p.spec)),codecParameters(p.spec),p.normalizer,p.mode,u32(p.bits),'',p.skipGrams?'skip':'']);
  this.tokenRoot=Buffer.from(hkdfSync('sha384',ring.key,Buffer.alloc(0),frame(['sealql/index/v3',ring.keyScopeId,descriptor]),48));
  this.prefix=BigInt(createHmac('sha384',this.tokenRoot).update(frame(['scope',scope])).digest().readUInt32BE());
 }
 key(piece:string){let k=this.keyCache.get(piece);if(!k){k=createHmac('sha256',this.stampRoot).update(frame([scope,utf8(piece)])).digest();this.keyCache.set(piece,k);}return k;}
 pieces(value:string){return searchPieces(this.p,value).map(hex);}
 queryPieces(value:string){return searchPieces(this.p,value,'contains').map(hex);}
 queryTokens(value:string){return [...new Set(searchPieces(this.p,value,'contains').map(piece=>this.token(piece)))];}
 token(piece:Uint8Array){const id=hex(piece);let t=this.tokenCache.get(id);if(!t){const raw=createHmac('sha384',this.tokenRoot).update(frame(['value',scope,piece])).digest().readUInt32BE();t=String(BigInt.asIntN(64,(this.prefix<<32n)|BigInt((raw>>>16)*65536)));this.tokenCache.set(id,t);}return t;}
 tokens(value:string){return [...new Set(searchPieces(this.p,value).map(piece=>this.token(piece)))].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);}
 snapshot(value:string,salt=randomBytes(16)):Snapshot{const chars=Array.from(norm(value)),seen=new Map<string,number>(),pairs:{s:bigint;p:number}[]=[];for(let p=0;p+1<chars.length;p++){const piece=chars[p]+chars[p+1],ord=(seen.get(piece)??0)+1;seen.set(piece,ord);pairs.push({s:digest(this.key(piece),salt,ord),p});}pairs.sort((a,b)=>a.s<b.s?-1:a.s>b.s?1:0);assert.equal(new Set(pairs.map(p=>p.s)).size,pairs.length);return {salt,n:chars.length,stamps:pairs.map(p=>p.s),offsets:pairs.map(p=>p.p),tokens:this.tokens(value)};}
 async validate(value:string){const actual=await positionProof(ring,this.p,scope,value,'compact2'),fast=this.snapshot(value,Buffer.from(actual.salt));assert.deepEqual(fast.stamps,actual.stamps);assert.deepEqual(fast.offsets,actual.offsets);assert.equal(fast.n,actual.length);assert.deepEqual(this.tokens(value),await searchTokens(ring,scope,this.p,searchPieces(this.p,value)));const chars=Array.from(norm(value));if(chars.length>=2){assert.deepEqual(this.key(chars.slice(0,2).join('')),Buffer.from(await stampKey(ring,this.p,'compact2',scope,utf8(chars.slice(0,2).join('')))));const q=await compileStampQuery(ring,this.p,scope,{op:'contains',value});for(let i=0;i<q.keys.length;i++)assert.deepEqual(Buffer.from(q.keys[i]),this.key(chars.slice(q.offsets[i],q.offsets[i]+2).join('')));}}
}
/** Attacker operation: only the snapshot and observed query key enter here. */
export function positions(s:Snapshot,key:Uint8Array):number[]{const result:number[]=[];for(let ordinal=1;ordinal<s.n;ordinal++){const target=digest(key,s.salt,ordinal);let lo=0,hi=s.stamps.length-1,found=-1;while(lo<=hi){const m=(lo+hi)>>>1;if(s.stamps[m]===target){found=m;break;}if(s.stamps[m]<target)lo=m+1;else hi=m-1;}if(found<0)break;result.push(s.offsets[found]);}return result;}

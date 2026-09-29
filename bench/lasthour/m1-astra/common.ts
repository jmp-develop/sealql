import assert from 'node:assert/strict';
import {createHmac,hkdfSync,hash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {generate} from '../../fixture/generator.js';
import {fields,rng,shuffled,scope,type Row} from '../../attack-extra/common.js';
import {norm,profile,ring} from '../../attack-extra/codec.js';
import {frame,hex,u32} from '../../../src/core/bytes.js';
import {searchPieces,searchTokens} from '../../../src/core/search-tokens.js';
export {assert,fields,rng,shuffled,scope,norm,ring,hex,hash};
export const OUT='bench/results/2026-09-29-lasthour/m1-astra';
export function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
/** Replay only the existing fixture's fixed original seed; never open a DB connection. */
export function rows(){const raw:Row[]=[];for(const row of generate(100000)){if(row.table!=='customers')break;raw.push({id:row.id,...row.data});}const result=shuffled(raw);const digest=hash('sha256',JSON.stringify(result.slice(0,20000).map(r=>r.id)));assert.equal(digest,JSON.parse(readFileSync('bench/results/2026-09-29-attack-extra/dataset.json','utf8')).identityDigest);assert.equal(hash('sha256',result.map(r=>r.id).join('\n')),JSON.parse(readFileSync('bench/results/2026-09-29-followup/token-bits/phone.json','utf8')).fixtureDigest);return result;}
/** Research-only bit parameter: product API still permits substring=16 only. */
export class BitCodec {
 readonly p; private key:Buffer;private prefix:bigint;private cache=new Map<string,string>();private values=new Map<string,string[]>();
 constructor(readonly field:string,readonly bits=16){assert([10,12,16].includes(bits));this.p=profile(field);const p=this.p,descriptor=frame([p.modelId,p.fieldId,p.indexId,'text',u32(2),new Uint8Array(),p.normalizer,'substring',u32(bits),'skip']);this.key=Buffer.from(hkdfSync('sha384',ring.key,new Uint8Array(),frame(['sealql/index/v3',ring.keyScopeId,descriptor]),48));this.prefix=BigInt(createHmac('sha384',this.key).update(frame(['scope',scope])).digest().readUInt32BE());}
 pieces(value:string){let ps=this.values.get(value);if(!ps){ps=searchPieces(this.p,value).map(hex);this.values.set(value,ps);}return ps;}
 queryPieces(value:string){return searchPieces(this.p,value,'contains').map(hex);}
 token(id:string){let t=this.cache.get(id);if(t===undefined){const raw=createHmac('sha384',this.key).update(frame(['value',scope,Buffer.from(id,'hex')])).digest().readUInt32BE();t=String(BigInt.asIntN(64,(this.prefix<<32n)|BigInt((raw>>>(32-this.bits))*2**(32-this.bits))));this.cache.set(id,t);}return t;}
 tokens(value:string){return [...new Set(this.pieces(value).map(p=>this.token(p)))].sort();}
 queryTokens(value:string){return [...new Set(this.queryPieces(value).map(p=>this.token(p)))].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);}
 clear(){this.values.clear();}
 async validate(value:string){if(this.bits===16)assert.deepEqual(this.tokens(value),[...await searchTokens(ring,scope,this.p,searchPieces(this.p,value))].sort());const buffer=(v:Uint8Array)=>Uint8Array.from(v).buffer;const p=this.p,descriptor=frame([p.modelId,p.fieldId,p.indexId,'text',u32(2),new Uint8Array(),p.normalizer,'substring',u32(this.bits),'skip']);const root=await crypto.subtle.importKey('raw',buffer(ring.key),'HKDF',false,['deriveBits']);const material=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-384',salt:new Uint8Array(),info:buffer(frame(['sealql/index/v3',ring.keyScopeId,descriptor]))},root,384);const key=await crypto.subtle.importKey('raw',material,{name:'HMAC',hash:'SHA-384'},false,['sign']);const prefix=Buffer.from(await crypto.subtle.sign('HMAC',key,buffer(frame(['scope',scope])))).readUInt32BE();let checks=0;for(const id of this.pieces(value)){const digest=Buffer.from(await crypto.subtle.sign('HMAC',key,buffer(frame(['value',scope,Buffer.from(id,'hex')])))),low=(BigInt(digest.readUInt32BE())>>BigInt(32-this.bits))<<BigInt(32-this.bits);assert.equal(this.token(id),String(BigInt.asIntN(64,(BigInt(prefix)<<32n)|low)));checks++;}return checks;}
}
export function cap3(tokens:string[]){const selected=new Set([0,Math.floor((tokens.length-1)/2),tokens.length-1]);return tokens.length<=3?tokens:tokens.filter((_,i)=>selected.has(i));}
export function stats(xs:number[]){const a=[...xs].sort((a,b)=>a-b);return {mean:a.length?a.reduce((a,b)=>a+b,0)/a.length:0,p95:a[Math.ceil(a.length*.95)-1]??0,max:a.at(-1)??0};}

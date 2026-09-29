import {createHmac,hkdfSync} from 'node:crypto';
import {frame,u32,utf8,hex} from '../../../src/core/bytes.js';
import {descriptorBytes,searchPieces,searchTokens} from '../../../src/core/search-tokens.js';
import {Codec as ProductCodec,profile,ring,norm} from '../../attack-extra/codec.js';
import {historical} from '../../attack-extra/historical.js';
import {candidateTokens as researchTokens} from '../../final-return/research-codec.js';
import {assert,scope} from '../../attack-extra/common.js';
export {norm,scope};
export const otherScope='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export type Generation='pre-r9'|'research'|'product';
export type Atom={id:string;kind:string;value:string};
export function decodeAtom(id:string):Atom{const b=Buffer.from(id,'hex');assert.equal(b.readUInt32BE(0),2);let p=4;const size=b.readUInt32BE(p);p+=4;const kind=b.subarray(p,p+size).toString();p+=size;const len=b.readUInt32BE(p);p+=4;return {id,kind,value:b.subarray(p,p+len).toString()};}
export class ActiveCodec {
 readonly p;private key:Buffer;private prefix:bigint;private cache=new Map<string,string>();private pieceCache=new Map<string,string[]>();private atomStrings=new Map<string,string>();
 constructor(readonly field:string,readonly generation:Generation,readonly scopeId=scope,readonly bits=16){this.p=profile(field);assert.ok([12,14,16].includes(bits));assert.ok(bits===16||generation==='product');const p=this.p,descriptor=generation==='product'?(bits===16?descriptorBytes(p):frame([p.modelId,p.fieldId,p.indexId,'text',u32(2),new Uint8Array(),p.normalizer,'substring',u32(bits),'skip'])):frame([p.modelId,p.fieldId,p.indexId,'text',u32(2),new Uint8Array(),p.normalizer,'substring',u32(16),generation==='research'?'word':'','skip']);this.key=Buffer.from(hkdfSync('sha384',ring.key,new Uint8Array(),frame(['sealql/index/v3',ring.keyScopeId,descriptor]),48));this.prefix=BigInt(createHmac('sha384',this.key).update(frame(['scope',scopeId])).digest().readUInt32BE());}
 pieces(value:string):string[]{let result=this.pieceCache.get(value);if(result)return result;const pieces=searchPieces(this.p,value);if(this.generation==='research')for(const word of value.normalize('NFC').toLowerCase().trim().split(/\s+/).filter(Boolean)){const chars=Array.from(word);pieces.push(frame(['word-start',utf8(chars[0])]),frame(['word-end',utf8(chars.at(-1)!)]));}result=[...new Set(pieces.map(hex))].map(id=>{const existing=this.atomStrings.get(id);if(existing!==undefined)return existing;this.atomStrings.set(id,id);return id;});this.pieceCache.set(value,result);return result;}
 token(id:string){let token=this.cache.get(id);if(!token){const n=createHmac('sha384',this.key).update(frame(['value',this.scopeId,Buffer.from(id,'hex')])).digest().readUInt32BE();token=String(BigInt.asIntN(64,(this.prefix<<32n)|BigInt((n>>>(32-this.bits))*2**(32-this.bits))));this.cache.set(id,token);}return token;}
 clearValueCache(){this.pieceCache.clear();}
 tokens(value:string){return [...new Set(this.pieces(value).map(p=>this.token(p)))].sort();}
 async validate(value:string){const actual=this.generation==='product'?await searchTokens(ring,this.scopeId,this.p,searchPieces(this.p,value)):this.generation==='pre-r9'?await historical.searchTokens(ring,this.scopeId,historical.profiles('customers',this.field,{type:'text',search:{substring:true}})[0],historical.searchPieces(this.p,value)):researchTokens(this.field,value,'write');assert.deepEqual(this.tokens(value),[...actual].sort());if(this.generation==='product'&&this.scopeId===scope)await new ProductCodec(this.field).validate(value);}
}

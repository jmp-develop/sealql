/** Frozen task4 byte formats; independent of concurrent product edits. */
import {createHmac,hash,hkdfSync,randomBytes} from 'node:crypto';
import {scope,normalize,assert} from './common.js';
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const frame=(parts:(string|Buffer)[])=>{const b=parts.map(p=>typeof p==='string'?Buffer.from(p):p);return Buffer.concat([u32(b.length),...b.flatMap(p=>[u32(p.length),p])]);};
const keys=new Map<string,{key:Buffer;prefix:bigint}>();
function material(field:string,value:string,op='contains'){
 const exact=op==='eq',mode=exact?'exact':'substring',id=field+'/'+mode;
 let derived=keys.get(id);if(!derived){const descriptor=frame(['customers',field,id,'text',u32(2),Buffer.alloc(0),'legacy-text-v1',mode,u32(16),exact?'':'word',exact?'':'skip']);const key=Buffer.from(hkdfSync('sha384',Buffer.alloc(32,93),Buffer.alloc(0),frame(['sealql/index/v3','global',descriptor]),48));derived={key,prefix:BigInt(createHmac('sha384',key).update(frame(['scope',scope])).digest().readUInt32BE())};keys.set(id,derived);}
 const chars=Array.from(normalize(value)),pieces:Buffer[]=[],piece=(kind:string,v:string)=>frame([kind,Buffer.from(v)]);
 if(exact)pieces.push(Buffer.from(chars.join('')));
 else if(chars.length>=2){for(let i=0;i+1<chars.length;i++)pieces.push(piece('adjacent',chars[i]+chars[i+1]));for(let i=0;i+2<chars.length;i++)pieces.push(piece('skip',chars[i]+chars[i+2]));if(op==='startsWith'||op==='write')pieces.push(piece('start',chars[0]));if(op==='endsWith'||op==='write')pieces.push(piece('end',chars.at(-1)!));if(op==='write'){const words=value.normalize('NFC').toLowerCase().trim().split(/\s+/).filter(Boolean);for(const word of words){const c=Array.from(word);pieces.push(piece('word-start',c[0]),piece('word-end',c.at(-1)!));}}}
 return {derived,pieces:[...new Map(pieces.map(p=>[p.toString('hex'),p])).values()],id};
}
export function candidateTokens(field:string,value:string,op='contains'){
 const {derived,pieces}=material(field,value,op),tokens=new Set<bigint>();for(const p of pieces){const raw=createHmac('sha384',derived.key).update(frame(['value',scope,p])).digest().readUInt32BE();tokens.add(BigInt.asIntN(64,(derived.prefix<<32n)|BigInt((raw>>>16)*65536)));}
 return [...tokens].sort((a,b)=>a<b?-1:a>b?1:0).map(String);
}
const webKeys=new Map<string,Promise<CryptoKey>>(),buffer=(b:Uint8Array)=>Uint8Array.from(b).buffer as ArrayBuffer;
/** Historical write/query token engine: WebCrypto HMAC-SHA384, eight workers, fixed derived-key cache only. */
export async function candidateTokensAsync(field:string,value:string,op='contains'){
 const {derived,pieces,id}=material(field,value,op);if(!pieces.length)return [];
 let pending=webKeys.get(id);if(!pending){pending=crypto.subtle.importKey('raw',buffer(derived.key),{name:'HMAC',hash:'SHA-384'},false,['sign']);webKeys.set(id,pending);}const key=await pending;
 const prefix=BigInt(Buffer.from(await crypto.subtle.sign('HMAC',key,buffer(frame(['scope',scope])))).readUInt32BE());
 const tokens=new Set<bigint>();let cursor=0;await Promise.all(Array.from({length:Math.min(8,pieces.length)},async()=>{while(cursor<pieces.length){const p=pieces[cursor++],raw=Buffer.from(await crypto.subtle.sign('HMAC',key,buffer(frame(['value',scope,p])))).readUInt32BE();tokens.add(BigInt.asIntN(64,(prefix<<32n)|BigInt((raw>>>16)*65536)));}}));
 return [...tokens].sort((a,b)=>a<b?-1:a>b?1:0).map(String);
}
export const positionalKey=(field:string,piece:string)=>createHmac('sha256',Buffer.alloc(32,7)).update([scope,'customers',field,'pb1b-w2-n2',piece].join('\0')).digest();
export const exactKey=(field:string,value:string)=>createHmac('sha256',Buffer.alloc(32,7)).update([scope,'customers',field,'x',normalize(value)].join('\0')).digest();
export function encode(field:string,value:string,cache=new Map<string,Buffer>()){
 const chars=Array.from(normalize(value)),salt=randomBytes(16),psalt=randomBytes(16),seen=new Map<string,number>(),pairs:{s:bigint;p:number}[]=[];
 for(let p=0;p+1<chars.length;p++){const piece=chars[p]+chars[p+1],id=field+'\0'+piece;let key=cache.get(id);if(!key){key=positionalKey(field,piece);cache.set(id,key);}const nth=(seen.get(piece)??0)+1;seen.set(piece,nth);pairs.push({s:hash('sha256',Buffer.concat([key,psalt,u32(nth)]),'buffer').readBigInt64BE(),p});}
 pairs.sort((a,b)=>a.s<b.s?-1:a.s>b.s?1:0);for(let i=1;i<pairs.length;i++)assert.notEqual(pairs[i-1].s,pairs[i].s);
 return {salt:salt.toString('hex'),jx:hash('sha256',Buffer.concat([exactKey(field,value),salt]),'buffer').readBigInt64BE().toString(),psalt:psalt.toString('hex'),n:chars.length,stamps:pairs.map(p=>String(p.s)),positions:pairs.map(p=>p.p)};
}

/** Exact token scorer for the removed earlier product's memo/substring profile. Attack code never calls this. */
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { frame, u32 } from '../../src/core/bytes.js';
import { scopeId } from './common.js';

const modelId='realistic-customers-standard',fieldId='memo',indexId='memo/substring';
const descriptor=frame([modelId,fieldId,indexId,'text',u32(2),new Uint8Array(),'legacy-text-v1','substring',u32(1),u32(16)]);
const digest=createHash('sha256').update(descriptor).digest();
const key=Buffer.from(hkdfSync('sha384',Buffer.alloc(32,93),Buffer.alloc(0),Buffer.from(frame(['sealql/index/v2','project',u32(1),digest])),48));
const scope=createHmac('sha384',key).update(frame(['scope',scopeId])).digest().subarray(0,5);
let prefix=0n;for(const byte of scope)prefix=(prefix<<8n)|BigInt(byte);
const whitespace=/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
export function oldPieces(value:string){
  const s=value.normalize('NFC').replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xff10+48)).replace(whitespace,'').replace(/[A-Z]/g,c=>c.toLowerCase());
  const chars=Array.from(s);return [...new Set(chars.slice(1).map((c,i)=>Buffer.from(chars[i]+c).toString('hex')))];
}
export function oldToken(pieceHex:string){
  const d=createHmac('sha384',key).update(frame(['value',scopeId,Buffer.from(pieceHex,'hex')])).digest();
  return BigInt.asIntN(64,(prefix<<24n)|BigInt((d[0]<<16)|(d[1]<<8))).toString();
}

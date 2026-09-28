/** Research B: actual product candidates plus per-row/per-field salted SHA256 tags. */
import {createHmac, hash, randomBytes} from 'node:crypto';
import {normalizeText} from '../../src/core/search-tokens.js';
import type {Node} from '../verify-native/r8-cases.js';

export const B_K = 8;
export const B_SCOPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const key = Buffer.alloc(32, 7); // .local/research/unified-keys.json: shared research prfKey
export const normalize = (value: string) => normalizeText(value, 'legacy-text-v1');
type Piece = {kind: 'g'|'s'|'e'|'x'; value: string};
export function pieces(value: string): Piece[] {
  const chars = Array.from(normalize(value));
  const found = new Map<string, Piece>();
  const add = (kind: Piece['kind'], value: string) => found.set(kind+'\0'+value, {kind,value});
  for (let length=2; length<=Math.min(B_K,chars.length); length++) {
    for (let i=0; i+length<=chars.length; i++) add('g', chars.slice(i,i+length).join(''));
    add('s',chars.slice(0,length).join(''));
    add('e',chars.slice(-length).join(''));
  }
  return [...found.values()];
}
export function pieceKey(table:string, field:string, piece:Piece): Buffer {
  return createHmac('sha256',key).update([B_SCOPE,table,field,piece.kind,piece.value].join('\0')).digest();
}
export function judge(k:Buffer, salt:Buffer): string {
  return hash('sha256',Buffer.concat([k,salt]),'buffer').readBigInt64BE().toString();
}
/** Cache, when supplied, is owned by one insertion batch and discarded afterwards. */
export function encode(table:string, field:string, value:string, batchKeys?:Map<string,Buffer>) {
  const salt=randomBytes(16);
  const derive=(p:Piece)=>{const id=[table,field,p.kind,p.value].join('\0');let k=batchKeys?.get(id);if(!k){k=pieceKey(table,field,p);batchKeys?.set(id,k);}return k;};
  return {salt:salt.toString('hex'),jt:pieces(value).map(p=>judge(derive(p),salt)),jx:judge(derive({kind:'x',value:normalize(value)}),salt)};
}
export function verification(node:Node, table:string, params:unknown[], alias='j'):string {
  if ('all' in node) return '('+node.all.map(n=>verification(n,table,params,alias)).join(' AND ')+')';
  if ('any' in node) return '('+node.any.map(n=>verification(n,table,params,alias)).join(' OR ')+')';
  const chars=Array.from(normalize(node.value));
  let queryPieces:Piece[];
  if(node.op==='eq') queryPieces=[{kind:'x',value:chars.join('')}];
  else if(chars.length<=B_K) queryPieces=[{kind:node.op==='contains'?'g':node.op==='startsWith'?'s':'e',value:chars.join('')}];
  else {
    queryPieces=[];
    if(node.op==='startsWith')queryPieces.push({kind:'s',value:chars.slice(0,B_K).join('')});
    if(node.op==='endsWith')queryPieces.push({kind:'e',value:chars.slice(-B_K).join('')});
    for(let i=0;i+B_K<=chars.length;i++)queryPieces.push({kind:'g',value:chars.slice(i,i+B_K).join('')});
  }
  return '('+queryPieces.map(p=>{
    params.push(pieceKey(table,node.field,p));
    const tag=`('x'||encode(substr(sha256($${params.length}::bytea||${alias}.salt_${node.field}),1,8),'hex'))::bit(64)::bigint`;
    return node.op==='eq'?`${tag}=${alias}.jx_${node.field}`:`${tag}=ANY(${alias}.jt_${node.field})`;
  }).join(' AND ')+')';
}

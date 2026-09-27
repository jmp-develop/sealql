/** Public core token APIs plus the stable physical companion-column name. */
import { createSealer, profiles, searchPieces, searchTokens } from 'sealql';
import { fields } from './schema.js';

export const cipher=createSealer({key:new Uint8Array(32).fill(93)});
const search={exact:true,substring:{wordBoundary:true,skipGrams:true}} as const;
export function tokenColumn(indexId:string){
  let hash=0xcbf29ce484222325n;
  for(const byte of new TextEncoder().encode(indexId))hash=BigInt.asUintN(64,(hash^BigInt(byte))*0x100000001b3n);
  return `tokens_${hash.toString(16).padStart(16,'0')}`;
}
export function fieldProfiles(model:string,field:typeof fields[number]){
  return profiles(model,field,{type:'text',search});
}
const cache={profiles:new Map<string,Promise<CryptoKey>>()};
export async function recompute(model:string,field:typeof fields[number],scope:string,value:string){
  const ring=cipher.ring(model), out:Record<string,string[]>={};
  for(const profile of fieldProfiles(model,field)){
    const tokens=await searchTokens(ring,scope,profile,searchPieces(profile,value,'write'),cache);
    out[tokenColumn(profile.indexId)]=tokens.map(String);
  }
  return out;
}

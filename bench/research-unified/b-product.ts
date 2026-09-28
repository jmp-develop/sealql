/** Actual standard-product token profiles, with no database connection or mutation. */
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../../src/core/field-cipher.js';
import {createSealed,registrationOf} from '../../src/adapters/drizzle/v0.45/native.js';
import {profiles,searchPieces,searchTokens} from '../../src/core/search-tokens.js';
import type {Node} from '../verify-native/r8-cases.js';
import {B_SCOPE} from './b-codec.js';
export const productSealer=createSealer({key:Buffer.alloc(32,93)});
const sealed=createSealed({sealer:productSealer});
const search={exact:true,substring:{wordBoundary:true,skipGrams:true}} as const;
const fields=['name','phone','address','memo','email','company'];
const schema=pgSchema('native_verify_main');
const entries=Object.fromEntries(['customers','tickets'].map(name=>{
  const table=schema.table(name,{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search})]))});
  return [name,sealed.register(table,{row:'id',scope:'scopeId'})];
}));
const cache={profiles:new Map()};
function profile(table:string,field:string,exact:boolean){return profiles(table,field,{type:'text',search}).find(p=>p.mode===(exact?'exact':'substring'))!;}
export function sourceTokenColumn(table:string,field:string,exact:boolean){const p=profile(table,field,exact);return registrationOf(entries[table]).storage.index!.profiles![p.indexId].tokens;}
export async function writeTokens(table:string,field:string,value:string){
  const e=profile(table,field,true),s=profile(table,field,false);
  return {ce:await searchTokens(productSealer.ring(table),B_SCOPE,e,searchPieces(e,value,'write'),cache),cs:await searchTokens(productSealer.ring(table),B_SCOPE,s,searchPieces(s,value,'write'),cache)};
}
export async function candidate(node:Node,table:string,params:unknown[],alias='j',respectWords=false):Promise<string>{
  if('all'in node){const parts=[];for(const child of node.all)parts.push(await candidate(child,table,params,alias,respectWords));return '('+parts.join(' AND ')+')';}
  if('any'in node){const parts=[];for(const child of node.any)parts.push(await candidate(child,table,params,alias,respectWords));return '('+parts.join(' OR ')+')';}
  const exact=node.op==='eq',p=profile(table,node.field,exact);
  const tokens=await searchTokens(productSealer.ring(table),B_SCOPE,p,searchPieces(p,node.value,node.op==='eq'?'write':node.op),cache);
  params.push(exact?tokens[0]:tokens);
  return exact?`${alias}.ce_${node.field}[1]=$${params.length}::bigint`:`${alias}.cs_${node.field} @> $${params.length}::bigint[]`;
}

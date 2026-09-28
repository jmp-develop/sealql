/** Pure research adapter: no Pool, DB connection, lock, or global instrumentation. */
import assert from 'node:assert/strict';
import {B_K,B_SCOPE,normalize,verification} from './b-codec.js';
import {candidate} from './b-product.js';
import {fields,type Field,type Node} from '../verify-native/r8-cases.js';

type Row=Record<string,any>;
export type BHost={
 query:(text:string,params:unknown[])=>Promise<{rows:Row[]}>;
 /** Open one shared AES-GCM field. The caller owns the key and decryption counter. */
 open:(field:Field,ciphertext:Buffer,id:string)=>string;
};
export type BOptions={mode:'count'|'list';limit?:number;batch?:number;after?:string;forceApp?:boolean};
const whitespace=/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
export function conditionFields(node:Node):Field[]{
 if('all'in node||'any'in node)return [...new Set(('all'in node?node.all:node.any).flatMap(conditionFields))];
 assert(fields.includes(node.field));return [node.field];
}
/** Literal list300 brief: even eq with a long term or spaces enters app checking. */
export function needsAppCheck(node:Node):boolean{
 if('all'in node||'any'in node)return ('all'in node?node.all:node.any).some(needsAppCheck);
 return Array.from(normalize(node.value)).length>B_K||whitespace.test(node.value);
}
/** Same normalized-text meaning as r8 plainWhere; NOT original word boundaries. */
export function normalizedPredicate(node:Node):(read:(field:Field)=>string)=>boolean{
 if('all'in node){const children=node.all.map(normalizedPredicate);return read=>children.every(p=>p(read));}
 if('any'in node){const children=node.any.map(normalizedPredicate);return read=>children.some(p=>p(read));}
 const term=normalize(node.value);
 return read=>{const value=normalize(read(node.field));return node.op==='eq'?value===term:node.op==='contains'?value.includes(term):node.op==='startsWith'?value.startsWith(term):value.endsWith(term);};
}
export async function compileBShared(node:Node,options:BOptions){
 const appCheck=!!options.forceApp||needsAppCheck(node),needed=conditionFields(node);
 const limit=options.limit??300,batch=options.batch??300;
 assert(Number.isSafeInteger(limit)&&limit>0);assert(Number.isSafeInteger(batch)&&batch>0);
 const params:unknown[]=[B_SCOPE];
 let cursor='';if(options.after){params.push(options.after);cursor=` AND j.id>$${params.length}::uuid`;}
 const cand=await candidate(node,'customers',params,'j'),judge=verification(node,'customers',params,'j');
 if(options.mode==='count'&&!appCheck)return {text:`SELECT count(*)::int n FROM research_u.b_customers_tags j WHERE j.scope_id=$1 AND ${cand} AND ${judge}`,params,appCheck,conditionFields:needed};
 // With app checking this LIMIT bounds candidates, never the final accepted count.
 const take=appCheck?batch:limit,projection=appCheck?needed:fields;
 const text=`WITH matched AS MATERIALIZED (
 SELECT j.id FROM (SELECT j.* FROM research_u.b_customers_tags j
 WHERE j.scope_id=$1${cursor} AND ${cand} ORDER BY j.id OFFSET 0) j
 WHERE ${judge} ORDER BY j.id LIMIT ${take})
 SELECT p.id,${projection.map(f=>`p.${f}_ct ${f}`).join(',')}
 FROM matched m JOIN research_u.customers_ct p ON p.id=m.id AND p.scope_id=$1 ORDER BY p.id`;
 return {text,params,appCheck,conditionFields:needed};
}
/** Raw product-token candidate count, for the harness's separately measured metadata. */
export async function compileBProductCandidateCount(node:Node){
 conditionFields(node);const params:unknown[]=[B_SCOPE],cand=await candidate(node,'customers',params,'j');
 return {text:`SELECT count(*)::int n FROM research_u.b_customers_tags j WHERE j.scope_id=$1 AND ${cand}`,params};
}
export async function runBShared(node:Node,options:BOptions,host:BHost){
 const stats={sqlCalls:0,appRows:0,candidateRows:0,projectionRows:0,conditionDecrypts:0,projectionDecrypts:0};
 const query=async(text:string,params:unknown[])=>{const r=await host.query(text,params);stats.sqlCalls++;stats.appRows+=r.rows.length;return r.rows;};
 const first=await compileBShared(node,options);
 if(!first.appCheck){
  const rows=await query(first.text,first.params);
  if(options.mode==='count')return {value:Number(rows[0].n),appCheck:false,conditionFields:first.conditionFields,...stats};
  stats.projectionRows=rows.length;
  const value=rows.map(row=>({id:row.id,...Object.fromEntries(fields.map(f=>{stats.projectionDecrypts++;return [f,host.open(f,row[f],row.id)];}))}));
  return {value,appCheck:false,conditionFields:first.conditionFields,...stats};
 }
 const accept=normalizedPredicate(node),limit=options.limit??300,batch=options.batch??300;
 const accepted=new Map<string,Map<Field,string>>();let count=0,after=options.after,pending:typeof first|undefined=first;
 while(true){
  const take=options.mode==='list'?Math.min(batch,limit-accepted.size):batch;
  const plan=pending&&take===batch?pending:await compileBShared(node,{...options,after,batch:take});pending=undefined;
  const rows=await query(plan.text,plan.params);stats.candidateRows+=rows.length;
  for(const row of rows){
   assert(typeof row.id==='string'&&(!after||row.id>after),'strict UUID keyset order');after=row.id;
   const opened=new Map<Field,string>();
   const read=(field:Field)=>{let value=opened.get(field);if(value===undefined){stats.conditionDecrypts++;value=host.open(field,row[field],row.id);opened.set(field,value);}return value;};
   if(accept(read)){count++;if(options.mode==='list')accepted.set(row.id,opened);}
  }
  if(options.mode==='list'&&accepted.size>=limit)break;
  if(rows.length<take)break;
 }
 if(options.mode==='count')return {value:count,appCheck:true,conditionFields:first.conditionFields,...stats};
 if(!accepted.size)return {value:[],appCheck:true,conditionFields:first.conditionFields,...stats};
 const ids=[...accepted.keys()];
 const rows=await query(`SELECT p.id,${fields.map(f=>`p.${f}_ct ${f}`).join(',')} FROM research_u.customers_ct p WHERE p.scope_id=$1 AND p.id=ANY($2::uuid[]) ORDER BY p.id`,[B_SCOPE,ids]);
 assert.deepEqual(rows.map(r=>r.id),ids,'accepted rows still present and ordered');stats.projectionRows=rows.length;
 const value=rows.map(row=>({id:row.id,...Object.fromEntries(fields.map(f=>{const cache=accepted.get(row.id)!;if(cache.has(f))return [f,cache.get(f)!];stats.projectionDecrypts++;return [f,host.open(f,row[f],row.id)];}))}));
 return {value,appCheck:true,conditionFields:first.conditionFields,...stats};
}

import {candidateTokensAsync,positionalKey,exactKey} from './research-codec.js';
import {scope,fields,normalize,assert,type Node} from './common.js';
export function equivalentLike(n:Node):Node{
 if('all'in n)return {all:n.all.map(equivalentLike)};if('any'in n)return {any:n.any.map(equivalentLike)};
 if(n.op!=='like')return n;
 const q=n.value;assert(!/[_\\]/.test(q),'Historical baseline LIKE comparison uses exactly equivalent prefix/suffix/contains patterns');
 const start=q.startsWith('%'),end=q.endsWith('%'),literal=q.slice(start?1:0,end?-1:undefined);assert(!literal.includes('%')&&Array.from(normalize(literal)).length>=2);
 return {...n,op:start&&end?'contains':start?'endsWith':end?'startsWith':'eq',value:literal};
}
export async function clauses(input:Node,params:unknown[]):Promise<{cand:string;full:string}>{
 const node=equivalentLike(input);
 if('all'in node||'any'in node){const all='all'in node,parts=[];for(const child of all?node.all:(node as {any:Node[]}).any)parts.push(await clauses(child,params));const op=all?' AND ':' OR ';return {cand:'('+parts.map(c=>c.cand).join(op)+')',full:'('+parts.map(c=>c.full).join(op)+')'};}
 const f=node.field;assert(fields.includes(f as any));const tokens=await candidateTokensAsync(f,node.value,node.op);params.push(node.op==='eq'?(f==='company'?String((BigInt(tokens[0])>>30n)&3n):tokens[0]):tokens);
 const cand=node.op==='eq'?`j.ce_${f}[1]=$${params.length}::bigint`:`j.cs_${f} @> $${params.length}::bigint[]`;
 let judge:string;
 if(node.op==='eq'){params.push(exactKey(f,node.value));judge=`(('x'||encode(substr(sha256($${params.length}::bytea||j.salt_${f}),1,8),'hex'))::bit(64)::bigint)=j.jx_${f}`;}
 else{const chars=Array.from(normalize(node.value));assert(chars.length>=2);const offsets:number[]=[];for(let i=0;i+2<=chars.length;i+=2)offsets.push(i);if(offsets.at(-1)!==chars.length-2)offsets.push(chars.length-2);const keys=offsets.map(i=>{params.push(positionalKey(f,chars.slice(i,i+2).join('')));return `$${params.length}::bytea`;});judge=`research_u.pb_4_match(array[${keys.join(',')}],array[${offsets.join(',')}],${chars.length},j.n_${f},j.psalt_${f},j.stamps_${f},j.positions_${f},${node.op==='startsWith'?1:node.op==='endsWith'?2:0})`;}
 return {cand,full:`(${cand} AND ${judge})`};
}
export async function compile(node:Node,mode:string){
 const params:unknown[]=[scope],{cand,full}=await clauses(node,params);
 const text=mode==='count'?`select count(*)::int n from research_u.pb_4_final j where j.scope_id=$1 and ${full}`:`with matched as materialized (select j.id from (select j.* from research_u.pb_4_final j where j.scope_id=$1 and ${cand} order by j.id offset 0) j where ${full} order by j.id ${mode==='list300'?'limit 300':''}) select p.id,${fields.map(f=>`p.${f}_ct`).join(',')} from matched m join native_verify_main.customers p on p.id=m.id and p.scope_id=$1 order by p.id`;
 return {text,params};
}

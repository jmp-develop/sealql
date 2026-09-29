/** Benchmark-only SQL variants. No product switches; callers own lock, DB guards and oracle. */
import assert from 'node:assert/strict';
import {registrationOf} from '../../src/adapters/drizzle/v0.45/native.js';
import {candidatePredicate} from '../../src/core/candidate-sql.js';
import {compileSearch,type SearchNode} from '../../src/core/search-predicate.js';
import {profiles} from '../../src/core/search-tokens.js';
import {stampMigrationSql} from '../../src/core/stamp-sql.js';
import {companionIndexName} from '../../src/core/companion-layout.js';
import type {Sealer} from '../../src/index.js';
import {column,join,pgsql,type Fragment,type Node as SqlNode} from '../../src/core/sql-fragment.js';

export type Query={text:string;params:unknown[]};
type Match={field:string;op:'eq'|'contains'|'startsWith'|'endsWith'|'like';value:unknown}|{all:Match[]}|{any:Match[]};
const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"';
function render(f:Fragment):Query{
 const params:unknown[]=[];
 const part=(n:SqlNode):string=>{
  if(n.kind==='literal')return n.text;
  if(n.kind==='identifier')return n.names.map(ident).join('.');
  if(n.kind==='concat')return n.nodes.map(part).join('');
  params.push(Array.isArray(n.value)?`{${n.value.join(',')}}`:n.value instanceof Uint8Array?Buffer.from(n.value):n.value);
  return `$${params.length}`;
 };return {text:part(f.node),params};
}
const core=(n:Match):SearchNode=>'all'in n?{op:'all',children:n.all.map(core)}:'any'in n?{op:'any',children:n.any.map(core)}:n;
/** Prepare outside measured query time. Pass the same seal/sealer/scope as the API. Pure secure predicates only. */
export async function prepareVariants(seal:object,sealer:Sealer,scope:string,match:Match,reg=registrationOf(seal)){
 const stored=[...reg.fields].flatMap(([key,f])=>profiles(reg.model,f.spec.id??key,f.spec));
 const compiled=await compileSearch(core(match),reg.definition,stored,sealer.ring(reg.model),scope);
 const coarse=(n:typeof compiled):Fragment=>{
  if(n.op!=='leaf')return pgsql`(${join(n.children.map(coarse),n.op==='all'?' and ':' or ')})`;
  const p=reg.storage.index!.profiles![n.leaf.profile.indexId],c=column('c',p.tokens);
  return n.leaf.profile.mode==='exact'?pgsql`(${c})[1]=${n.leaf.tokens[0]}::bigint`:pgsql`${c} @> ${n.leaf.tokens}::bigint[]`;
 };
 const predicate=render(candidatePredicate(reg.definition,reg.storage,scope,compiled));
 const marker=' in (select "__seal_idx"."row_id" from ',start=predicate.text.indexOf(marker);
 assert.ok(start>=0&&predicate.text.endsWith(')'));
 const count={text:'select count(*)::text as count from '+predicate.text.slice(start+marker.length,-1),params:predicate.params};
 return {count,coarse:render(coarse(compiled))};
}
function closing(text:string,open:number):number{
 let depth=0,quote='';
 for(let i=open;i<text.length;i++){
  const c=text[i];if(quote){if(c===quote){if(text[i+1]===quote)i++;else quote='';}continue;}
  if(c==='"'||c==="'"){quote=c;continue;}
  if(c==='(')depth++;else if(c===')'&&--depth===0)return i;
 }throw Error('Unbalanced generated SQL');
}
function cte(text:string,name:string){
 const m=new RegExp(`\\b${name} as materialized \\(`,'i').exec(text);assert.ok(m,`Missing ${name}`);
 const open=m.index+m[0].length-1,end=closing(text,open);return {start:open+1,end,body:text.slice(open+1,end)};
}
function compact(query:Query):Query{
 const used=new Map<number,number>(),params:unknown[]=[];
 const text=query.text.replace(/\$(\d+)/g,(_,n)=>{
  const old=Number(n);assert.ok(old>=1&&old<=query.params.length);
  if(!used.has(old)){used.set(old,params.length+1);params.push(query.params[old-1]);}
  return `$${used.get(old)}`;
 });return {text,params};
}
/** 4d: replace only fallback; keep API projection, quick, keyset and final LIMIT unchanged. */
export function researchFallback(query:Query,coarse:Query):Query{
 if(!/\bwith sample as materialized\s*\(/i.test(query.text))return query;
 const sample=cte(query.text,'sample'),quick=cte(query.text,'quick'),fallback=cte(query.text,'fallback');
 const s=/^\s*select "row_id",([\s\S]+?) from ([\s\S]+?) as "c"\s+where ([\s\S]+?) order by "c"\."row_id" limit \$\d+\s*$/i.exec(sample.body);
 const q=/^\s*select "c"\."row_id" from sample as "c" where ([\s\S]+?) order by "c"\."row_id" limit (\$\d+)\s*$/i.exec(quick.body);
 assert.ok(s,'Unexpected sample shape');assert.ok(q,'Unexpected quick shape');
 const shifted=coarse.text.replace(/\$(\d+)/g,(_,n)=>`$${query.params.length+Number(n)}`);
 const body=`select "c"."row_id" from (
 select "row_id",${s[1]} from ${s[2]} as "c" where ${s[3]} and ${shifted}
 order by "c"."row_id" offset 0
 ) as "c" where ${q[1]} and (select count(*) from quick)<${q[2]}
 order by "c"."row_id" limit ${q[2]}`;
 return compact({text:query.text.slice(0,fallback.start)+body+query.text.slice(fallback.end),params:[...query.params,...coarse.params]});
}
/** 4b: install renamed functions in the benchmark's NEW schema, then rewrite only calls. */
export function functionVariant(schema:string,mode:'checks-off'|'qualified-no-set'){
 assert.ok(/^test_/.test(schema),'Variant functions must stay in a new test schema');
 const suffix=mode==='checks-off'?'_bench_checks':'_bench_noset';
 const names=['sealql_piece_positions','sealql_run_positions','sealql_match_positions','sealql_match_like'];
 const rename=(text:string)=>names.reduce((s,name)=>s.replaceAll(name,name+suffix),text);
 let removedChecks=0;
 const statements=stampMigrationSql(schema).filter(s=>s.startsWith('create or replace function')).map(original=>{
  let sql=rename(original);
  if(mode==='checks-off'){
   sql=sql.replace(/\bif\s+(?:(?!\bthen\b|;)[\s\S])*\bthen\s*raise exception using[^;]*;\s*end if;/gi,()=>{removedChecks++;return '';});
   if(original.includes('.sealql_match_positions(')){
    sql=sql.replace('  loop\n    wanted :=','  while first_ordinal<=n loop\n    wanted :=')
     .replace('while latest[wi] < target loop','while latest[wi] < target and ordinals[wi]<=n loop')
     .replace('    if ok then return true; end if;\n  end loop;\nend','    if ok then return true; end if;\n  end loop;\n  return false;\nend');
   }
  }else{
   sql=sql.replace(' set search_path = pg_catalog','');
   for(const name of ['cardinality','array_position','array_lower','array_fill','array_append','octet_length','encode','substr','sha256','int4send'])
    sql=sql.replace(new RegExp(`(?<![.\\w])${name}\\(`,'g'),`pg_catalog.${name}(`);
  }
  return sql;
 });
 if(mode==='checks-off')assert.ok(removedChecks>=5,'Check-removal transform drift');
 return {statements,removedChecks,rewrite:(query:Query):Query=>({...query,text:rename(query.text)})};
}
/** 4c: apply BEFORE loading a fresh clone. ALTER alone does not rewrite existing TOAST values. */
export function storageVariant(seal:object,mode:'MAIN'|'EXTENDED',reg=registrationOf(seal)):string[]{
 const index=reg.storage.index!;assert.ok(/^test_/.test(index.schema));
 const columns=Object.values(index.profiles!).flatMap(p=>[p.tokens,...(p.positions?[p.positions.stamps,p.positions.offsets]:[])]);
 return columns.map(c=>`alter table ${ident(index.schema)}.${ident(index.name)} alter column ${ident(c)} set storage ${mode}`);
}
/** 4c: exact tail keys are compared independently from MAIN, on an owned test clone. */
export function exactTailVariant(seal:object,cover:boolean,reg=registrationOf(seal)):string[]{
 const index=reg.storage.index!;assert.ok(/^test_/.test(index.schema));
 const result:string[]=[];
 for(const [id,p]of Object.entries(index.profiles!))if(p.exact){
  const name=companionIndexName(index.name,id)+'_bt';
  const tail=cover&&reg.definition.rowType==='uuid'&&(!reg.scope||reg.definition.scopeType==='uuid')?[p.exact.salt,p.exact.stamp,p.tokens]:[];
  result.push(`drop index if exists ${ident(index.schema)}.${ident(name)}`,
   `create index ${ident(name)} on ${ident(index.schema)}.${ident(index.name)} (scope_id,(${ident(p.tokens)}[1]),row_id${tail.map(c=>','+ident(c)).join('')})`);
 }return result;
}

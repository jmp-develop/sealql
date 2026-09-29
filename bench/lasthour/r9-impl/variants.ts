/** Only generated bench SQL is rewritten; the product compiler remains unchanged. */
import {assert,schema} from './common.js';
import type {Statement} from '../../final-return/instrument.js';
export const helperSql=`create or replace function ${schema}.sealql_has_all(haystack pg_catalog.int8[], needles pg_catalog.int8[]) returns pg_catalog.bool
language plpgsql immutable strict parallel safe cost 100 set search_path=pg_catalog
as $$ begin return haystack OPERATOR(pg_catalog.@>) needles; end $$`;
const candidate=/("[^"]+"\."tokens_[a-f0-9]+")\s*@>\s*\$(\d+)::bigint\[\]/g;
function members(v:unknown):any[]{if(Array.isArray(v))return v;assert(typeof v==='string'&&/^\{[-\d,]*\}$/.test(v),'Unexpected token representation');return v.slice(1,-1).split(',').filter(Boolean);}
export function rewrite(q:Statement,restCheck:boolean):Statement {
 const values=[...q.values],restParams=new Map<number,number>();
 const text=q.text.replace(candidate,(full,lhs:string,n:string)=>{
  const index=Number(n)-1,original=q.values[index],array=members(original);if(array.length<=3)return full;
  if(!restParams.has(index)){
   const indices=new Set([0,Math.floor((array.length-1)/2),array.length-1]),selected=array.filter((_,i)=>indices.has(i)),rest=array.filter((_,i)=>!indices.has(i));
   assert.equal(selected.length+rest.length,array.length);
   values[index]=Array.isArray(original)?selected:`{${selected.join(',')}}`;
   if(restCheck){values.push(Array.isArray(original)?rest:`{${rest.join(',')}}`);restParams.set(index,values.length);}else restParams.set(index,0);
  }
  return restCheck?`(${full} and "${schema}"."sealql_has_all"(${lhs},$${restParams.get(index)}::bigint[]))`:full;
 });
 const all=[...q.text.matchAll(/@>\s*\$(\d+)::bigint\[\]/g)];assert.equal(all.length,[...q.text.matchAll(candidate)].length,'Every candidate atom must be recognized');
 return {text,values};
}
export function transform(path:string){return path==='P1'?(q:Statement)=>rewrite(q,false):path==='P2'||path==='P3'?(q:Statement)=>rewrite(q,true):undefined;}
function endGroup(text:string,start:number):number {assert.equal(text[start],'(');let depth=0,quote='';for(let i=start;i<text.length;i++){const c=text[i];if(quote){if(c===quote){if(text[i+1]===quote)i++;else quote='';}continue;}if(c==='\''||c==='"'){quote=c;continue;}if(c==='(')depth++;else if(c===')'&&--depth===0)return i+1;}throw Error('Unbalanced SQL');}
export function candidateCount(q:Statement):Statement {
 assert(q.text.startsWith('select count(*)::text as count from ('));
 let text=q.text;
 for(const pattern of [new RegExp(`"${schema}"\\."sealql_match_(?:positions|like)"\\(`),/"__seal_idx"\."eq_stamp_[a-f0-9]+"\s*=\(/])for(let m=pattern.exec(text);m;m=pattern.exec(text)){const end=endGroup(text,m.index+m[0].length-1);text=text.slice(0,m.index)+'true'+text.slice(end);}
 assert(!/sealql_match_|eq_stamp_/.test(text));
 const values:any[]=[],mapping=new Map<number,number>();text=text.replace(/\$(\d+)/g,(_,n:string)=>{const old=Number(n)-1;if(!mapping.has(old)){values.push(q.values[old]);mapping.set(old,values.length);}return '$'+mapping.get(old);});return {text,values};
}

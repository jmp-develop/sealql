/** Bench only: retain at most three evenly spaced members of each candidate array. */
import {assert} from './common.js';
import type {Statement} from '../../final-return/instrument.js';
export function cap3(q:Statement):Statement {
 const values=[...q.values];
 for(const index of new Set([...q.text.matchAll(/@>\s*\$(\d+)::bigint\[\]/g)].map(m=>Number(m[1])-1))){
  const original=values[index],array=Array.isArray(original)?original:typeof original==='string'&&/^\{[-\d,]*\}$/.test(original)?original.slice(1,-1).split(',').filter(Boolean):undefined;
  assert(array,'Unexpected candidate array representation');
  if(array.length>3){const chosen=[array[0],array[Math.floor((array.length-1)/2)],array[array.length-1]];values[index]=Array.isArray(original)?chosen:`{${chosen.join(',')}}`;}
 }
 return {text:q.text,values};
}
function endGroup(text:string,start:number):number {
 assert.equal(text[start],'(');let depth=0,quote='';
 for(let i=start;i<text.length;i++){const c=text[i];if(quote){if(c===quote){if(text[i+1]===quote)i++;else quote='';}continue;}if(c==='\''||c==='"'){quote=c;continue;}if(c==='(')depth++;else if(c===')'&&--depth===0)return i+1;}
 throw Error('Unbalanced generated SQL');
}
/** Strip only exact proofs from the generated count; retain the complete Boolean candidate tree. */
export function candidateCount(q:Statement):Statement {
 assert(q.text.startsWith('select count(*)::text as count from ('),'Use public count SQL');
 let text=q.text;
 for(const pattern of [/"test_followup_product"\."sealql_match_(?:positions|like)"\(/,/"__seal_idx"\."eq_stamp_[a-f0-9]+"\s*=\(/]){
  for(let match=pattern.exec(text);match;match=pattern.exec(text)){const start=match.index,end=endGroup(text,start+match[0].length-1);text=text.slice(0,start)+'true'+text.slice(end);}
 }
 assert(!/sealql_match_|eq_stamp_/.test(text),'All exact proofs removed');
 const values:any[]=[],mapping=new Map<number,number>();
 text=text.replace(/\$(\d+)/g,(_,n:string)=>{const old=Number(n)-1;if(!mapping.has(old)){values.push(q.values[old]);mapping.set(old,values.length);}return '$'+mapping.get(old);});
 return {text,values};
}

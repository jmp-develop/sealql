import {norm,unique} from './models.js';
import {counts} from './attacks.js';
export interface Observation {opaque:string;hits:number[];label?:string}
/** No query labels enter the unknown-query branch. Public dictionary frequencies only. */
export function inferQueryLabels(reference:string[],observations:Observation[],terms:string[],accepts:(value:string,term:string)=>boolean,knownFrequency?:Map<string,number>){
 const dictionary=unique(terms),frequency=knownFrequency??new Map(dictionary.map(q=>[q,reference.filter(v=>accepts(v,q)).length]));
 const unused=new Set(dictionary),assigned=new Map<string,string>();
 for(const observation of [...observations].sort((a,b)=>b.hits.length-a.hits.length)){
  if(assigned.has(observation.opaque))continue;let best:string|undefined,distance=Infinity;
  for(const q of unused){const d=Math.abs(Math.log(observation.hits.length+.5)-Math.log((frequency.get(q)??0)+.5));if(d<distance){distance=d;best=q;}}
  if(best!==undefined){assigned.set(observation.opaque,best);unused.delete(best);}
 }
 return observations.map(o=>({...o,label:assigned.get(o.opaque)}));
}
/** Query-result incidence / negative-evidence dictionary attack. A positive candidate
 * hit can be a truncation/Bloom false positive; only absent hits rule out expected terms.
 */
export function observationGuesses(reference:string[],rowCount:number,observations:Observation[],accepts:(value:string,term:string)=>boolean){
 const freq=counts(reference),ordered=[...freq.keys()].sort((a,b)=>freq.get(b)!-freq.get(a)!),maskGroups=new Map<bigint,string>();
 const actual=Array<bigint>(rowCount).fill(0n);observations.forEach((o,i)=>{for(const r of o.hits)actual[r]|=1n<<BigInt(i);});
 for(const v of ordered){let mask=0n;observations.forEach((o,i)=>{if(o.label!==undefined&&accepts(v,o.label))mask|=1n<<BigInt(i);});if(!maskGroups.has(mask))maskGroups.set(mask,v);}
 const pop=(n:bigint)=>{let c=0;for(;n;n&=n-1n)c++;return c;};
 const groups=[...maskGroups].map(([m,v])=>({m,v,n:pop(m)})).sort((a,b)=>b.n-a.n||freq.get(b.v)!-freq.get(a.v)!);
 const cache=new Map<bigint,string>();return actual.map(mask=>{let v=cache.get(mask);if(v===undefined){v=groups.find(g=>(g.m&~mask)===0n)?.v??ordered[0];cache.set(mask,v);}return v;});
}
export interface OpaqueLocations {opaque:string;locations:Map<number,number[]>;docs:number;occurrences:number}
/** Rank opaque piece keys by document/occurrence frequency; never reads query plaintext. */
export function inferPositionLabels(reference:string[],observed:OpaqueLocations[]){
 const freq=new Map<string,{docs:number;occurrences:number}>();for(const v of reference){const c=Array.from(v),seen=new Set<string>();for(let i=0;i+1<c.length;i++){const p=c[i]+c[i+1],f=freq.get(p)??{docs:0,occurrences:0};f.occurrences++;if(!seen.has(p))f.docs++;seen.add(p);freq.set(p,f);}}
 const labels=new Map<string,string>();for(const o of [...observed].sort((a,b)=>b.docs-a.docs)){
  let best:string|undefined,distance=Infinity;for(const [p,f]of freq){const d=(Math.log(o.docs+.5)-Math.log(f.docs+.5))**2+(Math.log(o.occurrences+.5)-Math.log(f.occurrences+.5))**2;if(d<distance){best=p;distance=d;}}
  if(best!==undefined){labels.set(o.opaque,best);freq.delete(best);}
 }return labels;
}
export function positionGuesses(lengths:number[],observed:OpaqueLocations[],labels:Map<string,string>){
 const votes=lengths.map(n=>Array.from({length:n},()=>new Map<string,number>()));
 for(const o of observed){const p=labels.get(o.opaque);if(p===undefined)continue;const c=Array.from(p);for(const [r,ps]of o.locations)for(const pos of ps)for(let j=0;j<2;j++){const m=votes[r][pos+j];m.set(c[j],(m.get(c[j])??0)+1);}}
 return votes.map(row=>row.map(v=>[...v].sort((a,b)=>b[1]-a[1])[0]?.[0]));
}
export function fillPositions(reference:string[],partial:(string|undefined)[][],fallback:string[]){
 const freq=counts(reference),prior=[...freq.keys()].sort((a,b)=>freq.get(b)!-freq.get(a)!),chars=prior.map(v=>Array.from(v));
 const byLength=new Map<number,number[]>(),byChar=new Map<string,number[]>();chars.forEach((cs,i)=>{const a=byLength.get(cs.length)??[];a.push(i);byLength.set(cs.length,a);cs.forEach((c,p)=>{const k=p+'\0'+c,b=byChar.get(k)??[];b.push(i);byChar.set(k,b);});});
 return partial.map((ps,r)=>{const labels=ps.flatMap((c,i)=>c===undefined?[]:[{c,i}]),pools=[byLength.get(ps.length)??[],...labels.map(({c,i})=>byChar.get(i+'\0'+c)??[])],smallest=pools.reduce((a,b)=>a.length<b.length?a:b);
  const id=smallest.find(i=>chars[i].length===ps.length&&labels.every(p=>chars[i][p.i]===p.c)),base=Array.from(id===undefined?fallback[r]:prior[id]);return ps.map((c,i)=>c??base[i]??'\ufffd').join('');});
}

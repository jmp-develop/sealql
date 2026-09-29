/** Public-format DFS, including positive and negative observed substring queries.
 * No truth, root, tag encoder or occurrence ledger enters this attack. */
import type {Observation} from '../competitor-sim/observation.js';
import {norm,unique} from '../competitor-sim/models.js';
export function queryPhonePredictor(reference:string[],observations:Observation[],rowCount:number,maxStates=20000,shape?:(candidate:string,row:number)=>boolean){
 const values=reference.map(norm),n=values[0].length;
 if(!values.every(v=>v.length===n&&/^[\x00-\x7f]*$/.test(v)))throw Error('Reference does not have one ASCII phone format');
 const alphabet=Array.from({length:n},(_,i)=>unique(values.map(v=>v[i]))),allowed=alphabet.map(a=>new Set(a));
 const terms=observations.map(o=>o.label),masks=Array<bigint>(rowCount).fill(0n),byLength=new Map<number,Map<string,bigint>>();
 observations.forEach((o,i)=>{if(o.label===undefined)return;const bit=1n<<BigInt(i);for(const r of o.hits)masks[r]|=bit;const map=byLength.get(o.label.length)??new Map();map.set(o.label,(map.get(o.label)??0n)|bit);byLength.set(o.label.length,map);});
 const referenceByMask=new Map<bigint,string[]>();
 for(const v of new Set(values)){let mask=0n;terms.forEach((q,i)=>{if(q!==undefined&&v.includes(q))mask|=1n<<BigInt(i);});const a=referenceByMask.get(mask)??[];a.push(v);referenceByMask.set(mask,a);}
 return (row:number)=>{const need=masks[row],required=terms.flatMap((q,i)=>q!==undefined&&(need&(1n<<BigInt(i)))?[{q,bit:1n<<BigInt(i)}]:[]),solutions:string[]=[];let states=0,capped=false;
  const witnesses=(referenceByMask.get(need)??[]).filter(v=>!shape||shape(v,row)).slice(0,2);
  if(witnesses.length===2)return {value:undefined,solutions:2,witnesses,states:0,capped:false};
  const canFit=(path:string,q:string)=>{for(let start=Math.max(0,path.length-q.length+1);start+q.length<=n;start++){let ok=true;for(let j=0;j<q.length;j++){const p=start+j;if(p<path.length?path[p]!==q[j]:!allowed[p].has(q[j])){ok=false;break;}}if(ok)return true;}return false;};
  const walk=(path:string,seen:bigint)=>{if(++states>maxStates){capped=true;return;}if(capped||solutions.length>=2)return;
   if(required.some(({q,bit})=>!(seen&bit)&&!canFit(path,q)))return;
   if(path.length===n){if((seen&need)===need&&(!shape||shape(path,row)))solutions.push(path);return;}
   for(const char of alphabet[path.length]){const next=path+char;let found=0n;for(const [length,map]of byLength)if(next.length>=length)found|=map.get(next.slice(-length))??0n;
    if(found&~need)continue;walk(next,seen|found);if(capped||solutions.length>=2)return;}
  };walk('',0n);return {value:!capped&&solutions.length===1?solutions[0]:undefined,solutions:solutions.length,witnesses:solutions,states,capped};
 };
}

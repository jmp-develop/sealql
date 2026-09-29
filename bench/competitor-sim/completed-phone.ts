/** Completed whole-population Bloom attack, retained alongside the stronger,
 * time-limited capacity-six experiment. Positive intersections wider than k
 * remain unknown; this makes the attack incomplete, not the model secure. */
import {learn,phonePredictor,type PublicModel} from './attacks.js';
import {norm,unique} from './models.js';
export function completedPhonePredictor(model:PublicModel,reference:string[],probes:string[],views:string[][]){
 if(model.kind!=='bloom')return phonePredictor(model,reference,probes,views);
 const learned=learn(probes.map(model.pieces),views),map=new Map([...learned.alternatives].filter(([,ts])=>ts.length<=6));
 const values=reference.map(norm),n=values[0].length;
 if(!values.every(v=>v.length===n&&/^[\x00-\x7f]*$/.test(v)))return undefined;
 const alphabet=Array.from({length:n},(_,i)=>unique(values.map(v=>v[i])));
 return {metadata:{hypotheses:1,overflow:false,mappedPieces:map.size,bloomHypothesis:true,algorithm:'complete-intersection-at-most-k'},predict(view:string[]){
  const set=new Set(view),solutions=new Set<string>();let states=0,capped=false;
  const walk=(path:string,seen:Set<string>)=>{
   if(++states>2000000){capped=true;return;}if(capped||solutions.size>=2)return;
   if(path.length===n){if(seen.size===set.size)solutions.add(path);return;}
   for(const c of alphabet[path.length]){const ts=path.length>=2?map.get(path.slice(-2)+c):[];
    if(!ts||ts.some(t=>!set.has(t)))continue;
    walk(path+c,new Set([...seen,...ts]));if(capped||solutions.size>=2)return;
   }
  };walk('',new Set());return {value:!capped&&solutions.size===1?[...solutions][0]:undefined,solutions:solutions.size,states,capped};
 }};
}

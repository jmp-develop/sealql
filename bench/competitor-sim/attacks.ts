import {norm,unique,type Model} from './models.js';
import {decodeAtom} from '../final-review/r9-impl/codec.js';
/** Public transforms and reference plaintext only; this object contains NO PRF/key. */
export type PublicModel=Pick<Model,'id'|'kind'|'field'|'pieces'|'queryPieces'>;
export function counts(xs:string[]){const m=new Map<string,number>();for(const x of xs)m.set(x,(m.get(x)??0)+1);return m;}
export function signatures(rows:string[][]){const m=new Map<string,bigint>();rows.forEach((xs,i)=>{const b=1n<<BigInt(i);for(const x of new Set(xs))m.set(x,(m.get(x)??0n)|b);});return m;}
export function learn(plain:string[][],views:string[][]){
 const ps=signatures(plain),ts=signatures(views),reverse=new Map<bigint,string[]>();
 for(const [p,s]of ps){const a=reverse.get(s)??[];a.push(p);reverse.set(s,a);}
 const labels=new Map<string,string>(),alternatives=new Map<string,string[]>();
 for(const [t,s]of ts){const a=reverse.get(s);if(a?.length===1)labels.set(t,a[0]);}
 // Retain every bucket compatible with all positive rows; hash collisions are not discarded.
 for(const [p,s]of ps)alternatives.set(p,[...ts].filter(([,t])=>(s&~t)===0n).map(([t])=>t));
 return {labels,alternatives};
}
export function dictionaryPredictor(model:PublicModel,reference:string[],probes:string[],views:string[][]){
 const frequency=counts(reference.map(norm)),prior=[...frequency.keys()].sort((a,b)=>frequency.get(b)!-frequency.get(a)!);
 const learned=learn(probes.map(model.pieces),views),ids=new Map([...new Set(learned.labels.values())].map((p,i)=>[p,i]));
 const labelsToTokens=new Map<string,string[]>();for(const [t,p]of learned.labels){const a=labelsToTokens.get(p)??[];a.push(t);labelsToTokens.set(p,a);}
 const mask=(ps:string[])=>{let mask=0n;for(const p of ps){const i=ids.get(p);if(i!==undefined)mask|=1n<<BigInt(i);}return mask;};
 const dictionary=new Map<bigint,string>();for(const value of prior){const s=mask(model.pieces(value));if(!dictionary.has(s))dictionary.set(s,value);}
 const direct=new Map<string,string[]>();probes.forEach((value,i)=>{const sig=views[i].join(','),a=direct.get(sig)??[];a.push(norm(value));direct.set(sig,unique(a));});
 for(const [sig,a]of direct)direct.set(sig,a.sort((a,b)=>(frequency.get(b)??0)-(frequency.get(a)??0)));
 return {learned,predict(view:string[]){
  const directValues=direct.get(view.join(','));if(directValues)return {value:directValues[0],method:'observed-whole-index',alternatives:directValues.length};
  const set=new Set(view),seen=counts(view.flatMap(t=>learned.labels.has(t)?[learned.labels.get(t)!]:[]));
  const labels=[...seen].filter(([p,n])=>model.kind!=='bloom'||n===labelsToTokens.get(p)!.length).map(([p])=>p);
  const value=dictionary.get(mask(labels));return {value:value??prior[0],method:value?'known-incidence-signature':'reference-prior',alternatives:0};
 }};
}
/** Collision-aware phone reconstruction. Format/alphabet come ONLY from reference.
 * S0 enumerates compatible bucket assignments and retains full-probe consistency.
 * Bloom retains all bit alternatives and solves capacity-six explanations; minimum
 * distinct bit count is a heuristic, so this is not a uniqueness proof.
 */
export function phonePredictor(model:PublicModel,reference:string[],probes:string[],views:string[][],maxStates=2000000){
 const relevant=(p:string)=>model.id!=='S0'||p.startsWith('s:');
 const plain=probes.map(v=>model.pieces(v).filter(relevant)),encrypted=views.map(ts=>ts.filter(relevant));
 const learned=learn(plain,encrypted),values=reference.map(norm),n=values[0].length;
 if(!values.every(v=>v.length===n&&/^[\x00-\x7f]*$/.test(v)))return undefined;
 const alphabet=Array.from({length:n},(_,i)=>unique(values.map(v=>v[i])));
 let hypotheses:Map<string,string[]>[]=[];let overflow=false;
 if(model.kind==='bloom')hypotheses=[new Map(learned.alternatives)];
 else {
  hypotheses=[new Map()];for(const [p,ts]of learned.alternatives){
   if(hypotheses.length*ts.length>10000){overflow=true;hypotheses=[new Map(learned.alternatives)];break;}
   hypotheses=hypotheses.flatMap(m=>ts.map(t=>new Map([...m,[p,[t]] as [string,string[]]])));
  }
  if(!overflow)hypotheses=hypotheses.filter(m=>plain.every((ps,i)=>unique(ps.flatMap(p=>m.get(p)!)).join(',')===encrypted[i].join(',')));
 }
 const maps=hypotheses.map(m=>new Map([...m].map(([p,ts])=>{if(model.kind==='bloom')return ['gram\0'+p,ts];const a=decodeAtom(p.slice(2));return [a.kind+'\0'+a.value,ts];})));
 return {metadata:{hypotheses:hypotheses.length,overflow,mappedPieces:hypotheses[0]?.size??0,bloomHypothesis:model.kind==='bloom'},predict(view:string[]){
  const set=new Set(view.filter(relevant)),solutions=new Set<string>();let states=0,capped=false;
  for(const map of maps){
   if((overflow&&model.id==='S0')||model.kind==='bloom'){
    // Existential bucket assignments per candidate avoid discarding ambiguous mappings.
    // Every observed token needs a distinct explaining piece; multiple pieces may collide.
    const capacity=model.kind==='bloom'?6:1;
    const covers=(assigned:Map<string,string[]>)=>{const used=new Map<string,string[]>();
     const match=(t:string,seen:Set<string>):boolean=>{for(const [p,ts]of assigned){if(!ts.includes(t)||seen.has(p))continue;seen.add(p);const previous=used.get(p)??[];if(previous.length<capacity){used.set(p,[...previous,t]);return true;}for(let i=0;i<previous.length;i++)if(match(previous[i],seen)){previous[i]=t;return true;}}return false;};
     return [...set].every(t=>match(t,new Set()));};
    const walk=(path:string,assigned:Map<string,string[]>)=>{
     if(++states>maxStates){capped=true;return;}if(capped||solutions.size>=2)return;
     if(path.length===n){if(covers(assigned))solutions.add(path);return;}
     const i=path.length;for(const c of alphabet[i]){const needs=model.kind==='bloom'?(i>=2?['gram\0'+path.slice(-2)+c]:[]):[...(i===0?['start\0'+c]:['adjacent\0'+path.at(-1)!+c]),...(i>=2?['skip\0'+path.at(-2)!+c]:[]),...(i===n-1?['end\0'+c]:[])];
      const next=new Map(assigned);let possible=true;for(const p of needs){const all=map.get(p)??[...set],allowed=all.filter(t=>set.has(t));if(allowed.length<(model.kind==='bloom'?Math.min(6,all.length):1)){possible=false;break;}next.set(p,allowed);}if(possible)walk(path+c,next);if(capped||solutions.size>=2)return;
     }
    };walk('',new Map());if(capped||solutions.size>=2)break;continue;
   }
   const walk=(path:string,seen:Set<string>)=>{
    if(++states>maxStates){capped=true;return;}if(capped||solutions.size>=2)return;
    if(path.length===n){if(seen.size===set.size)solutions.add(path);return;}
    const i=path.length;for(const c of alphabet[i]){
     const needs:string[]=model.kind==='bloom'?(i>=2?['gram\0'+path.slice(-2)+c]:[]):[
      ...(i===0?['start\0'+c]:['adjacent\0'+path.at(-1)!+c]),...(i>=2?['skip\0'+path.at(-2)!+c]:[]),...(i===n-1?['end\0'+c]:[])];
     const bits=needs.map(p=>map.get(p));if(bits.some(ts=>!ts||ts.some(t=>!set.has(t))))continue;
     walk(path+c,new Set([...seen,...bits.flatMap(ts=>ts!)]));if(capped||solutions.size>=2)return;
    }
   };walk('',new Set());if(capped||solutions.size>=2)break;
  }
  return {value:!capped&&solutions.size===1?[...solutions][0]:undefined,solutions:solutions.size,states,capped};
 }};
}
export function score(truth:string[],guesses:(string|undefined)[]){
 let correct=0,characters=0,totalCharacters=0,mostly=0;truth.forEach((value,i)=>{const a=Array.from(norm(value)),b=Array.from(guesses[i]??'');let n=0;a.forEach((c,j)=>{if(c===b[j])n++;});correct+=Number(norm(value)===guesses[i]);characters+=n;totalCharacters+=a.length;mostly+=Number(n>=a.length*.8);});
 return {rows:truth.length,correct,valuePct:correct/truth.length*100,characters,totalCharacters,characterPct:characters/totalCharacters*100,mostly,mostlyPct:mostly/truth.length*100};
}

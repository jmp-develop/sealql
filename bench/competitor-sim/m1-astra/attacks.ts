/** Predictors receive only public tokenization, reference/known plaintext and
 * leaked index views. Secret encoders and held-out truth never enter this file. */
export interface View { tokens:string[]; bytes?:number; length?:number }
export interface PublicModel { features(value:string):string[]; multiplicity:number; bloomBits?:number }
export interface Known { value:string; view:View }
type Entry={value:string;count:number;features:string[];featureSet:Set<string>;bytes:number;length:number;vector:number[];group:number};
const normalized=(v:string)=>v.normalize('NFC').replace(/[！-～]/g,c=>String.fromCharCode(c.charCodeAt(0)!-0xff01+0x21)).replace(/[A-Z]/g,c=>c.toLowerCase()).replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g,'');
const signature=(xs:string[])=>[...new Set(xs)].sort().join('\u0001');
function frequency(lists:string[][]){const m=new Map<string,number>();for(const xs of lists)for(const x of new Set(xs))m.set(x,(m.get(x)??0)+1);return m;}
function vector(xs:string[],freq:Map<string,number>,total:number,noise=0){const a=xs.map(x=>Math.log(noise+(1-noise)*(freq.get(x)??.5)/total)).sort((a,b)=>a-b);return a.length?[a[0],a[Math.floor(a.length/2)],a.at(-1)!,a.reduce((s,x)=>s+x,0)/a.length]:[0,0,0,0];}
const sameLengths=(e:Entry,v:View)=>(v.bytes===undefined||e.bytes===v.bytes)&&(v.length===undefined||e.length===v.length);
/** Candidate feature -> observed tokens that occurred in every known row with it.
 * This is the collision-aware S(feature) subset S(token) condition. */
export function learnCandidates(model:PublicModel,known:Known[]){const occurrences=new Map<string,number[]>(),sets=known.map(k=>new Set(k.view.tokens));known.forEach((k,i)=>{for(const p of new Set(model.features(k.value))){const rows=occurrences.get(p)??[];rows.push(i);occurrences.set(p,rows);}});const map=new Map<string,string[]>();for(const [p,rows]of occurrences){const pivot=rows.reduce((a,b)=>sets[a].size<sets[b].size?a:b);map.set(p,[...sets[pivot]].filter(t=>rows.every(i=>sets[i].has(t))).sort());}return map;}
export function buildAttacks(model:PublicModel,reference:string[],views:View[],known:Known[]){
 const counts=new Map<string,number>();for(const v of reference)counts.set(v,(counts.get(v)??0)+1);for(const k of known)if(!counts.has(k.value))counts.set(k.value,1);
 const referenceFeatures=reference.map(v=>[...new Set(model.features(v))]),plainFreq=frequency(referenceFeatures),tokenFreq=frequency(views.map(v=>v.tokens)),groups=frequency(views.map(v=>[signature(v.tokens)]));
 const featureGroups=frequency(referenceFeatures.map(fs=>[signature(fs)])),noise=model.bloomBits?views.reduce((a,v)=>a+v.tokens.length,0)/(views.length*model.bloomBits):0;
 const entries:Entry[]=[...counts].map(([value,count])=>{const features=[...new Set(model.features(value))];return {value,count,features,featureSet:new Set(features),bytes:Buffer.byteLength(value),length:Array.from(normalized(value)).length,vector:vector(features,plainFreq,reference.length,noise),group:featureGroups.get(signature(features))??1};}).sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value));
 const representatives=new Map<string,Entry>();for(const e of entries){const key=signature(e.features);if(!representatives.has(key))representatives.set(key,e);}
 const rankedPlain=[...representatives].sort((a,b)=>b[1].group-a[1].group||a[0].localeCompare(b[0])),rankedObserved=[...groups].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 const ranked=new Map(rankedObserved.map(([key],i)=>[key,rankedPlain[i]?.[1]]));
 const byMean=[...entries].sort((a,b)=>a.vector[3]-b.vector[3]||b.count-a.count),byGroup=[...entries].sort((a,b)=>a.group-b.group||b.count-a.count),byBytes=new Map<number,Entry[]>(),byLength=new Map<number,Entry[]>();for(const e of entries){const bs=byBytes.get(e.bytes)??[];bs.push(e);byBytes.set(e.bytes,bs);const ls=byLength.get(e.length)??[];ls.push(e);byLength.set(e.length,ls);}
 const candidates=learnCandidates(model,known),learned=new Map([...candidates].filter(([,ts])=>ts.length>0&&ts.length<=model.multiplicity)),labels=[...learned.keys()].sort(),ids=new Map(labels.map((p,i)=>[p,i]));
 const tokenToFeatures=new Map<string,string[]>();for(const [p,ts]of learned)for(const t of ts){const ps=tokenToFeatures.get(t)??[];ps.push(p);tokenToFeatures.set(t,ps);}
 const plainSignature=(e:Entry)=>e.features.filter(p=>ids.has(p)).map(p=>ids.get(p)!).sort((a,b)=>a-b).join(','),byLearned=new Map<string,Entry[]>();for(const e of entries){const key=plainSignature(e),es=byLearned.get(key)??[];es.push(e);byLearned.set(key,es);}
 const knownFingerprints=new Map<string,Map<string,number>>();for(const k of known){const key=signature(k.view.tokens),cs=knownFingerprints.get(key)??new Map();cs.set(k.value,(cs.get(k.value)??0)+1);knownFingerprints.set(key,cs);}
 const fingerprintValues=new Map([...knownFingerprints].map(([key,cs])=>[key,[...cs].sort((a,b)=>b[1]-a[1]).map(([v])=>v)]));
 function prior(v:View){return (v.bytes!==undefined?byBytes.get(v.bytes):v.length!==undefined?byLength.get(v.length):entries)?.find(e=>sameLengths(e,v))??entries[0];}
 function nearby<T>(xs:T[],key:(x:T)=>number,target:number){let lo=0,hi=xs.length;while(lo<hi){const m=(lo+hi)>>>1;if(key(xs[m])<target)lo=m+1;else hi=m;}return xs.slice(Math.max(0,lo-40),Math.min(xs.length,lo+41));}
 const poolCache=new Map<string,{mean:Entry[];group:Entry[];prior:Entry}>();
 function frequencyGuess(v:View,method:'group'|'pieces'){
  const vec=vector(v.tokens,tokenFreq,views.length),group=groups.get(signature(v.tokens))??1;
  const poolKey=JSON.stringify([v.bytes,v.length]);let cached=poolCache.get(poolKey);if(!cached){const source=(v.bytes!==undefined?byBytes.get(v.bytes)??[]:v.length!==undefined?byLength.get(v.length)??[]:entries).filter(e=>sameLengths(e,v));cached={mean:[...source].sort((a,b)=>a.vector[3]-b.vector[3]||b.count-a.count),group:[...source].sort((a,b)=>a.group-b.group||b.count-a.count),prior:source[0]??entries[0]};poolCache.set(poolKey,cached);}
  const pool=[cached.prior,...(method==='group'?nearby(cached.group,e=>e.group,group*reference.length/views.length):nearby(cached.mean,e=>e.vector[3],vec[3]))];
  let chosen=prior(v),best=Infinity;for(const e of pool){if(!sameLengths(e,v))continue;const expectedCount=model.bloomBits?model.bloomBits*(1-(1-1/model.bloomBits)**(e.features.length*model.multiplicity)):e.features.length*model.multiplicity;const distance=method==='group'?(Math.log(e.group/reference.length)-Math.log(group/views.length))**2:e.vector.reduce((s,x,i)=>s+(x-vec[i])**2,0)+.01*Math.abs(expectedCount-v.tokens.length);if(distance<best){best=distance;chosen=e;}}return chosen.value;
 }
 function learnedGuess(v:View){const hits=new Map<string,number>();for(const t of new Set(v.tokens))for(const p of tokenToFeatures.get(t)??[])hits.set(p,(hits.get(p)??0)+1);const key=[...hits].filter(([p,n])=>n===learned.get(p)!.length).map(([p])=>ids.get(p)!).sort((a,b)=>a-b).join(',');return (byLearned.get(key)??[]).find(e=>sameLengths(e,v))?.value??frequencyGuess(v,'pieces');}
 function knownGuess(v:View){const direct=fingerprintValues.get(signature(v.tokens))?.find(value=>(v.bytes===undefined||Buffer.byteLength(value)===v.bytes)&&(v.length===undefined||Array.from(normalized(value)).length===v.length));return direct??learnedGuess(v);}
 return {predict:{group_frequency:(v:View)=>frequencyGuess(v,'group'),piece_frequency:(v:View)=>frequencyGuess(v,'pieces'),rank_frequency:(v:View)=>{const e=ranked.get(signature(v.tokens));return e&&sameLengths(e,v)?e.value:frequencyGuess(v,'group');},known_projection:learnedGuess,known_fingerprint:knownGuess},learned,candidates,metadata:{dictionary:entries.length,learnedFeatures:learned.size,candidateFeatures:candidates.size,knownFingerprints:fingerprintValues.size,noise,knownRows:known.length}};
}

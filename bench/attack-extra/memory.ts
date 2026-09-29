import {readFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Codec,norm,positions,type Snapshot} from './codec.js';
import {compileStampQuery} from '../../src/core/stamp-query.js';
import {ring} from './codec.js';
import {historical,sourceHash as historicalSourceHash} from './historical.js';
import {encode as researchEncode,positionalKey} from '../final-return/research-codec.js';
import {assert,fields,loadRows,rng,save,scope,shuffled} from './common.js';
const seed=714029;
type Metric={rows:number;values:number;characters:number;characterTotal:number;positions:number;positionTotal:number;mostly:number};
const metric=():Metric=>({rows:0,values:0,characters:0,characterTotal:0,positions:0,positionTotal:0,mostly:0});
function score(m:Metric,truth:string,guess:(string|undefined)[],found:Set<number>){const chars=Array.from(truth),correct=chars.filter((c,i)=>guess[i]===c).length;m.rows++;m.values+=Number(correct===chars.length&&guess.length===chars.length);m.characters+=correct;m.characterTotal+=chars.length;m.positions+=found.size;m.positionTotal+=Math.max(0,chars.length-1);m.mostly+=Number(correct>=chars.length*.8);}
const frequencies=(lists:string[][])=>{const m=new Map<string,number>();for(const list of lists)for(const x of new Set(list))m.set(x,(m.get(x)??0)+1);return m;};
function words(values:string[]){const m=new Map<string,number>();for(const value of values)for(const word of value.match(/[\p{L}\p{N}]+/gu)??[]){const w=norm(word),n=Array.from(w).length;if(n>=2&&n<=45)m.set(w,(m.get(w)??0)+1);}return [...m];}
function draw(list:[string,number][],random:()=>number){const total=list.reduce((a,b)=>a+b[1],0),target=random()*total;let sum=0;for(const [word,count]of list){sum+=count;if(sum>target)return word;}return list.at(-1)![0];}
async function observe(field:string,truth:string[],reference:string[],queryIndices:number[],label:string){
 const codec=new Codec(field),legacy=new Codec(field,'pre-r9');for(const value of truth.slice(0,10)){await codec.validate(value);const p=historical.profiles('customers',field,{type:'text',search:{substring:true}})[0];assert.deepEqual(legacy.tokens(value),await historical.searchTokens(ring,scope,p,historical.searchPieces(p,value)));}
 const snapshots=truth.map(v=>codec.snapshot(v)),guesses=truth.map(v=>Array<string|undefined>(Array.from(norm(v)).length)),found=truth.map(()=>new Set<number>());
 const tokenSets=truth.map(v=>new Set(legacy.tokens(v))),oldMasks=truth.map(()=>0n),refCounts=frequencies(reference.map(v=>[norm(v)]));
 const refValues=[...new Set(reference.map(norm))],refSets=refValues.map(v=>new Set(codec.pieces(v))),refMasks=refValues.map(()=>0n),cipherPlainBytes=truth.map(v=>Buffer.byteLength(v));
 const refByteLengths=new Map<string,Set<number>>();for(const value of reference){const key=norm(value),lengths=refByteLengths.get(key)??new Set<number>();lengths.add(Buffer.byteLength(value));refByteLengths.set(key,lengths);}
 const orderedPrior=[...refCounts].sort((a,b)=>b[1]-a[1]).map(([v])=>v),refIndex=new Map(refValues.map((v,i)=>[v,i])),refChars=new Map(refValues.map(v=>[v,Array.from(v)]));
 const byByteLength=new Map<number,string[]>(),byLength=new Map<number,string[]>(),byCharacter=new Map<string,string[]>();
 for(const v of orderedPrior){for(const n of refByteLengths.get(v)!){const a=byByteLength.get(n)??[];a.push(v);byByteLength.set(n,a);}const chars=refChars.get(v)!,a=byLength.get(chars.length)??[];a.push(v);byLength.set(chars.length,a);chars.forEach((c,i)=>{const key=i+'\0'+c,b=byCharacter.get(key)??[];b.push(v);byCharacter.set(key,b);});}
 const opaque=new Map<string,{locations:Map<number,number[]>;docs:number;occurrences:number}>(),referencePieces=new Map<string,{docs:number;occurrences:number}>();
 for(const value of reference){const chars=Array.from(norm(value)),seen=new Set<string>();for(let i=0;i+1<chars.length;i++){const piece=chars[i]+chars[i+1],counts=referencePieces.get(piece)??{docs:0,occurrences:0};counts.occurrences++;if(!seen.has(piece)){counts.docs++;seen.add(piece);}referencePieces.set(piece,counts);}}
 const random=rng(seed+fields.indexOf(field as never)),dictionary=words(reference),observed=new Set<string>(),queries=new Set<string>(),results:unknown[]=[];
 const alphabet=[...new Set(reference.flatMap(v=>Array.from(norm(v))))],baseline=metric(),rb=rng(seed+94);
 for(const value of truth)score(baseline,norm(value),Array.from(norm(value),()=>alphabet[Math.floor(rb()*alphabet.length)]),new Set());
 let validations=0,researchComparisons=0;
 for(let global=1;global<=1000;global++){
  if(queryIndices.includes(global)){
   const query=draw(dictionary,random);queries.add(query);const compiled=await compileStampQuery(ring,codec.p,scope,{op:'contains',value:query}),chars=Array.from(norm(query));
   // Pre-R9 observer receives f9005bd candidate bytes, no normalized length, position or piece keys.
   const qt=legacy.queryTokens(query),qp=legacy.queryPieces(query),bit=1n<<BigInt(global);
   for(let i=0;i<truth.length;i++)if(qt.every(t=>tokenSets[i].has(t)))oldMasks[i]|=bit;
   for(let i=0;i<refValues.length;i++)if(qp.every(p=>refSets[i].has(p)))refMasks[i]|=bit;
   for(let k=0;k<compiled.keys.length;k++){const key=compiled.keys[k],keyHex=Buffer.from(key).toString('hex'),piece=chars.slice(compiled.offsets[k],compiled.offsets[k]+2).join('');if(observed.has(keyHex))continue;observed.add(keyHex);
    const locations=new Map<number,number[]>();let occurrences=0;
    for(let i=0;i<snapshots.length;i++){const ps=positions(snapshots[i],key);if(ps.length){locations.set(i,ps);occurrences+=ps.length;}for(const p of ps){const pc=Array.from(piece);assert.ok(guesses[i][p]===undefined||guesses[i][p]===pc[0]);assert.ok(guesses[i][p+1]===undefined||guesses[i][p+1]===pc[1]);guesses[i][p]=pc[0];guesses[i][p+1]=pc[1];found[i].add(p);}}
    opaque.set(keyHex,{locations,docs:locations.size,occurrences});
    // Independent frozen research bytes, same query/row, gives the same decoded positions.
    if(researchComparisons<200){const hit=truth.findIndex(value=>norm(value).includes(piece)),index=hit<0?researchComparisons%Math.min(100,truth.length):hit,r=researchEncode(field,truth[index]);const rs:Snapshot={salt:Buffer.from(r.psalt,'hex'),n:r.n,stamps:r.stamps.map(BigInt),offsets:r.positions,tokens:[]};assert.deepEqual(positions(rs,positionalKey(field,piece)),positions(snapshots[index],key));researchComparisons++;}
   }
  }
  if([10,100,1000].includes(global)){
   const m=metric();truth.forEach((v,i)=>score(m,norm(v),guesses[i],found[i]));assert.equal(m.positions,found.reduce((a,b)=>a+b.size,0));
   const randomPositionExpectedCorrect=snapshots.reduce((sum,s,i)=>sum+(s.n>1?found[i].size/(s.n-1):0),0);
   const old=metric(),combined=metric(),valuesByMask=new Map<bigint,string[]>();for(const v of orderedPrior){const mask=refMasks[refIndex.get(v)!],list=valuesByMask.get(mask)??[];list.push(v);valuesByMask.set(mask,list);}
   const fallback=orderedPrior[0];let noDictionarySignature=0;
   for(let i=0;i<truth.length;i++){const sameBytes=(v:string)=>refByteLengths.get(v)!.has(cipherPlainBytes[i]),maskPool=valuesByMask.get(oldMasks[i])??[],bytePool=byByteLength.get(cipherPlainBytes[i])??[];
    const value=(maskPool.length<bytePool.length?maskPool:bytePool).find(v=>sameBytes(v)&&refMasks[refIndex.get(v)!]===oldMasks[i]);if(value===undefined)noDictionarySignature++;const prior=bytePool[0]??fallback,guess=Array.from(value??prior),actual=Array.from(norm(truth[i])),correct=new Set<number>();for(let j=0;j+1<actual.length;j++)if(guess[j]===actual[j]&&guess[j+1]===actual[j+1])correct.add(j);score(old,norm(truth[i]),guess,correct);
    const labels=guesses[i].flatMap((c,j)=>c===undefined?[]:[{c,j}]),pools=[maskPool,byLength.get(snapshots[i].n)??[],...labels.map(({c,j})=>byCharacter.get(j+'\0'+c)??[])],smallest=pools.reduce((a,b)=>a.length<b.length?a:b);
    const compatible=smallest.find(v=>refMasks[refIndex.get(v)!]===oldMasks[i]&&refChars.get(v)!.length===snapshots[i].n&&labels.every(({c,j})=>refChars.get(v)![j]===c));
    const chosen=Array.from(compatible??value??prior),withPositions=Array.from({length:snapshots[i].n},(_,j)=>guesses[i][j]??chosen[j]),correctWithPositions=new Set<number>();for(let j=0;j+1<actual.length;j++)if(withPositions[j]===actual[j]&&withPositions[j+1]===actual[j+1])correctWithPositions.add(j);score(combined,norm(truth[i]),withPositions,correctWithPositions);
   }
   // Key-only attack: a key is labelled solely from its observed row/occurrence frequencies.
   const unused=new Map(referencePieces),votes=snapshots.map(s=>Array.from({length:s.n},()=>new Map<string,number>()));
   for(const [,entry]of [...opaque].sort((a,b)=>b[1].docs-a[1].docs)){
    let label:string|undefined,best=Infinity;
    for(const [piece,counts]of unused){const distance=(Math.log((entry.docs+.5)/truth.length)-Math.log((counts.docs+.5)/reference.length))**2+(Math.log((entry.occurrences+.5)/truth.length)-Math.log((counts.occurrences+.5)/reference.length))**2;if(distance<best){best=distance;label=piece;}}
    if(label===undefined)continue;unused.delete(label);const chars=Array.from(label);for(const [row,ps]of entry.locations)for(const p of ps)for(let j=0;j<2;j++)votes[row][p+j].set(chars[j],(votes[row][p+j].get(chars[j])??0)+1);
   }
   const keyOnly=metric();for(let i=0;i<truth.length;i++){const guess=votes[i].map(v=>[...v].sort((a,b)=>b[1]-a[1])[0]?.[0]),actual=Array.from(norm(truth[i])),correct=new Set<number>();for(let j=0;j+1<actual.length;j++)if(guess[j]===actual[j]&&guess[j+1]===actual[j+1])correct.add(j);score(keyOnly,norm(truth[i]),guess,correct);}
   results.push({observations:global,fieldObservations:queryIndices.filter(n=>n<=global).length,distinctQueries:queries.size,distinctKeys:observed.size,randomPositionExpectedCorrect,...m,candidateOnlyKnownQuery:{...old,noDictionarySignature},candidateAndPositionsKnownQuery:combined,keyOnlyFrequency:keyOnly});
   console.log(label,field,global,m.characters,m.characterTotal);
   save(`observation-${label}-${field}`,{seed,field,label,referenceRows:reference.length,victimRows:truth.length,queryDistribution:'empirical word frequency in disjoint reference, uniform field assignment',results,productWebCryptoChecks:10,historicalWebCryptoChecks:10,historicalSourceHash,randomCharacterBaseline:baseline,opaqueKeys:'Anonymous positions exact; character labels guessed by disjoint reference document+occurrence frequency, no observed query plaintext',candidateOnly:'f9005bd actual token format, default substring skip=true/wordBoundary=false; same 1000 query order; ciphertext byte length allowed, no normalized length/stamp/key access; query-bundle inclusion signature + ciphertext length -> most frequent reference dictionary value; length-only prior fallback; not a full historical search-runtime replay',researchComparisons});validations++;
  }
 }
 return {snapshots,codec,validations};
}
function signatureMap(lists:string[][],known:number){const signatures=new Map<string,number[]>();for(let i=0;i<known;i++)for(const p of new Set(lists[i])){const a=signatures.get(p)??[];a.push(i);signatures.set(p,a);}const reverse=new Map<string,string[]>();for(const [p,ids]of signatures){const key=ids.join(','),a=reverse.get(key)??[];a.push(p);reverse.set(key,a);}return {signatures,reverse};}
function vector(xs:string[],freq:Map<string,number>,total:number){const a=xs.map(x=>Math.log((freq.get(x)??.5)/total)).sort((a,b)=>a-b);return a.length?[a[0],a[Math.floor(a.length/2)],a.at(-1)!,a.reduce((a,b)=>a+b)/a.length]:[0,0,0,0];}
export function statistics(field:string,truth:string[],reference:string[],snapshots:Snapshot[],codec:Pick<Codec,'pieces'|'token'>,label:string){
 const normalized=truth.map(norm),ref=reference.map(norm),victimTokens=snapshots.map(s=>s.tokens),plainPieces=truth.map(v=>codec.pieces(v)),refPieces=reference.map(v=>codec.pieces(v));
 const vf=frequencies(victimTokens),rf=frequencies(refPieces),vectors=victimTokens.map(v=>vector(v,vf,truth.length));
 const candidates=[...new Map(ref.map((v,i)=>[v,{value:v,pieces:new Set(refPieces[i]),v:vector(refPieces[i],rf,reference.length),n:Array.from(v).length}])).values()],candidateValues=new Set(candidates.map(c=>c.value)),candidateIndex=new Map(candidates.map((c,i)=>[c.value,i]));
 const indices=candidates.map((_,i)=>i).sort((a,b)=>candidates[a].v[3]-candidates[b].v[3]),byLength=new Map<number,number[]>();for(const i of indices){const a=byLength.get(candidates[i].n)??[];a.push(i);byLength.set(candidates[i].n,a);}
 assert.ok(snapshots.every(s=>s.stamps.length===Math.max(0,s.n-1)&&s.offsets.length===s.stamps.length));
 const rows:unknown[]=[];
 for(const known of [0,1,10,100]){
  const encrypted=signatureMap(victimTokens,known),plain=signatureMap(plainPieces,known),mapping=new Map<string,string>();
  for(const [token,sig]of encrypted.signatures){const key=sig.join(','),ps=plain.reverse.get(key),ts=encrypted.reverse.get(key);if(ps?.length===1&&ts?.length===1)mapping.set(token,ps[0]);}
  // Evaluator-only root access measures mapping precision; predictions use mapping alone.
  const mappingCorrect=[...mapping].filter(([token,piece])=>codec.token(Buffer.from(piece,'hex'))===token).length;
  for(const mode of ['random','random-empirical','length','frequency','frequency+length','frequency+length+positions','known+joint']){
   const m=metric(),random=rng(seed+known);let hitsInDictionary=0;
   for(let i=known;i<truth.length;i++){
    const n=snapshots[i].n,v=vectors[i],pool=mode==='frequency'?indices:(byLength.get(n)??indices);let chosen:number;
    if(mode==='random')chosen=Math.floor(random()*candidates.length);
    else if(mode==='random-empirical')chosen=candidateIndex.get(ref[Math.floor(random()*ref.length)])!;
    else if(mode==='length')chosen=pool[Math.floor(random()*pool.length)];
    else{let lo=0,hi=pool.length;while(lo<hi){const mid=(lo+hi)>>>1;if(candidates[pool[mid]].v[3]<v[3])lo=mid+1;else hi=mid;}let shortlist=pool.slice(Math.max(0,lo-32),Math.min(pool.length,lo+33));
     const labels=mode==='known+joint'?victimTokens[i].flatMap(t=>mapping.has(t)?[mapping.get(t)!]:[]):[];
     // Label constraints filter the full reference dictionary; no truth from this victim row is used.
     if(labels.length){const constrained=pool.filter(j=>labels.every(p=>candidates[j].pieces.has(p)));if(constrained.length)shortlist=constrained;}
     chosen=shortlist[0]??pool[0];let best=Infinity;for(const j of shortlist){const c=candidates[j],d=c.v.reduce((a,x,k)=>a+(x-v[k])**2,0)+Math.abs(c.pieces.size-victimTokens[i].length)*.01;if(d<best){best=d;chosen=j;}}
    }
    const guess=Array.from(candidates[chosen].value),actual=Array.from(normalized[i]),correctPairs=new Set<number>();for(let j=0;j+1<actual.length;j++)if(guess[j]===actual[j]&&guess[j+1]===actual[j+1])correctPairs.add(j);score(m,normalized[i],guess,correctPairs);hitsInDictionary+=Number(candidateValues.has(normalized[i]));
   }
   rows.push({knownRows:known,knownPercent:known/truth.length*100,mode,uniquelyMappedTokens:mapping.size,correctlyMappedTokens:mappingCorrect,dictionaryCoverage:hitsInDictionary/(truth.length-known),...m});
  }
  console.log('statistics',label,field,known);
 }
 save(`statistics-${label}-${field}`,{seed,field,label,rows,victimRows:truth.length,referenceRows:reference.length,candidateValues:candidates.length,positionLengthRedundant:true,positionMetric:'correct adjacent character pair at its guessed offset; statistical guess, not verified key decoding',score:'squared log document-frequency quantile distance + .01 * token-cardinality difference; 65 nearest mean-frequency candidates; known constraints use full same-length dictionary'});
}
if(resolve(process.argv[1])===fileURLToPath(import.meta.url)){
const rows=await loadRows();assert.ok(rows.length>=20000);const victim=rows.slice(0,10000),reference=rows.slice(10000,20000);save('dataset',{fixture:'bench_realistic_100k.customers',fixtureRows:rows.length,victimRows:victim.length,referenceRows:reference.length,disjointIds:new Set([...victim,...reference].map(r=>r.id)).size===20000,seed,identityDigest:hash('sha256',JSON.stringify([...victim,...reference].map(r=>r.id)))});
const assign=rng(seed),schedule=Array.from({length:1000},()=>Math.floor(assign()*fields.length));
for(const [f,field]of fields.entries()){const truth=victim.map(r=>r[field]),ref=reference.map(r=>r[field]);const {snapshots,codec}=await observe(field,truth,ref,schedule.flatMap((v,i)=>v===f?[i+1]:[]),'fixture');if(!process.argv.includes('--observation-only'))statistics(field,truth,ref,snapshots,codec,'fixture');}
if(process.argv.includes('--reviews')){const raw=readFileSync('.local/ratings.txt','utf8'),lines=raw.split(/\r?\n/).slice(1).map(line=>line.split('\t')[1]).filter((s):s is string=>!!s&&Array.from(norm(s)).length>=2);const sample=shuffled(lines,seed);assert.ok(sample.length>=20000);const truth=sample.slice(0,10000),ref=sample.slice(10000,20000);save('dataset-reviews',{source:'.local/ratings.txt',sha256:hash('sha256',raw),eligibleRows:lines.length,victimRows:truth.length,referenceRows:ref.length,seed,disjointRecordIndices:true,duplicateTextsAcrossCohortsAllowed:true,databaseLoaded:false});const {snapshots,codec}=await observe('memo',truth,ref,Array.from({length:1000},(_,i)=>i+1),'reviews');if(!process.argv.includes('--observation-only'))statistics('memo',truth,ref,snapshots,codec,'reviews');}
console.log('attack memory completed');
}

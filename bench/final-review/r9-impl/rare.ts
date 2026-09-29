/** Read-only fixture + public corpus, all hypothetical tokens and attacks remain in memory. */
import {readFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {frame,hex,utf8} from '../../../src/core/bytes.js';
import {searchPieces,searchTokens} from '../../../src/core/search-tokens.js';
import {ring} from '../../attack-extra/codec.js';
import {ActiveCodec,norm,scope} from './codec.js';
import {assert,loadRows,shuffled,rng,save} from './common.js';
type Atom={kind:string;value:string};
type Query={term:string;width:number;matches:number};
const bitsList=[16,14,12],seed=20260929,knownSeed=99,substringMode=!process.argv.includes('--words'),output=substringMode?'rare':'rare-words';
const result:any={started:new Date().toISOString(),complete:false,seed,knownSeed,rows:100000,layout:'compact adjacent + start/end + skip, no word boundary',tokenMethod:'Current product descriptor includes hypothetical bit width; same as preceding bits.ts; fixed test key and scope',selection:substringMode?'Uniform reservoir of normalized letter-only substrings, document frequency 1..10':'Uniform reservoir of original Unicode-letter runs (whole orthographic words), normalized length 2/3/4 and normalized contains document frequency 1..10; fewer than 200 reported as shortage',datasets:[],validation:{pieceRows:0,product16Rows:0,truthQueries:0,noFalseNegatives:0}};
const stats=(xs:number[])=>{const a=[...xs].sort((x,y)=>x-y);return {mean:a.length?a.reduce((s,x)=>s+x,0)/a.length:0,p95:a.length?a[Math.ceil(a.length*.95)-1]:0,max:a.at(-1)??0};};
function contains(sorted:readonly number[],v:number){let a=0,b=sorted.length;while(a<b){const m=(a+b)>>>1;if(sorted[m]<v)a=m+1;else b=m;}return sorted[a]===v;}
function select(freq:Map<string,number>,width:number):{queries:Query[];eligible:number}{const random=rng(seed+width),queries:Query[]=[];let eligible=0;for(const [term,count]of freq)if(count<=10){eligible++;const q={term,width,matches:count};if(queries.length<200)queries.push(q);else{const index=Math.floor(random()*eligible);if(index<200)queries[index]=q;}}return {queries,eligible};}
/** Only known-row plaintext labels and observed token membership enter the attack. */
function knownAttack(rows:Uint32Array[],tokenRows:Uint16Array[],known:number[]){const pSig=new Map<number,number[]>(),tSig=new Map<number,number[]>();for(const i of [...known].sort((a,b)=>a-b)){for(const p of rows[i]){const a=pSig.get(p)??[];a.push(i);pSig.set(p,a);}for(const t of tokenRows[i]){const a=tSig.get(t)??[];a.push(i);tSig.set(t,a);}}const bySig=new Map<string,number>();for(const [p,ids]of pSig){const s=ids.join(',');bySig.set(s,bySig.has(s)?-1:p);}const guess=new Map<number,number>();for(const [t,ids]of tSig){const p=bySig.get(ids.join(','));if(p!==undefined&&p>=0)guess.set(t,p);}return guess;}
async function measure(name:string,field:string,input:string[]){
 assert.equal(input.length,100000);const values=input.map(norm),atomIds=new Map<string,number>(),atoms:Atom[]=[],rows:Uint32Array[]=[],freqs=[new Map<string,number>(),new Map<string,number>(),new Map<string,number>()];
 const atom=(kind:string,value:string)=>{const key=kind+'\0'+value;let id=atomIds.get(key);if(id===undefined){id=atoms.length;atoms.push({kind,value});atomIds.set(key,id);}return id;};
 for(let i=0;i<values.length;i++){
  const chars=Array.from(values[i]),ids=new Set<number>();if(chars.length>=2){for(let j=0;j+1<chars.length;j++)ids.add(atom('adjacent',chars[j]+chars[j+1]));ids.add(atom('start',chars[0]));ids.add(atom('end',chars.at(-1)!));for(let j=0;j+2<chars.length;j++)ids.add(atom('skip',chars[j]+chars[j+2]));}rows.push(Uint32Array.from(ids));
  for(let w=2;w<=4;w++){const seen=new Set<string>();for(let j=0;j+w<=chars.length;j++){const term=chars.slice(j,j+w).join('');if(/^\p{L}+$/u.test(term))seen.add(term);}for(const term of seen){const m=freqs[w-2],n=m.get(term)??0;if(n<=10)m.set(term,n+1);}}
 }
 const vocabulary=new Set(input.flatMap(v=>(v.match(/\p{L}+/gu)??[]).map(norm)).filter(v=>{const n=Array.from(v).length;return n>=2&&n<=4;}));
 if(!substringMode)for(const freq of freqs)for(const term of freq.keys())if(!vocabulary.has(term))freq.delete(term);
 const selected=freqs.map((freq,i)=>({...select(freq,i+2),width:i+2}));freqs.forEach(f=>f.clear());const queries=selected.flatMap(s=>s.queries),knownOrder=shuffled(Array.from({length:values.length},(_,i)=>i),knownSeed);
 const record:any={name,field,rows:values.length,digest:hash('sha256',input.join('\n')),uniquePieces:atoms.length,selection:selected.map(s=>({width:s.width,eligible:s.eligible,sampled:s.queries.length,shortage:Math.max(0,200-s.queries.length)})),variants:[]};result.datasets.push(record);save(output,result);console.log(`PREPARED ${name} pieces=${atoms.length} queries=${queries.length}`);
 const framed=atoms.map(a=>hex(frame([a.kind,utf8(a.value)])));
 const p=new ActiveCodec(field,'product').p;
 for(let i=0;i<50;i++){assert.deepEqual([...rows[i]].map(id=>framed[id]).sort(),searchPieces(p,input[i]).map(hex).sort());result.validation.pieceRows++;}
 for(const bits of bitsList){
  const codec=new ActiveCodec(field,'product',scope,bits),tokenOf=Uint16Array.from(framed.map(id=>Number(BigInt(codec.token(id))&0xffffffffn) >>> (32-bits))),postings:number[][]=Array.from({length:2**bits},()=>[]),tokenRows:Uint16Array[]=[];
  for(let i=0;i<rows.length;i++){const ts=[...new Set([...rows[i]].map(p=>tokenOf[p]))];tokenRows.push(Uint16Array.from(ts));for(const t of ts)postings[t].push(i);}
  if(bits===16)for(let i=0;i<10;i++){const actual=await searchTokens(ring,scope,p,searchPieces(p,input[i]));assert.deepEqual([...tokenRows[i]].sort((a,b)=>a-b),actual.map(t=>Number(BigInt(t)&0xffffffffn)>>>16).sort((a,b)=>a-b));result.validation.product16Rows++;}
  const search=queries.map(q=>{const ts=[...new Set(searchPieces(p,q.term,'contains').map(piece=>Number(BigInt(codec.token(hex(piece)))&0xffffffffn) >>>(32-bits)))],lists=ts.map(t=>postings[t]).sort((a,b)=>a.length-b.length),candidateIds=lists[0].filter(i=>lists.slice(1).every(list=>contains(list,i)));let matches=0;for(let i=0;i<values.length;i++)if(values[i].includes(q.term)){matches++;assert.ok(contains(candidateIds,i),'False negative');}assert.equal(matches,q.matches);result.validation.truthQueries++;result.validation.noFalseNegatives+=matches;return {...q,candidates:candidateIds.length,factor:candidateIds.length/matches};});
  const known=[1,5].map(pct=>{const ids=knownOrder.slice(0,values.length*pct/100),knownSet=new Set(ids),guess=knownAttack(rows,tokenRows,ids);let mostly=0,unknown=0,correct=0,total=0,adjacentCorrect=0,adjacentTotal=0,unknownCorrect=0,unknownTotal=0;
   for(let i=0;i<rows.length;i++){let rowCorrect=0;for(const p of rows[i]){const ok=guess.get(tokenOf[p])===p;correct+=Number(ok);total++;rowCorrect+=Number(ok);if(atoms[p].kind==='adjacent'){adjacentCorrect+=Number(ok);adjacentTotal++;}}if(!knownSet.has(i)){unknown++;unknownCorrect+=rowCorrect;unknownTotal+=rows[i].length;if(rows[i].length&&rowCorrect/rows[i].length>=.8)mostly++;}}
   return {knownPct:pct,knownRows:ids.length,unknownRows:unknown,decodedLabels:guess.size,mostly,mostlyPct:mostly/unknown*100,allPiecePct:correct/total*100,adjacentPct:adjacentCorrect/adjacentTotal*100,unknownPiecePct:unknownCorrect/unknownTotal*100};});
  const summary=[2,3,4].map(width=>{const qs=search.filter(q=>q.width===width),base=record.variants[0]?.search.filter((q:any)=>q.width===width)??qs;return {width,sampled:qs.length,candidates:stats(qs.map(q=>q.candidates)),factor:stats(qs.map(q=>q.factor)),relative16:stats(qs.map((q,i)=>q.candidates/base[i].candidates)),ratioOfMeans:qs.length?qs.reduce((s,q)=>s+q.candidates,0)/base.reduce((s:number,q:any)=>s+q.candidates,0):null};});
  record.variants.push({bits,known,search,summary});save(output,result);console.log(JSON.stringify({name,bits,known,summary}));
 }
}
const corpus=readFileSync('.local/ratings.txt','utf8').split('\n').slice(1).map(s=>s.split('\t')[1]).filter((s):s is string=>!!s&&Array.from(s).length>=2).slice(0,100000);
await measure('ratings','memo',corpus);global.gc?.();
const fixture=await loadRows();for(const field of ['memo','address','name'] as const){await measure('fixture-'+field,field,fixture.map(r=>r[field]));global.gc?.();}
result.complete=true;result.finished=new Date().toISOString();save(output,result);console.log(`COMPLETE ${output}`);

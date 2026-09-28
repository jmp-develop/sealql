import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHmac,hkdfSync,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
import {profiles,searchPieces,searchTokens,descriptorBytes,normalizeText} from '../../src/core/search-tokens.js';
import {frame,hex} from '../../src/core/bytes.js';
const n=2000,seed=99,scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const root=Buffer.alloc(32,93),ring={key:root,keyScopeId:'global'};
const out='bench/results/2026-09-28-mission/m1-astra-attack.json';
const norm=(s:string)=>normalizeText(s,'legacy-text-v1');
const pct=(a:number,b:number)=>b?+(a*100/b).toFixed(4):0;
function order(size:number){let x=seed;const a=Array.from({length:size},(_,i)=>i);for(let i=size-1;i>0;i--){x^=x<<13;x^=x>>>17;x^=x<<5;const j=Math.floor((x>>>0)/2**32*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function substrings(s:string){const a=Array.from(norm(s)),set=new Set<string>();for(let i=0;i<a.length-1;i++){let p=a[i];for(let j=i+1;j<a.length;j++){p+=a[j];set.add(p);}}return [...set];}
function bigrams(s:string){const a=Array.from(norm(s));return a.slice(0,-1).map((c,i)=>c+a[i+1]);}
function infer(labels:string[][],tokens:string[][],known:Set<number>){const ps=new Map<string,number[]>(),ts=new Map<string,number[]>();for(const r of known){for(const p of new Set(labels[r])){if(!ps.has(p))ps.set(p,[]);ps.get(p)!.push(r);}for(const t of new Set(tokens[r])){if(!ts.has(t))ts.set(t,[]);ts.get(t)!.push(r);}}
 const bySig=new Map<string,string[]>();for(const [p,ids] of ps){const s=ids.join(',');if(!bySig.has(s))bySig.set(s,[]);bySig.get(s)!.push(p);}const g=new Map<string,string>();for(const [t,ids] of ts){const a=bySig.get(ids.join(','));if(a?.length===1)g.set(t,a[0]);}return g;}
function frequency(labels:string[][],tokens:string[][]){const p=new Map<string,number>(),t=new Map<string,number>();for(const r of labels)for(const x of new Set(r))p.set(x,(p.get(x)??0)+1);for(const r of tokens)for(const x of new Set(r))t.set(x,(t.get(x)??0)+1);const ps=[...p].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])),ts=[...t].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));return new Map(ts.map(([x],i)=>[x,ps[i]?.[0]??'']));}
async function attack(dataset:string,values:string[],reference:string[]){
 const p=profiles('mission-astra','memo',{type:'text',search:{substring:true}})[0];
 const key=Buffer.from(hkdfSync('sha384',root,Buffer.alloc(0),frame(['sealql/index/v3','global',descriptorBytes(p)]),48));
 const oracle=new Map<string,string>();const token=(label:string)=>{let v=oracle.get(label);if(!v){v=createHmac('sha384',key).update(frame(['value',scope,Buffer.from(label,'hex')])).digest().subarray(0,2).toString('hex');oracle.set(label,v);}return v;};
 const rows=values.map(s=>searchPieces(p,s).map(hex)),refs=reference.map(s=>searchPieces(p,s).map(hex));const tokens=rows.map(r=>[...new Set(r.map(token))]);
 // Verify emulator against the actual product API, including the scope prefix and high-bit placement.
 for(let i=0;i<Math.min(10,n);i++){const actual=await searchTokens(ring,scope,p,rows[i].map(x=>Buffer.from(x,'hex')));const low=actual.map(t=>((BigInt.asUintN(64,BigInt(t))&0xffffffffn)>>16n).toString(16).padStart(4,'0')).sort();assert.deepEqual(low,[...new Set(rows[i].map(token))].sort());}
 const adjLabel=(s:string)=>hex(frame(['adjacent',s]));
 const score=(g:Map<string,string>,known=new Set<number>())=>{let all=0,correct=0,adj=0,adjCorrect=0;for(let i=0;i<n;i++){if(known.has(i))continue;for(const x of rows[i]){all++;if(g.get(token(x))===x)correct++;}for(const x of new Set(bigrams(values[i]))){adj++;if(g.get(token(adjLabel(x)))===adjLabel(x))adjCorrect++;}}return {piecePct:pct(correct,all),adjacentPct:pct(adjCorrect,adj)};};
 const orderIds=order(n),knownResult:any[]=[];
 for(const k of [1,5,10]){const known=new Set(orderIds.slice(0,n*k/100)),g=infer(rows,tokens,known);let mostly=0,unknown=0;for(let i=0;i<n;i++){if(known.has(i))continue;unknown++;const a=[...new Set(bigrams(values[i]))],c=a.filter(x=>g.get(token(adjLabel(x)))===adjLabel(x)).length;if(a.length&&c/a.length>=.8)mostly++;}knownResult.push({knownPct:k,...score(g,known),unknownAdjacent80Pct:pct(mostly,unknown)});}
 const current={frequency:score(frequency(refs,tokens)),known:knownResult,uniqueLabels:oracle.size,storedTokens:tokens.reduce((s,r)=>s+r.length,0)};
 const posKey=Buffer.alloc(32,71),posOracle=new Map<string,string>();const posTok=(s:string)=>{let v=posOracle.get(s);if(!v){v=createHmac('sha256',posKey).update(s).digest('hex').slice(0,32);posOracle.set(s,v);}return v;};
 const posLabels=values.map(bigrams),posTokens=posLabels.map(r=>r.map(posTok));
 function posScore(g:Map<string,string>,known:Set<number>){let pieces=0,correct=0,unknown=0,mostly=0,full=0,chars=0,correctChars=0;for(let i=0;i<n;i++){if(known.has(i))continue;unknown++;const a=Array.from(norm(values[i])),recovered=Array<string|null>(a.length).fill(null);for(let j=0;j<posLabels[i].length;j++){const label=g.get(posTokens[i][j]);if(label===posLabels[i][j]){const b=Array.from(label);recovered[j]=b[0];recovered[j+1]=b[1];}}const unique=[...new Set(posLabels[i])],good=unique.filter(p=>g.get(posTok(p))===p).length;pieces+=unique.length;correct+=good;const cc=recovered.filter((x,j)=>x===a[j]).length;chars+=a.length;correctChars+=cc;if(unique.length&&good/unique.length>=.8)mostly++;if(a.length>=2&&cc===a.length)full++;}return {adjacentPct:pct(correct,pieces),unknownAdjacent80Pct:pct(mostly,unknown),characterPct:pct(correctChars,chars),fullNormalizedValuePct:pct(full,unknown)};}
 const positional={storedOccurrences:posTokens.reduce((s,r)=>s+r.length,0),frequency:posScore(frequency(reference.map(bigrams),posTokens),new Set()),known:[1,5,10].map(k=>{const known=new Set(orderIds.slice(0,n*k/100)),g=new Map<string,string>();for(const i of known)posLabels[i].forEach((p,j)=>g.set(posTokens[i][j],p));return {knownPct:k,...posScore(g,known)};})};
 const allRows=values.map(substrings),allRefs=reference.map(substrings),allMap=new Map<string,string>();
 const allTok=(s:string)=>{let v=allMap.get(s);if(!v){v=createHmac('sha256',Buffer.alloc(32,72)).update(s).digest('hex').slice(0,32);allMap.set(s,v);}return v;};const allTokens=allRows.map(r=>r.map(allTok).sort());
 function allScore(g:Map<string,string>,known:Set<number>){let adjacent=0,correct=0,unknown=0,mostly=0,full=0;for(let i=0;i<n;i++){if(known.has(i))continue;unknown++;const a=[...new Set(bigrams(values[i]))],good=a.filter(x=>g.get(allTok(x))===x).length;adjacent+=a.length;correct+=good;if(a.length&&good/a.length>=.8)mostly++;const value=norm(values[i]);if(g.get(allTok(value))===value)full++;}return {adjacentPct:pct(correct,adjacent),unknownAdjacent80Pct:pct(mostly,unknown),fullNormalizedValuePct:pct(full,unknown)};}
 const allSubstring={storedTags:allTokens.reduce((s,r)=>s+r.length,0),maxTagsPerRow:Math.max(...allTokens.map(r=>r.length)),frequency:allScore(frequency(allRefs,allTokens),new Set()),known:[1,5,10].map(k=>{const known=new Set(orderIds.slice(0,n*k/100));return {knownPct:k,...allScore(infer(allRows,allTokens,known),known)};})};
 // Row-bound 128-bit tags, same substring set; attack sees only per-row tag sets, not labels or query keys.
 // Query key HMAC(master,substring); stored tag HMAC(queryKey, scope+rowId). Full tags shuffled by sort.
 const rowTokens=allRows.map((ps,i)=>ps.map(s=>createHmac('sha256',Buffer.from(allTok(s),'hex')).update(`${scope}/${i}`).digest('hex').slice(0,32)).sort());
 const shared=new Set<string>();let crossRowCollisions=0;for(const ts of rowTokens)for(const t of ts){if(shared.has(t))crossRowCollisions++;shared.add(t);}assert.equal(crossRowCollisions,0);
 const rowBound={storedTags:allSubstring.storedTags,crossRowCollisions,known:[1,5,10].map(k=>{const known=new Set(orderIds.slice(0,n*k/100));const guesses=infer(allRows,rowTokens,known);let transfers=0,total=0;for(let i=0;i<n;i++)if(!known.has(i))for(const t of rowTokens[i]){total++;if(guesses.has(t))transfers++;}return {knownPct:k,transferredKnownLabels:transfers,unknownTokenRecoveryPct:pct(transfers,total)};}),qualification:'0 is only this token equality transfer attack; unpadded lengths, query history and T2 are excluded, not a safety claim'};
 const queries=[...new Set(['서비스','푸른달',...values.slice(0,40).flatMap(s=>[2,3,4].map(k=>Array.from(norm(s)).slice(0,k).join('')))])].filter(s=>Array.from(s).length>=2);const correctness=queries.map(q=>{const qp=searchPieces(p,q,'contains').map(hex).map(token);let truth=0,candidates=0,position=0,full=0,row=0;for(let i=0;i<n;i++){if(norm(values[i]).includes(q))truth++;if(qp.every(x=>tokens[i].includes(x)))candidates++;const qt=bigrams(q).map(posTok);if(posTokens[i].some((_,j)=>qt.every((t,k)=>posTokens[i][j+k]===t)))position++;if(allTokens[i].includes(allTok(q)))full++;const rt=createHmac('sha256',Buffer.from(allTok(q),'hex')).update(`${scope}/${i}`).digest('hex').slice(0,32);if(rowTokens[i].includes(rt))row++;}assert.equal(position,truth);assert.equal(full,truth);assert.equal(row,truth);assert(candidates>=truth);return {q,truth,currentCandidates:candidates,currentFalsePositives:candidates-truth,positional:position,allSubstring:full,rowBound:row};});
 return {dataset,rows:n,referenceRows:n,seed,normalizer:'legacy-text-v1',current,positional,allSubstring,rowBound,correctness,sourceSha256:createHash('sha256').update(JSON.stringify(values)).digest('hex')};
}
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
let values:string[];
try{await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);values=(await pool.query('select memo_plain from bench_realistic_100k.customers where scope_id=$1 order by id limit $2',[scope,2*n])).rows.map(r=>r.memo_plain);}finally{await pool.end();}
assert.equal(values.length,2*n);
const reviews=readFileSync('.local/ratings.txt','utf8').split('\n').slice(1).map(l=>l.split('\t')[1]).filter((s):s is string=>!!s&&Array.from(norm(s)).length>=2);
const result:any={conditions:{n,seed,referenceDisjointRows:true,rawValueOverlapAllowed:true,noPerformanceTiming:true,baseline:'actual product profile and HMAC, verified first 10 rows',attacks:['known row incidence signature','positional known row alignment','disjoint reference frequency ranking','row-bound equality transfer']},datasets:[]};
mkdirSync('bench/results/2026-09-28-mission',{recursive:true});
for(const [name,data] of [['fixture-memo',values],['nsmc-review',reviews.slice(0,2*n)]] as const){result.datasets.push(await attack(name,data.slice(0,n),data.slice(n,2*n)));writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result.datasets.at(-1)));}

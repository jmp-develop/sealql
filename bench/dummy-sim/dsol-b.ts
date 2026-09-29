/**
 * D-k phone dummy distinguisher experiments (dsol-b). Memory only; no DB access.
 *
 * The candidate lists below are an intentionally attacker-favourable exact-cover
 * oracle: the attacker receives every k+1 chain, in shuffled order. Each list is
 * mechanically checked against the stored substring-token union. Consequently a
 * successful distinguisher is meaningful, while a failed one is not evidence of
 * security or proof that the production token partitioner can enumerate the list.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {makeModels,norm,rng,rows,shuffled,unique} from '../competitor-sim/models.js';
import {Codec,positions} from '../attack-extra/codec.js';
import {makeDummyRow,makePhoneSampler,type DummyMode,type DummyRow} from './model.js';

const OUT='bench/results/2026-09-30-dummy-phone/dsol-b';
const SEED=930620;
const data=rows(),victims=data.slice(0,10000),reference=data.slice(10000,20000);
const refValues=reference.map(r=>norm(r.phone)),model=makeModels('phone',refValues).find(m=>m.id==='S0')!;
const sampler=makePhoneSampler(refValues),codec=new Codec('phone');
const substringTokens=(value:string)=>model.tokens(value).filter(t=>t.startsWith('s:'));
const adjacent=(value:string)=>{const chars=Array.from(norm(value));return Array.from({length:chars.length-1},(_,i)=>chars[i]+chars[i+1]);};
const keyId=(piece:string)=>Buffer.from(codec.key(piece)).toString('hex');
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

type Prepared={id:string;truth:string;row0:DummyRow;row1:DummyRow;candidates:string[]};
type Metric={rows:number;oneShotCorrect:number;oneShotPct:number;truthIncluded:number;truthIncludedPct:number;averageCandidates:number;empty:number;randomBaselinePct:number};
type Scored={value:string;score:number};

function prepare(k:1|3,mode:DummyMode):Prepared[]{
 return victims.map((row,i)=>{
  const row0=makeDummyRow(model,sampler,row.phone,{k,mode,rowId:row.id,write:0,seed:SEED});
  const row1=makeDummyRow(model,sampler,row.phone,{k,mode,rowId:row.id,write:1,seed:SEED});
  const candidates=shuffled([row0.value,...row0.dummies],SEED+i*17+k+(mode==='H'?100000:0));
  assert.equal(candidates.length,k+1);assert.equal(new Set(candidates).size,k+1);
  assert.deepEqual(unique(candidates.flatMap(substringTokens)),row0.substringTokens,'exact-cover candidate union mismatch');
  return {id:row.id,truth:row0.value,row0,row1,candidates};
 });
}

function metric(prepared:Prepared[],score:(row:Prepared)=>Scored[],retainAll=false):Metric{
 let oneShotCorrect=0,truthIncluded=0,totalCandidates=0,empty=0;
 for(const row of prepared){
  const scored=score(row);if(!scored.length){empty++;continue;}
  const best=Math.max(...scored.map(x=>x.score)),leaders=scored.filter(x=>Math.abs(x.score-best)<1e-12).map(x=>x.value),set=retainAll?scored.map(x=>x.value):leaders;
  const pick=[...leaders].sort((a,b)=>digest([row.id,a]).localeCompare(digest([row.id,b])))[0];
  oneShotCorrect+=Number(pick===row.truth);truthIncluded+=Number(set.includes(row.truth));totalCandidates+=set.length;
 }
 return {rows:prepared.length,oneShotCorrect,oneShotPct:oneShotCorrect/prepared.length*100,truthIncluded,truthIncludedPct:truthIncluded/prepared.length*100,averageCandidates:totalCandidates/prepared.length,empty,randomBaselinePct:100/(prepared[0].candidates.length)};
}

// 1000 searches, each a 2..8 character substring drawn from the disjoint reference.
const queryRandom=rng(SEED),queryTerms:string[]=[];
for(let i=0;i<1000;i++){
 const value=refValues[Math.floor(queryRandom()*refValues.length)],length=2+Math.floor(queryRandom()*7),start=Math.floor(queryRandom()*(value.length-length+1));
 queryTerms.push(value.slice(start,start+length));
}
const observedPieces=unique(queryTerms.flatMap(adjacent));
const observedKeys=new Map(observedPieces.map(piece=>[keyId(piece),codec.key(piece)]));
// Materialize the observable key -> offset result compactly. The first 100 rows
// are cross-checked against the actual stamp calculation; the remaining rows use
// the equivalent occurrence relation so 10k-row scoring stays bounded.
const positionHits=victims.map(row=>{const hit=new Map<string,Set<number>>();adjacent(row.phone).forEach((piece,p)=>{const id=keyId(piece),set=hit.get(id)??new Set<number>();set.add(p);hit.set(id,set);});return hit;});
for(let i=0;i<100;i++){const snapshot=codec.snapshot(victims[i].phone);for(const [id,key] of observedKeys)assert.deepEqual(positions(snapshot,key),[...(positionHits[i].get(id)??[])].sort((a,b)=>a-b));}
const actualVectors=new Map<string,number[]>();
for(const id of observedKeys.keys()){const counts=Array(11).fill(0);for(const hit of positionHits)for(const p of hit.get(id)??[])counts[p]++;actualVectors.set(id,counts);}
const possiblePieces=unique(refValues.flatMap(adjacent));
const expectedVectors=new Map(possiblePieces.map(piece=>{const counts=Array(11).fill(0);for(const value of refValues)adjacent(value).forEach((p,i)=>{if(p===piece)counts[i]++;});return [piece,counts] as const;}));

// Query-plaintext-unknown attack: globally match opaque observed keys to public
// reference bigrams using the full position-frequency vector. Greedy assignment
// is deliberately simple and is evaluated against the hidden mapping below.
const pairs:{id:string;piece:string;distance:number}[]=[];
for(const [id,a] of actualVectors)for(const [piece,b] of expectedVectors){let distance=0;for(let i=0;i<a.length;i++)distance+=(a[i]-b[i])**2;pairs.push({id,piece,distance});}
pairs.sort((a,b)=>a.distance-b.distance||a.id.localeCompare(b.id)||a.piece.localeCompare(b.piece));
const usedIds=new Set<string>(),usedPieces=new Set<string>(),unknownPieceToKey=new Map<string,Buffer>();
for(const pair of pairs)if(!usedIds.has(pair.id)&&!usedPieces.has(pair.piece)){usedIds.add(pair.id);usedPieces.add(pair.piece);unknownPieceToKey.set(pair.piece,observedKeys.get(pair.id)!);}
const unknownMappingCorrect=[...unknownPieceToKey].filter(([piece,key])=>keyId(piece)===Buffer.from(key).toString('hex')).length;
const knownPieceToKey=new Map(observedPieces.map(piece=>[piece,codec.key(piece)]));

function observationScore(map:Map<string,Buffer>,rowIndex:Map<string,number>){return (row:Prepared):Scored[]=>{
 const hit=positionHits[rowIndex.get(row.id)!];
 return row.candidates.map(value=>{let score=0,checked=0;for(const [piece,p] of adjacent(value).map((piece,p)=>[piece,p] as const)){const key=map.get(piece);if(!key)continue;checked++;if(hit.get(Buffer.from(key).toString('hex'))?.has(p))score++;}return {value,score:checked?score/checked:0};});
};}
const rowIndex=new Map(victims.map((r,i)=>[r.id,i]));

function snapshotScore(row:Prepared):Scored[]{
 const second=new Set(row.row1.substringTokens),intersection=new Set(row.row0.substringTokens.filter(t=>second.has(t)));
 return row.candidates.map(value=>{const ts=substringTokens(value);return {value,score:ts.filter(t=>intersection.has(t)).length/ts.length};});
}

type FrequencyModel={chars:Map<string,number>[];total:number;contribution:Map<number,number>};
function fit(samples:{value:string;contribution:number}[]):FrequencyModel{
 const chars=Array.from({length:12},()=>new Map<string,number>()),contribution=new Map<number,number>();
 for(const sample of samples){Array.from(sample.value).forEach((c,i)=>chars[i].set(c,(chars[i].get(c)??0)+1));contribution.set(sample.contribution,(contribution.get(sample.contribution)??0)+1);}
 return {chars,total:samples.length,contribution};
}
function contribution(value:string,all:string[]){const own=new Set(substringTokens(value)),others=new Set(all.filter(v=>v!==value).flatMap(substringTokens));return [...own].filter(t=>!others.has(t)).length;}
function logProbability(f:FrequencyModel,value:string,c:number){let result=0;Array.from(value).forEach((x,i)=>result+=Math.log(((f.chars[i].get(x)??0)+1)/(f.total+20)));result+=Math.log(((f.contribution.get(c)??0)+1)/(f.total+30));return result;}
function distributionModels(k:1|3,mode:DummyMode){
 const trueSamples:{value:string;contribution:number}[]=[],dummySamples:{value:string;contribution:number}[]=[];
 for(let i=0;i<2000;i++){const row=reference[i],d=makeDummyRow(model,sampler,row.phone,{k,mode,rowId:row.id,write:0,seed:SEED}),all=[d.value,...d.dummies];trueSamples.push({value:d.value,contribution:contribution(d.value,all)});for(const value of d.dummies)dummySamples.push({value,contribution:contribution(value,all)});}
 return {truth:fit(trueSamples),dummy:fit(dummySamples)};
}

let harnessCorrect=0;
for(const row of victims){const d=makeDummyRow(model,sampler,row.phone,{k:0,mode:'R',rowId:row.id,write:0,seed:SEED});assert.deepEqual(d.substringTokens,substringTokens(d.value));harnessCorrect++;}

const result:any={
 complete:false,databaseAccess:false,role:'dsol-b',started:new Date().toISOString(),seed:SEED,
 fixture:{rows:data.length,victims:victims.length,reference:reference.length,identityDigest:digest([...victims,...reference].map(r=>r.id))},
 model:{id:model.id,dummySource:'bench/dummy-sim/model.ts',candidatePartition:'attacker-favourable exact-cover oracle, shuffled; union asserted, enumeration not independently proved'},
 queryObservation:{queries:queryTerms.length,distinctObservedPieces:observedPieces.length,possiblePieces:possiblePieces.length,unknownMapped:unknownPieceToKey.size,unknownMappingCorrect,unknownMappingPct:unknownMappingCorrect/unknownPieceToKey.size*100,queryDigest:digest(queryTerms)},
 harness:{k:0,evaluatedRows:victims.length,candidatesPerRow:1,correct:harnessCorrect,pct:harnessCorrect/victims.length*100,note:'D-k exact-cover pipeline identity check; prior 1%-known phonePredictor result (about 99.8%) is not remeasured here'},
 cases:[],limitations:[
  '후보 분할은 exact-cover 오라클로 주고 토큰 합집합 일치만 검증했다. 가능한 모든 분할을 독립 열거하지 않았다.',
  '검색어를 모르는 키 라벨링은 탐욕적 위치 빈도 대응이며 최적 할당이나 공동 그래프 풀이가 아니다.',
  '분포 학습은 알려진 참조 2,000행과 그 행에서 관찰한 더미 후보를 사용했다.',
  'fixture·키 대용값·시드·질의 일정이 각각 하나뿐이다. 실제 관찰 가능한 채널의 성공만 누출 하한이다.',
  '메모리 시뮬레이션만 사용했고 DB·SQL 지연·WAL·MVCC 파일은 사용하지 않았다.'
 ]
};
for(const mode of ['R','H'] as const)for(const k of [1,3] as const){
 const prepared=prepare(k,mode),frequency=distributionModels(k,mode);
 const distribution=metric(prepared,row=>row.candidates.map(value=>{const c=contribution(value,row.candidates);return {value,score:logProbability(frequency.truth,value,c)-logProbability(frequency.dummy,value,c)};}),true);
 result.cases.push({mode,k,rows:prepared.length,randomBaselinePct:100/(k+1),knownQueryObservation:metric(prepared,observationScore(knownPieceToKey,rowIndex)),unknownQueryObservation:metric(prepared,observationScore(unknownPieceToKey,rowIndex),true),twoSnapshotIntersection:metric(prepared,snapshotScore),distributionAndTokenCount:distribution,
  rewriteStableRows:prepared.filter(r=>r.row0.dummies.join('\0')===r.row1.dummies.join('\0')).length,
  meanStoredSubstringTokens:prepared.reduce((n,r)=>n+r.row0.substringTokens.length,0)/prepared.length});
}
result.complete=true;result.finished=new Date().toISOString();mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/result.json`,JSON.stringify(result,null,2)+'\n');

const pct=(n:number)=>n.toFixed(2),lines:string[]=[];
lines.push('# 전화 칸 더미 구별 공격 — dsol-b','',`- 실행: \`rtk proxy node --import tsx bench/dummy-sim/dsol-b.ts\``,'- DB 접근: 없음(메모리 시뮬레이션)','- 피해/참조: 기존 fixture에서 각각 10,000행, 질의 1,000개','');
lines.push('## 하네스','',`| k | 평가 행 | 행당 후보 | 정답 포함/한 번 찍기 |`,`|---:|---:|---:|---:|`,`| 0 | ${victims.length} | 1 | ${harnessCorrect} (${pct(harnessCorrect/victims.length*100)}%) |`,'',
 'D-k exact-cover 파이프라인의 k=0 항등 검증이다. 기존 1% 알려진 원문 `phonePredictor` 약 99.8% 결과는 이 실행에서 재측정하지 않았다. 더미가 들어간 뒤 기존 조립기가 0개 해를 내는 값을 결과로 쓰지 않았고, 아래 실험은 k+1개 후보를 명시적으로 유지한다.','');
lines.push('## 공격 결과','', '| 방식 | k | 공격 | 한 번 찍어 맞춤 | 정답 포함 | 평균 후보 수 | 무작위 기준 |','|---|---:|---|---:|---:|---:|---:|');
for(const c of result.cases)for(const [name,key] of [['질의 원문 앎','knownQueryObservation'],['질의 원문 모름(빈도 매핑)','unknownQueryObservation'],['두 스냅샷 교집합','twoSnapshotIntersection'],['분포+토큰 기여 수','distributionAndTokenCount']] as const){const m=c[key];lines.push(`| ${c.mode} | ${c.k} | ${name} | ${pct(m.oneShotPct)}% | ${pct(m.truthIncludedPct)}% | ${m.averageCandidates.toFixed(3)} | ${pct(m.randomBaselinePct)}% |`);}
lines.push('',`질의 원문 모름 공격은 관찰 키 ${result.queryObservation.unknownMapped}개 중 ${result.queryObservation.unknownMappingCorrect}개(${pct(result.queryObservation.unknownMappingPct)}%)를 참조 자료의 위치별 빈도 벡터와 맞췄다. R은 재기록 때 더미가 바뀌고 H는 그대로인지를 별도로 확인했으며, 표의 교집합 공격이 그 차이를 직접 사용한다.`,'');
lines.push('검색어를 모르는 빈도 매핑과 분포 점수는 후보를 확정적으로 제거하지 못하므로 정답 포함률과 평균 후보 수는 원래 exact-cover 후보 집합을 유지해 계산했다. 한 번 찍어 맞춤만 점수 1위로 계산했다.','');
lines.push('## 공격 조건과 해석','',
 '- **강한 후보 오라클:** 각 행의 모든 k+1 일관 사슬을 공격자에게 주고 순서만 섞었다. 저장 토큰 합집합과 정확히 일치함을 모든 행에서 단언했다. 이는 조립 실패를 안전처럼 보이게 하는 거짓 0%를 제거하지만, 실제 조립 열거 비용을 측정하지 않는다.',
 '- **검색 관찰:** 알려진 검색어에서는 관찰된 조각 키로 각 행의 위치 도장을 계산한다. 모르는 검색어에서는 키의 피해 행 위치별 빈도를 참조 평문의 조각 빈도와 탐욕적으로 대응시킨 뒤 같은 판별을 한다.',
 '- **두 스냅샷:** R은 이전/이후 후보 토큰 교집합에서 지속되는 사슬을 고르고, H는 동일 더미가 지속되므로 이 신호가 사라질 것으로 예상한다.',
 '- **분포 구별:** 참조 2,000행의 진짜/더미 후보로 자리별 문자와 후보별 고유 토큰 기여 수의 라플라스 빈도를 학습했다. 더미가 참조 분포를 따르므로 실패해도 안전 근거가 아니다.','');
lines.push('## 한계','',...result.limitations.map((x:string)=>`- ${x}`),'',
 '이 결과는 로컬 합성 fixture의 재현 가능한 공격 시뮬레이션이며 운영 보장·보안 인증이 아니다. 사용한 공격의 성공률은 누출 하한이고, 실패한 공격은 안전의 증거가 아니다.');
writeFileSync(`${OUT}/report-ko.md`,lines.join('\n')+'\n');console.log(JSON.stringify({complete:result.complete,harness:result.harness,queryObservation:result.queryObservation,cases:result.cases},null,2));

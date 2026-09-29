/** Strong, dummy-aware D-k phone simulation. Research only; never opens a DB. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {rows,makeModels,norm,shuffled,rng,unique,type Model} from '../competitor-sim/models.js';
import {decodeAtom} from '../final-review/r9-impl/codec.js';
import {makeProbes} from '../final-review/r9-impl/probes.js';
import {dictionaryPredictor,phonePredictor} from '../competitor-sim/attacks.js';
import {makeDummyRow,makePhoneSampler,type DummyMode} from './model.js';

const OUT='bench/results/2026-09-30-dummy-phone/dsol-a';
const VICTIMS=Number(process.env.DUMMY_VICTIMS??120);
const MAX_CHAIN_STATES=Number(process.env.DUMMY_CHAIN_STATES??2_000_000);
const MAX_CHAINS=Number(process.env.DUMMY_CHAINS??300);
const MAX_PARTITION_STATES=Number(process.env.DUMMY_PARTITION_STATES??300_000);
const MAX_PARTITIONS=Number(process.env.DUMMY_PARTITIONS??1000);
const data=rows(),victimRows=data.slice(0,10000),referenceRows=data.slice(10000,20000);
const reference=referenceRows.map(r=>norm(r.phone)),truth=victimRows.map(r=>norm(r.phone));
const model=makeModels('phone',reference).find(m=>m.id==='S0')!;
const sampler=makePhoneSampler(reference);

type Learned={alternatives:Map<string,string[]>;plainPieces:number;observedTokens:number;resolvedPieces:number};
function learnAlternatives(plain:string[][],views:string[][]):Learned{
  const signatures=(lists:string[][])=>{const result=new Map<string,bigint>();lists.forEach((xs,i)=>{const bit=1n<<BigInt(i);for(const x of new Set(xs))result.set(x,(result.get(x)??0n)|bit);});return result;};
  const ps=signatures(plain),ts=signatures(views),alternatives=new Map<string,string[]>();
  for(const [p,s] of ps)alternatives.set(p,[...ts].filter(([,t])=>(s&~t)===0n).map(([t])=>t));
  return {alternatives,plainPieces:ps.size,observedTokens:ts.size,resolvedPieces:[...alternatives.values()].filter(a=>a.length===1).length};
}

const substringPieces=(value:string)=>model.pieces(value).filter(p=>p.startsWith('s:'));
const atomToPiece=new Map<string,string>();
for(const value of reference)for(const piece of substringPieces(value)){const atom=decodeAtom(piece.slice(2));atomToPiece.set(atom.kind+'\0'+atom.value,piece);}
const n=reference[0].length,alphabet=Array.from({length:n},(_,i)=>unique(reference.map(v=>v[i])));
assert(reference.every(v=>v.length===n&&/^\d+(?:-\d+)+$/.test(v)));

function enumerateChains(view:string[],learned:Learned){
  const viewSet=new Set(view),allView=[...viewSet],allowedCache=new Map<string,string[]>();
  const allowed=(piece:string)=>{let a=allowedCache.get(piece);if(!a){const learnedTokens=learned.alternatives.get(piece);a=learnedTokens?learnedTokens.filter(t=>viewSet.has(t)):allView;allowedCache.set(piece,a);}return a;};
  const candidates:{value:string;pieces:string[];possible:Set<string>;exact?:Set<string>}[]=[];let states=0,capped=false;
  const need=(kind:string,value:string)=>{const piece=atomToPiece.get(kind+'\0'+value);return piece&&allowed(piece).length?piece:undefined;};
  function walk(path:string,pieces:Set<string>){
    if(++states>MAX_CHAIN_STATES||candidates.length>=MAX_CHAINS){capped=true;return;}
    const i=path.length;if(i===n){const ps=[...pieces],possible=new Set(ps.flatMap(allowed)),resolved=ps.map(p=>learned.alternatives.get(p));const exact=resolved.every(a=>a?.length===1)?new Set(resolved.map(a=>a![0])):undefined;candidates.push({value:path,pieces:ps,possible,exact});return;}
    for(const c of alphabet[i]){
      const required:string[]=[];
      const first=i===0?need('start',c):need('adjacent',path.at(-1)!+c);if(!first)continue;required.push(first);
      if(i>=2){const skip=need('skip',path.at(-2)!+c);if(!skip)continue;required.push(skip);}
      if(i===n-1){const end=need('end',c);if(!end)continue;required.push(end);}
      walk(path+c,new Set([...pieces,...required]));if(capped)return;
    }
  }
  walk('',new Set());return {candidates,states,capped};
}

function canExactlyExplain(view:string[],pieces:string[],learned:Learned){
  const uniquePieces=unique(pieces),viewSet=new Set(view),options=new Map(uniquePieces.map(p=>[p,(learned.alternatives.get(p)??view).filter(t=>viewSet.has(t))]));
  if([...options.values()].some(a=>a.length===0)||uniquePieces.length<view.length)return false;
  // A matching from every opaque token to a distinct compatible piece proves that
  // one global piece->token assignment can expose every token; remaining pieces
  // may collide onto any compatible token.
  const tokenOrder=[...view].sort((a,b)=>uniquePieces.filter(p=>options.get(p)!.includes(a)).length-uniquePieces.filter(p=>options.get(p)!.includes(b)).length);
  const used=new Set<string>();
  function match(i:number):boolean{
    if(i===tokenOrder.length)return true;const token=tokenOrder[i];
    for(const piece of uniquePieces)if(!used.has(piece)&&options.get(piece)!.includes(token)){used.add(piece);if(match(i+1))return true;used.delete(piece);}
    return false;
  }
  return match(0);
}

function solve(view:string[],k:number,learned:Learned){
  const chains=enumerateChains(view,learned);if(chains.capped)return {values:[] as string[],capped:true,reason:'chain-cap',chainStates:chains.states,partitionStates:0,partitions:0};
  const target=k+1,values=new Set<string>();let partitionStates=0,partitions=0,capped=false;
  if(chains.candidates.every(c=>c.exact)){
    const tokenId=new Map(view.map((t,i)=>[t,i])),wanted=(1n<<BigInt(view.length))-1n,masks=chains.candidates.map(c=>[...c.exact!].reduce((m,t)=>m|(1n<<BigInt(tokenId.get(t)!)),0n));
    const byToken=view.map((_,bit)=>masks.flatMap((mask,i)=>(mask&(1n<<BigInt(bit)))!==0n?[i]:[]));
    function member(fixed:number){
      const chosen=new Set([fixed]),memo=new Set<string>();
      function complete(mask:bigint):boolean{
        if(++partitionStates>MAX_PARTITION_STATES){capped=true;return false;}
        const slots=target-chosen.size;if(slots===0)return mask===wanted;
        const available=chains.candidates.length-chosen.size;if(available<slots)return false;
        const missing=wanted&~mask;
        if(missing===0n)return true; // Any distinct remaining chains keep the union exact.
        let options:number[]|undefined;
        for(let bit=0;bit<view.length;bit++)if((missing&(1n<<BigInt(bit)))!==0n){const xs=byToken[bit].filter(i=>!chosen.has(i));if(!options||xs.length<options.length)options=xs;}
        if(!options?.length)return false;
        const key=`${[...chosen].sort((a,b)=>a-b).join(',')}|${mask}`;if(memo.has(key))return false;memo.add(key);
        for(const i of options){chosen.add(i);if(complete(mask|masks[i]))return true;chosen.delete(i);if(capped)return false;}
        return false;
      }
      return complete(masks[fixed]);
    }
    for(let i=0;i<chains.candidates.length;i++){if(member(i)){values.add(chains.candidates[i].value);partitions++;}if(capped)break;}
    return {values:[...values],capped,reason:capped?'partition-cap':undefined,chainStates:chains.states,partitionStates,partitions};
  }
  function choose(start:number,selected:typeof chains.candidates){
    if(++partitionStates>MAX_PARTITION_STATES||partitions>=MAX_PARTITIONS){capped=true;return;}
    if(selected.length===target){const possible=new Set(selected.flatMap(c=>[...c.possible]));if(view.some(t=>!possible.has(t)))return;const pieces=selected.flatMap(c=>c.pieces);if(canExactlyExplain(view,pieces,learned)){partitions++;for(const c of selected)values.add(c.value);}return;}
    for(let i=start;i<chains.candidates.length;i++){choose(i+1,[...selected,chains.candidates[i]]);if(capped)return;}
  }
  choose(0,[]);return {values:[...values],capped,reason:capped?'partition-cap':undefined,chainStates:chains.states,partitionStates,partitions};
}

const prefixCounts=new Map<string,number>(),positionCounts=Array.from({length:n},()=>new Map<string,number>());
for(const value of reference){const prefix=value.slice(0,sampler.prefixLength);prefixCounts.set(prefix,(prefixCounts.get(prefix)??0)+1);value.split('').forEach((c,i)=>positionCounts[i].set(c,(positionCounts[i].get(c)??0)+1));}
function prior(value:string){let score=(prefixCounts.get(value.slice(0,sampler.prefixLength))??0)/reference.length;for(let i=sampler.prefixLength;i<n;i++)score*=((positionCounts[i].get(value[i])??0)+1)/(reference.length+positionCounts[i].size);return score;}

function viewFor(value:string,rowId:string,k:0|1|3,mode:DummyMode,write=0){return makeDummyRow(model,sampler,value,{k,mode,rowId,write,seed:5709952}).substringTokens;}
function runAttack(label:string,probeValues:string[],probeIds:string[],k:0|1|3,mode:DummyMode,indices:number[]){
  const probePlain=probeValues.map(substringPieces),probeViews=probeValues.map((v,i)=>viewFor(v,probeIds[i],k,mode));
  const learned=learnAlternatives(probePlain,probeViews);let guessed=0,included=0,capped=0,zero=0,totalCandidates=0,totalPartitions=0;
  const examples:any[]=[];
  for(const index of indices){const view=viewFor(truth[index],victimRows[index].id,k,mode),solved=solve(view,k,learned);if(solved.capped){capped++;continue;}const ranked=solved.values.sort((a,b)=>prior(b)-prior(a)||a.localeCompare(b));guessed+=Number(ranked[0]===truth[index]);included+=Number(ranked.includes(truth[index]));zero+=Number(ranked.length===0);totalCandidates+=ranked.length;totalPartitions+=solved.partitions;if(examples.length<5)examples.push({id:victimRows[index].id,truth:truth[index],candidates:ranked.slice(0,12),candidateCount:ranked.length,partitions:solved.partitions,chainStates:solved.chainStates,partitionStates:solved.partitionStates});
  }
  const rows=indices.length,decided=rows-capped;
  return {label,mode,k,probeRows:probeValues.length,evaluatedRows:rows,decidedRows:decided,capped,zero,randomBaselinePct:100/(k+1),oneGuessCorrect:guessed,oneGuessPct:100*guessed/rows,truthIncluded:included,truthIncludedPct:100*included/rows,meanCandidates:decided?totalCandidates/decided:0,meanPartitions:decided?totalPartitions/decided:0,learned:{plainPieces:learned.plainPieces,observedTokens:learned.observedTokens,resolvedPieces:learned.resolvedPieces},examples};
}

function countMatches(postings:Map<string,number[]>,tokens:string[]){const lists=tokens.map(t=>postings.get(t)??[]).sort((a,b)=>a.length-b.length);if(!lists.length)return 0;const rest=lists.slice(1).map(xs=>new Set(xs));return lists[0].reduce((sum,row)=>sum+Number(rest.every(s=>s.has(row))),0);}
function costs(k:0|1|3){const baseRows=victimRows,base=baseRows.map(r=>viewFor(r.phone,r.id,0,'H')),withDummy=baseRows.map(r=>viewFor(r.phone,r.id,k,'H'));const posting=(sets:string[][])=>{const p=new Map<string,number[]>();sets.forEach((ts,i)=>ts.forEach(t=>{const a=p.get(t)??[];a.push(i);p.set(t,a);}));return p;};const a=posting(base),b=posting(withDummy),random=rng(5709952),queries=[] as string[];for(let i=0;i<1000;i++){const value=reference[Math.floor(random()*reference.length)],length=2+Math.floor(random()*7),start=Math.floor(random()*(value.length-length+1));queries.push(value.slice(start,start+length));}let baseCandidates=0,dummyCandidates=0;for(const q of queries){const tokens=model.query(q).filter(t=>t.startsWith('s:'));baseCandidates+=countMatches(a,tokens);dummyCandidates+=countMatches(b,tokens);}const avg=(sets:string[][])=>sets.reduce((s,x)=>s+x.length,0)/sets.length;return {k,rows:baseRows.length,queries:queries.length,queryLength:[2,8],querySeed:5709952,baseCandidates,dummyCandidates,candidateIncrease:baseCandidates?dummyCandidates/baseCandidates:null,baseTokensPerRow:avg(base),dummyTokensPerRow:avg(withDummy),tokenIncrease:avg(withDummy)/avg(base)};}

const selected=shuffled(Array.from({length:10000},(_,i)=>i),5709952).slice(0,VICTIMS),result:any={complete:false,databaseAccess:false,productCodeChanged:false,fixtureRows:data.length,victimPopulation:victimRows.length,referencePopulation:referenceRows.length,evaluatedPerCell:VICTIMS,modeNote:'단일 스냅샷 공격은 R/H의 주변분포가 같으므로 H를 본표로 실행하고 생성 불변식에서 R/H를 함께 검증했다.',limits:{MAX_CHAIN_STATES,MAX_CHAINS,MAX_PARTITION_STATES,MAX_PARTITIONS},model:{id:'D-k over S0',phoneFormat:sampler.format,prefixes:sampler.prefixes,sourceHash:hash('sha256',await import('node:fs').then(fs=>fs.readFileSync('bench/dummy-sim/model.ts')))},validation:{},baselineHarness:[],attacks:[],costs:[]};
for(const mode of ['R','H'] as const){const a=makeDummyRow(model,sampler,truth[0],{k:3,mode,rowId:victimRows[0].id,write:0,seed:5709952}),b=makeDummyRow(model,sampler,truth[0],{k:3,mode,rowId:victimRows[0].id,write:1,seed:5709952});result.validation[mode]={sameRewrite:JSON.stringify(a.dummies)===JSON.stringify(b.dummies),trueExactPreserved:a.tokens.filter(t=>t.startsWith('e:')).length===1,dummies:a.dummies};}
assert.equal(result.validation.R.sameRewrite,false);assert.equal(result.validation.H.sameRewrite,true);
for(const percent of [0.3,1,5]){const count=Math.round(10000*percent/100),known=shuffled(Array.from({length:10000},(_,i)=>i),930500+count).slice(0,count),knownSet=new Set(known),indices=selected.filter(i=>!knownSet.has(i)),knownValues=known.map(i=>truth[i]),knownViews=knownValues.map(v=>model.tokens(v)),phone=phonePredictor(model,reference,knownValues,knownViews,2_000_000)!,shared=dictionaryPredictor(model,reference,knownValues,knownViews);let correct=0,graphUnique=0,graphCapped=0;for(const i of indices){const graph=phone.predict(model.tokens(truth[i])),guess=graph.value??shared.predict(model.tokens(truth[i])).value;correct+=Number(guess===truth[i]);graphUnique+=Number(graph.value!==undefined);graphCapped+=Number(graph.capped);}result.baselineHarness.push({knownPercent:percent,knownRows:count,evaluatedRows:indices.length,correct,oneGuessPct:100*correct/indices.length,graphUnique,graphCapped,method:'기존 collision-aware phonePredictor; 유일 조립이 없으면 기존 incidence dictionary prior'});}
for(const k of [0,1,3] as const){
  for(const percent of [0.3,1,5]){const count=Math.round(10000*percent/100),known=shuffled(Array.from({length:10000},(_,i)=>i),930500+count).slice(0,count),knownSet=new Set(known),evalIndices=selected.filter(i=>!knownSet.has(i)).slice(0,VICTIMS);result.attacks.push(runAttack(`known-${percent}%`,known.map(i=>truth[i]),known.map(i=>victimRows[i].id),k,'H',evalIndices));}
  const chosen=makeProbes(reference,'phone','packed-pieces');for(const count of [100,1000])result.attacks.push(runAttack(`chosen-${count}`,chosen.slice(0,count),Array.from({length:count},(_,i)=>`chosen-${i}`),k,'H',selected));
  result.costs.push(costs(k));
  mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/result.json`,JSON.stringify(result,null,2)+'\n');
}
result.complete=true;result.finished=new Date().toISOString();writeFileSync(`${OUT}/result.json`,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({complete:result.complete,attacks:result.attacks.map((r:any)=>({label:r.label,k:r.k,oneGuessPct:r.oneGuessPct,inclusion:r.truthIncludedPct,meanCandidates:r.meanCandidates,capped:r.capped})),costs:result.costs},null,2));

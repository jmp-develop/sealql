/** Stronger Bloom attack: fixed 500-row sample, explicit per-row state budget. */
import {readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {rows,norm,makeModels,shuffled} from './models.js';
import {phonePredictor,score,type PublicModel} from './attacks.js';
const out='bench/results/2026-09-30-competitor-sim/r9-impl',seed=930500,maxStates=20000;
const data=rows(),truth=data.slice(0,10000).map(r=>norm(r.phone)),reference=data.slice(10000,20000).map(r=>norm(r.phone));
const indices=shuffled(Array.from({length:10000},(_,i)=>i),seed).slice(0,500),model=makeModels('phone',reference).find(m=>m.kind==='bloom')!;
const pub:PublicModel={id:model.id,kind:model.kind,field:model.field,pieces:model.pieces,queryPieces:model.queryPieces};
const probes=shuffled(reference,108029).slice(0,1000),probeViews=probes.map(model.tokens),views=indices.map(i=>model.tokens(truth[i]));
const d=JSON.parse(readFileSync(`${out}/observed-phone-CipherStash-match-partial.json`,'utf8'));
const wilson=(k:number,n:number)=>{const z=1.959963984540054,p=k/n,den=1+z*z/n,mid=(p+z*z/(2*n))/den,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;return {lowerPct:(mid-half)*100,upperPct:(mid+half)*100};};
const result:any={complete:false,field:'phone',model:model.id,sample:500,population:10000,seed,maxStates,indices,results:[],sourceHashes:Object.fromEntries(['models.ts','attacks.ts'].map(f=>[f,hash('sha256',readFileSync(`bench/competitor-sim/${f}`))]))};
for(const tag of ['C100','C1000','D-known']){
 const N=tag==='C100'?100:1000,labels=tag==='D-known'?d.observations.map((o:any)=>o.label):probes.slice(0,N),tokens=tag==='D-known'?d.observations.map((o:any)=>o.opaque.split(',')):probeViews.slice(0,N);
 const predictor=phonePredictor(pub,reference,labels,tokens,maxStates)!;
 const base=tag==='D-known'?d.predictions.known:JSON.parse(readFileSync(`${out}/chosen-phone-CipherStash-match-${N}.json`,'utf8')).basePredictions;
 const graph=views.map(v=>predictor.predict(v)),predictions=graph.map((g,i)=>g.value??base[indices[i]]),metric=score(indices.map(i=>truth[i]),predictions);
 const row={tag,trainingRows:labels.length,metadata:predictor.metadata,metric,wilson95: wilson(metric.correct,500),capped:graph.filter(g=>g.capped).length,returned:graph.filter(g=>g.value!==undefined).length,maxObservedStates:Math.max(...graph.map(g=>g.states)),predictions,graph};
 result.results.push(row);writeFileSync(`${out}/phone-strong-sample.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...row,predictions:undefined,graph:undefined}));
}
result.complete=true;writeFileSync(`${out}/phone-strong-sample.json`,JSON.stringify(result,null,2)+'\n');

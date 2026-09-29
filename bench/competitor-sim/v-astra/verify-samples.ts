/** Fixed-sample scoring and interval verification; no database access. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {rows,norm,makeModels,shuffled} from '../models.js';
import {phonePredictor,dictionaryPredictor,type PublicModel} from '../attacks.js';
const root='bench/results/2026-09-30-competitor-sim',read=(p:string)=>JSON.parse(readFileSync(`${root}/${p}`,'utf8'));
const data=rows(),victims=data.slice(0,10000),truth=victims.map(r=>norm(r.phone)),ref=data.slice(10000,20000).map(r=>norm(r.phone));
const model=makeModels('phone',ref).find(m=>m.kind==='bloom')!,pub:PublicModel={id:model.id,kind:model.kind,field:'phone',pieces:model.pieces,queryPieces:model.queryPieces};
const ab=read('m1-astra/results.json'),cd=read('r9-impl/phone-strong-sample.json'),obs=read('r9-impl/observed-phone-CipherStash-match-partial.json');
assert.equal(ab.complete,true);assert.equal(cd.complete,true);
const result:any={complete:false,started:new Date().toISOString(),databaseAccess:false,maxStates:20000,interval:'Wilson 95%, z=1.959963984540054; binomial approximation without finite-population correction',sourceHashes:Object.fromEntries(['models.ts','attacks.ts'].map(f=>[f,hash('sha256',readFileSync(`bench/competitor-sim/${f}`))])),rows:[],errors:[]};
function interval(k:number,n:number){const z2=1.959963984540054**2,center=(k+z2/2)/(n+z2),radius=Math.sqrt(z2*(k*(n-k)/n+z2/4))/(n+z2);return [(center-radius)*100,(center+radius)*100];}
function audit(tag:string,indices:number[],predictions:string[],metric:any,ci:number[],graph:any[],seed:number,population:number,known=0){
 assert.equal(indices.length,500);assert.equal(new Set(indices).size,500);assert.deepEqual(indices,shuffled(Array.from({length:population},(_,i)=>i+known),seed).slice(0,500));
 let correct=0,characters=0,total=0,mostly=0;for(let i=0;i<500;i++){const a=Array.from(truth[indices[i]]),b=Array.from(norm(predictions[i])),hits=a.filter((c,j)=>c===b[j]).length;correct+=Number(a.join('')===b.join(''));characters+=hits;total+=a.length;mostly+=Number(hits>=.8*a.length);assert.ok(graph[i].states<=20001);}
 assert.equal(metric.correct,correct);assert.equal(metric.characters,characters);assert.equal(metric.totalCharacters??metric.characterTotal,total);assert.equal(metric.mostly,mostly);assert.equal(metric.rows,500);
 const expected=interval(correct,500);for(let i=0;i<2;i++)assert.ok(Math.abs(ci[i]-expected[i])<.001);
 result.rows.push({tag,seed,population,sampleRows:500,correct,valuePct:correct/5,wilson95:expected,capped:graph.filter(g=>g.capped).length,scoredRows:500,replayedRows:9});
}
try{
 for(const s of ab.phoneSamples){const indices=s.predictions.map((p:any)=>p.index),predictions=s.predictions.map((p:any)=>p.predicted),graph=s.predictions;
  audit(`B${s.known}`,indices,predictions,s,s.wilson95,graph,s.sampleSeed,s.population,s.known);
  assert.equal(s.capped,graph.filter((g:any)=>g.capped).length);const probes=truth.slice(0,s.known),pv=probes.map(model.tokens),shared=dictionaryPredictor(pub,ref,probes,pv),phone=phonePredictor(pub,ref,probes,pv,20000)!;
  for(const j of [0,19,57,103,217,319,407,461,499]){const i=indices[j],g=phone.predict(model.tokens(truth[i])),p=g.value??shared.predict(model.tokens(truth[i])).value;assert.equal(p,predictions[j]);assert.equal(g.states,graph[j].states);assert.equal(g.capped,graph[j].capped);assert.equal(graph[j].id,victims[i].id);}
 }
 assert.equal(cd.maxStates,20000);assert.equal(cd.sample,500);
 const probes=shuffled(ref,108029).slice(0,1000);
 for(const s of cd.results){audit(s.tag,cd.indices,s.predictions,s.metric,[s.wilson95.lowerPct,s.wilson95.upperPct],s.graph,cd.seed,10000);
  assert.equal(s.capped,s.graph.filter((g:any)=>g.capped).length);const n=s.tag==='C100'?100:1000,labels=s.tag==='D-known'?obs.observations.map((o:any)=>o.label):probes.slice(0,n),tokens=s.tag==='D-known'?obs.observations.map((o:any)=>o.opaque.split(',')):labels.map(model.tokens),phone=phonePredictor(pub,ref,labels,tokens,20000)!;
  const base=s.tag==='D-known'?obs.predictions.known:read(`r9-impl/chosen-phone-CipherStash-match-${n}.json`).basePredictions;
  for(const j of [0,19,57,103,217,319,407,461,499]){const i=cd.indices[j],g=phone.predict(model.tokens(truth[i]));assert.equal(g.value??base[i],s.predictions[j]);assert.equal(g.states,s.graph[j].states);assert.equal(g.capped,s.graph[j].capped);}
 }
 result.complete=true;
}catch(e){result.errors.push(String(e));throw e;}finally{result.finished=new Date().toISOString();writeFileSync(`${root}/v-astra/verify-samples.json`,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({complete:result.complete,conditions:result.rows.length,scoredRows:result.rows.length*500}));

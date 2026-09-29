import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {rows,norm,makeModels} from '../models.js';
import {completedPhonePredictor} from '../completed-phone.js';
const root='bench/results/2026-09-30-competitor-sim',file=`${root}/r9-impl/observed-phone-CipherStash-match-graph.json`,saved=JSON.parse(readFileSync(file,'utf8')),obs=JSON.parse(readFileSync(`${root}/r9-impl/observed-phone-CipherStash-match-partial.json`,'utf8'));
const data=rows(),truth=data.slice(0,10000).map(r=>norm(r.phone)),ref=data.slice(10000,20000).map(r=>norm(r.phone)),model=makeModels('phone',ref).find(m=>m.kind==='bloom')!;
let correct=0,characters=0,total=0,mostly=0;assert.equal(saved.predictions.length,10000);
truth.forEach((v,i)=>{const a=Array.from(v),b=Array.from(saved.predictions[i] as string),n=a.filter((c,j)=>c===b[j]).length;correct+=Number(v===saved.predictions[i]);characters+=n;total+=a.length;mostly+=Number(n>=.8*a.length);});
assert.equal(saved.metric.correct,correct);assert.equal(saved.metric.characters,characters);assert.equal(saved.metric.totalCharacters,total);assert.equal(saved.metric.mostly,mostly);
const predictor=completedPhonePredictor({id:model.id,kind:model.kind,field:'phone',pieces:model.pieces,queryPieces:model.queryPieces},ref,obs.observations.map((o:any)=>o.label),obs.observations.map((o:any)=>o.opaque.split(',')))!;
for(const i of [19,423,1681,3157,4499,5881,7057,8913,9999]){const g=predictor.predict(model.tokens(truth[i]));assert.equal(g.value??obs.predictions.known[i],saved.predictions[i]);assert.equal(g.states,saved.graph[i].states);}
const result={complete:true,databaseAccess:false,scoredRows:10000,replayedRows:9,correct,characters,totalCharacters:total,fileHash:hash('sha256',readFileSync(file))};
writeFileSync(`${root}/v-astra/verify-observed-graph.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));

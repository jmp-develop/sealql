import {readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {assert,rows,fields,norm,rng,shuffled} from '../models.js';
const out='bench/results/2026-09-30-competitor-sim/m1-astra';
const d=JSON.parse(readFileSync(`${out}/results.json`,'utf8'));
assert.equal(d.complete,true);assert.deepEqual(d.scope,{field:'all',model:'all'});
assert.equal(d.models.length,36);assert.equal(d.results.length,1176);assert.equal(d.validation.productTokenRows,60);assert.equal(d.phoneSamples.length,2);
const data=rows(),victims=data.slice(0,10000),reference=data.slice(10000,20000);
assert.equal(d.identityDigest,hash('sha256',JSON.stringify([...victims,...reference].map(r=>r.id))));
assert.equal(new Set([...victims,...reference].map(r=>r.id)).size,20000);
assert.equal(d.modelSourceHash,hash('sha256',readFileSync('bench/competitor-sim/models.ts')));
assert.equal(d.attackSourceHash,hash('sha256',readFileSync('bench/competitor-sim/attacks.ts')));
let witnessChecks=0;
const keys=new Set<string>();
for(const r of d.results){
 const key=[r.field,r.model,r.known,r.channel,r.method].join('/');assert.ok(!keys.has(key));keys.add(key);
 assert.equal(r.rows,10000-r.known);assert.ok(Math.abs(r.pct-100*r.correct/r.rows)<1e-12);
 assert.equal(r.characterTotal,victims.slice(r.known).reduce((n,row)=>n+Array.from(norm(row[r.field as typeof fields[number]])).length,0));
 assert.ok(r.correct>=0&&r.correct<=r.rows);assert.ok(r.characters>=0&&r.characters<=r.characterTotal);
 for(const w of r.witnesses){assert.ok(w.index>=r.known&&w.index<10000);assert.equal(w.id,victims[w.index].id);assert.equal(w.correct,norm(w.predicted)===norm(victims[w.index][r.field as typeof fields[number]]));witnessChecks++;}
}
for(const m of d.models){if(m.id==='AWS-standard')assert.match(m.metadata.hash,/SHA384/);if(m.id==='CipherSweet-FIPS-fast')assert.equal(m.metadata.bits,8);if(m.id==='CipherStash-match'){assert.equal(m.metadata.m,2048);assert.equal(m.metadata.k,6);assert.match(m.metadata.fidelity,/u16LE/);}}
let baselineChecks=0;
for(const [fi,field]of fields.entries()){
 const ref=reference.map(r=>r[field]),distinct=[...new Set(ref)],random=rng(714029+fi),uniform=rng(814029+fi);
 const guesses={random_empirical:victims.map(()=>ref[Math.floor(random()*ref.length)]),random_distinct:victims.map(()=>distinct[Math.floor(uniform()*distinct.length)])};
 for(const known of [0,100,500])for(const [method,pred]of Object.entries(guesses)){
  const b=d.baselines.find((x:any)=>x.field===field&&x.known===known&&x.method===method);
  assert.equal(b.rows,10000-known);assert.equal(b.correct,victims.slice(known).filter((r,i)=>norm(r[field])===norm(pred[i+known])).length);baselineChecks++;
 }
}
const coverage=fields.flatMap(field=>[0,100,500].map(known=>{const dictionary=new Set([...reference,...victims.slice(0,known)].map(r=>norm(r[field])));const held=victims.slice(known);return {field,known,rows:held.length,covered:held.filter(r=>dictionary.has(norm(r[field]))).length,referenceDistinct:new Set(reference.map(r=>norm(r[field]))).size};}));
for(const s of d.phoneSamples){assert.equal(s.rows,500);assert.equal(s.sampleSeed,930500);assert.equal(s.graphMetadata.maxStates,20000);assert.equal(s.predictions.length,500);assert.deepEqual(s.predictions.map((p:any)=>p.index),shuffled(Array.from({length:10000-s.known},(_,i)=>i+s.known),930500).slice(0,500));let correct=0,capped=0;for(const p of s.predictions){assert.ok(p.index>=s.known&&p.index<10000);assert.equal(p.id,victims[p.index].id);assert.equal(p.correct,norm(p.predicted)===norm(victims[p.index].phone));correct+=Number(p.correct);capped+=Number(p.capped);}assert.equal(s.correct,correct);assert.equal(s.capped,capped);assert.ok(Math.abs(s.pct-correct/5)<1e-12);assert.ok(s.wilson95[0]<=s.pct+1e-12&&s.wilson95[1]>=s.pct-1e-12);}
const best:any[]=[];for(const field of fields)for(const model of [...new Set<string>(d.models.map((m:any)=>m.id))])for(const known of [0,100,500])for(const channel of model==='S0'?['index','shared_bytes','s0_native']:['index','shared_bytes']){
 const matches=d.results.filter((r:any)=>r.field===field&&r.model===model&&r.known===known&&r.channel===channel).sort((a:any,b:any)=>b.correct-a.correct||b.characters-a.characters);
 const r=matches[0];best.push({field,model,known,channel,method:r.method,correct:r.correct,rows:r.rows,pct:r.pct,characterPct:r.characterPct,predictionDigest:r.predictionDigest});
}
const sourcePaths=['bench/competitor-sim/models.ts','bench/competitor-sim/attacks.ts','bench/competitor-sim/m1-astra/attacks.ts','bench/competitor-sim/m1-astra/run.ts','bench/competitor-sim/m1-astra/verify.ts'];
writeFileSync(`${out}/verification.json`,JSON.stringify({generated:new Date().toISOString(),passed:true,databaseAccess:false,witnessChecks,baselineChecks,aggregateRows:d.results.length,independentPredictionReplay:'Owned by v-astra; this verifier checks scoring and denominators, not independent attack predictions.',coverage,best,sourceHashes:Object.fromEntries(sourcePaths.map(p=>[p,hash('sha256',readFileSync(p))]))},null,2)+'\n');
console.log(JSON.stringify({passed:true,witnessChecks,baselineChecks,aggregateRows:d.results.length}));

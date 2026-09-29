/** Memory-only artifact and byte-format checks. No DB connection or product writes. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHmac,hkdfSync,hash} from 'node:crypto';
import {rows,fields,norm,makeModels,validateProduct,Codec,ring,scope,assert,shuffled} from './models.js';
import {score} from './attacks.js';
import {inferQueryLabels} from './observation.js';
import {stampKey} from '../../src/core/search-stamps.js';
import {profiles} from '../../src/core/search-tokens.js';
import {spec} from '../attack-extra/codec.js';
import {frame,u32,utf8} from '../../src/core/bytes.js';
const out='bench/results/2026-09-30-competitor-sim/r9-impl';
const read=(name:string)=>JSON.parse(readFileSync(`${out}/${name}.json`,'utf8'));
const data=rows(),victims=data.slice(0,10000),reference=data.slice(10000,20000);
const c=read('chosen'),d=read('observed');assert.equal(c.complete,true);assert.equal(d.complete,true);
assert.equal(c.results.length,72);assert.equal(d.results.length,42);
assert.equal(c.identityDigest,d.identityDigest);
assert.equal(c.identityDigest,hash('sha256',JSON.stringify([...victims,...reference].map(r=>r.id))));
assert.equal(new Set([...victims,...reference].map(r=>r.id)).size,20000);
let metricChecks=0,orderChecks=0,byteChecks=0;
for(const row of c.results){const artifact=read(`chosen-${row.field}-${row.model}-${row.N}`),truth=victims.map(r=>norm(r[row.field as typeof fields[number]]));
 assert.deepEqual(score(truth,artifact.predictions),row.strongest);metricChecks++;
 assert.deepEqual(score(truth,artifact.basePredictions),row.base);metricChecks++;
 assert.deepEqual(artifact.strongest,row.strongest);assert.equal(artifact.probeIndices.length,row.N);
}
for(const row of d.results){const artifact=read(`observed-${row.field}-${row.model}-${row.mode}`),truth=victims.map(r=>norm(r[row.field as typeof fields[number]]));
 for(const [key,metric]of [['known','known'],['unknown','unknown'],['knownCombined','knownCombined'],['unknownCombined','unknownCombined'],['knownPartial','knownPositions'],['unknownPartial','unknownPositions']]){
  if(artifact.predictions[key]===undefined)continue;
  assert.deepEqual(score(truth,artifact.predictions[key]),row[metric]);metricChecks++;
 }
 assert.deepEqual(artifact.observations.map((o:any)=>o.label),[...new Set(artifact.observedQueries)]);orderChecks++;
}
for(const field of fields){const values=reference.slice(0,3).map(r=>norm(r[field])),model=makeModels(field,reference.map(r=>norm(r[field])))[0];
 byteChecks+=await validateProduct(model,values);const codec=new Codec(field);
 for(const value of values){await codec.validate(value);byteChecks++;
  const root=Buffer.from(hkdfSync('sha384',ring.key,Buffer.alloc(0),frame(['sealql/search-stamp/v1',ring.keyScopeId,'customers',field,'text',u32(2),new Uint8Array(),'legacy-text-v1','exact']),32));
  const fast=createHmac('sha256',root).update(frame([scope,utf8(value)])).digest();
  const profile=profiles('customers',field,spec(field)).find(p=>p.mode==='exact')!;
  assert.deepEqual(fast,Buffer.from(await stampKey(ring,profile,'exact',scope,utf8(value))));byteChecks++;
 }
}
// Input-boundary invariant: evaluator-only plaintext labels cannot affect inference.
const opaque=[{opaque:'a',hits:[0,1]},{opaque:'b',hits:[2]}],ref=['x','x','y'];
const infer=(xs:any[])=>inferQueryLabels(ref,xs,['x','y'],(v,q)=>v===q).map(o=>o.label);
assert.deepEqual(infer(opaque),infer(opaque.map((o,i)=>({...o,label:'hidden-'+i}))));
const graph=read('observed-phone-CipherStash-match-graph');
assert.deepEqual(graph.metric,score(victims.map(r=>norm(r.phone)),graph.predictions));metricChecks++;
const sample=read('phone-strong-sample');assert.equal(sample.complete,true);assert.equal(sample.results.length,3);
assert.deepEqual(sample.indices,shuffled(Array.from({length:10000},(_,i)=>i),sample.seed).slice(0,500));
for(const r of sample.results){assert.deepEqual(r.metric,score(sample.indices.map((i:number)=>norm(victims[i].phone)),r.predictions));metricChecks++;
 assert.equal(r.capped,r.graph.filter((g:any)=>g.capped).length);assert.ok(r.graph.every((g:any)=>g.states<=sample.maxStates+1));
 const n=500,p=r.metric.correct/n,z=1.959963984540054,den=1+z*z/n,mid=(p+z*z/(2*n))/den,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
 assert.ok(Math.abs(r.wilson95.lowerPct-(mid-half)*100)<1e-10);assert.ok(Math.abs(r.wilson95.upperPct-(mid+half)*100)<1e-10);
}
const sourceHashes=Object.fromEntries(['models.ts','attacks.ts','completed-phone.ts','run-c.ts','run-d.ts','run-d-graph.ts','run-phone-sample.ts','observation.ts'].map(f=>[f,hash('sha256',readFileSync(`bench/competitor-sim/${f}`))]));
assert.equal(sample.sourceHashes['models.ts'],sourceHashes['models.ts']);assert.equal(sample.sourceHashes['attacks.ts'],sourceHashes['attacks.ts']);
const result={pass:true,databaseAccess:false,C:72,D:42,sampleCases:3,sampleRows:500,metricChecks,firstAppearanceOrderChecks:orderChecks,byteChecks,unknownLabelBoundary:true,identityDigest:c.identityDigest,sourceHashes};
writeFileSync(`${out}/verification.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));

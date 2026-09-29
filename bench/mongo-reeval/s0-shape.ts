/** WITHDRAWN: normalized UTF8 bytes are not necessarily raw ciphertext length.
 * Preserved exploratory output only; not an accepted security comparison.
 * Apply the new public length + incidence family to S0 as well.
 * Original competitor results stay immutable. The attack receives lengths only. */
import {readFileSync,writeFileSync} from 'node:fs';
import {rows,fields,norm,publicRowShape} from './models.js';
import {counts,score} from '../competitor-sim/attacks.js';
import type {Observation} from '../competitor-sim/observation.js';
import {shapeAttack,shapeKey,type Shape} from './m1-astra/shape-attacks.js';
const OUT='bench/results/2026-09-30-mongo-reeval/r9-impl',data=rows(),victims=data.slice(0,10000),reference=data.slice(10000,20000);
const shapeOf=(v:string):Shape=>({tags:Array.from(v).length,bytes:Buffer.byteLength(v)+28});
function predict(reference:string[],views:Shape[],observations:Observation[],accepts:(v:string,q:string)=>boolean){
 const prior=shapeAttack(reference,shapeOf,[],norm),freq=counts(reference),lookup=new Map<string,string>(),masks=Array<bigint>(views.length).fill(0n);
 observations.forEach((o,j)=>o.hits.forEach(i=>masks[i]|=1n<<BigInt(j)));
 for(const [v]of [...freq].sort((a,b)=>b[1]-a[1])){let mask=0n;observations.forEach((o,j)=>{if(o.label!==undefined&&accepts(v,o.label))mask|=1n<<BigInt(j);});const k=shapeKey(shapeOf(v))+'/'+mask.toString(16);if(!lookup.has(k))lookup.set(k,v);}
 return {prior:views.map(v=>prior.predictReference(v)),incidence:views.map((v,i)=>lookup.get(shapeKey(v)+'/'+masks[i].toString(16))??prior.predictReference(v))};
}
const results=[];
for(const field of fields)for(const mode of ['eq','partial'] as const){
 const old=JSON.parse(readFileSync(`bench/results/2026-09-30-competitor-sim/r9-impl/observed-${field}-S0-${mode}.json`,'utf8'));
 const truth=victims.map(r=>norm(r[field])),ref=reference.map(r=>norm(r[field])),views=truth.map(shapeOf),accepts=(v:string,q:string)=>mode==='eq'?v===q:v.includes(q);
 const known=predict(ref,views,old.observations,accepts),unknown=predict(ref,views,old.observations.map((o:Observation,j:number)=>({...o,label:old.unknownAssignedLabels[j]})),accepts);
 const predictions={prior:known.prior,knownShape:known.incidence,unknownShape:unknown.incidence};
 const supported=truth.flatMap((v,i)=>publicRowShape({id:'C-mongo',field,mode},v).supported?[i]:[]);
 const metrics=Object.fromEntries(Object.entries(predictions).map(([k,p])=>[k,score(truth,p)])),supportedMetrics=Object.fromEntries(Object.entries(predictions).map(([k,p])=>[k,score(supported.map(i=>truth[i]),supported.map(i=>p[i]))]));
 const row={field,mode,metrics,supportedMetrics,supportedRows:supported.length};results.push(row);
 writeFileSync(`${OUT}/s0-shape-${field}-${mode}.json`,JSON.stringify({...row,predictions,supported},null,2)+'\n');
}
writeFileSync(`${OUT}/s0-shape.json`,JSON.stringify({complete:true,databaseAccess:false,observable:'S0 normalized character length (position stream n) and ciphertext byte length; no PRF or key',results},null,2)+'\n');console.log(JSON.stringify(results.filter(r=>r.field==='company')));

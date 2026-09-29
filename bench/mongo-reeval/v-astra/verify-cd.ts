/** Saved predictions are fully rescored; observed exact-hit sets are checked against plaintext. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {rows,fields,norm,publicRowShape,type Options} from '../models.js';
import {inferQueryLabels,observationGuesses} from '../../competitor-sim/observation.js';
import {queryPhonePredictor} from '../phone.js';
const ROOT='bench/results/2026-09-30-mongo-reeval',DIR=ROOT+'/r9-impl',OUT=ROOT+'/v-astra';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),all=rows(),victim=all.slice(0,10000),reference=all.slice(10000,20000);
const count=(xs:string[])=>{const m=new Map<string,number>();for(const x of xs)m.set(x,(m.get(x)??0)+1);return m;};
const out:any={complete:false,started:new Date().toISOString(),files:[],predictionsRescored:0,observationHitChecks:0,unknownLabelReplays:0,phoneReplays:0,errors:[]};
function score(values:string[],guesses:(string|null|undefined)[]){let correct=0,characters=0,totalCharacters=0,mostly=0;for(let i=0;i<values.length;i++){const a=Array.from(norm(values[i])),b=Array.from(guesses[i]??''),hits=a.filter((c,j)=>c===b[j]).length;correct+=Number(a.join('')===guesses[i]);characters+=hits;totalCharacters+=a.length;mostly+=Number(hits>=.8*a.length);}return {rows:values.length,correct,valuePct:correct/values.length*100,characters,totalCharacters,characterPct:characters/totalCharacters*100,mostly,mostlyPct:mostly/values.length*100};}
try{
 const files=readdirSync(DIR).filter(x=>/^(chosen|observed)-.*\.json$/.test(x));assert.ok(files.length>0);
 for(const file of files){const raw=readFileSync(DIR+'/'+file,'utf8'),r=JSON.parse(raw),field=r.field as typeof fields[number],truth=victim.map(v=>norm(v[field]));const options:Options={id:r.model,field,mode:r.model==='C-port'?'combined':r.mode??'partial',contention:r.model==='C-port'?0:8,maxLength:60};const supported=truth.flatMap((v,i)=>publicRowShape(options,v).supported?[i]:[]);assert.deepEqual(r.supported,supported);
  for(const [name,metric]of Object.entries(r.metrics)){const p=r.predictions[name];assert.ok(Array.isArray(p),file+'/'+name);assert.equal(p.length,truth.length);assert.deepEqual(score(supported.map(i=>truth[i]),supported.map(i=>p[i])),metric);out.predictionsRescored+=supported.length;}
  if(file.startsWith('observed-')){
   const op=r.mode==='eq'?(v:string,q:string)=>v===q:(v:string,q:string)=>v.includes(q);for(const o of r.observations){assert.deepEqual(o.hits,supported.filter(i=>op(truth[i],o.label)));out.observationHitChecks++;}
   const ref=reference.map(v=>norm(v[field])).filter(v=>publicRowShape(options,v).supported),dict=r.mode==='eq'?reference.map(v=>norm(v[field])):[...new Set(reference.flatMap(v=>(v[field].match(/[\p{L}\p{N}]+/gu)??[]).map(norm).filter(q=>q.length>=3&&q.length<=10)))];
   const unknown=inferQueryLabels(ref,r.observations.map((o:any)=>({opaque:o.opaque,hits:o.hits})),dict,op,r.mode==='eq'?count(ref):undefined);assert.deepEqual(unknown.map(x=>x.label),r.unknownAssignedLabels);assert.deepEqual(observationGuesses(ref,truth.length,unknown,op),r.predictions.unknown);out.unknownLabelReplays++;
   if(r.graph){const predict=queryPhonePredictor(ref,r.observations,truth.length,20000,(candidate,row)=>{const a=publicRowShape(options,candidate),b=publicRowShape(options,truth[row]);return a.tagCount===b.tagCount&&a.cipherBytes===b.cipherBytes;});for(const i of [0,33,877,2333,4999,7117,9999]){assert.deepEqual(JSON.parse(JSON.stringify(predict(i))),r.graph[i]);out.phoneReplays++;}}
  }
  out.files.push({file,sha256:hash(raw),predictions:Object.keys(r.metrics),supported:supported.length});
 }
 out.complete=true;
}catch(e){out.errors.push(String(e));throw e;}finally{out.finished=new Date().toISOString();writeFileSync(OUT+'/verify-cd.json',JSON.stringify(out,null,2)+'\n');}
console.log(JSON.stringify({complete:out.complete,files:out.files.length,predictionsRescored:out.predictionsRescored,observationHitChecks:out.observationHitChecks,unknownLabelReplays:out.unknownLabelReplays,phoneReplays:out.phoneReplays}));

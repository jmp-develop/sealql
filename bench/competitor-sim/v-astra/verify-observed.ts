/** Independent output scoring, sampled observed hits, and public attack replay. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {rows,fields,makeModels,norm} from '../models.js';
import {inferQueryLabels,observationGuesses} from '../observation.js';
const root='bench/results/2026-09-30-competitor-sim',read=(p:string)=>JSON.parse(readFileSync(`${root}/${p}`,'utf8'));
const summary=read('r9-impl/observed.json'),data=rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000);
assert.equal(summary.complete,true);assert.equal(summary.identityDigest,hash('sha256',JSON.stringify(data.slice(0,20000).map(r=>r.id))));
const result:any={complete:false,databaseAccess:false,started:new Date().toISOString(),modelsSourceHash:hash('sha256',readFileSync('bench/competitor-sim/models.ts')),checks:[],errors:[]};
try{for(const field of fields){const truth=victim.map(r=>norm(r[field])),ref=reference.map(r=>norm(r[field]));for(const model of makeModels(field,ref))for(const row of summary.results.filter((r:any)=>r.field===field&&r.model===model.id)){
 const filename=`r9-impl/observed-${field}-${model.id}-${row.mode}.json`,saved=read(filename);
 for(const [name,predictions]of Object.entries(saved.predictions)){if(!Array.isArray(predictions))continue;const metric=(saved as any)[name==='knownPartial'?'knownPositions':name==='unknownPartial'?'unknownPositions':name];if(!metric)continue;
  assert.equal(predictions.length,10000);let correct=0,characters=0,total=0,mostly=0;truth.forEach((value,i)=>{const cs=Array.from(value),gs=Array.from(String(predictions[i]??'')),n=cs.filter((c,j)=>c===gs[j]).length;correct+=Number(value===predictions[i]);characters+=n;total+=cs.length;mostly+=Number(n>=.8*cs.length);});
  assert.equal(metric.correct,correct);assert.equal(metric.characters,characters);assert.equal(metric.totalCharacters,total);assert.equal(metric.mostly,mostly);assert.ok(Math.abs(metric.valuePct-correct/100)<1e-10);
 }
 assert.deepEqual(saved.observations.map((o:any)=>o.label),[...new Set(saved.observedQueries)],'Query observations must preserve first-arrival order, not hidden plaintext sort');
 let hitChecks=0;for(const obs of saved.observations.filter((_:any,i:number)=>i%17===0)){const actual=new Set(obs.hits);for(const i of [19,423,1681,3157,4499,5881,7057,8913,9999]){const expected=model.id==='S0'?(row.mode==='eq'?truth[i]===obs.label:truth[i].includes(obs.label)):model.query(obs.label).every(t=>model.tokens(truth[i]).includes(t));assert.equal(actual.has(i),expected);hitChecks++;}}
 const pieceCache=new Map<string,Set<string>>(),queryCache=new Map<string,string[]>();
 const accepts=(v:string,q:string)=>{if(row.mode==='eq')return v===q;if(model.id==='S0')return v.includes(q);let ps=pieceCache.get(v);if(!ps){ps=new Set(model.pieces(v));pieceCache.set(v,ps);}let qs=queryCache.get(q);if(!qs){qs=model.queryPieces(q);queryCache.set(q,qs);}return qs.every(p=>ps!.has(p));};
 const known=observationGuesses(ref,10000,saved.observations,accepts);assert.deepEqual(known,saved.predictions.known);
 const terms=row.mode==='eq'?ref:reference.flatMap(r=>(r[field].match(/[\p{L}\p{N}]+/gu)??[]).map(norm).filter(q=>Array.from(q).length>=3&&Array.from(q).length<=45));
 const frequencies=new Map<string,number>();if(row.mode==='eq')for(const v of ref)frequencies.set(v,(frequencies.get(v)??0)+1);
 const unknownObs=inferQueryLabels(ref,saved.observations.map((o:any)=>({opaque:o.opaque,hits:o.hits})),terms,accepts,row.mode==='eq'?frequencies:undefined);
 assert.deepEqual(unknownObs.map(o=>o.label),saved.unknownAssignedLabels);
 const unknown=observationGuesses(ref,10000,unknownObs,accepts);assert.deepEqual(unknown,saved.predictions.unknown);
 result.checks.push({field,model:model.id,mode:row.mode,hitChecks,predictionsScored:Object.values(saved.predictions).filter(Array.isArray).length*10000,replayedPredictions:20000,fileHash:hash('sha256',readFileSync(`${root}/${filename}`))});console.log(`D verified ${field}/${model.id}/${row.mode}`);
 }}result.complete=true;}catch(e){result.errors.push(String(e));throw e;}finally{result.finished=new Date().toISOString();writeFileSync(`${root}/v-astra/verify-observed.json`,JSON.stringify(result,null,2)+'\n');}

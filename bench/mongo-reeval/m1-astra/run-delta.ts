import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import * as m from '../models.js';
import {counterDelta,learnBatchCounterLabels,shapeAttack} from './shape-attacks.js';
export function runDelta(field:string,id:m.ModelId,reusedEncoder?:ReturnType<typeof m.createOccurrenceModel>){
const mode:m.Mode=id==='C-port'?'combined':'partial';
const root='bench/results/2026-09-30-mongo-reeval/m1-astra';mkdirSync(root,{recursive:true});
const sourceHash=hash('sha256',readFileSync('bench/mongo-reeval/models.ts')),data=m.rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000),probes=m.shuffled(reference,108029).slice(0,1000);
const truth=victim.map(r=>r[field as typeof m.fields[number]]),ref=reference.map(r=>r[field as typeof m.fields[number]]),options:m.Options={id,field,mode,contention:id==='C-port'?0:8,maxLength:60};
const enc=reusedEncoder??m.createOccurrenceModel(options);if(!reusedEncoder)for(let i=0;i<victim.length;i++)enc.insert(victim[i].id,truth[i]);
const start=enc.snapshot(false),startComp=enc.snapshot(true),baseIds=new Set(victim.map(r=>r.id));
const publicShape=(value:string)=>{const s=(m as any).publicRowShape(options,value);return {tags:s.tagCount,bytes:s.cipherBytes};};
const result:any={started:new Date().toISOString(),complete:false,field,model:id,options,sourceHash,databaseAccess:false,identityDigest:hash('sha256',JSON.stringify([...victim,...reference].map(r=>r.id))),protocol:'Two batch endpoints only. Known replacement values from disjoint reference. No per-write timestamps, transaction grouping, query tokens, root or counter-to-document map to attacker.',cases:[]};
function metric(pred:string[],indices:number[]){let correct=0;for(let j=0;j<indices.length;j++)correct+=Number(m.norm(pred[j])===m.norm(truth[indices[j]]));return {rows:indices.length,correct,pct:100*correct/indices.length,predictionDigest:hash('sha256',JSON.stringify(pred))};}
function analyze(before:m.Snapshot,after:m.Snapshot,N:number,operation:'insert'|'update',phase:string){
 const priorRows=new Map(before.rows.map(r=>[r.id,r])),newRows=new Map(after.rows.map(r=>[r.id,r])),knownViews=operation==='insert'?probes.slice(0,N).map(p=>newRows.get(p.id)!):victim.slice(0,N).map(p=>newRows.get(p.id)!);
 const knownValues=probes.slice(0,N).map(p=>p[field as typeof m.fields[number]]),known=knownViews.flatMap((row,i)=>row.supported?[{value:knownValues[i],shape:{tags:row.tagCount,bytes:row.cipherBytes}}]:[]),shapes=shapeAttack(ref.filter(v=>(m as any).publicRowShape(options,v).supported),publicShape,known,m.norm);
 const indices=victim.flatMap((r,i)=>newRows.get(r.id)?.supported&&(operation==='insert'||i>=N)?[i]:[]),knownTags=new Set(knownViews.flatMap(r=>r.tags));
 let joined=0,changedUntouched=0;for(const i of indices){const a=newRows.get(victim[i].id)!,b=priorRows.get(a.id)!;joined+=Number(a.tags.some(t=>knownTags.has(t)));changedUntouched+=Number(JSON.stringify(a.tags)!==JSON.stringify(b.tags));}
 const fingerprintKnown=new Map(knownViews.flatMap((r,i)=>r.supported?[[r.tags.join(','),knownValues[i]] as [string,string]]:[]));
 const predictions=indices.map(i=>{const r=newRows.get(victim[i].id)!;return fingerprintKnown.get(r.tags.join(','))??shapes.predictKnown({tags:r.tagCount,bytes:r.cipherBytes});}),referencePred=indices.map(i=>{const r=newRows.get(victim[i].id)!;return shapes.predictReference({tags:r.tagCount,bytes:r.cipherBytes});});
 const delta=counterDelta(before.esc,after.esc),knownPieces=knownViews.flatMap((r,i)=>r.supported?[m.publicPieces(field,knownValues[i],mode)]:[]),labels=learnBatchCounterLabels(delta.deltas,knownPieces),unique=labels.filter(x=>x.candidates.length===1);
 // Evaluation-only mapping precision. Never used to filter labels or select guesses.
 const correctLabels=id==='C-port'?unique.filter(x=>m.portEscId(m.portToken(field,x.candidates[0]))===x.id).length:null;
 const removedOldTagRetained=operation==='update'?victim.slice(0,N).reduce((n,r)=>{const a=newRows.get(r.id)!,b=priorRows.get(r.id)!;const next=new Set(a.tags);return n+b.tags.filter(t=>next.has(t)).length;},0):null;
 const sample=new Set(m.shuffled(indices,9917).slice(0,12));
 result.cases.push({operation,N,knownSupported:known.length,phase,unmodifiedVictims:metric(predictions,indices),referenceOnly:metric(referencePred,indices),knownTargetTagOverlapRows:joined,unexpectedChangedUntouchedRows:changedUntouched,oldTagsRetainedOnUpdatedRows:removedOldTagRetained,esc:{before:before.esc.length,after:after.esc.length,added:delta.added.length,removed:delta.removed.length,changed:delta.changed.length,plaintextCountDeltas:delta.deltas.length,uniqueBatchCounterLabels:unique.length,evaluationOnlyCorrectCounterLabels:correctLabels,counterToVictimRowLinksProvided:0},witnesses:indices.flatMap((i,j)=>sample.has(i)?[{index:i,id:victim[i].id,predicted:predictions[j],correct:m.norm(predictions[j])===m.norm(truth[i])}]:[])});
 if(operation==='update'){
  const targetIndices=victim.slice(0,N).flatMap((r,i)=>priorRows.get(r.id)!.supported?[i]:[]),guess=targetIndices.map(i=>{const row=priorRows.get(victim[i].id)!;return shapes.predictReference({tags:row.tagCount,bytes:row.cipherBytes});});
  result.cases.at(-1).overwrittenOldValues={...metric(guess,targetIndices),method:'pre-snapshot shape reference; new tag identities do not transfer to old occurrence tags',knownNewValueOnlyBaseline:'Replacement values are a fixed shuffled reference batch, not correlated character edits.'};
 }
 m.assert.equal(changedUntouched,0,'Untouched rows changed');console.log(JSON.stringify({field,model:id,operation,N,phase,joined,escAdded:delta.added.length,escChanged:delta.changed.length}));
}
let done=0;for(const N of [100,1000]){for(;done<N;done++)enc.insert(probes[done].id,probes[done][field as typeof m.fields[number]]);analyze(start,enc.snapshot(false),N,'insert','precompaction');if(id==='C-mongo')analyze(startComp,enc.snapshot(true),N,'insert','postcompaction-endpoints');}
const updateStart=enc.snapshot(false),updateComp=enc.snapshot(true);done=0;
for(const N of [100,1000]){for(;done<N;done++)(enc as any).update(victim[done].id,probes[done][field as typeof m.fields[number]]);analyze(updateStart,enc.snapshot(false),N,'update','precompaction');if(id==='C-mongo')analyze(updateComp,enc.snapshot(true),N,'update','postcompaction-endpoints');}
m.assert.equal(hash('sha256',readFileSync('bench/mongo-reeval/models.ts')),sourceHash,'Model changed during run');result.complete=true;result.finished=new Date().toISOString();writeFileSync(`${root}/delta-${id}-${field}.json`,JSON.stringify(result,null,2)+'\n');console.log('COMPLETE DELTA '+id+'/'+field);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runDelta(process.argv[2]??'phone',(process.argv[3]??'C-port') as m.ModelId);

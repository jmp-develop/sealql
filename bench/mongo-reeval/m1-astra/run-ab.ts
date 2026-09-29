import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import * as m from '../models.js';
import {buildAttacks,type View} from '../../competitor-sim/m1-astra/attacks.js';
import {shapeAttack} from './shape-attacks.js';
import {queryPhonePredictor} from '../phone.js';
import {runDelta} from './run-delta.js';
const field=process.argv[2]??'phone',id=(process.argv[3]??'C-port') as m.ModelId;
m.assert.ok(m.fields.includes(field as typeof m.fields[number]));
const root='bench/results/2026-09-30-mongo-reeval/m1-astra';mkdirSync(root,{recursive:true});
const sourceHash=hash('sha256',readFileSync('bench/mongo-reeval/models.ts'));
const data=m.rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000),mode:m.Mode=id==='C-port'?'combined':'partial';
const options:m.Options={id,field,mode,contention:id==='C-port'?0:8,maxLength:60},encoder=m.createOccurrenceModel(options);
const truth=victim.map(r=>r[field as typeof m.fields[number]]),ref=reference.map(r=>r[field as typeof m.fields[number]]),featureCache=new Map<string,string[]>();
const features=(value:string)=>{let ps=featureCache.get(value);if(!ps){ps=m.publicPieces(field,value,mode);featureCache.set(value,ps);}return ps;};
for(let i=0;i<victim.length;i++)encoder.insert(victim[i].id,truth[i]);
const snap=encoder.snapshot(false),compacted=encoder.snapshot(true);
m.assert.equal(snap.rows.length,victim.length);m.assert.deepEqual(snap.rows,compacted.rows,'Compaction must not relabel document tags in this model');
const indexViews:View[]=snap.rows.map(r=>({tokens:r.tags}));
const allTags=new Set<string>();let repeats=0;for(const row of snap.rows)for(const tag of new Set(row.tags)){if(allTags.has(tag))repeats++;allTags.add(tag);}
const fingerprint=(ss:m.Snapshot)=>hash('sha256',JSON.stringify(ss.rows.map(r=>[r.id,r.tagCount,r.cipherBytes,r.supported,r.tags])));
const result:any={started:new Date().toISOString(),complete:false,databaseAccess:false,field,model:id,mode,options,sourceHash,identityDigest:hash('sha256',JSON.stringify([...victim,...reference].map(r=>r.id))),snapshotDigest:fingerprint(snap),metadata:snap.metadata,compactedMetadata:compacted.metadata,esc:{beforeRows:snap.esc.length,afterCompactionRows:compacted.esc.length,plaintextCounters:snap.esc.filter(x=>x.n!==undefined).length,totalPlaintextCounts:snap.esc.reduce((n,x)=>n+(x.n??0),0),distinctPlaintextCounts:new Set(snap.esc.flatMap(x=>x.n===undefined?[]:[x.n])).size,preDigest:hash('sha256',JSON.stringify(snap.esc)),postDigest:hash('sha256',JSON.stringify(compacted.esc))},uniqueness:{tagOccurrences:snap.rows.reduce((n,r)=>n+r.tags.length,0),distinctTags:allTags.size,crossRowRepeats:repeats},unsupported:snap.rows.flatMap((r,i)=>r.supported?[]:[{index:i,id:r.id}]),results:[],baselines:[]};
const publicShape=(value:string)=>{const s=(m as any).publicRowShape(options,value);return {tags:s.tagCount,bytes:s.cipherBytes};};
const shapeCache=new Map<string,{tags:number;bytes:number}>();const shapeOf=(value:string)=>{let s=shapeCache.get(value);if(!s){s=publicShape(value);shapeCache.set(value,s);}return s;};
if(field==='phone'){
 const graph=queryPhonePredictor(ref,[],snap.rows.length,20000,(candidate,row)=>{const s=shapeOf(candidate),v=snap.rows[row];return s.tags===v.tagCount&&s.bytes===v.cipherBytes;});
 const byShape=new Map<string,ReturnType<typeof graph>>();for(let i=0;i<snap.rows.length;i++){const r=snap.rows[i],key=JSON.stringify([r.tagCount,r.cipherBytes]);if(!byShape.has(key))byShape.set(key,graph(i));}
 result.phoneShapeGraph={maxStates:20000,knownTagTransferRequired:true,classes:[...byShape].map(([shape,g])=>({shape,...g})),rowsWithMultipleWitnesses:snap.rows.filter(r=>(byShape.get(JSON.stringify([r.tagCount,r.cipherBytes]))?.solutions??0)>=2).length,rowsWithCap:snap.rows.filter(r=>byShape.get(JSON.stringify([r.tagCount,r.cipherBytes]))?.capped).length};
}
function score(predictions:string[],indices:number[]){let correct=0,characters=0,totalCharacters=0,mostly=0;for(let j=0;j<indices.length;j++){const t=Array.from(m.norm(truth[indices[j]])),g=Array.from(m.norm(predictions[j])),hits=t.filter((c,i)=>g[i]===c).length;correct+=Number(t.join('')===g.join(''));characters+=hits;totalCharacters+=t.length;mostly+=Number(hits>=.8*t.length);}return {rows:indices.length,correct,pct:100*correct/indices.length,characters,totalCharacters,characterPct:100*characters/totalCharacters,mostly};}
const supportedRef=ref.filter(v=>(m as any).publicRowShape(options,v).supported);
for(const knownCount of [0,100,500]){
 const known=truth.slice(0,knownCount).flatMap((value,i)=>snap.rows[i].supported?[{value,view:indexViews[i]}]:[]),indices=snap.rows.flatMap((r,i)=>i>=knownCount&&r.supported?[i]:[]);
 const family=buildAttacks({features,multiplicity:1},supportedRef,indexViews.filter((_,i)=>snap.rows[i].supported),known);
 const shapes=shapeAttack(supportedRef,shapeOf,truth.slice(0,knownCount).flatMap((value,i)=>snap.rows[i].supported?[{value,shape:{tags:snap.rows[i].tagCount,bytes:snap.rows[i].cipherBytes}}]:[]),m.norm);
 const indexShapes=shapeAttack(supportedRef,v=>({tags:shapeOf(v).tags}),truth.slice(0,knownCount).flatMap((value,i)=>snap.rows[i].supported?[{value,shape:{tags:snap.rows[i].tagCount}}]:[]),m.norm);
 const knownTags=new Set(indexViews.slice(0,knownCount).flatMap(v=>v.tokens));const sharedTargets=indices.filter(i=>indexViews[i].tokens.some(t=>knownTags.has(t))).length;
 const methods=Object.entries(family.predict).filter(([name])=>knownCount>0||name.endsWith('frequency')).map(([method,predict])=>({method,channel:'index',predict:(i:number)=>predict(indexViews[i])}));
 methods.push({method:'public_shape_reference',channel:'native_shape',predict:i=>shapes.predictReference({tags:snap.rows[i].tagCount,bytes:snap.rows[i].cipherBytes})});
 methods.push({method:'public_tagcount_reference',channel:'index',predict:i=>indexShapes.predictReference({tags:snap.rows[i].tagCount})});
 if(knownCount)methods.push({method:'public_shape_known',channel:'native_shape',predict:i=>shapes.predictKnown({tags:snap.rows[i].tagCount,bytes:snap.rows[i].cipherBytes})});
 if(knownCount)methods.push({method:'public_tagcount_known',channel:'index',predict:i=>indexShapes.predictKnown({tags:snap.rows[i].tagCount})});
 const rng=m.rng(714029+m.fields.indexOf(field as typeof m.fields[number])),uniform=m.rng(814029+m.fields.indexOf(field as typeof m.fields[number])),distinct=[...new Set(supportedRef)],randomRows=truth.map(()=>supportedRef[Math.floor(rng()*supportedRef.length)]),randomDistinct=truth.map(()=>distinct[Math.floor(uniform()*distinct.length)]);
 for(const [method,pred]of [['random_empirical',randomRows],['random_distinct',randomDistinct]] as const)result.baselines.push({known:knownCount,method,...score(indices.map(i=>pred[i]),indices)});
 for(const method of methods){const predictions=indices.map(method.predict),metric=score(predictions,indices),selected=new Set(m.shuffled(indices,9917).slice(0,12)),witnesses=indices.flatMap((i,j)=>selected.has(i)?[{index:i,id:victim[i].id,predicted:predictions[j],correct:m.norm(predictions[j])===m.norm(truth[i])}]:[]);result.results.push({known:knownCount,knownSupported:known.length,phase:'snapshot',...method,predict:undefined,...metric,sharedKnownTargetRows:sharedTargets,learned:family.metadata,predictionDigest:hash('sha256',JSON.stringify(predictions)),witnesses});}
 console.log(JSON.stringify({field,model:id,known:knownCount,rows:indices.length,sharedKnownTargetRows:sharedTargets}));
}
m.assert.equal(hash('sha256',readFileSync('bench/mongo-reeval/models.ts')),sourceHash,'Shared model changed during run');result.complete=true;result.finished=new Date().toISOString();
writeFileSync(`${root}/ab-${id}-${field}.json`,JSON.stringify(result,null,2)+'\n');console.log('COMPLETE '+id+'/'+field);
runDelta(field,id,encoder);

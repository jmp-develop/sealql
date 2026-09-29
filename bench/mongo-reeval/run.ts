import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {hash} from 'node:crypto';
import {createOccurrenceModel,publicRowShape,queryHits,rows,fields,norm,shuffled,assert,publicPieces,portToken,portEscId,portTag,type Options,type RowView,type Snapshot,type QueryView} from './models.js';
import {shapeAttack,counterDelta,learnBatchCounterLabels,shapeKey,type Shape} from './m1-astra/shape-attacks.js';
import {score,counts} from '../competitor-sim/attacks.js';
import {observationGuesses,inferQueryLabels,type Observation} from '../competitor-sim/observation.js';
import {queryPhonePredictor} from './phone.js';
const OUT='bench/results/2026-09-30-mongo-reeval/r9-impl',OLD='bench/results/2026-09-30-competitor-sim/r9-impl';mkdirSync(OUT,{recursive:true});
const onlyField=process.argv[2]??process.env.ONLY_FIELD,onlyModel=process.argv[3]??process.env.ONLY_MODEL;
const resultName=onlyField?`results-${onlyField}-${onlyModel??'all'}`:'results';
const save=(name:string,data:unknown)=>writeFileSync(`${OUT}/${name==='results'?resultName:name}.json`,JSON.stringify(data,null,2)+'\n');
const data=rows(),victims=data.slice(0,10000),reference=data.slice(10000,20000);
const sourceHash=hash('sha256',readFileSync('bench/mongo-reeval/models.ts'));
const result:any=existsSync(`${OUT}/results.json`)?JSON.parse(readFileSync(`${OUT}/results.json`,'utf8')):{complete:false,databaseAccess:false,identityDigest:hash('sha256',JSON.stringify([...victims,...reference].map(r=>r.id))),sourceHash,C:[],D:[],baseline:[],started:new Date().toISOString()};
assert.equal(result.sourceHash,sourceHash);result.complete=false;
const portIndexes=new WeakMap<Snapshot,{esc:Map<string,number>;tags:Map<string,number[]>}>();
function observedHits(query:QueryView,snapshot:Snapshot){
 if(query.model!=='C-port')return queryHits(query,snapshot);
 let ix=portIndexes.get(snapshot);if(!ix){const tags=new Map<string,number[]>();snapshot.rows.forEach((r,i)=>r.tags.forEach(t=>{const a=tags.get(t)??[];a.push(i);tags.set(t,a);}));ix={esc:new Map(snapshot.esc.map(e=>[e.id,e.n!])),tags};portIndexes.set(snapshot,ix);}
 const key=Buffer.from(query.keys[0],'hex'),n=ix.esc.get(portEscId(key))??0,hits=new Set<number>();for(let j=1;j<=n;j++)for(const i of ix.tags.get(portTag(key,j))??[])hits.add(i);return [...hits].sort((a,b)=>a-b);
}
const asShape=(r:RowView):Shape=>({tags:r.tagCount,bytes:r.cipherBytes});
function metric(truth:string[],predictions:(string|undefined)[],supported:number[]){return score(supported.map(i=>truth[i]),supported.map(i=>predictions[i]));}
function queryShape(reference:string[],observations:Observation[],views:RowView[],shapeOf:(v:string)=>Shape,accepts:(v:string,q:string)=>boolean){
 const prior=shapeAttack(reference,shapeOf,[],norm),frequency=counts(reference),lookup=new Map<string,string>();
 const sig=(v:string)=>{let mask=0n;observations.forEach((o,i)=>{if(o.label!==undefined&&accepts(v,o.label))mask|=1n<<BigInt(i);});return mask.toString(16);};
 for(const [v]of [...frequency].sort((a,b)=>b[1]-a[1])){const key=shapeKey(shapeOf(v))+'/'+sig(v);if(!lookup.has(key))lookup.set(key,v);}
 const masks=Array<bigint>(views.length).fill(0n);observations.forEach((o,i)=>{for(const row of o.hits)masks[row]|=1n<<BigInt(i);});
 return views.map((v,i)=>lookup.get(shapeKey(asShape(v))+'/'+masks[i].toString(16))??prior.predictReference(asShape(v)));
}
async function runOne(field:typeof fields[number],options:Options,doC=true){
 const truth=victims.map(r=>norm(r[field])),ref=reference.map(r=>norm(r[field])),encoder=createOccurrenceModel(options),shapeOf=(v:string)=>{const s=publicRowShape(options,v);return {tags:s.tagCount,bytes:s.cipherBytes};};
 victims.forEach((r,i)=>encoder.insert(r.id,truth[i]));console.log('encoded',field,options.id,options.mode);
 const before=encoder.snapshot(),supported=before.rows.flatMap((r,i)=>r.supported?[i]:[]),validRef=ref.filter(v=>publicRowShape(options,v).supported);
 const meta={...before.metadata,rows:before.rows.length,supportedRows:supported.length,excludedRows:before.rows.length-supported.length,totalTags:before.rows.reduce((n,r)=>n+r.tags.length,0)};
 for(const mode of options.id==='C-port'?['eq','partial']:options.mode==='eq'?['eq']:['partial']){
  const old=JSON.parse(readFileSync(`${OLD}/observed-${field}-S0-${mode}.json`,'utf8')),observations:Observation[]=[],payloads:any[]=[],unsupportedQueries:string[]=[];
  for(const q of [...new Set<string>(old.observedQueries)]){const query=encoder.query(q,mode==='eq'?'eq':'contains');if(query.unsupported){unsupportedQueries.push(q);continue;}
   const hits=observedHits(query,before),expected=truth.flatMap((v,i)=>before.rows[i].supported&&(mode==='eq'?v===q:v.includes(q))?[i]:[]);assert.deepEqual(hits,expected);
   observations.push({opaque:query.keys.join('/'),label:q,hits});payloads.push(query);
  }
  const accepts=(v:string,q:string)=>mode==='eq'?v===q:v.includes(q),dictionary=mode==='eq'?ref:[...new Set(reference.flatMap(r=>(r[field].match(/[\p{L}\p{N}]+/gu)??[]).map(norm).filter(q=>q.length>=3&&q.length<=10)))];
  const known=observationGuesses(validRef,truth.length,observations,accepts),unknownObs=inferQueryLabels(validRef,observations.map(({opaque,hits})=>({opaque,hits})),dictionary,accepts,mode==='eq'?counts(validRef):undefined),unknown=observationGuesses(validRef,truth.length,unknownObs,accepts);
  const knownShape=queryShape(validRef,observations,before.rows,shapeOf,accepts),unknownShape=queryShape(validRef,unknownObs,before.rows,shapeOf,accepts);
  let graph:ReturnType<ReturnType<typeof queryPhonePredictor>>[]|undefined,assembled:string[]|undefined;
  if(field==='phone'&&mode==='partial'){const predict=queryPhonePredictor(validRef,observations,truth.length,20000,(candidate,row)=>shapeKey(shapeOf(candidate))===shapeKey(asShape(before.rows[row]))),masks=Array<bigint>(truth.length).fill(0n),cache=new Map<string,ReturnType<typeof predict>>();observations.forEach((o,j)=>o.hits.forEach(i=>masks[i]|=1n<<BigInt(j)));graph=truth.map((_,i)=>{const key=masks[i].toString(16)+'/'+shapeKey(asShape(before.rows[i]));if(!cache.has(key))cache.set(key,predict(i));return cache.get(key)!;});assembled=graph.map((g,i)=>g.value??knownShape[i]);}
  const metrics={known:metric(truth,known,supported),unknown:metric(truth,unknown,supported),knownShape:metric(truth,knownShape,supported),unknownShape:metric(truth,unknownShape,supported),...(assembled?{assembled:metric(truth,assembled,supported)}:{})};
  const current=Object.fromEntries(Object.entries(old.predictions).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,metric(truth,v as string[],supported)]));
  const row={field,model:options.id,mode,fieldObservations:old.fieldObservations,distinctQueries:observations.length,unsupportedQueries,supportedRows:supported.length,metrics,current,phone:graph?{single:graph.filter(g=>g.value!==undefined).length,capped:graph.filter(g=>g.capped).length,ambiguous:graph.filter(g=>g.solutions===2).length,maxStates:Math.max(...graph.map(g=>g.states))}:undefined};
  save(`observed-${field}-${options.id}-${mode}`,{...row,observedQueries:old.observedQueries,observations,payloads,unknownAssignedLabels:unknownObs.map(o=>o.label),predictions:{known,unknown,knownShape,unknownShape,assembled},graph,supported,metadata:meta});result.D.push(row);save('results',result);console.log('D',field,options.id,mode,JSON.stringify(metrics));
 }
 if(doC){
  const probes=shuffled(ref,108029).slice(0,1000),probeViews:RowView[]=[];
  for(let i=0;i<1000;i++){probeViews.push(encoder.insert('chosen-'+i,probes[i]));if(i!==99&&i!==999)continue;
   const N=i+1,after=encoder.snapshot(),compacted=encoder.snapshot(true);assert.deepEqual(after.rows,compacted.rows);
   const attack=shapeAttack(validRef,shapeOf,probeViews.flatMap((v,j)=>v.supported?[{value:probes[j],shape:asShape(v)}]:[]),norm),prior=before.rows.map(v=>attack.predictReference(asShape(v))),known=before.rows.map(v=>attack.predictKnown(asShape(v)));
   const learnedTokens=new Set(probeViews.flatMap(v=>v.tags)),sharedRows=before.rows.filter(v=>v.tags.some(t=>learnedTokens.has(t))).length;
   const delta=counterDelta(before.esc,after.esc),labels=learnBatchCounterLabels(delta.deltas,probes.slice(0,N).map(encoder.pieces)),uniqueLabels=labels.filter(x=>x.candidates.length===1);
   const correctLabels=options.id==='C-port'?uniqueLabels.filter(x=>portEscId(portToken(field,x.candidates[0]))===x.id).length:undefined;
   let graph:any[]|undefined,assembled:string[]|undefined;
   if(field==='phone'){const cache=new Map<string,any>(),predict=queryPhonePredictor(validRef,[],truth.length,20000,(candidate,row)=>shapeKey(shapeOf(candidate))===shapeKey(asShape(before.rows[row])));graph=before.rows.map((v,i)=>{const key=shapeKey(asShape(v));if(!cache.has(key))cache.set(key,predict(i));return cache.get(key);});assembled=graph.map((g,i)=>g.value??known[i]);}
   const metrics={referenceShape:metric(truth,prior,supported),knownShape:metric(truth,known,supported),...(assembled?{assembled:metric(truth,assembled,supported)}:{})};
   const old=JSON.parse(readFileSync(`${OLD}/chosen-${field}-S0-${N}.json`,'utf8')),current=metric(truth,old.predictions,supported);
   const row={field,model:options.id,N,supportedRows:supported.length,unsupportedProbes:probeViews.filter(v=>!v.supported).length,metrics,current,sharedVictimRows:sharedRows,
    twoSnapshots:{newEsc:delta.added.length,removedEsc:delta.removed.length,changedPlainCounters:delta.changed.length,uniqueInferredLabels:uniqueLabels.length,correctLabels,associationWithVictimRows:'No ESC-to-document join is present in two endpoint snapshots'},
    compaction:{beforeEsc:after.esc.length,afterEsc:compacted.esc.length,ecocBefore:after.metadata.ecocRows??null,ecocAfter:compacted.metadata.ecocRows??null,documentViewsIdentical:true},phone:graph?{single:graph.filter(g=>g.value!==undefined).length,capped:graph.filter(g=>g.capped).length,maxStates:Math.max(...graph.map(g=>g.states))}:undefined};
   save(`chosen-${field}-${options.id}-${N}`,{...row,predictions:{referenceShape:prior,knownShape:known,assembled},graph,supported,metadata:meta,snapshotSample:{victims:before.rows.slice(0,3),probes:probeViews.slice(0,3),escBefore:before.esc.slice(0,12),escAfter:after.esc.slice(0,12),escCompacted:compacted.esc.slice(0,12)},counterLabels:uniqueLabels.slice(0,100)});result.C.push(row);save('results',result);console.log('C',field,options.id,N,JSON.stringify(metrics));
  }
 }
}
for(const field of ['phone',...fields.filter(f=>f!=='phone')] as typeof fields[number][]){if(onlyField&&onlyField!==field)continue;
 for(const options of [{id:'C-port',field,mode:'combined'},{id:'C-mongo',field,mode:'partial'},{id:'C-mongo',field,mode:'eq'}] as Options[]){if(onlyModel&&onlyModel!==options.id)continue;const dExpected=options.id==='C-port'?2:1;if(result.D.filter((r:any)=>r.field===field&&r.model===options.id&&(options.id==='C-port'||r.mode===options.mode)).length===dExpected&&(options.mode==='eq'||result.C.filter((r:any)=>r.field===field&&r.model===options.id).length===2))continue;await runOne(field,options,options.mode!=='eq');global.gc?.();}
}
assert.equal(hash('sha256',readFileSync('bench/mongo-reeval/models.ts')),sourceHash,'Model changed during run');result.complete=true;result.finished=new Date().toISOString();save('results',result);console.log('COMPLETE C/D');

import {mkdirSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {rows,fields,norm,rng,shuffled,makeModels,validateProduct,assert,type Model} from './models.js';
import {dictionaryPredictor,score,type PublicModel} from './attacks.js';
import {completedPhonePredictor as phonePredictor} from './completed-phone.js';
export const OUT='bench/results/2026-09-30-competitor-sim/r9-impl';
mkdirSync(OUT,{recursive:true});
const save=(name:string,data:unknown)=>writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');
const data=rows(),victims=data.slice(0,10000),reference=data.slice(10000,20000);
const result:any={complete:false,databaseAccess:false,seed:108029,victimRows:10000,referenceRows:10000,identityDigest:hash('sha256',JSON.stringify([...victims,...reference].map(r=>r.id))),models:[],results:[],baselines:[],productChecks:0};
for(const field of fields){
 const truth=victims.map(r=>norm(r[field])),ref=reference.map(r=>norm(r[field])),probes=shuffled(ref,108029).slice(0,1000),random=rng(108029),distinct=[...new Set(ref)];
 result.baselines.push({field,empirical:score(truth,truth.map(()=>ref[Math.floor(random()*ref.length)])),uniform:score(truth,truth.map(()=>distinct[Math.floor(random()*distinct.length)]))});
 for(const model of makeModels(field,ref)){
  result.models.push({field,id:model.id,...model.metadata});if(model.id==='S0')result.productChecks+=await validateProduct(model,ref.slice(0,10));
  const views=truth.map(model.tokens),allProbeViews=probes.map(model.tokens);
  const pub:PublicModel={id:model.id,kind:model.kind,field:model.field,pieces:model.pieces,queryPieces:model.queryPieces};
  for(const N of [100,1000]){
   const predictor=dictionaryPredictor(pub,ref,probes.slice(0,N),allProbeViews.slice(0,N));
   const base=views.map(view=>predictor.predict(view));
   const phone=field==='phone'&&model.kind!=='exact'?phonePredictor(pub,ref,probes.slice(0,N),allProbeViews.slice(0,N)):undefined;
   const graph=phone?views.map(view=>phone.predict(view)):undefined;
   const guesses=base.map((g,i)=>graph?.[i].value??g.value);
   const row={field,model:model.id,N,base:score(truth,base.map(g=>g.value)),strongest:score(truth,guesses),phone:phone?{...phone.metadata,returned:graph!.filter(g=>g.value!==undefined).length,capped:graph!.filter(g=>g.capped).length}:undefined,learnedLabels:predictor.learned.labels.size};
   // Evaluator-only checks. They do not alter hypotheses or predictions.
   const mappedCorrect=[...predictor.learned.labels].filter(([t,p])=>model.token(p).includes(t)).length;
   result.results.push({...row,mappedCorrect});
   save(`chosen-${field}-${model.id}-${N}`,{...row,probeIndices:shuffled(Array.from({length:ref.length},(_,i)=>i),108029).slice(0,N),predictions:guesses,basePredictions:base.map(g=>g.value),methods:base.map(g=>g.method),graph:graph?.map(g=>({value:g.value,solutions:g.solutions,states:g.states,capped:g.capped}))});
   save('chosen',result);console.log(JSON.stringify(row));
  }
 }
}
result.complete=true;save('chosen',result);console.log('COMPLETE C');

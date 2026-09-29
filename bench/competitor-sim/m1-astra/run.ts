import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {makeModels,rows,fields,norm,rng,shuffled,assert,validateProduct,type Model} from '../models.js';
import {buildAttacks,type View} from './attacks.js';
import {dictionaryPredictor,phonePredictor,type PublicModel as SharedPublicModel} from '../attacks.js';
const OUT=process.env.OUT_DIR??'bench/results/2026-09-30-competitor-sim/m1-astra';mkdirSync(OUT,{recursive:true});
const data=rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000),sourceHash=hash('sha256',readFileSync('bench/competitor-sim/models.ts'));
const attackSourceHash=hash('sha256',readFileSync('bench/competitor-sim/attacks.ts'));
const result:any={started:new Date().toISOString(),complete:false,databaseAccess:false,fixtureRows:data.length,victims:victim.length,reference:reference.length,identityDigest:hash('sha256',JSON.stringify([...victim,...reference].map(r=>r.id))),modelSourceHash:sourceHash,seed:714029,models:[],results:[],baselines:[],validation:{productTokenRows:0},protocol:'A: reference-only; B: first 100/500 shuffled victim plaintexts revealed and excluded from scoring. All predictions use public pieces, reference/known values and index views only. Target=common compact normalized value.',channels:{index:'Only deterministic index tokens/bits',shared_bytes:'Index + original plaintext UTF-8 byte length given equally as a controlled sensitivity; vendor ciphertext envelopes not reproduced',s0_native:'S0 index + actual original byte length + compact character length; proof permutations not exploited'},limitations:['Structural external models, not SDK interoperability or product attack','No random-query/root oracle in predictors','One fixed synthetic fixture and key','Best-family score is a post hoc maximum of named complete attacks, never per-row oracle voting']};
type Metric={rows:number;correct:number;rawCorrect:number;characters:number;characterTotal:number;mostly:number};
const blank=():Metric=>({rows:0,correct:0,rawCorrect:0,characters:0,characterTotal:0,mostly:0});
function score(m:Metric,value:string,guess:string){const t=norm(value),g=norm(guess),cs=Array.from(t),gs=Array.from(g),correct=cs.filter((c,i)=>gs[i]===c).length;m.rows++;m.correct+=Number(t===g);m.rawCorrect+=Number(value===guess);m.characters+=correct;m.characterTotal+=cs.length;m.mostly+=Number(correct>=.8*cs.length);}
function save(){writeFileSync(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');}
result.attackSourceHash=attackSourceHash;
result.phoneSamples=[];
for(const [fi,field]of fields.entries()){
 if(process.env.ONLY_FIELD&&process.env.ONLY_FIELD!==field)continue;
 if(process.env.SKIP_FIELD===field)continue;
 const truth=victim.map(r=>r[field]),ref=reference.map(r=>r[field]),random=rng(714029+fi),uniform=rng(814029+fi),distinct=[...new Set(ref)];
 const baselinePred={random_empirical:truth.map(()=>ref[Math.floor(random()*ref.length)]),random_distinct:truth.map(()=>distinct[Math.floor(uniform()*distinct.length)])};
 for(const known of [0,100,500])for(const [method,pred]of Object.entries(baselinePred)){const m=blank();for(let i=known;i<truth.length;i++)score(m,truth[i],pred[i]);result.baselines.push({field,known,method,...m,pct:m.correct/m.rows*100});}
 const models=makeModels(field,ref);
 assert.equal(models.find(m=>m.id==='CipherSweet-FIPS-fast')!.metadata.bits,8,'Wait for the shared model to match the approved 8-bit contract');
 for(const model of models){
  if(process.env.ONLY_MODEL&&process.env.ONLY_MODEL!==model.id)continue;
  const featuresCache=new Map<string,string[]>(),publicModel={features:(v:string)=>{let ps=featuresCache.get(v);if(!ps){ps=model.pieces(v);featuresCache.set(v,ps);}return ps;},multiplicity:model.kind==='bloom'?Number(model.metadata.k):1,...(model.kind==='bloom'?{bloomBits:Number(model.metadata.m)}:{})};
  const baseViews:View[]=truth.map(value=>({tokens:model.tokens(value)}));
  if(model.id==='S0')result.validation.productTokenRows+=await validateProduct(model,truth.slice(0,5));
  result.models.push({field,id:model.id,kind:model.kind,metadata:model.metadata});
  for(const knownCount of [0,100,500]){
   const known=truth.slice(0,knownCount).map((value,i)=>({value,view:baseViews[i]})),attacks=buildAttacks(publicModel,ref,baseViews,known),methods=Object.entries(attacks.predict).filter(([method])=>knownCount>0||method.endsWith('frequency'));
   const sharedPublic:SharedPublicModel={id:model.id,kind:model.kind,field:model.field,pieces:model.pieces,queryPieces:model.queryPieces};
   const shared=knownCount?dictionaryPredictor(sharedPublic,ref,known.map(k=>k.value),known.map(k=>k.view.tokens)):undefined;
   if(shared)methods.push(['shared_known_dictionary',(v:View)=>shared.predict(v.tokens).value]);
   const phone=knownCount&&field==='phone'&&model.kind!=='exact'?phonePredictor(sharedPublic,ref,known.map(k=>k.value),known.map(k=>k.view.tokens),model.kind==='bloom'?20000:2000000):undefined;
   let graphMetadata:unknown;
   if(phone&&model.kind!=='bloom'){const graph=new Map(baseViews.slice(knownCount).map(v=>[v.tokens.join(','),phone.predict(v.tokens)]));graphMetadata={...phone.metadata,views:graph.size,returned:[...graph.values()].filter(g=>g.value!==undefined).length,capped:[...graph.values()].filter(g=>g.capped).length};methods.push(['shared_collision_phone',(v:View)=>graph.get(v.tokens.join(','))?.value??shared!.predict(v.tokens).value]);}
   if(phone&&model.kind==='bloom'){
    const sampleSeed=930500,indices=shuffled(Array.from({length:truth.length-knownCount},(_,i)=>i+knownCount),sampleSeed).slice(0,500),metric=blank(),predictions:any[]=[];let capped=0,returned=0;
    for(const index of indices){const g=phone.predict(baseViews[index].tokens),predicted=g.value??shared!.predict(baseViews[index].tokens).value;score(metric,truth[index],predicted);capped+=Number(g.capped);returned+=Number(g.value!==undefined);predictions.push({index,id:victim[index].id,predicted,correct:norm(predicted)===norm(truth[index]),states:g.states,capped:g.capped,solutions:g.solutions,graphReturned:g.value!==undefined});if(predictions.length%100===0)console.log(JSON.stringify({sample:model.id,known:knownCount,done:predictions.length,capped}));}
    const z=1.959963984540054,n=metric.rows,p=metric.correct/n,den=1+z*z/n,center=(p+z*z/(2*n))/den,radius=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
    result.phoneSamples.push({field,model:model.id,known:knownCount,channel:'index',method:'shared_collision_phone_sample',sampleSeed,population:truth.length-knownCount,...metric,pct:p*100,wilson95:[Math.max(0,(center-radius)*100),Math.min(100,(center+radius)*100)],capped,returned,graphMetadata:{...phone.metadata,maxStates:20000},predictions});save();
   }
   const validation={learned:attacks.learned.size,fullyCorrect:[...attacks.learned].filter(([piece,tokens])=>JSON.stringify([...model.token(piece)].sort())===JSON.stringify([...tokens].sort())).length};
   // Secret token() is used above only to evaluate learned mapping precision;
   // neither the learned map nor any prediction is modified using that answer.
   for(const channel of model.id==='S0'?['index','shared_bytes','s0_native']:['index','shared_bytes']){
    const views=baseViews.map((v,i)=>({...v,...(channel!=='index'?{bytes:Buffer.byteLength(truth[i])}:{}),...(channel==='s0_native'?{length:Array.from(norm(truth[i])).length}:{})}));
    for(const [method,predict]of methods){const metric=blank(),predictions:string[]=[],witnesses:any[]=[],sample=rng(9917),indices=new Set([knownCount,Math.floor((knownCount+truth.length)/2),truth.length-1,...Array.from({length:9},()=>knownCount+Math.floor(sample()*(truth.length-knownCount)))]),cache=new Map<string,string>();
     for(let i=knownCount;i<truth.length;i++){const view=views[i],cacheId=JSON.stringify([view.tokens,view.bytes,view.length]);let guess=cache.get(cacheId);if(guess===undefined){guess=predict(view);cache.set(cacheId,guess);}score(metric,truth[i],guess);predictions.push(guess);if(indices.has(i))witnesses.push({index:i,id:victim[i].id,predicted:guess,correct:norm(guess)===norm(truth[i])});}
     result.results.push({field,model:model.id,known:knownCount,channel,method,...metric,pct:metric.correct/metric.rows*100,characterPct:metric.characters/metric.characterTotal*100,metadata:attacks.metadata,mappingValidation:validation,...(method==='shared_collision_phone'?{graphMetadata}:{}),predictionDigest:hash('sha256',JSON.stringify(predictions)),witnesses});
    }
   }
  }
  save();console.log(JSON.stringify({field,model:model.id,done:result.results.length,index:result.results.filter((r:any)=>r.field===field&&r.model===model.id&&r.channel==='index').map((r:any)=>({known:r.known,method:r.method,pct:r.pct}))}));
 }
}
assert.equal(hash('sha256',readFileSync('bench/competitor-sim/models.ts')),sourceHash,'Model changed during the run');assert.equal(hash('sha256',readFileSync('bench/competitor-sim/attacks.ts')),attackSourceHash,'Shared attack changed during the run');result.complete=true;result.scope={field:process.env.ONLY_FIELD??'all',model:process.env.ONLY_MODEL??'all'};result.finished=new Date().toISOString();save();console.log('COMPLETE A/B memory attack comparison');

import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {makeModels,rows,fields,norm,shuffled,assert,validateProduct} from '../../../../competitor-sim/models.js';
import {buildAttacks,type View} from '../../../../competitor-sim/m1-astra/attacks.js';
import {dictionaryPredictor,phonePredictor} from '../../../../competitor-sim/attacks.js';
const root='bench/results/2026-09-30-competitor-sim/m1-astra/low-known',field=process.argv[2] as typeof fields[number];assert.ok(fields.includes(field));mkdirSync(root,{recursive:true});
const data=rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000),truth=victim.map(r=>r[field]),ref=reference.map(r=>r[field]),model=makeModels(field,ref).find(m=>m.id==='S0')!;
const sources=['bench/competitor-sim/models.ts','bench/competitor-sim/attacks.ts','bench/competitor-sim/m1-astra/attacks.ts'],sourceHashes=Object.fromEntries(sources.map(p=>[p,hash('sha256',readFileSync(p))]));
const views:View[]=truth.map(value=>({tokens:model.tokens(value)})),cache=new Map<string,string[]>(),publicModel={features:(v:string)=>{let p=cache.get(v);if(!p){p=model.pieces(v);cache.set(v,p);}return p;},multiplicity:1};
const result:any={complete:false,databaseAccess:false,field,model:'S0',channel:'index',started:new Date().toISOString(),fixtureSeed:714029,knownSeeds:[930501,930502,930503],phoneSampleSeed:930500,modelMetadata:model.metadata,sourceHashes,identityDigest:hash('sha256',JSON.stringify([...victim,...reference].map(r=>r.id))),productTokenChecks:await validateProduct(model,truth.slice(0,5)),cases:[]};
const suffix=field==='phone'&&process.env.PHONE_SKIP_GRAPH?'-baseline':process.env.ONLY_KNOWN_SEED?'-'+process.env.ONLY_KNOWN_SEED:'';
const save=()=>writeFileSync(`${root}/${field}${suffix}.json`,JSON.stringify(result,null,2)+'\n');
function metric(indices:number[],pred:string[]){let correct=0,characters=0,totalCharacters=0;for(let j=0;j<indices.length;j++){const t=Array.from(norm(truth[indices[j]])),p=Array.from(norm(pred[j]));correct+=Number(t.join('')===p.join(''));characters+=t.filter((c,i)=>p[i]===c).length;totalCharacters+=t.length;}const sample=new Set(shuffled(indices,9917).slice(0,12));return {rows:indices.length,correct,pct:100*correct/indices.length,characterPct:100*characters/totalCharacters,predictionDigest:hash('sha256',JSON.stringify(pred)),witnesses:indices.flatMap((i,j)=>sample.has(i)?[{index:i,id:victim[i].id,predicted:pred[j],correct:norm(pred[j])===norm(truth[i])}]:[])};}
for(const knownSeed of result.knownSeeds){if(process.env.ONLY_KNOWN_SEED&&knownSeed!==Number(process.env.ONLY_KNOWN_SEED))continue;const permutation=shuffled(Array.from({length:10000},(_,i)=>i),knownSeed);
 for(const knownCount of [1,3,10,30]){const knownIndices=permutation.slice(0,knownCount),ks=new Set(knownIndices),indices=Array.from({length:10000},(_,i)=>i).filter(i=>!ks.has(i));
  const known=knownIndices.map(i=>({value:truth[i],view:views[i]})),family=buildAttacks(publicModel,ref,views,known),shared=dictionaryPredictor(model,ref,known.map(k=>k.value),known.map(k=>k.view.tokens));
  const methods:any[]=[];for(const [method,predict]of [...Object.entries(family.predict),['shared_known_dictionary',(v:View)=>shared.predict(v.tokens).value]] as [string,(v:View)=>string][]){const predictions=indices.map(i=>predict(views[i]));methods.push({method,...metric(indices,predictions)});}
  const c:any={knownSeed,known:knownCount,knownPercent:knownCount/100,knownIndices,knownIds:knownIndices.map(i=>victim[i].id),population:indices.length,methods};
  if(field==='phone'&&!process.env.PHONE_SKIP_GRAPH){
   const maxStates=Number(process.env.PHONE_MAX_STATES??2000000),sampleSize=Number(process.env.PHONE_SAMPLE??10000),selected=sampleSize>=indices.length?indices:shuffled(indices,result.phoneSampleSeed).slice(0,sampleSize),phone=phonePredictor(model,ref,known.map(k=>k.value),known.map(k=>k.view.tokens),maxStates)!;
   const predictions:string[]=[],records:any[]=[];for(const i of selected){const g=phone.predict(views[i].tokens),predicted=g.value??shared.predict(views[i].tokens).value;predictions.push(predicted);records.push({index:i,id:victim[i].id,predicted,correct:norm(predicted)===norm(truth[i]),...g,value:undefined,graphReturned:g.value!==undefined});if(records.length%100===0)console.log(JSON.stringify({field,knownSeed,known:knownCount,phoneRows:records.length}));}
   const m=metric(selected,predictions),n=m.rows,p=m.correct/n,z=1.959963984540054,den=1+z*z/n,center=(p+z*z/(2*n))/den,radius=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
   c.phone={method:'shared_collision_phone',maxStates,sampleSeed:result.phoneSampleSeed,population:indices.length,...m,wilson95:[Math.max(0,center-radius)*100,Math.min(1,center+radius)*100],capped:records.filter(r=>r.capped).length,returned:records.filter(r=>r.graphReturned).length,metadata:phone.metadata,predictions:records};
  }
  result.cases.push(c);save();console.log(JSON.stringify({field,knownSeed,known:knownCount,best:Math.max(...methods.map(m=>m.pct)),phone:c.phone?.pct,capped:c.phone?.capped}));
 }
}
for(const p of sources)assert.equal(hash('sha256',readFileSync(p)),sourceHashes[p]);result.complete=true;result.finished=new Date().toISOString();save();console.log('COMPLETE '+field);

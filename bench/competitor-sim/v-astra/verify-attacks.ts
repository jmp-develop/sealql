/** Reviewer replay and independent scoring. Memory only; never connects to DB. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {rows,fields,makeModels,norm,shuffled,type Model} from '../models.js';
import {buildAttacks,type View} from '../m1-astra/attacks.js';
import {dictionaryPredictor,type PublicModel} from '../attacks.js';
import {completedPhonePredictor as phonePredictor} from '../completed-phone.js';
const root='bench/results/2026-09-30-competitor-sim',hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const read=(p:string)=>JSON.parse(readFileSync(`${root}/${p}`,'utf8'));
const sourceHash=hash(readFileSync('bench/competitor-sim/models.ts','utf8')),attackSourceHash=hash(readFileSync('bench/competitor-sim/attacks.ts','utf8'));
const data=rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000);
const result:any={started:new Date().toISOString(),complete:false,databaseAccess:false,modelsSourceHash:sourceHash,attackSourceHash,identityDigest:hash(JSON.stringify(data.slice(0,20000).map(r=>r.id))),ab:[],c:[],errors:[]};
function independentScore(truth:string[],pred:(string|undefined)[]){assert.equal(pred.length,truth.length);let correct=0,characters=0,totalCharacters=0,mostly=0;for(let i=0;i<truth.length;i++){const t=Array.from(norm(truth[i])),g=Array.from(norm(pred[i]??'')),hits=t.filter((c,j)=>c===g[j]).length;correct+=Number(t.join('')===g.join(''));characters+=hits;totalCharacters+=t.length;mostly+=Number(hits>=.8*t.length);}return {rows:truth.length,correct,characters,totalCharacters,mostly};}
const mode=process.argv[2]??process.env.REVIEW_MODE??'AB';
try{
 const ab=mode==='AB'?read('m1-astra/results.json'):undefined;
 if(ab){assert.equal(ab.complete,true);assert.equal(ab.identityDigest,result.identityDigest);assert.equal(ab.modelSourceHash,sourceHash);assert.equal(ab.attackSourceHash,attackSourceHash);}
 const chosen=mode==='C'?read('r9-impl/chosen.json'):undefined;
 if(chosen){assert.equal(chosen.complete,true);assert.equal(chosen.identityDigest,result.identityDigest);}
 for(const field of fields){const truth=victim.map(r=>r[field]),ref=reference.map(r=>r[field]);
  for(const model of makeModels(field,ref)){
   const views=truth.map(v=>({tokens:model.tokens(v)})),pub:PublicModel={id:model.id,kind:model.kind,field,pieces:model.pieces,queryPieces:model.queryPieces};
   if(ab)for(const known of [0,100,500]){
    const relevant=ab.results.filter((r:any)=>r.field===field&&r.model===model.id&&r.known===known);assert.ok(relevant.length>0);
    const publicModel={features:model.pieces,multiplicity:model.kind==='bloom'?Number(model.metadata.k):1,...(model.kind==='bloom'?{bloomBits:Number(model.metadata.m)}:{})};
    const knownRows=truth.slice(0,known).map((value,i)=>({value,view:views[i]})),attack=buildAttacks(publicModel,ref,views,knownRows);
    const shared=known?dictionaryPredictor(pub,ref,truth.slice(0,known),views.slice(0,known).map(v=>v.tokens)):undefined;
    const phone=known&&field==='phone'&&model.kind!=='exact'?phonePredictor(pub,ref,truth.slice(0,known),views.slice(0,known).map(v=>v.tokens)):undefined;
    for(const row of relevant){assert.equal(row.rows,10000-known);assert.equal(row.pct,row.correct/row.rows*100);assert.equal(row.characterPct,row.characters/row.characterTotal*100);
     for(const w of row.witnesses){assert.ok(w.index>=known&&w.index<10000);assert.equal(w.id,victim[w.index].id);assert.equal(w.correct,norm(w.predicted)===norm(truth[w.index]));
      const view:View={...views[w.index],...(row.channel!=='index'?{bytes:Buffer.byteLength(truth[w.index])}:{}),...(row.channel==='s0_native'?{length:Array.from(norm(truth[w.index])).length}:{})};
      const predicted=row.method==='shared_known_dictionary'?shared!.predict(view.tokens).value:row.method==='shared_collision_phone'?(phone!.predict(view.tokens).value??shared!.predict(view.tokens).value):(attack.predict as any)[row.method](view);
      assert.equal(predicted,w.predicted,`${field}/${model.id}/${known}/${row.channel}/${row.method}/${w.index}`);
     }
     result.ab.push({field,model:model.id,known,channel:row.channel,method:row.method,witnessChecks:row.witnesses.length,denominator:row.rows});
    }
   }
   if(chosen)for(const N of [100,1000]){
    const file=`r9-impl/chosen-${field}-${model.id}-${N}.json`,saved=read(file),probes=shuffled(ref.map(norm),108029).slice(0,N),pv=probes.map(model.tokens),predictor=dictionaryPredictor(pub,ref.map(norm),probes,pv);
    const phone=field==='phone'&&model.kind!=='exact'?phonePredictor(pub,ref.map(norm),probes,pv):undefined;
    for(const [metric,pred]of [[saved.strongest,saved.predictions],[saved.base,saved.basePredictions]] as const){const independent=independentScore(truth,pred);for(const k of Object.keys(independent))assert.equal(metric[k],(independent as any)[k],`${file}/${k}`);assert.ok(Math.abs(metric.valuePct-independent.correct/100)<1e-10);}
    let checks=0;for(const i of [19,423,1681,3157,4499,5881,7057,8913,9999]){const b=predictor.predict(views[i].tokens).value,g=phone?.predict(views[i].tokens).value??b;assert.equal(b,saved.basePredictions[i]);assert.equal(g,saved.predictions[i]);checks++;}
    const summary=chosen.results.find((r:any)=>r.field===field&&r.model===model.id&&r.N===N);assert.deepEqual(summary.strongest,saved.strongest);
    result.c.push({field,model:model.id,N,scoreChecks:20000,replayChecks:checks,fileHash:hash(readFileSync(`${root}/${file}`,'utf8'))});
   }
   console.log(`${mode} verified ${field}/${model.id}`);
  }
 }
 assert.equal(hash(readFileSync('bench/competitor-sim/models.ts','utf8')),sourceHash);assert.equal(hash(readFileSync('bench/competitor-sim/attacks.ts','utf8')),attackSourceHash);result.complete=true;
}catch(e){result.errors.push(String(e));throw e;}finally{result.finished=new Date().toISOString();writeFileSync(`${root}/v-astra/verify-attacks-${mode.toLowerCase()}.json`,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({complete:true,ab:result.ab.length,c:result.c.length}));

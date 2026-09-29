/** Independent score reconstruction for two-endpoint shape attacks; no DB. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {rows,fields,norm,shuffled,publicRowShape,type Options} from '../models.js';
const ROOT='bench/results/2026-09-30-mongo-reeval',data=rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000),probes=shuffled(reference,108029),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const out:any={complete:false,started:new Date().toISOString(),files:[],cases:0,predictionsRescored:0,witnesses:0,errors:[],limitations:'Independently replays endpoint shape predictions and scores; opaque ESC/tag delta aggregate integrity is source-reviewed, not rebuilt from all ciphertexts.'};
try{
 const files=readdirSync(ROOT+'/m1-astra').filter(x=>x.startsWith('delta-')&&x.endsWith('.json'));if(!process.argv.includes('--partial'))assert.equal(files.length,12);out.partial=files.length!==12;
 for(const file of files){const raw=readFileSync(ROOT+'/m1-astra/'+file,'utf8'),x=JSON.parse(raw),o=x.options as Options,field=x.field as typeof fields[number],truth=victim.map(r=>r[field]);assert.equal(x.complete,true);
  const cache=new Map<string,ReturnType<typeof publicRowShape>>(),shape=(v:string)=>{let s=cache.get(v);if(!s){s=publicRowShape(o,v);cache.set(v,s);}return s;},key=(v:string)=>{const s=shape(v);return JSON.stringify([s.tagCount,s.cipherBytes]);};
  const rc=new Map<string,number>();for(const r of reference)if(shape(r[field]).supported)rc.set(r[field],(rc.get(r[field])??0)+1);
  const groups=new Map<string,string[]>();for(const v of rc.keys()){const k=key(v),g=groups.get(k)??[];g.push(v);groups.set(k,g);}const prior=[...rc].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0];
  for(const c of x.cases){const known=probes.slice(0,c.N).map(r=>r[field]).filter(v=>shape(v).supported),kc=new Map<string,number>();for(const v of known)kc.set(v,(kc.get(v)??0)+1);assert.equal(c.knownSupported,known.length);
   const choices=new Map<string,string>();
   for(const [k,g]of groups)for(const useKnown of [true,false])choices.set(k+'/'+useKnown,[...g].sort((a,b)=>(rc.get(b)??0)+(useKnown?(kc.get(b)??0):0)-(rc.get(a)??0)-(useKnown?(kc.get(a)??0):0)||a.localeCompare(b))[0]??prior);
   const index=truth.flatMap((v,i)=>shape(v).supported&&(c.operation==='insert'||i>=c.N)?[i]:[]),choice=(v:string,useKnown:boolean)=>choices.get(key(v)+'/'+useKnown)??prior;
   for(const [label,useKnown]of [['unmodifiedVictims',true],['referenceOnly',false]] as const){const guesses=index.map(i=>choice(truth[i],useKnown)),correct=guesses.filter((p,j)=>norm(p)===norm(truth[index[j]])).length;assert.deepEqual(c[label],{rows:index.length,correct,pct:100*correct/index.length,predictionDigest:hash(JSON.stringify(guesses))});out.predictionsRescored+=index.length;}
   assert.equal(c.knownTargetTagOverlapRows,0);assert.equal(c.unexpectedChangedUntouchedRows,0);if(x.model==='C-mongo'){assert.equal(c.esc.plaintextCountDeltas,0);assert.equal(c.esc.uniqueBatchCounterLabels,0);}for(const w of c.witnesses){assert.equal(w.predicted,choice(truth[w.index],true));assert.equal(w.correct,norm(w.predicted)===norm(truth[w.index]));out.witnesses++;}
   if(c.overwrittenOldValues){const ii=truth.slice(0,c.N).flatMap((v,i)=>shape(v).supported?[i]:[]),g=ii.map(i=>choice(truth[i],false));assert.equal(c.overwrittenOldValues.predictionDigest,hash(JSON.stringify(g)));assert.equal(c.overwrittenOldValues.correct,g.filter((p,j)=>norm(p)===norm(truth[ii[j]])).length);out.predictionsRescored+=ii.length;}
   out.cases++;
  }
  out.files.push({file,sha256:hash(raw),cases:x.cases.length});
 }
 out.complete=true;
}catch(e){out.errors.push(String(e));throw e;}finally{out.finished=new Date().toISOString();writeFileSync(ROOT+'/v-astra/verify-delta.json',JSON.stringify(out,null,2)+'\n');}
console.log(JSON.stringify({complete:out.complete,files:out.files.length,cases:out.cases,predictionsRescored:out.predictionsRescored,witnesses:out.witnesses}));

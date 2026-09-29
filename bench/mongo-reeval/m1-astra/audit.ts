import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import * as m from '../models.js';
const root='bench/results/2026-09-30-mongo-reeval/m1-astra',data=m.rows(),victim=data.slice(0,10000),ref=data.slice(10000,20000);
const files=readdirSync(root).filter(f=>/^(ab|delta)-.*\.json$/.test(f)),best:any[]=[],deltas:any[]=[],phoneCertificates:any[]=[];let witnesses=0,aggregates=0;
const modelHash=hash('sha256',readFileSync('bench/mongo-reeval/models.ts'));
for(const file of files){const x=JSON.parse(readFileSync(`${root}/${file}`,'utf8'));m.assert.equal(x.complete,true);m.assert.equal(x.sourceHash,modelHash);
 m.assert.equal(x.identityDigest,hash('sha256',JSON.stringify([...victim,...ref].map(r=>r.id))));
 const truth=victim.map(r=>r[x.field as typeof m.fields[number]]),supported=truth.map(v=>m.publicRowShape(x.options,v).supported);
 if(file.startsWith('ab-')){
  m.assert.equal(x.uniqueness.crossRowRepeats,0);m.assert.equal(x.results.length,23);
  for(const r of [...x.results,...x.baselines]){m.assert.equal(r.rows,supported.filter((s,i)=>s&&i>=r.known).length);m.assert.equal(r.pct,100*r.correct/r.rows);aggregates++;
   for(const w of r.witnesses??[]){m.assert.equal(w.id,victim[w.index].id);m.assert.ok(w.index>=r.known&&supported[w.index]);m.assert.equal(w.correct,m.norm(w.predicted)===m.norm(truth[w.index]));witnesses++;}
  }
  for(const known of [0,100,500])for(const channel of ['index','native_shape']){const xs=x.results.filter((r:any)=>r.known===known&&r.channel===channel).sort((a:any,b:any)=>b.correct-a.correct);best.push({model:x.model,field:x.field,known,channel,...xs[0],witnesses:undefined,learned:undefined});}
  if(x.field==='phone'){
   const classes=new Map<string,Set<string>>();for(const row of ref){const value=m.norm(row.phone),s=m.publicRowShape(x.options,value),key=JSON.stringify([s.tagCount,s.cipherBytes]),vs=classes.get(key)??new Set<string>();vs.add(value);classes.set(key,vs);}
   const counts=new Map<string,number>();for(const row of victim){const s=m.publicRowShape(x.options,row.phone),key=JSON.stringify([s.tagCount,s.cipherBytes]);counts.set(key,(counts.get(key)??0)+1);}
   const cs=[...counts].map(([shape,rows])=>({shape,rows,referenceDistinct:classes.get(shape)?.size??0,witnesses:[...(classes.get(shape)??[])].slice(0,2)}));
   for(const c of cs)for(const value of c.witnesses){const s=m.publicRowShape(x.options,value);m.assert.equal(JSON.stringify([s.tagCount,s.cipherBytes]),c.shape);}
   phoneCertificates.push({model:x.model,kind:'Two distinct public reference values with equal visible shape; not a full global-ledger consistency proof',rowsWithAtLeastTwoReferenceWitnesses:cs.reduce((n,c)=>n+(c.referenceDistinct>=2?c.rows:0),0),dfsCappedRows:x.phoneShapeGraph.rowsWithCap,classes:cs});
  }
 }else for(const r of x.cases){
  m.assert.equal(r.unexpectedChangedUntouchedRows,0);m.assert.equal(r.knownTargetTagOverlapRows,0);
  if(r.operation==='update')m.assert.equal(r.oldTagsRetainedOnUpdatedRows,0);
  const expected=supported.filter((s,i)=>s&&(r.operation==='insert'||i>=r.N)).length;
  m.assert.equal(r.unmodifiedVictims.rows,expected);m.assert.equal(r.unmodifiedVictims.pct,100*r.unmodifiedVictims.correct/expected);aggregates++;
  for(const w of r.witnesses){m.assert.equal(w.id,victim[w.index].id);m.assert.equal(w.correct,m.norm(w.predicted)===m.norm(truth[w.index]));witnesses++;}
  deltas.push({field:x.field,model:x.model,...r,witnesses:undefined});
 }
}
const paths=['bench/mongo-reeval/models.ts','bench/mongo-reeval/phone.ts','bench/competitor-sim/models.ts','bench/competitor-sim/m1-astra/attacks.ts',...readdirSync('bench/mongo-reeval/m1-astra').filter(f=>f.endsWith('.ts')).map(f=>'bench/mongo-reeval/m1-astra/'+f)];
const output={generated:new Date().toISOString(),complete:files.length===24,files:files.length,expectedFiles:24,passed:true,databaseAccess:false,aggregates,witnesses,fixtureValuesDigest:hash('sha256',JSON.stringify([...victim,...ref])),independentReplay:'v-astra separately verifies public predictions; this audit checks denominators/scoring/invariants and public-reference ambiguity certificates.',sourceHashes:Object.fromEntries(paths.map(p=>[p,hash('sha256',readFileSync(p))])),best,deltas,phoneCertificates};
writeFileSync(`${root}/audit.json`,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({files:files.length,aggregates,witnesses,best:best.map(x=>({field:x.field,model:x.model,known:x.known,channel:x.channel,pct:x.pct})),phone:phoneCertificates.map(x=>({model:x.model,multiple:x.rowsWithAtLeastTwoReferenceWitnesses,capped:x.dfsCappedRows}))}));

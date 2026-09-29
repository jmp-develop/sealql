import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import * as m from '../models.js';
import {occurrenceDictionary} from './strong-dictionary.js';
import {dictionaryPredictor} from '../../competitor-sim/attacks.js';
const root='bench/results/2026-09-30-mongo-reeval/m1-astra',data=m.rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000),results:any[]=[];
let reductionChecks=0;
for(const file of readdirSync(root).filter(f=>f.startsWith('ab-')&&f.endsWith('.json'))){
 const x=JSON.parse(readFileSync(`${root}/${file}`,'utf8'));m.assert.equal(x.uniqueness.crossRowRepeats,0);
 const field=x.field as typeof m.fields[number],truth=victim.map(r=>r[field]),ref=reference.map(r=>r[field]).filter(v=>m.publicRowShape(x.options,v).supported),pieces=(value:string)=>{const v=m.norm(value),real=m.publicPieces(field,v,x.mode);if(x.model==='C-port')return real;const s=m.publicRowShape(x.options,v);return ['e\0'+v,...real,...(s.tagCount>real.length+1?['pad\0'+v]:[])];};
 // Independent canonical comparison on known subsets; symbolic names preserve
 // precisely the singleton incidence relation measured in the full snapshots.
 for(const n of [1,3,10]){const known=truth.slice(0,n),views=known.map((v,i)=>pieces(v).map((_,j)=>`occurrence-${i}-${j}`));const pub={id:'occurrence',kind:'exact',field,pieces,queryPieces:pieces} as any;
  const canonical=dictionaryPredictor(pub,ref,known,views),fast=occurrenceDictionary(ref,known,pieces);m.assert.equal(canonical.predict(['unseen-occurrence']).value,fast.value);reductionChecks++;
 }
 for(const knownCount of [0,100,500]){const known=truth.slice(0,knownCount).filter(v=>m.publicRowShape(x.options,v).supported),p=occurrenceDictionary(ref,known,pieces),indices=truth.flatMap((v,i)=>i>=knownCount&&m.publicRowShape(x.options,v).supported?[i]:[]);
  for(const r of x.results.filter((r:any)=>r.known===knownCount))m.assert.equal(r.sharedKnownTargetRows,0);
  const correct=indices.filter(i=>m.norm(truth[i])===p.value).length;results.push({model:x.model,field,known:knownCount,method:'shared_known_dictionary_occurrence_reduction',...p,correct,rows:indices.length,pct:100*correct/indices.length,predictionDigest:hash('sha256',JSON.stringify(indices.map(()=>p.value)))});
 }
}
const out={complete:results.length===36,databaseAccess:false,reductionChecks,mongoFeatures:'Real queryable substrings plus internal exact and repeated fake value as one incidence piece; multiplicity does not change row incidence',canonicalSourceHash:hash('sha256',readFileSync('bench/competitor-sim/attacks.ts')),modelSourceHash:hash('sha256',readFileSync('bench/mongo-reeval/models.ts')),results};writeFileSync(`${root}/strong-dictionary.json`,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));

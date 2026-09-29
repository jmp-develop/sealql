/** Model-specific strengthening for Bloom: learn gram/bit correspondences from
 * labelled query payloads, then use exactly the C/B phone-format solver. */
import {readFileSync,writeFileSync} from 'node:fs';
import {rows,makeModels,norm} from './models.js';
import {score,type PublicModel} from './attacks.js';
import {completedPhonePredictor as phonePredictor} from './completed-phone.js';
const out='bench/results/2026-09-30-competitor-sim/r9-impl',d=JSON.parse(readFileSync(`${out}/observed-phone-CipherStash-match-partial.json`,'utf8'));
const data=rows(),truth=data.slice(0,10000).map(r=>norm(r.phone)),reference=data.slice(10000,20000).map(r=>norm(r.phone));
const model=makeModels('phone',reference).find(m=>m.kind==='bloom')!,pub:PublicModel={id:model.id,kind:model.kind,field:model.field,pieces:model.pieces,queryPieces:model.queryPieces};
const predict=phonePredictor(pub,reference,d.observations.map((o:any)=>o.label),d.observations.map((o:any)=>o.opaque.split(',')))!;
const graph=truth.map(v=>predict.predict(model.tokens(v))),guesses=graph.map((g,i)=>g.value??d.predictions.known[i]);
const result={field:'phone',model:model.id,mode:'partial',attack:'Known query gram/bit training + common collision-aware phone solver',observations:d.fieldObservations,trainingQueries:d.observations.length,metadata:predict.metadata,metric:score(truth,guesses),predictions:guesses,graph};
writeFileSync(`${out}/observed-phone-CipherStash-match-graph.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,predictions:undefined,graph:undefined}));

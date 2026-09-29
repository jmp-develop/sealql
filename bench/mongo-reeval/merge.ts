/** Merge distinct field files after independent field workers have stopped. */
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {hash} from 'node:crypto';
import {assert} from './models.js';
const OUT='bench/results/2026-09-30-mongo-reeval/r9-impl';
const result=JSON.parse(readFileSync(`${OUT}/results.json`,'utf8'));result.C=[];result.D=[];
assert.equal(result.sourceHash,hash('sha256',readFileSync('bench/mongo-reeval/models.ts')));
for(const name of readdirSync(OUT).sort())if(/^(chosen|observed)-.+\.json$/.test(name)){
 const a=JSON.parse(readFileSync(`${OUT}/${name}`,'utf8'));
 const {predictions,graph,supported,snapshotSample,counterLabels,observations,payloads,observedQueries,unknownAssignedLabels,metadata,...row}=a;
 (name.startsWith('chosen-')?result.C:result.D).push(row);
}
result.complete=result.C.length===24&&result.D.length===24;result.finished=new Date().toISOString();
if(process.argv.includes('--stopped')){result.status='stopped-by-user';result.stopReason='사용자 결정으로 중단, 부분 결과';result.unmeasured={C:24-result.C.length,D:24-result.D.length};}
result.attackHashes=Object.fromEntries(['models.ts','phone.ts','run.ts','m1-astra/shape-attacks.ts'].map(p=>[p,hash('sha256',readFileSync('bench/mongo-reeval/'+p))]));
writeFileSync(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({complete:result.complete,C:result.C.length,D:result.D.length}));

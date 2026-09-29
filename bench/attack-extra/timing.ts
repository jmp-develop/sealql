/** Reanalyse recorded, same-session real API timings; no concurrent DB timing or query access. */
import {readFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {norm,profile} from './codec.js';
import {normalizeLike} from '../../src/core/stamp-query.js';
import {assert,rng,save,shuffled} from './common.js';
const source='bench/results/2026-09-29-final-return/remeasure.json',bytes=readFileSync(source,'utf8'),data=JSON.parse(bytes);
assert.equal(data.complete,true);assert.deepEqual(data.errors,[]);
const canonical=(node:any):string=>{if(node.all)return JSON.stringify({all:node.all.map(canonical).sort()});if(node.any)return JSON.stringify({any:node.any.map(canonical).sort()});let {field,op,value}=node;value=norm(value);if(op==='like'){const simple=normalizeLike(value,profile(field));if(simple&&!simple.whole){op=simple.op;value=simple.value;}}return JSON.stringify({field,op,value});};
const median=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b);return a[Math.floor(a.length/2)];};
const bin=(n:number)=>n===0?0:n<=100?1:n<=1000?2:n<=10000?3:4;
const groups=new Map<string,any[]>();for(const row of data.rows.filter((r:any)=>r.mode==='count')){const key=canonical(row.node),a=groups.get(key)??[];a.push(row);groups.set(key,a);}
const ordered=shuffled([...groups],919029),folds=5,results:any[]=[];
const evaluate=(pairs:{truth:number;prediction:number}[])=>({samples:pairs.length,exactCountPercent:100*pairs.filter(p=>p.truth===p.prediction).length/pairs.length,within20Percent:100*pairs.filter(p=>Math.abs(p.truth-p.prediction)<=Math.max(1,p.truth*.2)).length/pairs.length,binAccuracyPercent:100*pairs.filter(p=>bin(p.truth)===bin(p.prediction)).length/pairs.length,meanAbsoluteError:pairs.reduce((s,p)=>s+Math.abs(p.truth-p.prediction),0)/pairs.length,medianAbsoluteError:median(pairs.map(p=>Math.abs(p.truth-p.prediction)))});
for(const path of ['research','product'])for(const metric of ['totalMs','sqlMs']){
 const predictions:{truth:number;prediction:number}[]=[],randomPairs:{truth:number;prediction:number}[]=[],constantPairs:{truth:number;prediction:number}[]=[],random=rng(190029),details:any[]=[];
 for(let fold=0;fold<folds;fold++){
  const train=ordered.filter((_,i)=>i%folds!==fold).map(([id,rows])=>{assert.ok(rows.every(r=>r.matches===rows[0].matches),'Equivalent predicates must have same count');return {id,count:rows[0].matches as number,time:median(rows.flatMap(r=>r.runs[path].map((m:any)=>m[metric]))) };});
  const test=ordered.filter((_,i)=>i%folds===fold),constant=median(train.map(r=>r.count));
  for(const [id,rows]of test){assert.ok(!train.some(r=>r.id===id));for(const row of rows)for(const run of row.runs[path]){
   // At inference the only input is elapsed time; query labels/counts are held out for evaluation.
   const nearest=[...train].sort((a,b)=>Math.abs(Math.log(a.time)-Math.log(run[metric]))-Math.abs(Math.log(b.time)-Math.log(run[metric]))).slice(0,3),prediction=median(nearest.map(r=>r.count)),truth=row.matches;
   predictions.push({truth,prediction});randomPairs.push({truth,prediction:train[Math.floor(random()*train.length)].count});constantPairs.push({truth,prediction:constant});details.push({fold,case:row.name,elapsedMs:run[metric],truth,prediction});
  }}
 }
 results.push({path,metric,model:'fixed k=3 nearest log-duration, median calibrated count',...evaluate(predictions),randomBaseline:evaluate(randomPairs),constantMedianBaseline:evaluate(constantPairs),details});
}
save('timing',{source,sha256:hash('sha256',bytes),commit:data.commit,session:data.session,sourceFinished:data.finished,queryRows:data.rows.filter((r:any)=>r.mode==='count').length,canonicalQueryGroups:groups.size,folds,calibration:'Attacker knows labelled timing/count calibration for disjoint query groups; test input contains elapsed time only',network:'Local API elapsed time, no network added; sqlMs is a stronger diagnostic observer, not a remote-client measurement',notMeasured:'No latest-build remote timing collection; reuses real recorded single-literal-LIKE-normalized count measurements; no physical WAL capture',results});
console.log(JSON.stringify(results.map(({details,...r})=>r),null,2));

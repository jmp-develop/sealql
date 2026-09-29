/** Re-score stored predictions and validate every phone ambiguity witness.
 * Truth is used here only after the attack, never to construct predictions. */
import {readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {rows,norm,assert,publicRowShape,type Options} from './models.js';
const DIR='bench/results/2026-09-30-mongo-reeval/r9-impl';
const result=JSON.parse(readFileSync(`${DIR}/results.json`,'utf8')),partial=process.argv.includes('--partial');
if(!partial){assert.equal(result.complete,true);assert.equal(result.C.length,24);assert.equal(result.D.length,24);}
assert.equal(result.sourceHash,hash('sha256',readFileSync('bench/mongo-reeval/models.ts')));
const victims=rows().slice(0,10000);let scored=0,witnesses=0,queryPairs=0,files=0;
const metrics=(truth:string[],p:(string|null)[])=>{let correct=0,characters=0,totalCharacters=0,mostly=0;for(let i=0;i<truth.length;i++){const a=[...truth[i]],b=[...(p[i]??'')];const matched=a.filter((v,j)=>v===b[j]).length;correct+=Number(truth[i]===p[i]);characters+=matched;totalCharacters+=a.length;mostly+=Number(matched>=a.length*.8);}return {rows:truth.length,correct,valuePct:correct/truth.length*100,characters,totalCharacters,characterPct:characters/totalCharacters*100,mostly,mostlyPct:mostly/truth.length*100};};
for(const [family,list]of [['C',result.C],['D',result.D]] as const)for(const r of list){
 const name=family==='C'?`chosen-${r.field}-${r.model}-${r.N}`:`observed-${r.field}-${r.model}-${r.mode}`;
 const a=JSON.parse(readFileSync(`${DIR}/${name}.json`,'utf8'));files++;
 const truth=victims.map(row=>norm(row[r.field as keyof typeof row]));
 const options:Options={id:r.model,field:r.field,mode:r.model==='C-port'?'combined':r.mode??'partial'};
 assert.deepEqual(a.supported,truth.flatMap((v,i)=>publicRowShape(options,v).supported?[i]:[]));
 for(const [key,expected]of Object.entries(a.metrics)){const predictions=a.predictions[key];assert.equal(predictions.length,10000);assert.deepEqual(metrics(a.supported.map((i:number)=>truth[i]),a.supported.map((i:number)=>predictions[i])),expected);scored+=a.supported.length;}
 const old=JSON.parse(readFileSync(`bench/results/2026-09-30-competitor-sim/r9-impl/${family==='C'?`chosen-${r.field}-S0-${r.N}`:`observed-${r.field}-S0-${r.mode}`}.json`,'utf8'));
 if(family==='C'){assert.deepEqual(metrics(a.supported.map((i:number)=>truth[i]),a.supported.map((i:number)=>old.predictions[i])),a.current);scored+=a.supported.length;}
 else for(const [key,expected]of Object.entries(a.current)){assert.deepEqual(metrics(a.supported.map((i:number)=>truth[i]),a.supported.map((i:number)=>old.predictions[key][i])),expected);scored+=a.supported.length;}
 const supported=new Set<number>(a.supported);
 if(a.observations)for(const o of a.observations){assert.deepEqual(o.hits,truth.flatMap((v,i)=>supported.has(i)&&(r.mode==='eq'?v===o.label:v.includes(o.label))?[i]:[]));queryPairs+=truth.length;}
 if(a.graph){const incidence=(a.observations??[]).map((o:any)=>new Set<number>(o.hits));for(let i=0;i<a.graph.length;i++){
  const g=a.graph[i];assert.ok(g.states<=20001);assert.ok(!g.capped||g.value===undefined);assert.equal(g.witnesses.length,g.solutions);assert.equal(new Set(g.witnesses).size,g.witnesses.length);
  for(const v of g.witnesses){assert.match(v,/^[1-8][0-9]-[0-9]{4}-[0-9]{4}$/);const shape=publicRowShape(options,v),actual=publicRowShape(options,truth[i]);assert.equal(shape.tagCount,actual.tagCount);assert.equal(shape.cipherBytes,actual.cipherBytes);(a.observations??[]).forEach((o:any,j:number)=>assert.equal(v.includes(o.label),incidence[j].has(i)));witnesses++;}
  if(g.value!==undefined)assert.equal(g.solutions,1);
 }}
}
const output={pass:true,partial,databaseAccess:false,files,scoredPredictions:scored,phoneWitnesses:witnesses,queryTruthPairs:queryPairs,sourceHash:result.sourceHash};writeFileSync(`${DIR}/verification${partial?'-partial':''}.json`,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output));

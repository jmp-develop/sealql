/** Offline consistency audit of saved measurements; deliberately no DB/runtime import. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const out='bench/results/2026-09-28-unified';
const read=(phase:string)=>JSON.parse(readFileSync(`${out}/m1-astra-${phase}.json`,'utf8'));
const rows:any[]=read('all'),write=read('write'),sizes:any[]=read('sizes'),plans:any[]=read('plans');
assert.equal(rows.length,43);
const normal=rows.filter(r=>r.summary);assert.equal(normal.length,42);
const long=rows.find(r=>r.name==='sub45');assert.deepEqual(long.observedMismatch,{path:'B',expected:0,actual:2440});
assert(!rows.some(r=>r.mode.startsWith('join')),'unified JOIN intentionally not measured');
for(const row of normal){
 assert.equal(Object.keys(row.failed).length,0);
 for(const path of ['plain','B']){
  assert.equal(row.runs[path].length,7);
  for(const s of row.runs[path]){
   assert.equal(s.sqlCalls,1);assert(s.totalMs>=0&&s.dbMs>=0);
   assert(Math.abs(s.totalMs-s.preMs-s.dbWallMs-s.betweenSqlMs-s.postMs)<1e-6);
   assert.equal(s.rowsToApp,row.mode==='find'?row.truth:1);
   assert.equal(s.openCount,path==='B'&&row.mode==='find'?6*row.truth:0);
  }
 }
 assert(row.dbCandidates>=row.actualMatches);
 assert(Math.abs(row.sqlRatios.B-row.summary.B.dbMs/row.summary.plain.dbMs)<1e-9);
}
for(const r of write.cases.filter((r:any)=>r.summary)){
 assert.equal(r.checks.length,18);
 for(const p of ['plain','B'])assert.equal(r.runs[p].length,7);
 assert.equal(r.checks.filter((x:any)=>x.path==='B'&&x.allCipherValuesChecked).length,9);
}
assert(write.cases.filter((r:any)=>r.summary).length>=3);
assert.equal(plans.length,4);
for(const p of plans){const nodes:any[]=[];const visit=(x:any)=>{if(x['Node Type'])nodes.push(x);for(const c of x.Plans??[])visit(c);};visit(p.plan[0].Plan);const judged=nodes.filter(x=>String(x.Filter).includes('sha256'));assert.equal(judged.length,1);assert.equal(judged[0]['Actual Rows'],20);assert.equal(judged[0]['Actual Loops'],1);}
for(const name of ['customers_plain','customers_ct','b_customers_tags'])assert.equal(sizes.find(x=>x.relname===name).rows,100000);
const report={at:new Date().toISOString(),databaseAccess:false,normalQueries:normal.length,knownFailure:long.observedMismatch,unifiedJoin:'not measured by coordinator instruction',completedWriteOperations:write.cases.filter((x:any)=>x.summary).map((x:any)=>x.op),writeChecks:write.cases.map((x:any)=>({op:x.op,checks:x.checks.length,BChecks:x.checks.filter((c:any)=>c.path==='B').length,timingComplete:!!x.summary,failure:x.failed})),limitPlans:plans.map(p=>p.name),verdict:'saved metrics, repetitions, units, and failure classification consistent; not a security proof'};
writeFileSync(`${out}/m1-astra-audit.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));

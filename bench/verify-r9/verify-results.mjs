import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const out='bench/results/2026-09-29-r9-verify';
const read=name=>JSON.parse(readFileSync(`${out}/${name}.json`,'utf8'));
const load=read('load'),install=read('install'),measure=read('measure'),writes=read('writes'),capacity=read('capacity'),tickets=read('ticket-load'),cases=read('cases');
assert.equal(load.complete,true);assert.equal(load.loaded,100000);assert.equal(load.normalizedBaselineMismatches,0);
const revision=existsSync(`${out}/revision.json`)?read('revision'):null;
assert.equal(install.commit,revision?.commit??'04994b2097a215a47dfb8ac07809bd9bb89f489c');
if(revision){
 assert.equal(measure.commit,revision.commit);assert.equal(read('join').commit,revision.commit);assert.equal(revision.writePathUnchanged,true);assert(existsSync(`${out}/${revision.previous}`));
 for(const name of revision.reused)assert(readFileSync(`${out}/${name}.json`).equals(readFileSync(`${out}/prior-04994b2/${name}.json`)),`${name}: prior evidence unchanged`);
 assert.deepEqual(cases,JSON.parse(readFileSync(`${out}/prior-04994b2/cases.json`,'utf8')));
}
assert.equal(cases.length,56);assert.equal(new Set(cases.map(c=>c.name)).size,56);
assert.equal(measure.complete,true);assert.equal(measure.rows.length,115);
assert.equal(writes.complete,true);assert.equal(writes.cases.length,4);
assert.equal(capacity.complete,true);assert.equal(capacity.tables.length,3);assert.equal(capacity.streams.length,30);
for(const result of [load,measure,writes,tickets])assert.equal(result.errors?.length??0,0);
for(const [mode,count] of [['count',56],['list300',56],['listAll',3]])assert.equal(measure.rows.filter(r=>r.mode===mode).length,count);
function rounds(record){
 for(const path of ['plain','product']){
  assert(record.first[path]);assert.equal(record.runs[path].length,7);
  for(const run of [record.first[path],...record.runs[path]])for(const key of ['preMs','sqlMs','betweenMs','postMs','totalMs','sqlCalls','appRows','opens'])assert(Number.isFinite(run[key])&&run[key]>=0,`${path} ${key}`);
 }
}
for(const record of measure.rows){
 rounds(record);
 for(const run of [record.first.product,...record.runs.product]){
  assert.equal(run.sqlCalls,1);assert.equal(run.opens,record.mode==='count'?0:record.returned*6);
  assert.equal(run.appRows,record.mode==='count'?1:record.returned);
 }
}
for(const record of writes.cases){rounds(record);for(const path of ['plain','product'])assert.equal(record.rowTimings[path].length,7);}
for(const table of capacity.tables){
 assert.equal(table.rows,100000);
 assert.equal(table.total,table.heap+table.heap_fsm+table.heap_vm+table.indexes+table.toast_heap+table.toast_indexes+table.toast_aux);
}
assert.equal(capacity.functionBodies.length,4);assert(capacity.functionBodies.every(f=>f.matches));
let joinRows=0;
if(tickets.complete){const join=read('join');assert.equal(join.complete,true);assert.equal(join.errors.length,0);assert.equal(join.rows.length,2);for(const record of join.rows)rounds(record);joinRows=join.rows.length;}
else assert.equal(tickets.limitReached,true);
assert(!existsSync('.local/research/measure.lock'),'Measurement lock released');
assert(readFileSync(`${out}/report-ko.md`,'utf8').includes('상태: 완료.'));
assert.equal(readFileSync(`${out}/report-ko.md`,'utf8'),readFileSync('.local/research/final-measure-v-astra.md','utf8'));
const result={at:new Date().toISOString(),commit:install.commit,complete:true,queryRows:measure.rows.length,queryExecutionsIncludingFirstAndWarmups:measure.rows.length*20,writeCases:writes.cases.length,reusedFrom:revision?.base,joinRows,scope:'Offline artifact consistency; actual oracle assertions run inside each measurement script'};
writeFileSync(`${out}/verification.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));

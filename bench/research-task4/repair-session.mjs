import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const root='bench/results/2026-09-29-task4',file=root+'/measure.json';
assert(!existsSync(root+'/before-session-repair.json'),'preserve first audit archive');
const raw=readFileSync(file,'utf8'),a=JSON.parse(raw);writeFileSync(root+'/before-session-repair.json',raw);
a.sessionAudit={expectedEndPid:48748,observedEndPid:77016,issue:'Pool default idleTimeoutMillis=10000 expires during long A count postprocessing; physical session changed.',observedCaseOverIdleTimeout:'or6 count; A postprocessing max >12 seconds',repair:'Disable idleTimeoutMillis; rerun or6/count all five paths, preserving first and warm-up protocol; initial results archived.',limitation:'Original warmup per-query backend PID was not recorded; a single unchanged physical backend for all initial cases is not proven.'};
assert.equal(a.rows.filter(r=>r.name==='or6'&&r.mode==='count').length,1);
a.rows=a.rows.filter(r=>!(r.name==='or6'&&r.mode==='count'));writeFileSync(file,JSON.stringify(a,null,2)+'\n');

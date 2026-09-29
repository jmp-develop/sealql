import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const commit=process.argv[2];assert(/^[0-9a-f]{7,40}$/.test(commit??''));
const lock='.local/research/measure.lock',owner=`final-return-v-astra runner ${process.pid}`;
writeFileSync(lock,owner,{flag:'wx'});
const env={...process.env,SEALQL_MEASURE_LOCK_OWNER:owner};
async function run(args){await new Promise((resolve,reject)=>{const child=spawn('rtk',args,{env,stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Step failed (${code}): ${args.join(' ')}`)));});}
try{
 console.log(JSON.stringify({phase:'locked-build',commit,owner}));
 await run(['npm','run','build']);
 await run(['proxy','node','--import','tsx','bench/final-return/measure.ts','--commit',commit]);
 const measurement=JSON.parse(readFileSync('bench/results/2026-09-29-final-return/measure.json','utf8'));assert.equal(measurement.complete,true);assert.deepEqual(measurement.variants,[]);
 console.log(JSON.stringify({phase:'writes',commit}));
 await run(['proxy','node','--import','tsx','bench/final-return/writes.ts']);
 console.log(JSON.stringify({phase:'capacity',commit}));
 await run(['proxy','node','--import','tsx','bench/final-return/capacity.ts']);
 await run(['proxy','node','bench/final-return/report.mjs']);
}finally{if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}

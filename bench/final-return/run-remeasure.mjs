import {readFileSync,writeFileSync,existsSync,unlinkSync,mkdirSync,copyFileSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const commit=process.argv[2];assert(/^[0-9a-f]{7,40}$/.test(commit??''));const lock='.local/research/measure.lock',owner=`final-return-v-astra recount ${process.pid}`,deadline=Date.parse('2026-09-29T08:48:00Z');
let waiting=false;for(;;){assert(Date.now()<deadline,'Cutoff reached before lock acquisition');try{writeFileSync(lock,owner,{flag:'wx'});break;}catch(error){if(error.code!=='EEXIST')throw error;if(!waiting){console.log(JSON.stringify({phase:'waiting-lock',owner:readFileSync(lock,'utf8')}));waiting=true;}await new Promise(r=>setTimeout(r,1000));}}
const env={...process.env,SEALQL_MEASURE_LOCK_OWNER:owner};
async function run(args){await new Promise((resolve,reject)=>{const child=spawn('rtk',args,{env,stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Step failed (${code}): ${args.join(' ')}`)));});}
try{
 assert(Date.now()<deadline);const fullCommit=execFileSync('git',['rev-parse',commit],{encoding:'utf8'}).trim(),tree=execFileSync('git',['rev-parse',`${commit}:src`],{encoding:'utf8'}).trim();
 const build=resolve(`.local/final-return-build-${commit}-${process.pid}`);assert(!existsSync(build));mkdirSync(build,{recursive:true});
 const archive=build+'/source.tar';await run(['proxy','git','archive','--format=tar','--output',archive,commit,'src','package.json','tsconfig.json']);await run(['proxy','tar','-xf',archive,'-C',build]);
 mkdirSync(build+'/bench/final-return',{recursive:true});for(const name of ['remeasure.ts','common.ts','product.ts','oracle.ts','instrument.ts','research-query.ts','research-codec.ts'])copyFileSync('bench/final-return/'+name,build+'/bench/final-return/'+name);
 const common=build+'/bench/final-return/common.ts';writeFileSync(common,readFileSync(common,'utf8').replace("'../../test/disposable.js'","'../../../../test/disposable.js'"));
 await run(['proxy','node','node_modules/typescript/bin/tsc','-p',build+'/tsconfig.json']);writeFileSync(build+'/build-provenance.json',JSON.stringify({commit:fullCommit,sourceTree:tree,method:'git archive pinned source; shared dependencies; original disposable guard'},null,2));env.SEALQL_PINNED_BUILD=build;
 console.log(JSON.stringify({phase:'pinned-build-complete',commit:fullCommit,sourceTree:tree}));
 await run(['proxy','node','--import','tsx',build+'/bench/final-return/remeasure.ts','--commit',commit]);
}
finally{if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);if(existsSync('bench/results/2026-09-29-final-return/remeasure.json'))await run(['proxy','node','bench/final-return/append-remeasure.mjs']);}

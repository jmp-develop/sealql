import {mkdirSync,copyFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const commit=execFileSync('git',['rev-parse',process.argv[2]??'HEAD'],{encoding:'utf8'}).trim(),build=resolve(`.local/scale-count-build-${commit.slice(0,7)}-${process.pid}`);assert(/^[a-f0-9]{40}$/.test(commit));assert(!existsSync(build));mkdirSync(build,{recursive:true});
const run=args=>new Promise((resolve,reject)=>{const c=spawn('rtk',args,{stdio:'inherit',windowsHide:true,env:{...process.env,SEALQL_SCALE_COMMIT:commit}});c.once('error',reject);c.once('exit',n=>n===0?resolve():reject(new Error('Step failed '+n+': '+args.join(' '))));});
await run(['proxy','git','archive','--format=tar','--output',build+'/source.tar',commit,'src','package.json','tsconfig.json']);await run(['proxy','tar','-xf',build+'/source.tar','-C',build]);
for(const dir of ['scale-count-million','final-return'])mkdirSync(build+'/bench/'+dir,{recursive:true});
for(const name of ['common.ts','product.ts','load.ts','pipeline.ts','measure.ts','clone.ts','head-recheck.ts','finalize.ts'])copyFileSync('bench/scale-count-million/'+name,build+'/bench/scale-count-million/'+name);
for(const name of ['common.ts','oracle.ts','instrument.ts'])copyFileSync('bench/final-return/'+name,build+'/bench/final-return/'+name);
for(const dir of ['scale-count-million','final-return']){const file=build+'/bench/'+dir+'/common.ts';writeFileSync(file,readFileSync(file,'utf8').replace("'../../test/disposable.js'","'../../../../test/disposable.js'"));}
await run(['proxy','node','node_modules/typescript/bin/tsc','-p',build+'/tsconfig.json']);
await run(['proxy','node','--import','tsx',build+'/bench/scale-count-million/pipeline.ts']);

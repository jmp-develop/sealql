import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
const model=process.argv[2]??'C-port';
const fields=['company','name','address','email','memo','phone'];
for(const phase of ['ab','delta'])for(const field of fields){
 const output=`bench/results/2026-09-30-mongo-reeval/m1-astra/${phase}-${model}-${field}.json`;
 if(existsSync(output)&&JSON.parse(readFileSync(output,'utf8')).complete){console.log('SKIP '+output);continue;}
 console.log(new Date().toISOString()+' START '+phase+'/'+model+'/'+field);
 const p=spawnSync(process.execPath,['--max-old-space-size=6144','--import','tsx',`bench/mongo-reeval/m1-astra/run-${phase}.ts`,field,model],{stdio:'inherit'});
 if(p.status!==0)throw new Error(`Failed ${phase}/${model}/${field}: ${p.status}`);
}

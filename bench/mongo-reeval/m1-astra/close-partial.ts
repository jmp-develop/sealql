/** Preservation only: no model imports, encoders, attacks or DB access. */
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import assert from 'node:assert/strict';
const root='bench/results/2026-09-30-mongo-reeval/m1-astra',code='bench/mongo-reeval/m1-astra';
const raw=readdirSync(root).filter(f=>/^(ab|delta)-.*\.json$/.test(f)),modelHash=hash('sha256',readFileSync('bench/mongo-reeval/models.ts'));
const completed=raw.map(file=>{const x=JSON.parse(readFileSync(`${root}/${file}`,'utf8'));assert.equal(x.complete,true);assert.equal(x.sourceHash,modelHash);return {file,field:x.field,model:x.model,conditions:x.results?.length??x.cases.length,sha256:hash('sha256',readFileSync(`${root}/${file}`))};});
const paths=[...readdirSync(code).map(f=>`${code}/${f}`),...readdirSync(root).filter(f=>f!=='closure.json').map(f=>`${root}/${f}`)];
writeFileSync(`${root}/closure.json`,JSON.stringify({status:'stopped-by-user-partial',closed:new Date().toISOString(),databaseAccess:false,rawFiles:completed.length,expectedRawFiles:24,missing:['ab-C-mongo-address.json',...['name','phone','address','memo','email','company'].map(f=>`delta-C-mongo-${f}.json`)],completed,ownedRunningProcesses:0,preservationChecks:'Completed flags and frozen model hash only; no new attack, simulation or independent replay after stop',files:Object.fromEntries(paths.map(p=>[p,hash('sha256',readFileSync(p))]))},null,2)+'\n');
console.log('Preserved '+completed.length+' complete raw files');

import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const dir='bench/results/2026-09-29-final-return';
const files=['bench/final-return/variants.ts','bench/final-return/instrument.ts','bench/final-return/measure.ts','dist/core/position-sql.js','dist/adapters/drizzle/v0.45/native-search.js'];
const hashes={};for(const file of files){try{hashes[file]=createHash('sha256').update(readFileSync(file)).digest('hex');}catch{hashes[file]='not present';}}
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceDiff=execFileSync('git',['diff','527d13f',head,'--stat','--','src'],{encoding:'utf8'}).trim();
writeFileSync(`${dir}/provenance.json`,JSON.stringify({observedAt:new Date().toISOString(),productCommit:'527d13f',head,sourceDiff,hashes,note:'Captured after process startup; latest qualified-no-set variant committed in 4b58f47; product source diff checked independently'},null,2)+'\n');

/** Capture the entire built package tree before and after each timing block. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const phase=process.argv[2];assert(['customer-before','customer-after','ticket-before','ticket-after','combo-before','combo-after'].includes(phase));
const root='dist',out='bench/results/2026-09-27-native-scale-100m';
async function files(path:string):Promise<string[]>{
  const entries=await readdir(path,{withFileTypes:true});const found:string[]=[];
  for(const e of entries){const child=join(path,e.name);if(e.isDirectory())found.push(...await files(child));else if(e.isFile())found.push(child);}
  return found;
}
const paths=(await files(root)).sort();assert(paths.length>0);
const hashes=[];
for(const path of paths)hashes.push({file:relative(root,path).replaceAll('\\','/'),
  sha256:createHash('sha256').update(await readFile(path)).digest('hex')});
const aggregate=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
const result={phase,atUtc:new Date().toISOString(),fileCount:hashes.length,aggregate,files:hashes};
await writeFile(`${out}/dist-${phase}.json`,JSON.stringify(result,null,2)+'\n');
if(phase.endsWith('-after')){
  const before=JSON.parse(await readFile(`${out}/dist-${phase.replace('after','before')}.json`,'utf8'));
  assert.deepEqual(hashes,before.files,`dist changed during ${phase.split('-')[0]} measurement`);
}
console.log(JSON.stringify({phase,fileCount:hashes.length,aggregate,identicalToBefore:phase.endsWith('-after')?true:null}));

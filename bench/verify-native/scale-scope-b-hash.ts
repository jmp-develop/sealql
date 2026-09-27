import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function files(path:string):Promise<string[]>{
  const entries=await readdir(path,{withFileTypes:true});
  const out:string[]=[];
  for(const e of entries){const child=join(path,e.name);out.push(...(e.isDirectory()?await files(child):[child]));}
  return out;
}
const h=createHash('sha256');
const paths=(await files('dist')).sort();
for(const path of paths){h.update(path.replaceAll('\\','/'));h.update(Buffer.from([0]));h.update(await readFile(path));}
const result={files:paths.length,sha256:h.digest('hex')};
const phase=process.argv[2];
if(phase){
  if(phase!=='before'&&phase!=='after')throw Error('phase must be before or after');
  const path='bench/results/2026-09-27-native-scale-100m/scope-b/dist-hashes.json';
  let previous:any={};try{previous=JSON.parse(await readFile(path,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  previous[phase]=result;
  await writeFile(path,JSON.stringify(previous,null,2)+'\n');
}
console.log(JSON.stringify({phase,...result}));

import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {dirname,extname,resolve} from 'node:path';

const sourceExtensions=new Set(['.ts','.tsx','.mts','.cts','.js','.mjs','.cjs']);
const files=[];
function walk(directory){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(entry.name==='results'||entry.name==='node_modules')continue;
    const path=`${directory}/${entry.name}`;
    if(entry.isDirectory())walk(path);else if(sourceExtensions.has(extname(entry.name)))files.push(path);
  }
}
function resolves(importer,specifier){
  const exact=resolve(dirname(importer),specifier),extension=extname(exact);
  const candidates=[exact];
  if(extension==='.js'||extension==='.mjs'||extension==='.cjs')candidates.push(exact.slice(0,-extension.length)+'.ts',exact.slice(0,-extension.length)+'.tsx',exact.slice(0,-extension.length)+'.mts',exact.slice(0,-extension.length)+'.cts');
  if(!extension)candidates.push(...[...sourceExtensions].map(ext=>exact+ext),...['.ts','.js','.mjs'].map(ext=>resolve(exact,'index'+ext)));
  return candidates.some(path=>existsSync(path)&&statSync(path).isFile());
}
export function checkBenchImports(){
  walk('bench');const missing=[];
  const patterns=[/(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g,/import\(\s*['"]([^'"]+)['"]\s*\)/g,/require\(\s*['"]([^'"]+)['"]\s*\)/g];
  for(const file of files){const body=readFileSync(file,'utf8');for(const pattern of patterns)for(const match of body.matchAll(pattern)){const specifier=match[1];if(specifier.startsWith('.')&&!resolves(file,specifier))missing.push(`${file}: ${specifier}`);}}
  if(missing.length)throw Error(`Unresolved bench relative imports:\n${missing.join('\n')}`);
  return files.length;
}

if(resolve(process.argv[1]??'')===resolve(import.meta.filename)){const checked=checkBenchImports();console.log(`Bench relative imports PASS (${checked} source files)`);}

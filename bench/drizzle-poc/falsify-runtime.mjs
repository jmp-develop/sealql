import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { probe } from './falsify-crypto.mjs';
const out=new URL('../results/2026-09-27-drizzle-falsify/',import.meta.url);await mkdir(out,{recursive:true});
const bundle=fileURLToPath(new URL('../../.local/drizzle-poc-worker.bundle.mjs',import.meta.url));
await build({entryPoints:[fileURLToPath(new URL('./falsify-worker.mjs',import.meta.url))],bundle:true,format:'esm',platform:'neutral',external:['node:*'],outfile:bundle});
const mf=new Miniflare({modules:true,scriptPath:bundle,compatibilityDate:'2025-09-01',compatibilityFlags:['nodejs_compat']});
let workerd;try{workerd=await (await mf.dispatchFetch('http://local/')).json();}finally{await mf.dispose();}
const result={node:await probe(),workerd};await writeFile(new URL('runtime.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));

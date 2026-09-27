import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { probeCrypto } from './crypto.mjs';
const out = new URL('../results/2026-09-27-drizzle-poc/', import.meta.url);
await mkdir(out, {recursive:true});
const als = new AsyncLocalStorage();
const nodeScopes = await Promise.all(['a','b'].map(s => als.run(s, async () => { await Promise.resolve(); return als.getStore(); })));
const mf = new Miniflare({ modules:true, scriptPath:fileURLToPath(new URL('./worker.mjs',import.meta.url)), compatibilityDate:'2025-09-01', compatibilityFlags:['nodejs_compat'] });
let workerd;
try { const response = await mf.dispatchFetch('http://local/'); workerd = await response.json(); }
finally { await mf.dispose(); }
const result = { node:{crypto:await probeCrypto(),scopes:nodeScopes}, workerd };
await writeFile(new URL('runtime.json',out), JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));

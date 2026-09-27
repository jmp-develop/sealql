import { AsyncLocalStorage } from 'node:async_hooks';
import { probeCrypto } from './crypto.mjs';
export default { async fetch() {
  const als = new AsyncLocalStorage();
  const scopes = await Promise.all(['a','b'].map(s => als.run(s, async () => { await Promise.resolve(); return als.getStore(); })));
  return Response.json({ crypto: await probeCrypto(), scopes });
} };

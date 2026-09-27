import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createSealer } from '../src/index.js';

test('v3 envelope crosses local workerd and Node WebCrypto', async () => {
  const bundle = await build({ entryPoints: ['test/standard-workerd-entry.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', metafile: true });
  assert.ok(Object.keys(bundle.metafile!.inputs).every(path => !path.includes('runtime/node')));
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30' });
  try {
    const result = await (await mf.dispatchFetch('https://sealql.test')).json() as { opened: string; encrypted: number[] };
    assert.equal(result.opened, 'Worker standard');
    const sealer = createSealer({ key: new Uint8Array(32).fill(7) });
    const ring = sealer.ring('m');
    assert.equal(await sealer.open(new Uint8Array(result.encrypted), { modelId: 'm', fieldId: 'title', keyScopeId: 'global', scopeId: 's', rowId: 'r', spec: { type: 'text' } }, ring), result.opened);
  } finally { await mf.dispose(); }
});

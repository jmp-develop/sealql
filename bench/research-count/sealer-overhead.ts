/** Where does Sealer.open spend time beyond the raw WebCrypto AES-GCM call? (in memory, pool 64, fixture and2 fields) */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createSealer, type CipherContext } from '../../src/core/field-cipher.js';
import { decodeField, type FieldSpec } from '../../src/core/field-codec.js';
import { utf8 } from '../../src/core/bytes.js';

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
async function time(fn: () => unknown) { for (let i = 0; i < 2; i++) await fn(); const t: number[] = []; for (let i = 0; i < 7; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); } return med(t); }
async function pool<T>(n: number, jobs: T[], f: (j: T) => Promise<unknown>) { let c = 0; await Promise.all(Array.from({ length: n }, async () => { while (c < jobs.length) await f(jobs[c++]); })); }
const spec: FieldSpec = { type: 'text' };
const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rows = (JSON.parse(readFileSync('.local/research/r2-fixture.json', 'utf8')) as Record<string, string>[]).slice(0, 21176);
const sealer = createSealer({ key: new Uint8Array(32).fill(93) }); const ring = sealer.ring('m');
const ctx = (f: string, id: string): CipherContext => ({ modelId: 'm', fieldId: f, keyScopeId: 'global', scopeId, rowId: id, spec });
const jobs: { b: Uint8Array; c: CipherContext }[] = [];
for (const r of rows) for (const f of ['company', 'memo']) jobs.push({ b: await sealer.seal(r[f], ctx(f, r.id), ring), c: ctx(f, r.id) });
// raw with same sizes, single key vs 256 shard keys
const keys = await Promise.all(Array.from({ length: 256 }, (_, i) => crypto.subtle.importKey('raw', new Uint8Array(32).fill(i), 'AES-GCM', false, ['encrypt', 'decrypt'])));
const aad = new Uint8Array(150);
const raw = await Promise.all(jobs.map(async (j, i) => { const iv = crypto.getRandomValues(new Uint8Array(12)); const k = keys[i & 255]; const p = j.b.length - 29;
  return { iv, k, ct: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, k, new Uint8Array(p))) }; }));
const N = jobs.length, us = (ms: number) => +(1000 * ms / N).toFixed(3);
const out = {
  sealerOpen: us(await time(() => pool(64, jobs, j => sealer.open(j.b, j.c, ring)))),
  raw256Keys: us(await time(() => pool(64, raw, x => crypto.subtle.decrypt({ name: 'AES-GCM', iv: x.iv, additionalData: aad }, x.k, x.ct)))),
  raw256KeysPlusDecode: us(await time(() => pool(64, raw, async x => { const p = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: x.iv, additionalData: aad }, x.k, x.ct)); utf8(scopeId); utf8('0123456789abcdef0123456789abcdef0123'); return decodeField(spec, p); }))),
};
console.log(out);
writeFileSync('bench/results/2026-09-28-count-research/r2-sealer-overhead.json', JSON.stringify(out, null, 1));

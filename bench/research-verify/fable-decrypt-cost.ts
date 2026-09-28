// fable: in-memory only (no DB). Per-call floor of the client-side verification step:
// WebCrypto AES-256-GCM decrypt (sequential / windowed concurrency) vs node:crypto sync decrypt,
// and WebCrypto HMAC-SHA-384 vs node:crypto sync HMAC, for ~60 B and ~600 B payloads.
// Run: rtk proxy npx tsx bench/research-verify/fable-decrypt-cost.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { webcrypto } from 'node:crypto';
const subtle = webcrypto.subtle;
const N = 20_000, ROUNDS = 3;
const keyBytes = randomBytes(32);
const key = await subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
const hmacKey = await subtle.importKey('raw', randomBytes(48), { name: 'HMAC', hash: 'SHA-384' }, false, ['sign']);
const aad = randomBytes(90); // product AAD is ~this size (prefix + scope + row id)
type Item = { iv: Uint8Array; body: Uint8Array; tag: Uint8Array; full: Uint8Array };
function make(size: number): Item[] {
  return Array.from({ length: N }, () => {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyBytes, iv); c.setAAD(aad);
    const body = Buffer.concat([c.update(randomBytes(size)), c.final()]), tag = c.getAuthTag();
    return { iv, body, tag, full: Buffer.concat([body, tag]) };
  });
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time(label: string, fn: () => Promise<void> | void, results: Record<string, number>) {
  const per: number[] = [];
  await fn(); // warm-up
  for (let r = 0; r < ROUNDS; r++) { const t0 = performance.now(); await fn(); per.push((performance.now() - t0) * 1000 / N); }
  results[label] = +median(per).toFixed(2);
  console.log(label.padEnd(44), results[label].toFixed(2), 'us/op');
}
const results: Record<string, number> = {};
for (const size of [60, 600]) {
  const items = make(size);
  await time(`webcrypto gcm decrypt ${size}B sequential`, async () => { for (const it of items) await subtle.decrypt({ name: 'AES-GCM', iv: it.iv, additionalData: aad, tagLength: 128 }, key, it.full); }, results);
  for (const conc of [8, 64]) await time(`webcrypto gcm decrypt ${size}B concurrency ${conc}`, async () => {
    for (let i = 0; i < items.length; i += conc) await Promise.all(items.slice(i, i + conc).map(it => subtle.decrypt({ name: 'AES-GCM', iv: it.iv, additionalData: aad, tagLength: 128 }, key, it.full)));
  }, results);
  await time(`node:crypto gcm decrypt ${size}B sync`, () => { for (const it of items) { const d = createDecipheriv('aes-256-gcm', keyBytes, it.iv); d.setAAD(aad); d.setAuthTag(it.tag); d.update(it.body); d.final(); } }, results);
}
const msgs = Array.from({ length: N }, () => randomBytes(48));
await time('webcrypto hmac-sha384 48B sequential', async () => { for (const m of msgs) await subtle.sign('HMAC', hmacKey, m); }, results);
await time('webcrypto hmac-sha384 48B concurrency 64', async () => { for (let i = 0; i < msgs.length; i += 64) await Promise.all(msgs.slice(i, i + 64).map(m => subtle.sign('HMAC', hmacKey, m))); }, results);
await time('node:crypto hmac-sha384 48B sync', () => { for (const m of msgs) createHmac('sha384', keyBytes).update(m).digest(); }, results);
const out = { n: N, rounds: ROUNDS, node: process.version, unit: 'us per operation, median of rounds', results,
  note: 'In-process micro-benchmark; excludes SQL, network, and row assembly. Product path uses WebCrypto (Node 22 and Workers).' };
mkdirSync(new URL('../results/2026-09-28-count-verify/', import.meta.url), { recursive: true });
writeFileSync(new URL('../results/2026-09-28-count-verify/fable-decrypt-cost.json', import.meta.url), JSON.stringify(out, null, 2));

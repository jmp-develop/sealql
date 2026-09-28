/**
 * X4 quality gates for the pure-JS SHA-256 / HMAC-SHA-256 and the CBC+HMAC batch open (memory only, no DB):
 *  1 NIST SHA-256 vectors (FIPS 180-2 App. B incl. multi-block + 1,000,000 x 'a'), K/H0 vs prime roots
 *  2 RFC 4231 HMAC-SHA-256 test cases 1-7
 *  3 randomized differential: SHA-256 vs node:crypto (OpenSSL), generic HMAC vs WebCrypto HMAC, prefix-state tag path vs WebCrypto
 *  4 batch CBC open vs per-field WebCrypto AES-CBC decrypt
 *  5 tamper / truncation / reordering / cross-context properties (memory), mixed batches
 *  6 tag comparison: no early exit (code) + timing sanity
 * Usage: rtk proxy npx tsx bench/research-count/x4-vectors.ts [nRandom=100000]
 */
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { sha256, hmacSha256, K, H0, prefix, tagInto, tagDiff, now } from './x4-crypto.js';
import { cbc, mk, macBytes, HDR, aPrefixBytes, fullA, prefixes, sealValue, open, fields, scopeA } from './x4-lib.js';
import { OUT, json } from './x2-lib.js';

const N = Number(process.argv[2] ?? 100000);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const enc = new TextEncoder();
const res: any = { startedAt: new Date().toISOString(), nRandom: N };

// 1 NIST
const primes: number[] = []; for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
assert.deepEqual([...K], primes.map(p => Math.floor((Math.cbrt(p) % 1) * 2 ** 32) | 0), 'K');
assert.deepEqual([...H0], primes.slice(0, 8).map(p => Math.floor((Math.sqrt(p) % 1) * 2 ** 32) | 0), 'H0');
const nist: [string, Uint8Array, string][] = [
  ['empty', new Uint8Array(0), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc (1 block)', enc.encode('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['448-bit (2 blocks)', enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['896-bit (3 blocks)', enc.encode('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'), 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
  ['1,000,000 x a', new Uint8Array(1_000_000).fill(0x61), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
];
res.nist = nist.map(([name, m, want]) => { const got = hex(sha256(m)); assert.equal(got, want, name); return { name, bytes: m.length, pass: true }; });

// 2 RFC 4231
const rep = (b: number, n: number) => new Uint8Array(n).fill(b);
const rfc: [number, Uint8Array, Uint8Array, string, number?][] = [
  [1, rep(0x0b, 20), enc.encode('Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
  [2, enc.encode('Jefe'), enc.encode('what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
  [3, rep(0xaa, 20), rep(0xdd, 50), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
  [4, Uint8Array.from({ length: 25 }, (_, i) => i + 1), rep(0xcd, 50), '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b'],
  [5, rep(0x0c, 20), enc.encode('Test With Truncation'), 'a3b6167473100ee06e0c796c2955552b', 16],
  [6, rep(0xaa, 131), enc.encode('Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
  [7, rep(0xaa, 131), enc.encode('This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.'), '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2'],
];
res.rfc4231 = rfc.map(([tc, key, data, want, trunc]) => { const got = hex(hmacSha256(key, data).subarray(0, trunc ?? 32)); assert.equal(got, want, `RFC 4231 TC${tc}`); return { tc, pass: true }; });

// 3 randomized differential
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const edgeLens = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 191, 192];
const pickLen = (max: number) => Math.random() < 0.3 ? edgeLens[randomInt(edgeLens.length)] + randomInt(3) * 64 : randomInt(max + 1);
let t = now();
for (let i = 0; i < N; i++) { const m = rnd(pickLen(3000)); assert.equal(hex(sha256(m)), createHash('sha256').update(m).digest('hex'), `sha256 len ${m.length}`); }
res.sha256VsOpenSSL = { cases: N, maxLen: 3000 + 192 + 128, pass: true, ms: now() - t };
t = now();
for (let i = 0; i < N; i += 1000) {
  const batch = await Promise.all(Array.from({ length: 1000 }, async () => {
    const key = rnd(1 + randomInt(200)), m = rnd(pickLen(2000));
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return [hex(hmacSha256(key, m)), hex(new Uint8Array(await crypto.subtle.sign('HMAC', k, m))), key.length, m.length] as const;
  }));
  for (const [a, b, kl, ml] of batch) assert.equal(a, b, `hmac key ${kl} msg ${ml}`);
}
res.hmacVsWebCrypto = { cases: N, keyLen: '1-200', msgLen: '0-2000 (+block edges)', pass: true, ms: now() - t };
// prefix-state tag path (the one used by open/seal) vs WebCrypto HMAC over the full RFC 7518 MAC input
t = now();
const wk = await crypto.subtle.importKey('raw', macBytes as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const macInput = (A: Uint8Array, body: Uint8Array) => { const m = new Uint8Array(A.length + body.length + 8); m.set(A); m.set(body, A.length); new DataView(m.buffer).setBigUint64(m.length - 8, BigInt(A.length * 8)); return m; };
const randAscii = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x21 + randomInt(94))).join('');
for (let i = 0; i < N; i += 1000) {
  const batch = await Promise.all(Array.from({ length: 1000 }, async () => {
    const field = fields[randomInt(fields.length)], scope = Math.random() < 0.5 ? scopeA : randAscii(randomInt(120)), row = Math.random() < 0.7 ? crypto.randomUUID() : randAscii(randomInt(100));
    const env = rnd(1 + 16 * (2 + randomInt(30)) + 32); const bs = 1, be = env.length - 32;
    const p = prefix(mk, aPrefixBytes(field, scope)); const out = new Uint8Array(32); tagInto(mk, p, row, env, bs, be, out, 0);
    const want = new Uint8Array(await crypto.subtle.sign('HMAC', wk, macInput(fullA(field, scope, row), env.subarray(bs, be))));
    return [hex(out), hex(want)];
  }));
  for (const [a, b] of batch) assert.equal(a, b, 'prefix tag path');
}
res.prefixTagVsWebCrypto = { cases: N, pass: true, ms: now() - t, note: 'random field, scope 0-120 ASCII or UUID, rowId UUID or 0-100 ASCII, body 32-512 B' };

// 4 batch open vs per-field WebCrypto CBC decrypt (+ original plaintext)
const hangul = () => String.fromCharCode(0xac00 + randomInt(11172));
const randText = () => Array.from({ length: randomInt(80) }, () => { const r = Math.random(); return r < 0.4 ? hangul() : r < 0.8 ? String.fromCharCode(0x20 + randomInt(95)) : r < 0.95 ? '😀' : String.fromCharCode(0x100 + randomInt(0x2000)); }).join('');
const pre = prefixes(scopeA);
{
  const M = 20000; const items = Array.from({ length: M }, () => ({ v: randText(), f: fields[randomInt(6)], row: crypto.randomUUID() }));
  const envs = await Promise.all(items.map(x => sealValue(pre, x.f, x.row, x.v)));
  const batch = await open(items.map((x, i) => ({ env: envs[i], rowId: x.row, pre: pre.get(x.f)! })));
  const td = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < M; i++) {
    const e = envs[i]; const single = td.decode(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: e.subarray(1, 17) }, cbc.dec, e.subarray(17, e.length - 32))));
    assert.equal(batch[i], items[i].v); assert.equal(single, items[i].v);
  }
  res.batchVsSingleCbc = { items: M, pass: true, sizes: { min: Math.min(...envs.map(e => e.length)), max: Math.max(...envs.map(e => e.length)) } };
}

// 5 properties (memory)
const rejects = async (jobs: any[]) => { try { await open(jobs); return false; } catch (e: any) { return e.message === 'AUTHENTICATION_FAILED'; } };
{
  const M = 2000; const items = Array.from({ length: M }, () => ({ v: randText(), f: fields[randomInt(6)], row: crypto.randomUUID() }));
  const envs = await Promise.all(items.map(x => sealValue(pre, x.f, x.row, x.v)));
  const job = (e: Uint8Array, i: number, over: any = {}) => ({ env: e, rowId: items[i].row, pre: pre.get(items[i].f)!, ...over });
  const P: Record<string, { tried: number; rejected: number }> = {};
  const rec = async (name: string, jobs: any[]) => { const r = (P[name] ??= { tried: 0, rejected: 0 }); r.tried++; if (await rejects(jobs)) r.rejected++; };
  const otherPre = prefixes('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  for (let i = 0; i < M; i++) {
    const e = envs[i];
    for (let k = 0; k < 8; k++) { const x = e.slice(); const pos = randomInt(x.length); x[pos] ^= 1 << randomInt(8); await rec('random bit flip (any byte incl. header/IV/C/tag)', [job(x, i)]); }
    { const x = e.slice(); x[0] = [0, 3, 4, 6, 255][randomInt(5)]; await rec('header byte changed', [job(x, i)]); }
    for (const cut of [1, 15, 16, 32, 33, 48]) if (e.length - cut > 0) await rec(`truncate tail ${cut} B`, [job(e.subarray(0, e.length - cut), i)]);
    await rec('truncate: drop first C block', [job(new Uint8Array([...e.subarray(0, 17), ...e.subarray(33)]), i)]);
    await rec('extend: duplicate a C block', [job(new Uint8Array([...e.subarray(0, 33), ...e.subarray(17, 33), ...e.subarray(33)]), i)]);
    if (e.length >= 49 + 32) { const x = e.slice(); x.set(e.subarray(33, 49), 17); x.set(e.subarray(17, 33), 33); await rec('reorder: swap first two C blocks', [job(x, i)]); }
    const j = (i + 1) % M; const o = envs[j];
    { const x = e.slice(); x.set(o.subarray(1, 17), 1); await rec('IV transplant from other envelope', [job(x, i)]); }
    await rec('cross-row (other rowId, same field)', [job(e, i, { rowId: items[j].row })]);
    await rec('cross-field (other field AAD)', [job(e, i, { pre: pre.get(fields[(fields.indexOf(items[i].f as any) + 1) % 6])! })]);
    await rec('cross-scope (other scope AAD)', [job(e, i, { pre: otherPre.get(items[i].f)! })]);
    await rec('tag transplant from other envelope', [job(new Uint8Array([...e.subarray(0, e.length - 32), ...o.subarray(o.length - 32)]), i)]);
  }
  // mixed batch: 1 bad among many good -> whole batch rejected; X3 layout case: two forged items each shortened 8 B (block alignment of the batch kept)
  const good = items.slice(0, 500).map((_, i) => job(envs[i], i));
  for (let k = 0; k < 50; k++) { const b = good.slice(); const i = randomInt(500); const x = envs[i].slice(); x[randomInt(x.length)] ^= 1; b[i] = job(x, i); await rec('mixed batch: 1 tampered of 500', b); }
  { const b = good.slice(); b[10] = job(envs[10].subarray(0, envs[10].length - 8), 10); b[400] = job(envs[400].subarray(0, envs[400].length - 8), 400); await rec('X3 layout case: 2 items shortened 8 B each', b); }
  for (const L of [0, 20, 48, 64, 65 + 1, 81 - 16 + 3]) await rec(`malformed length ${L}`, [job(rnd(L).fill(HDR, 0, 1), 0)]);
  await rec('non-Uint8Array envelope', [job('x' as any, 0)]);
  assert.deepEqual(await open(good), items.slice(0, 500).map(x => x.v), 'control batch opens');
  for (const [k, v] of Object.entries(P)) assert.equal(v.rejected, v.tried, k);
  res.propertiesMemory = { envelopes: M, control: 'good batch of 500 opens to the original values', results: P };
}

// 6 tag comparison timing sanity (no early exit): equal tag vs first-byte diff vs last-byte diff
{
  const e = await sealValue(pre, 'memo', crypto.randomUUID(), '서울 서비스 상담 메모'); const row = crypto.randomUUID();
  const env = await sealValue(pre, 'memo', row, '서울 서비스 상담 메모');
  const variants: Record<string, Uint8Array> = { equal: env, firstByteDiff: env.slice(), lastByteDiff: env.slice() };
  variants.firstByteDiff[env.length - 32] ^= 1; variants.lastByteDiff[env.length - 1] ^= 1;
  const time: Record<string, number> = {};
  for (let rep = 0; rep < 9; rep++) for (const [k, v] of Object.entries(variants)) {
    const s = now(); let d = 0; for (let i = 0; i < 100000; i++) d |= tagDiff(mk, pre.get('memo')!, row, v, 1, v.length - 32, v.length - 32);
    const ms = now() - s; if (rep >= 2) (time[k] ??= 0), time[k] = Math.max(time[k], 0) + ms / 7;
    assert.equal(d !== 0, k !== 'equal');
  }
  res.constantTime = { method: 'tagDiff XOR-accumulates all 8 words with no branch on data; openBatch throws only after ALL tags of the batch are computed', usPerTagMean: Object.fromEntries(Object.entries(time).map(([k, v]) => [k, +(v * 1000 / 100000).toFixed(4)])), unused: e.length };
}
res.finishedAt = new Date().toISOString();
writeFileSync(`${OUT}/x4-vectors.json`, json(res));
console.log(json(res));

/**
 * Per-candidate verification cost anatomy for the and2 count (company = "서울서비스 담당" AND memo contains "서비스"),
 * in memory, with fixture values re-encrypted by the product Sealer (test key fill(93)).
 * Also prototypes batched AES (AES-CBC decrypt used as a batch AES^-1 oracle) for:
 *   B1 row-bound equality tags, B3 batch-verifiable EtM(AES-CBC, PMAC over AES^-1).
 * Usage: npx tsx bench/research-count/cost-anatomy.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createSealer, type CipherContext } from '../../src/core/field-cipher.js';
import { decodeField, type FieldSpec } from '../../src/core/field-codec.js';
import { normalizeText } from '../../src/core/search-tokens.js';
import { utf8, frame, concat } from '../../src/core/bytes.js';

const WARM = 2, REPS = 7;
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
async function time(fn: () => Promise<unknown> | unknown): Promise<number> {
  for (let i = 0; i < WARM; i++) await fn();
  const t: number[] = [];
  for (let i = 0; i < REPS; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  return med(t);
}
async function pool<T>(n: number, jobs: T[], f: (j: T) => Promise<unknown>) {
  let c = 0; await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (c < jobs.length) await f(jobs[c++]); }));
}
const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const spec: FieldSpec = { type: 'text', search: { exact: true, substring: { wordBoundary: true, skipGrams: true } } };
const ws = new RegExp('[' + [[9, 13], [32, 32], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
const compact = (v: string) => normalizeText(v, 'legacy-text-v1').replace(ws, '');
const qCompany = normalizeText('서울서비스 담당', 'legacy-text-v1'), qMemo = compact('서비스');

const all = JSON.parse(readFileSync('.local/research/r2-fixture.json', 'utf8')) as Record<string, string>[];
const rows = all.filter(r => normalizeText(r.company, 'legacy-text-v1') === qCompany && compact(r.memo).includes(qMemo));
console.error('and2 rows', rows.length);
const sealer = createSealer({ key: new Uint8Array(32).fill(93) });
const ring = sealer.ring('customers');
const ctx = (fieldId: string, rowId: string): CipherContext => ({ modelId: 'customers', fieldId, keyScopeId: ring.keyScopeId, scopeId, rowId, spec });
type Item = { id: string; company: Uint8Array; memo: Uint8Array; companyPlain: string; memoPlain: string };
const items: Item[] = [];
for (const r of rows) items.push({ id: r.id, companyPlain: r.company, memoPlain: r.memo,
  company: await sealer.seal(r.company, ctx('company', r.id), ring), memo: await sealer.seal(r.memo, ctx('memo', r.id), ring) });
const fieldsN = items.length * 2;
const res: Record<string, any> = { rows: items.length, fields: fieldsN, avgCipherBytes: { company: items.reduce((a, i) => a + i.company.length, 0) / items.length, memo: items.reduce((a, i) => a + i.memo.length, 0) / items.length } };
const us = (ms: number) => +(1000 * ms / fieldsN).toFixed(3);

// ---- S0: promise scheduling only ----
res.noopAsyncPool64 = us(await time(() => pool(64, items.flatMap(i => [i, i]), async () => {})));
// ---- S1: driver-like copy + shape check (Buffer -> Uint8Array copy) ----
const bufs = items.flatMap(i => [Buffer.from(i.company), Buffer.from(i.memo)]);
res.copyAndShape = us(await time(() => { let n = 0; for (const b of bufs) { const u = new Uint8Array(b); assert(u[0] === 3 && u.length >= 29); n += u.length; } return n; }));
// ---- S2: raw AES-GCM decrypt with a cached CryptoKey (same sizes), concurrency sweep ----
const rawKey = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['encrypt', 'decrypt']);
const aad = new Uint8Array(110);
const raw = await Promise.all(items.flatMap(i => [i.companyPlain, i.memoPlain]).map(async p => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, ct: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, rawKey, utf8(p))) };
}));
const dec = (x: { iv: Uint8Array; ct: Uint8Array }) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: x.iv, additionalData: aad }, rawKey, x.ct);
res.rawGcm = {};
for (const c of [1, 4, 8, 16, 64, 256, 1024]) res.rawGcm[`pool${c}`] = us(await time(() => pool(c, raw, dec)));
res.rawGcm.allAtOnce = us(await time(() => Promise.all(raw.map(dec))));
res.rawGcm.windows64Barrier = us(await time(async () => { for (let o = 0; o < raw.length; o += 128) await pool(64, raw.slice(o, o + 128), dec); }));
// ---- S3: full Sealer.open (AAD build, shard key lookup, decrypt, decodeField) ----
const jobs = items.flatMap(i => [{ b: i.company, c: ctx('company', i.id) }, { b: i.memo, c: ctx('memo', i.id) }]);
const openJob = (j: { b: Uint8Array; c: CipherContext }) => sealer.open(j.b, j.c, ring);
res.sealerOpen = {};
for (const c of [1, 8, 64, 256]) res.sealerOpen[`pool${c}`] = us(await time(() => pool(c, jobs, openJob)));
res.sealerOpen.allAtOnce = us(await time(() => Promise.all(jobs.map(openJob))));
// product count shape: windows of 64 rows (128 fields) opened with 64 workers, verify, next window
res.sealerOpen.productWindows = us(await time(async () => { for (let o = 0; o < jobs.length; o += 128) await pool(64, jobs.slice(o, o + 128), openJob); }));
// ---- S4: decode stage alone (TextDecoder fatal + canonical re-encode check) ----
const plainBytes = items.flatMap(i => [utf8(i.companyPlain), utf8(i.memoPlain)]);
res.decodeField = us(await time(() => { for (const b of plainBytes) decodeField(spec, b); }));
res.textDecoderOnly = us(await time(() => { const d = new TextDecoder('utf-8', { fatal: true }); for (const b of plainBytes) d.decode(b); }));
// ---- S5: predicate verification (normalize + compare) ----
res.verifyCompanyEq = +(1000 * await time(() => { let n = 0; for (const i of items) if (normalizeText(i.companyPlain, 'legacy-text-v1') === qCompany) n++; assert.equal(n, items.length); }) / items.length).toFixed(3);
res.verifyMemoContains = +(1000 * await time(() => { let n = 0; for (const i of items) if (compact(i.memoPlain).includes(qMemo)) n++; assert.equal(n, items.length); }) / items.length).toFixed(3);
// ---- S6: HMAC-SHA256 per call (row-bound tag verified by WebCrypto, one call per candidate) ----
const hk = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(9), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const hin = items.map(i => utf8(i.id + '\0' + i.companyPlain));
res.hmacPerCall = {};
for (const c of [1, 64, 1024]) res.hmacPerCall[`pool${c}`] = +(1000 * await time(() => pool(c, hin, x => crypto.subtle.sign('HMAC', hk, x))) / items.length).toFixed(3);

// ================= batched AES^-1 via AES-CBC decrypt =================
// CBC decrypt: out_j = D(in_j) xor in_{j-1}; choose all in_j freely => D at arbitrary points in ONE call.
// Final block X0 = E(P16) (per-key constant, from one CBC encrypt of empty data with iv=0) makes PKCS#7 valid.
type BatchKey = { k: CryptoKey; x0: Uint8Array };
async function batchKey(bytes: Uint8Array): Promise<BatchKey> {
  const k = await crypto.subtle.importKey('raw', bytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const x0 = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, k, new Uint8Array(0)));
  assert.equal(x0.length, 16); return { k, x0 };
}
/** in: n blocks (n*16 bytes). returns raw CBC-decrypt output (n blocks); caller xors previous input block where needed. */
async function cbcDecryptRaw(key: BatchKey, input: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(input.length + 32); buf.set(input); buf.set(key.x0, input.length + 16); // [..., 0^16, X0]
  const out = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key.k, buf));
  assert.equal(out.length, input.length + 16); return out.subarray(0, input.length);
}
/** D_K at arbitrary points: xs n blocks -> D(x_i). Interleave each point with a zero block so the xor is with 0. */
async function batchD(key: BatchKey, xs: Uint8Array): Promise<Uint8Array> {
  const n = xs.length / 16, inp = new Uint8Array(n * 32);
  for (let i = 0; i < n; i++) inp.set(xs.subarray(i * 16, i * 16 + 16), i * 32 + 16);
  const out = await cbcDecryptRaw(key, inp), r = new Uint8Array(n * 16);
  for (let i = 0; i < n; i++) r.set(out.subarray(i * 32 + 16, i * 32 + 32), i * 16);
  return r;
}
/** Denser variant: D(x_i) = out_i xor x_{i-1}, no zero padding blocks. */
async function batchDDense(key: BatchKey, xs: Uint8Array): Promise<Uint8Array> {
  const out = await cbcDecryptRaw(key, xs);
  const o = new Uint32Array(out.buffer, out.byteOffset, out.length / 4), x = new Uint32Array(xs.buffer, xs.byteOffset, xs.length / 4);
  for (let i = o.length - 1; i >= 4; i--) o[i] ^= x[i - 4];
  return out;
}
// correctness: D(E(x)) == x using single-block encrypts
const kb = await batchKey(new Uint8Array(32).fill(11));
{
  const xs = crypto.getRandomValues(new Uint8Array(16 * 50)); const d = await batchDDense(kb, xs); const d2 = await batchD(kb, xs);
  assert.deepEqual(d, d2);
  for (let i = 0; i < 50; i++) { // E(D(x)) with CBC encrypt of one block, iv=0: output first block = E(block)
    const e = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, kb.k, d.subarray(i * 16, i * 16 + 16))).subarray(0, 16);
    assert.deepEqual(e, xs.subarray(i * 16, i * 16 + 16));
  }
}
res.batchAesInv = {};
for (const n of [1, 64, 1024, 21176, 42352, 423520]) {
  const xs = crypto.getRandomValues(new Uint8Array(16 * Math.min(n, 4096))); const big = new Uint8Array(16 * n); for (let o = 0; o < big.length; o += xs.length) big.set(xs.subarray(0, Math.min(xs.length, big.length - o)), o);
  const ms = await time(() => batchDDense(kb, big)); res.batchAesInv[`n${n}`] = { totalMs: +ms.toFixed(3), nsPerBlock: +(1e6 * ms / n).toFixed(1) };
}

// ---- B1: row-bound equality tag  T_r = D_Kt(uuid16(r) xor h(v)),  h(v) = HMAC-SHA256(K_h, v)[0..16) ----
const uuid16 = (id: string) => Uint8Array.from(id.replace(/-/g, '').match(/../g)!, h => parseInt(h, 16));
const kh = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(21), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const kt = await batchKey(new Uint8Array(32).fill(22));
const h = async (v: string) => new Uint8Array(await crypto.subtle.sign('HMAC', kh, utf8(v))).subarray(0, 16);
async function tagsFor(ids: string[], hv: (i: number) => Uint8Array) {
  const xs = new Uint8Array(ids.length * 16);
  ids.forEach((id, i) => { const u = uuid16(id), hh = hv(i); for (let j = 0; j < 16; j++) xs[i * 16 + j] = u[j] ^ hh[j]; });
  return batchDDense(kt, xs);
}
const storedHv = await Promise.all(items.map(i => h(normalizeText(i.companyPlain, 'legacy-text-v1'))));
const storedTags = await tagsFor(items.map(i => i.id), i => storedHv[i]); // write-time (not timed)
const ids = items.map(i => i.id);
const b1Verify = async () => {
  const hq = await h(qCompany); const t = await tagsFor(ids, () => hq);
  const a = new Uint32Array(t.buffer, t.byteOffset, t.length / 4), b = new Uint32Array(storedTags.buffer, storedTags.byteOffset, storedTags.length / 4);
  let ok = 0; for (let i = 0; i < items.length; i++) { const o = i * 4; if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2] && a[o + 3] === b[o + 3]) ok++; }
  return ok;
};
assert.equal(await b1Verify(), items.length);
{ // negative control: a different value must certify 0 rows
  const hq = await h('서울서비스 중앙지사'); const t = await tagsFor(ids, () => hq); let ok = 0;
  for (let i = 0; i < items.length; i++) if (t.subarray(i * 16, i * 16 + 16).every((x, j) => x === storedTags[i * 16 + j])) ok++;
  assert.equal(ok, 0);
}
res.B1_eqTagVerify = { totalMs: +(await time(b1Verify)).toFixed(3), usPerRow: 0 };
res.B1_eqTagVerify.usPerRow = +(1000 * res.B1_eqTagVerify.totalMs / items.length).toFixed(3);

// ---- B3: batch-verifiable AEAD = EtM(AES-256-CBC random IV, PMAC over pi = AES^-1 with independent key) ----
const dbl = (b: Uint8Array) => { const r = new Uint8Array(16); let c = 0; for (let i = 15; i >= 0; i--) { r[i] = ((b[i] << 1) | c) & 0xff; c = b[i] >> 7; } if (b[0] & 0x80) r[15] ^= 0x87; return r; };
const half = (b: Uint8Array) => { const lsb = b[15] & 1; const x = Uint8Array.from(b); if (lsb) x[15] ^= 0x87; const r = new Uint8Array(16); let c = lsb; for (let i = 0; i < 16; i++) { r[i] = (x[i] >> 1) | (c << 7); c = x[i] & 1; } return r; };
type PmacKey = BatchKey & { L: Uint8Array[]; Linv: Uint8Array };
async function pmacKey(bytes: Uint8Array): Promise<PmacKey> {
  const b = await batchKey(bytes); const L0 = await batchDDense(b, new Uint8Array(16));
  const L = [L0]; for (let i = 1; i < 64; i++) L.push(dbl(L[i - 1]));
  assert.deepEqual(dbl(half(L0)), L0);
  return { ...b, L, Linv: half(L0) };
}
const ntz = (i: number) => 31 - Math.clz32(i & -i);
/** Round 1 inputs for PMAC of msg (all but last block) + final xor term; returns number of round-1 blocks written. */
function pmacPrepare(pk: PmacKey, msg: Uint8Array, out: Uint8Array, at: number): { n: number; last: Uint8Array } {
  const m = Math.max(1, Math.ceil(msg.length / 16)); const off = new Uint8Array(16);
  for (let i = 0; i < m - 1; i++) { const L = pk.L[ntz(i + 1)]; for (let j = 0; j < 16; j++) { off[j] ^= L[j]; out[at + i * 16 + j] = msg[i * 16 + j] ^ off[j]; } }
  const tail = msg.subarray((m - 1) * 16), last = new Uint8Array(16);
  if (tail.length === 16) for (let j = 0; j < 16; j++) last[j] = tail[j] ^ pk.Linv[j]; else { last.set(tail); last[tail.length] = 0x80; }
  return { n: m - 1, last };
}
async function pmacOne(pk: PmacKey, msg: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(Math.ceil(msg.length / 16) * 16 + 16); const p = pmacPrepare(pk, msg, buf, 0);
  const d = p.n ? await batchDDense(pk, buf.subarray(0, p.n * 16)) : new Uint8Array(0);
  const sum = Uint8Array.from(p.last); for (let i = 0; i < p.n; i++) for (let j = 0; j < 16; j++) sum[j] ^= d[i * 16 + j];
  return batchDDense(pk, sum);
}
// Note: batchDDense xors with the previous *input* block, so interleaved independent points are fine.
const ke = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(31), 'AES-CBC', false, ['encrypt', 'decrypt']);
const keB = await batchKey(new Uint8Array(32).fill(31));
const pm = await pmacKey(new Uint8Array(32).fill(32));
const aadOf = (fieldId: string, rowId: string) => frame(['sealql/aad/v4', 'customers', fieldId, 'text', 'global', scopeId, rowId]);
async function b3Seal(plain: string, fieldId: string, rowId: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ke, utf8(plain)));
  const body = concat(new Uint8Array([4]), iv, c);
  const tag = await pmacOne(pm, concat(aadOf(fieldId, rowId), body));
  return concat(body, tag);
}
type B3Job = { env: Uint8Array; fieldId: string; rowId: string };
/** Batch open: 2 WebCrypto calls for PMAC (round 1 + final) + 1 call for CBC; tag checked before plaintext use. */
async function b3OpenBatch(jobs: B3Job[]): Promise<string[]> {
  const msgs = jobs.map(j => concat(aadOf(j.fieldId, j.rowId), j.env.subarray(0, j.env.length - 16)));
  let r1 = 0; for (const m of msgs) r1 += Math.max(0, Math.ceil(m.length / 16) - 1);
  const buf1 = new Uint8Array(r1 * 16); const lasts: { n: number; last: Uint8Array; at: number }[] = []; let at = 0;
  for (const m of msgs) { const p = pmacPrepare(pm, m, buf1, at * 16); lasts.push({ ...p, at }); at += p.n; }
  // CBC: [iv, c1..cn] per job, concatenated; out block j = D(c_j) xor c_{j-1} = plaintext for j>=1
  let cb = 0; for (const j of jobs) cb += (j.env.length - 17) / 16;
  const cbuf = new Uint8Array(cb * 16); const spans: number[] = []; let o = 0;
  for (const j of jobs) { spans.push(o); const part = j.env.subarray(1, j.env.length - 16); cbuf.set(part, o); o += part.length; }
  const [d1, pOut] = await Promise.all([batchDDense(pm, buf1), cbcDecryptRaw(keB, cbuf)]);
  const sums = new Uint8Array(jobs.length * 16);
  lasts.forEach((p, k) => { const s = sums.subarray(k * 16, k * 16 + 16); s.set(p.last); for (let i = 0; i < p.n; i++) { const b = (p.at + i) * 16; for (let j = 0; j < 16; j++) s[j] ^= d1[b + j]; } });
  const tags = await batchDDense(pm, sums);
  const outStrings: string[] = []; const td = new TextDecoder('utf-8', { fatal: true });
  for (let k = 0; k < jobs.length; k++) {
    const env = jobs[k].env, t = env.subarray(env.length - 16); let diff = 0; for (let j = 0; j < 16; j++) diff |= t[j] ^ tags[k * 16 + j];
    if (diff) throw Error('AUTHENTICATION_FAILED');
    const start = spans[k] + 16, end = spans[k] + (env.length - 17); const p = pOut.subarray(start, end); const pad = p[p.length - 1];
    if (pad < 1 || pad > 16) throw Error('AUTHENTICATION_FAILED');
    outStrings.push(td.decode(p.subarray(0, p.length - pad)));
  }
  return outStrings;
}
const b3Jobs: B3Job[] = [];
for (const i of items) { b3Jobs.push({ env: await b3Seal(i.companyPlain, 'company', i.id), fieldId: 'company', rowId: i.id }); b3Jobs.push({ env: await b3Seal(i.memoPlain, 'memo', i.id), fieldId: 'memo', rowId: i.id }); }
{ // correctness + tamper + row-swap checks
  const plain = await b3OpenBatch(b3Jobs); items.forEach((i, k) => { assert.equal(plain[2 * k], i.companyPlain); assert.equal(plain[2 * k + 1], i.memoPlain); });
  const bad = b3Jobs.slice(0, 3).map(j => ({ ...j, env: Uint8Array.from(j.env) })); bad[1].env[20] ^= 1;
  await assert.rejects(b3OpenBatch(bad), /AUTHENTICATION_FAILED/);
  const swap = [{ ...b3Jobs[0], rowId: b3Jobs[2].rowId }]; await assert.rejects(b3OpenBatch(swap), /AUTHENTICATION_FAILED/);
  const cut = [{ ...b3Jobs[1], env: concat(b3Jobs[1].env.subarray(0, 17), b3Jobs[1].env.subarray(33)) }]; await assert.rejects(b3OpenBatch(cut));
}
res.B3 = { avgEnvelopeBytes: { company: b3Jobs.filter(j => j.fieldId === 'company').reduce((a, j) => a + j.env.length, 0) / items.length, memo: b3Jobs.filter(j => j.fieldId === 'memo').reduce((a, j) => a + j.env.length, 0) / items.length } };
const b3Count = async () => { const p = await b3OpenBatch(b3Jobs); let n = 0; for (let k = 0; k < items.length; k++) if (normalizeText(p[2 * k], 'legacy-text-v1') === qCompany && compact(p[2 * k + 1]).includes(qMemo)) n++; assert.equal(n, items.length); return n; };
res.B3.openBatchAllMs = +(await time(() => b3OpenBatch(b3Jobs))).toFixed(3);
res.B3.usPerField = us(res.B3.openBatchAllMs);
res.B3.countIncludingVerifyMs = +(await time(b3Count)).toFixed(3);
// chunked (e.g. streamed candidates in batches of 2000 rows)
res.B3.chunk4000FieldsMs = +(await time(async () => { for (let o = 0; o < b3Jobs.length; o += 4000) await b3OpenBatch(b3Jobs.slice(o, o + 4000)); })).toFixed(3);
// reference: current product path for the same count (open both fields, product windows, verify)
res.currentCountEquivalentMs = +(await time(async () => {
  let n = 0;
  for (let o = 0; o < jobs.length; o += 128) {
    const w = jobs.slice(o, o + 128); const out: unknown[] = new Array(w.length); let c = 0;
    await Promise.all(Array.from({ length: 64 }, async () => { while (c < w.length) { const k = c++; out[k] = await openJob(w[k]); } }));
    for (let k = 0; k < out.length; k += 2) if (normalizeText(out[k] as string, 'legacy-text-v1') === qCompany && compact(out[k + 1] as string).includes(qMemo)) n++;
  }
  assert.equal(n, items.length);
})).toFixed(3);
res.env = { node: process.version, platform: process.platform, note: 'in-memory, no DB/driver; median of 7 after 2 warmups; µs values are wall per field unless stated' };
writeFileSync('bench/results/2026-09-28-count-research/r2-cost-anatomy.json', JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));

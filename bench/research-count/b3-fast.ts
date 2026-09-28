/**
 * Optimized prototypes (JS overhead minimized) for:
 *   B3  batch-verifiable AEAD: EtM(AES-256-CBC random IV, PMAC over pi = AES^-1, independent key), AAD row-bound.
 *   B1  row-bound equality tag T = D_Kt(uuid128 xor h(v)).
 *   V   verification fast path (skip NFC when value is ASCII/precomposed Hangul only).
 * and the and2 count end to end in memory (company = "서울서비스 담당" AND memo contains "서비스", fixture rows).
 * Batched AES^-1: WebCrypto AES-CBC decrypt, out_j = D(in_j) xor in_{j-1}; PKCS#7 made valid by a per-key constant block.
 * Usage: npx tsx bench/research-count/b3-fast.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createSealer, type CipherContext } from '../../src/core/field-cipher.js';
import type { FieldSpec } from '../../src/core/field-codec.js';
import { normalizeText } from '../../src/core/search-tokens.js';
import { frame, utf8 } from '../../src/core/bytes.js';

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
async function time(fn: () => unknown) { for (let i = 0; i < 2; i++) await fn(); const t: number[] = []; for (let i = 0; i < 7; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); } return +med(t).toFixed(3); }
const ws = new RegExp('[' + [[9, 13], [32, 32], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
const compact = (v: string) => normalizeText(v, 'legacy-text-v1').replace(ws, '');
const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const qCompany = normalizeText('서울서비스 담당', 'legacy-text-v1'), qMemo = compact('서비스');
const all = JSON.parse(readFileSync('.local/research/r2-fixture.json', 'utf8')) as Record<string, string>[];
const rows = all.filter(r => normalizeText(r.company, 'legacy-text-v1') === qCompany && compact(r.memo).includes(qMemo));

// ---------- batched AES^-1 ----------
type BK = { k: CryptoKey; x0: Uint8Array };
async function bk(bytes: Uint8Array): Promise<BK> {
  const k = await crypto.subtle.importKey('raw', bytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
  return { k, x0: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, k, new Uint8Array(0))) };
}
/** buf must have 32 spare bytes at the end: [..data.., 0^16, X0]. Returns raw CBC output over data. */
async function cbcRaw(key: BK, buf: Uint8Array, dataLen: number): Promise<Uint8Array> {
  buf.fill(0, dataLen, dataLen + 16); buf.set(key.x0, dataLen + 16);
  const out = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key.k, buf.subarray(0, dataLen + 32)));
  return out;
}
/** D at independent points held in buf[0..n*16): result D(x_i) in-place into a new array. */
async function dPoints(key: BK, buf: Uint8Array, n: number): Promise<Uint32Array> {
  const out = await cbcRaw(key, buf, n * 16);
  const o = new Uint32Array(out.buffer, 0, n * 4), x = new Uint32Array(buf.buffer, buf.byteOffset, n * 4);
  for (let i = n * 4 - 1; i >= 4; i--) o[i] ^= x[i - 4];
  return o;
}
// ---------- PMAC over AES^-1 ----------
const dbl = (b: Uint8Array) => { const r = new Uint8Array(16); let c = 0; for (let i = 15; i >= 0; i--) { r[i] = ((b[i] << 1) | c) & 0xff; c = b[i] >> 7; } if (b[0] & 0x80) r[15] ^= 0x87; return r; };
const half = (b: Uint8Array) => { const lsb = b[15] & 1; const x = Uint8Array.from(b); if (lsb) x[15] ^= 0x87; const r = new Uint8Array(16); let c = lsb; for (let i = 0; i < 16; i++) { r[i] = (x[i] >> 1) | (c << 7); c = x[i] & 1; } return r; };
const ntz = (i: number) => 31 - Math.clz32(i & -i);
type PK = BK & { L: Uint32Array; Linv: Uint32Array };
async function pk(bytes: Uint8Array): Promise<PK> {
  const b = await bk(bytes); const z = new Uint8Array(48); const L0 = new Uint8Array((await dPoints(b, z, 1)).buffer.slice(0, 16));
  const L = new Uint8Array(64 * 16); let cur = L0; for (let i = 0; i < 64; i++) { L.set(cur, i * 16); cur = dbl(cur); }
  return { ...b, L: new Uint32Array(L.buffer), Linv: new Uint32Array(half(L0).buffer) };
}
/** Reference PMAC (sequential, generic) used for sealing. */
async function pmacRef(p: PK, msg: Uint8Array): Promise<Uint8Array> {
  const m = Math.max(1, Math.ceil(msg.length / 16)); const buf = new Uint8Array(m * 16 + 32); const off = new Uint32Array(4);
  const mm = new Uint8Array(m * 16); mm.set(msg); const M = new Uint32Array(mm.buffer), B = new Uint32Array(buf.buffer);
  for (let i = 0; i < m - 1; i++) { const l = ntz(i + 1) * 4; for (let j = 0; j < 4; j++) { off[j] ^= p.L[l + j]; B[i * 4 + j] = M[i * 4 + j] ^ off[j]; } }
  const d = m > 1 ? await dPoints(p, buf, m - 1) : new Uint32Array(0);
  const last = new Uint8Array(16); const tail = msg.subarray((m - 1) * 16);
  const sum = new Uint32Array(4);
  if (tail.length === 16) { last.set(tail); const T = new Uint32Array(last.buffer); for (let j = 0; j < 4; j++) sum[j] = T[j] ^ p.Linv[j]; } else { last.set(tail); last[tail.length] = 0x80; sum.set(new Uint32Array(last.buffer)); }
  for (let i = 0; i < m - 1; i++) for (let j = 0; j < 4; j++) sum[j] ^= d[i * 4 + j];
  const b2 = new Uint8Array(48); b2.set(new Uint8Array(sum.buffer)); return new Uint8Array((await dPoints(p, b2, 1)).buffer.slice(0, 16));
}
// ---------- B3 format ----------
// PMAC input = CONST(field,scope) padded to 16 | u32(rowLen) rowId | IV | C ; envelope = [4][IV16][C][tag16]
const ke = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(31), 'AES-CBC', false, ['encrypt']);
const keB = await bk(new Uint8Array(32).fill(31)), pm = await pk(new Uint8Array(32).fill(32));
const constPart = (field: string) => { const f = frame(['sealql/aad/v4', 'customers', field, 'text', '1', 'global', scopeId]); const r = new Uint8Array(Math.ceil(f.length / 16) * 16); r.set(f); return r; };
const enc = new TextEncoder();
function tailOf(rowId: string, env: Uint8Array): Uint8Array { const rb = enc.encode(rowId); const t = new Uint8Array(4 + rb.length + env.length - 17); new DataView(t.buffer).setUint32(0, rb.length); t.set(rb, 4); t.set(env.subarray(1, env.length - 16), 4 + rb.length); return t; }
async function seal(plain: string, field: string, rowId: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(16)); const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ke, utf8(plain)));
  const env = new Uint8Array(1 + 16 + c.length + 16); env[0] = 4; env.set(iv, 1); env.set(c, 17);
  const cp = constPart(field), tl = tailOf(rowId, env); const msg = new Uint8Array(cp.length + tl.length); msg.set(cp); msg.set(tl, cp.length);
  env.set(await pmacRef(pm, msg), env.length - 16); return env;
}
/** Per-call precompute of the constant prefix PMAC state (derived from key + schema + scope; not persisted). */
async function prefixState(field: string) {
  const cp = constPart(field), k = cp.length / 16; const buf = new Uint8Array(cp.length + 32); const C = new Uint32Array(cp.buffer), B = new Uint32Array(buf.buffer); const off = new Uint32Array(4);
  for (let i = 0; i < k; i++) { const l = ntz(i + 1) * 4; for (let j = 0; j < 4; j++) { off[j] ^= pm.L[l + j]; B[i * 4 + j] = C[i * 4 + j] ^ off[j]; } }
  const d = await dPoints(pm, buf, k); const sum = new Uint32Array(4); for (let i = 0; i < k; i++) for (let j = 0; j < 4; j++) sum[j] ^= d[i * 4 + j];
  return { k, off, sum };
}
type Job = { env: Uint8Array; rowId: string; field: string };
const td = new TextDecoder('utf-8', { fatal: true });
async function openBatch(jobs: Job[], prefix: Map<string, { k: number; off: Uint32Array; sum: Uint32Array }>): Promise<string[]> {
  const n = jobs.length; let r1 = 0, cbTotal = 0; const tails: Uint8Array[] = new Array(n);
  for (let i = 0; i < n; i++) { const t = tailOf(jobs[i].rowId, jobs[i].env); tails[i] = t; r1 += Math.ceil(t.length / 16) - 1; cbTotal += jobs[i].env.length - 17; }
  const b1 = new Uint8Array(r1 * 16 + 32), B1 = new Uint32Array(b1.buffer); const sums = new Uint8Array(n * 16 + 32), S = new Uint32Array(sums.buffer);
  const starts = new Int32Array(n + 1); let at = 0; const off = new Uint32Array(4); const lastB = new Uint8Array(16), LB = new Uint32Array(lastB.buffer);
  for (let i = 0; i < n; i++) {
    const pre = prefix.get(jobs[i].field)!; off.set(pre.off); const t = tails[i]; const m = Math.ceil(t.length / 16); starts[i] = at;
    const full = (m - 1) * 16; const tv = t.byteOffset % 4 === 0 ? new Uint32Array(t.buffer, t.byteOffset, full / 4) : null;
    for (let b = 0; b < m - 1; b++) { const l = ntz(pre.k + b + 1) * 4; for (let j = 0; j < 4; j++) { off[j] ^= pm.L[l + j]; } if (tv) for (let j = 0; j < 4; j++) B1[(at + b) * 4 + j] = tv[b * 4 + j] ^ off[j]; else { b1.set(t.subarray(b * 16, b * 16 + 16), (at + b) * 16); for (let j = 0; j < 4; j++) B1[(at + b) * 4 + j] ^= off[j]; } }
    at += m - 1; const tail = t.subarray(full); lastB.fill(0); lastB.set(tail);
    if (tail.length === 16) for (let j = 0; j < 4; j++) S[i * 4 + j] = pre.sum[j] ^ LB[j] ^ pm.Linv[j]; else { lastB[tail.length] = 0x80; for (let j = 0; j < 4; j++) S[i * 4 + j] = pre.sum[j] ^ LB[j]; }
  }
  starts[n] = at;
  const cb = new Uint8Array(cbTotal + 32); const spans = new Int32Array(n); let o = 0;
  for (let i = 0; i < n; i++) { spans[i] = o; const e = jobs[i].env; cb.set(e.subarray(1, e.length - 16), o); o += e.length - 17; }
  const [d1, pOut] = await Promise.all([dPoints(pm, b1, r1), cbcRaw(keB, cb, cbTotal)]);
  for (let i = 0; i < n; i++) for (let b = starts[i]; b < starts[i + 1]; b++) for (let j = 0; j < 4; j++) S[i * 4 + j] ^= d1[b * 4 + j];
  const tags = await dPoints(pm, sums, n); const T8 = new Uint8Array(tags.buffer, 0, n * 16);
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const e = jobs[i].env, tg = e.length - 16; let diff = 0; for (let j = 0; j < 16; j++) diff |= e[tg + j] ^ T8[i * 16 + j];
    if (diff) throw Error('AUTHENTICATION_FAILED');
    const s = spans[i] + 16, end = spans[i] + e.length - 17; const pad = pOut[end - 1]; if (pad < 1 || pad > 16) throw Error('AUTHENTICATION_FAILED');
    out[i] = td.decode(pOut.subarray(s, end - pad));
  }
  return out;
}
// ---------- verification fast path ----------
const plainish = /^[ -@[-~가-힣]*$/; // ASCII w/o uppercase + precomposed Hangul + space: NFC/fold are identity, only spaces to drop
const fastLegacy = (v: string) => plainish.test(v) ? v.replaceAll(' ', '') : normalizeText(v, 'legacy-text-v1');
const fastCompact = (v: string) => plainish.test(v) ? v.replaceAll(' ', '') : compact(v);

// ---------- run ----------
const res: any = { rows: rows.length, fields: rows.length * 2 };
const jobs: Job[] = [];
for (const r of rows) { jobs.push({ env: await seal(r.company, 'company', r.id), rowId: r.id, field: 'company' }); jobs.push({ env: await seal(r.memo, 'memo', r.id), rowId: r.id, field: 'memo' }); }
const prefixes = async () => new Map([['company', await prefixState('company')], ['memo', await prefixState('memo')]]);
{ // correctness, tamper, swap, truncation
  const p = await openBatch(jobs, await prefixes()); rows.forEach((r, i) => { assert.equal(p[2 * i], r.company); assert.equal(p[2 * i + 1], r.memo); });
  const bad = jobs.slice(0, 4).map(j => ({ ...j, env: Uint8Array.from(j.env) })); bad[3].env[18] ^= 0x40; await assert.rejects(openBatch(bad, await prefixes()), /AUTHENTICATION_FAILED/);
  await assert.rejects(openBatch([{ ...jobs[0], rowId: jobs[2].rowId }], await prefixes()), /AUTHENTICATION_FAILED/);
  await assert.rejects(openBatch([{ ...jobs[0], field: 'memo' }], await prefixes()), /AUTHENTICATION_FAILED/);
  const tagFlip = Uint8Array.from(jobs[1].env); tagFlip[tagFlip.length - 1] ^= 1; await assert.rejects(openBatch([{ ...jobs[1], env: tagFlip }], await prefixes()), /AUTHENTICATION_FAILED/);
  const noncePlain = rows.filter(r => !plainish.test(r.memo)).length; res.fastPathMissMemoRows = noncePlain;
  for (const r of all.slice(0, 20000)) for (const f of ['name', 'address', 'memo', 'email', 'company']) { assert.equal(fastLegacy(r[f]), normalizeText(r[f], 'legacy-text-v1')); assert.equal(fastCompact(r[f]), compact(r[f])); }
}
res.B3 = { envelopeAvgBytes: jobs.reduce((a, j) => a + j.env.length, 0) / jobs.length };
res.B3.openAllMs = await time(async () => openBatch(jobs, await prefixes()));
res.B3.usPerField = +(1000 * res.B3.openAllMs / jobs.length).toFixed(3);
const countB3 = async (fast: boolean) => { const p = await openBatch(jobs, await prefixes()); let c = 0; const L = fast ? fastLegacy : (v: string) => normalizeText(v, 'legacy-text-v1'), C = fast ? fastCompact : compact; for (let i = 0; i < rows.length; i++) if (L(p[2 * i]) === qCompany && C(p[2 * i + 1]).includes(qMemo)) c++; assert.equal(c, rows.length); return c; };
res.B3.countMs = await time(() => countB3(false));
res.B3.countFastVerifyMs = await time(() => countB3(true));
res.B3.countChunks2000RowsMs = await time(async () => { const pr = await prefixes(); for (let o = 0; o < jobs.length; o += 4000) await openBatch(jobs.slice(o, o + 4000), pr); });
res.verifyOnly = { productNormalizeMs: await time(() => { let c = 0; for (const r of rows) if (normalizeText(r.company, 'legacy-text-v1') === qCompany && compact(r.memo).includes(qMemo)) c++; return c; }),
  fastPathMs: await time(() => { let c = 0; for (const r of rows) if (fastLegacy(r.company) === qCompany && fastCompact(r.memo).includes(qMemo)) c++; return c; }) };

// ---------- B1 eq tag (optimized): T = D_Kt(uuid xor h(v)); compare u32x4 ----------
const hexv = new Int8Array(128).fill(-1); '0123456789abcdef'.split('').forEach((c, i) => { hexv[c.charCodeAt(0)] = i; });
function uuidInto(id: string, dst: Uint8Array, at: number) { let k = 0; for (let i = 0; i < id.length; i++) { const c = id.charCodeAt(i); if (c === 45) continue; const v = hexv[c]; if (k & 1) dst[at + (k >> 1)] |= v; else dst[at + (k >> 1)] = v << 4; k++; } }
const kh = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(21), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const kt = await bk(new Uint8Array(32).fill(22));
const h = async (v: string) => new Uint32Array((await crypto.subtle.sign('HMAC', kh, utf8(v))).slice(0, 16));
async function tags(ids: string[], hv: Uint32Array[] | Uint32Array): Promise<Uint32Array> {
  const buf = new Uint8Array(ids.length * 16 + 32); const B = new Uint32Array(buf.buffer);
  for (let i = 0; i < ids.length; i++) { uuidInto(ids[i], buf, i * 16); const x = Array.isArray(hv) ? hv[i] : hv; for (let j = 0; j < 4; j++) B[i * 4 + j] ^= x[j]; }
  return dPoints(kt, buf, ids.length);
}
const ids = rows.map(r => r.id);
const stored = await tags(ids, await Promise.all(rows.map(r => h(normalizeText(r.company, 'legacy-text-v1')))));
const b1 = async (q: string) => { const t = await tags(ids, await h(q)); let ok = 0; for (let i = 0; i < ids.length; i++) { const o = i * 4; if (t[o] === stored[o] && t[o + 1] === stored[o + 1] && t[o + 2] === stored[o + 2] && t[o + 3] === stored[o + 3]) ok++; } return ok; };
assert.equal(await b1(qCompany), rows.length); assert.equal(await b1(normalizeText('서울서비스 중앙지사', 'legacy-text-v1')), 0);
res.B1 = { verifyAllMs: await time(() => b1(qCompany)) }; res.B1.usPerRow = +(1000 * res.B1.verifyAllMs / rows.length).toFixed(3);

// ---------- reference: product GCM path, same count ----------
const sealer = createSealer({ key: new Uint8Array(32).fill(93) }); const ring = sealer.ring('customers');
const spec: FieldSpec = { type: 'text', search: { exact: true, substring: { wordBoundary: true, skipGrams: true } } };
const ctx = (fieldId: string, rowId: string): CipherContext => ({ modelId: 'customers', fieldId, keyScopeId: ring.keyScopeId, scopeId, rowId, spec });
const g = [] as { b: Uint8Array; c: CipherContext }[]; for (const r of rows) { g.push({ b: await sealer.seal(r.company, ctx('company', r.id), ring), c: ctx('company', r.id) }); g.push({ b: await sealer.seal(r.memo, ctx('memo', r.id), ring), c: ctx('memo', r.id) }); }
const gcmCount = async (lazyCompanyTag: boolean) => {
  let c = 0; const certified = lazyCompanyTag ? await b1(qCompany) : 0; // B1 variant: company certified by tag, memo decrypted
  for (let o = 0; o < g.length; o += 128) {
    const w = g.slice(o, o + 128).filter((_, i) => !lazyCompanyTag || i % 2 === 1); const out: unknown[] = new Array(w.length); let k = 0;
    await Promise.all(Array.from({ length: 64 }, async () => { while (k < w.length) { const i = k++; out[i] = await sealer.open(w[i].b, w[i].c, ring); } }));
    if (lazyCompanyTag) { for (const m of out) if (compact(m as string).includes(qMemo)) c++; }
    else for (let i = 0; i < out.length; i += 2) if (normalizeText(out[i] as string, 'legacy-text-v1') === qCompany && compact(out[i + 1] as string).includes(qMemo)) c++;
  }
  assert.equal(c, rows.length); if (lazyCompanyTag) assert.equal(certified, rows.length); return c;
};
res.gcmCurrentCountMs = await time(() => gcmCount(false));
res.gcmPlusB1CountMs = await time(() => gcmCount(true));
res.env = { node: process.version, platform: process.platform, note: 'in-memory, no DB; median of 7 after 2 warmups' };
writeFileSync('bench/results/2026-09-28-count-research/r2-b3-fast.json', JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));

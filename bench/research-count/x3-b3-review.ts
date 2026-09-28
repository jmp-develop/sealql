/**
 * X3 adversarial review of B3 (EtM AES-CBC + PMAC over AES^-1) and standard-mode alternatives. Memory only, no DB.
 *  Part 1: B3 prototype core copied from b3-fast.ts (unchanged logic) + attack/property tests.
 *  Part 2: cost of alternatives on the same and2 row set (company + memo, 21,176 rows = 42,352 fields):
 *    gcmField  : AES-256-GCM per field (raw WebCrypto, pool 64)                         -- current format, no Sealer glue
 *    gcmRow    : one AES-256-GCM per row over frame([company, memo])                      -- row envelope
 *    cbcHmacWC : EtM AES-256-CBC + HMAC-SHA-512/256 (WebCrypto sign per field, pool 64), CBC batch-decrypted in 1 call
 *    cbcHmacJS : EtM AES-256-CBC + HMAC-SHA-256 in plain JS (ARX, no tables), CBC batch-decrypted in 1 call
 *    b3        : B3 openBatch (reference)
 * Usage: npx tsx bench/research-count/x3-b3-review.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { frame, utf8 } from '../../src/core/bytes.js';
import { normalizeText } from '../../src/core/search-tokens.js';

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
async function time(fn: () => unknown) { for (let i = 0; i < 2; i++) await fn(); const t: number[] = []; for (let i = 0; i < 7; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); } return +med(t).toFixed(3); }
async function pool<T, R>(n: number, xs: T[], f: (x: T, i: number) => Promise<R>): Promise<R[]> { const out: R[] = new Array(xs.length); let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < xs.length) { const i = k++; out[i] = await f(xs[i], i); } })); return out; }
const ws = new RegExp('[' + [[9, 13], [32, 32], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
const compact = (v: string) => normalizeText(v, 'legacy-text-v1').replace(ws, '');
const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const qCompany = normalizeText('서울서비스 담당', 'legacy-text-v1'), qMemo = compact('서비스');
const all = JSON.parse(readFileSync('.local/research/r2-fixture.json', 'utf8')) as Record<string, string>[];
const rows = all.filter(r => normalizeText(r.company, 'legacy-text-v1') === qCompany && compact(r.memo).includes(qMemo));
const res: any = { rows: rows.length, fields: rows.length * 2 };

// ================= Part 1: B3 core (copied from b3-fast.ts) =================
type BK = { k: CryptoKey; x0: Uint8Array };
async function bk(bytes: Uint8Array): Promise<BK> { const k = await crypto.subtle.importKey('raw', bytes, 'AES-CBC', false, ['encrypt', 'decrypt']); return { k, x0: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, k, new Uint8Array(0))) }; }
async function cbcRaw(key: BK, buf: Uint8Array, dataLen: number): Promise<Uint8Array> { buf.fill(0, dataLen, dataLen + 16); buf.set(key.x0, dataLen + 16); return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key.k, buf.subarray(0, dataLen + 32))); }
async function dPoints(key: BK, buf: Uint8Array, n: number): Promise<Uint32Array> { const out = await cbcRaw(key, buf, n * 16); const o = new Uint32Array(out.buffer, 0, n * 4), x = new Uint32Array(buf.buffer, buf.byteOffset, n * 4); for (let i = n * 4 - 1; i >= 4; i--) o[i] ^= x[i - 4]; return o; }
const dbl = (b: Uint8Array) => { const r = new Uint8Array(16); let c = 0; for (let i = 15; i >= 0; i--) { r[i] = ((b[i] << 1) | c) & 0xff; c = b[i] >> 7; } if (b[0] & 0x80) r[15] ^= 0x87; return r; };
const half = (b: Uint8Array) => { const lsb = b[15] & 1; const x = Uint8Array.from(b); if (lsb) x[15] ^= 0x87; const r = new Uint8Array(16); let c = lsb; for (let i = 0; i < 16; i++) { r[i] = (x[i] >> 1) | (c << 7); c = x[i] & 1; } return r; };
const ntz = (i: number) => 31 - Math.clz32(i & -i);
type PK = BK & { L: Uint32Array; Linv: Uint32Array };
async function pk(bytes: Uint8Array): Promise<PK> { const b = await bk(bytes); const z = new Uint8Array(48); const L0 = new Uint8Array((await dPoints(b, z, 1)).buffer.slice(0, 16)); const L = new Uint8Array(64 * 16); let cur = L0; for (let i = 0; i < 64; i++) { L.set(cur, i * 16); cur = dbl(cur); } return { ...b, L: new Uint32Array(L.buffer), Linv: new Uint32Array(half(L0).buffer) }; }
async function pmacRef(p: PK, msg: Uint8Array): Promise<Uint8Array> {
  const m = Math.max(1, Math.ceil(msg.length / 16)); const buf = new Uint8Array(m * 16 + 32); const off = new Uint32Array(4);
  const mm = new Uint8Array(m * 16); mm.set(msg); const M = new Uint32Array(mm.buffer), B = new Uint32Array(buf.buffer);
  for (let i = 0; i < m - 1; i++) { const l = ntz(i + 1) * 4; for (let j = 0; j < 4; j++) { off[j] ^= p.L[l + j]; B[i * 4 + j] = M[i * 4 + j] ^ off[j]; } }
  const d = m > 1 ? await dPoints(p, buf, m - 1) : new Uint32Array(0);
  const last = new Uint8Array(16); const tail = msg.subarray((m - 1) * 16); const sum = new Uint32Array(4);
  if (tail.length === 16) { last.set(tail); const T = new Uint32Array(last.buffer); for (let j = 0; j < 4; j++) sum[j] = T[j] ^ p.Linv[j]; } else { last.set(tail); last[tail.length] = 0x80; sum.set(new Uint32Array(last.buffer)); }
  for (let i = 0; i < m - 1; i++) for (let j = 0; j < 4; j++) sum[j] ^= d[i * 4 + j];
  const b2 = new Uint8Array(48); b2.set(new Uint8Array(sum.buffer)); return new Uint8Array((await dPoints(p, b2, 1)).buffer.slice(0, 16));
}
const ke = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(31), 'AES-CBC', false, ['encrypt']);
const keB = await bk(new Uint8Array(32).fill(31)), pm = await pk(new Uint8Array(32).fill(32));
const constPart = (field: string) => { const f = frame(['sealql/aad/v4', 'customers', field, 'text', '1', 'global', scopeId]); const r = new Uint8Array(Math.ceil(f.length / 16) * 16); r.set(f); return r; };
const enc = new TextEncoder();
function tailOf(rowId: string, env: Uint8Array): Uint8Array { const rb = enc.encode(rowId); const t = new Uint8Array(4 + rb.length + env.length - 17); new DataView(t.buffer).setUint32(0, rb.length); t.set(rb, 4); t.set(env.subarray(1, env.length - 16), 4 + rb.length); return t; }
async function seal(plain: Uint8Array, field: string, rowId: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(16)); const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ke, plain));
  const env = new Uint8Array(1 + 16 + c.length + 16); env[0] = 4; env.set(iv, 1); env.set(c, 17);
  const cp = constPart(field), tl = tailOf(rowId, env); const msg = new Uint8Array(cp.length + tl.length); msg.set(cp); msg.set(tl, cp.length);
  env.set(await pmacRef(pm, msg), env.length - 16); return env;
}
async function prefixState(field: string) {
  const cp = constPart(field), k = cp.length / 16; const buf = new Uint8Array(cp.length + 32); const C = new Uint32Array(cp.buffer), B = new Uint32Array(buf.buffer); const off = new Uint32Array(4);
  for (let i = 0; i < k; i++) { const l = ntz(i + 1) * 4; for (let j = 0; j < 4; j++) { off[j] ^= pm.L[l + j]; B[i * 4 + j] = C[i * 4 + j] ^ off[j]; } }
  const d = await dPoints(pm, buf, k); const sum = new Uint32Array(4); for (let i = 0; i < k; i++) for (let j = 0; j < 4; j++) sum[j] ^= d[i * 4 + j];
  return { k, off, sum };
}
type Job = { env: Uint8Array; rowId: string; field: string };
const td = new TextDecoder('utf-8', { fatal: true });
/** mode 'throw' = b3-fast behaviour; mode 'collect' = hypothetical per-item error reporting (to test robustness of the batch layout). */
async function openBatch(jobs: Job[], prefix: Map<string, any>, mode: 'throw' | 'collect' = 'throw'): Promise<(string | Error)[]> {
  const n = jobs.length; let r1 = 0, cbTotal = 0; const tails: Uint8Array[] = new Array(n);
  for (let i = 0; i < n; i++) { const t = tailOf(jobs[i].rowId, jobs[i].env); tails[i] = t; r1 += Math.ceil(t.length / 16) - 1; cbTotal += jobs[i].env.length - 17; }
  const b1 = new Uint8Array(r1 * 16 + 32), B1 = new Uint32Array(b1.buffer); const sums = new Uint8Array(n * 16 + 32), S = new Uint32Array(sums.buffer);
  const starts = new Int32Array(n + 1); let at = 0; const off = new Uint32Array(4); const lastB = new Uint8Array(16), LB = new Uint32Array(lastB.buffer);
  for (let i = 0; i < n; i++) {
    const pre = prefix.get(jobs[i].field)!; off.set(pre.off); const t = tails[i]; const m = Math.ceil(t.length / 16); starts[i] = at;
    const full = (m - 1) * 16;
    for (let b = 0; b < m - 1; b++) { const l = ntz(pre.k + b + 1) * 4; for (let j = 0; j < 4; j++) off[j] ^= pm.L[l + j]; b1.set(t.subarray(b * 16, b * 16 + 16), (at + b) * 16); for (let j = 0; j < 4; j++) B1[(at + b) * 4 + j] ^= off[j]; }
    at += m - 1; const tail = t.subarray(full); lastB.fill(0); lastB.set(tail);
    if (tail.length === 16) for (let j = 0; j < 4; j++) S[i * 4 + j] = pre.sum[j] ^ LB[j] ^ pm.Linv[j]; else { lastB[tail.length] = 0x80; for (let j = 0; j < 4; j++) S[i * 4 + j] = pre.sum[j] ^ LB[j]; }
  }
  starts[n] = at;
  const cb = new Uint8Array(cbTotal + 32); const spans = new Int32Array(n); let o = 0;
  for (let i = 0; i < n; i++) { spans[i] = o; const e = jobs[i].env; cb.set(e.subarray(1, e.length - 16), o); o += e.length - 17; }
  const [d1, pOut] = await Promise.all([dPoints(pm, b1, r1), cbcRaw(keB, cb, cbTotal)]);
  for (let i = 0; i < n; i++) for (let b = starts[i]; b < starts[i + 1]; b++) for (let j = 0; j < 4; j++) S[i * 4 + j] ^= d1[b * 4 + j];
  const tags = await dPoints(pm, sums, n); const T8 = new Uint8Array(tags.buffer, 0, n * 16);
  const out: (string | Error)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    try {
      const e = jobs[i].env, tg = e.length - 16; let diff = 0; for (let j = 0; j < 16; j++) diff |= e[tg + j] ^ T8[i * 16 + j];
      if (diff) throw Error('AUTHENTICATION_FAILED');
      const s = spans[i] + 16, end = spans[i] + e.length - 17; const pad = pOut[end - 1]; if (pad < 1 || pad > 16) throw Error('AUTHENTICATION_FAILED');
      out[i] = td.decode(pOut.subarray(s, end - pad));
    } catch (err) { if (mode === 'throw') throw err; out[i] = err as Error; }
  }
  return out;
}
const prefixes = async () => new Map([['company', await prefixState('company')], ['memo', await prefixState('memo')]]);
const jobs: Job[] = [];
for (const r of rows) { jobs.push({ env: await seal(utf8(r.company), 'company', r.id), rowId: r.id, field: 'company' }); jobs.push({ env: await seal(utf8(r.memo), 'memo', r.id), rowId: r.id, field: 'memo' }); }
const P = await prefixes();
const t: Record<string, string> = {};
const outcome = async (js: Job[], mode: 'throw' | 'collect' = 'throw') => { try { return await openBatch(js, P, mode); } catch (e) { return (e as Error).name === 'Error' ? (e as Error).message : `${(e as Error).name}: ${(e as Error).message}`; } };
{
  // A1 header byte is neither MACed nor checked by openBatch
  const e = Uint8Array.from(jobs[0].env); e[0] = 0x03; const r = await outcome([{ ...jobs[0], env: e }]);
  t.headerByteChangedTo3 = Array.isArray(r) && r[0] === rows[0].company ? 'ACCEPTED (header not authenticated, not checked)' : `rejected: ${r}`;
  // A2 misaligned (forged) envelope in the middle, per-item error mode: do later AUTHENTIC items decrypt correctly?
  // 1-byte misalignment of the total: WebCrypto rejects the whole CBC call (before any tag check)
  t.misaligned1Byte = String(await outcome([jobs[0], jobs[1], { ...jobs[2], env: jobs[2].env.subarray(0, jobs[2].env.length - 1) }, jobs[3]]));
  // two forged items each 8 bytes short: total stays block aligned, authentic items 3,4 between them are shifted by 8 bytes
  const cut8 = (e: Uint8Array) => e.subarray(0, e.length - 8);
  const js = [jobs[0], jobs[1], { ...jobs[2], env: cut8(jobs[2].env) }, jobs[3], jobs[4], { ...jobs[5], env: cut8(jobs[5].env) }];
  const r2 = await outcome(js, 'collect');
  if (Array.isArray(r2)) { const exp = (i: number) => (i % 2 ? rows[i >> 1].memo : rows[i >> 1].company);
    t.misaligned8x2CollectMode = [2, 3, 4, 5].map(i => `item${i}=${r2[i] instanceof Error ? (r2[i] as Error).message : r2[i] === exp(i) ? 'correct' : 'WRONG PLAINTEXT ACCEPTED'}`).join('; ');
  } else t.misaligned8x2CollectMode = r2;
  t.misaligned8x2ThrowMode = String(await outcome(js));
  // A3 too-short envelopes: error type
  t.len20 = String(await outcome([{ ...jobs[0], env: jobs[0].env.subarray(0, 20) }]));
  t.len0 = String(await outcome([{ ...jobs[0], env: new Uint8Array(0) }]));
  // A4 splices: swap one C block between company and memo of the same row at the same offset; IV swap; tag swap; append block
  const c = Uint8Array.from(jobs[0].env), m = Uint8Array.from(jobs[1].env); c.set(jobs[1].env.subarray(17, 33), 17); m.set(jobs[0].env.subarray(17, 33), 17);
  t.blockSwapCrossField = String(await outcome([{ ...jobs[0], env: c }, { ...jobs[1], env: m }]));
  const ivs = Uint8Array.from(jobs[0].env); ivs.set(jobs[2].env.subarray(1, 17), 1); t.ivFromOtherRow = String(await outcome([{ ...jobs[0], env: ivs }]));
  const ext = new Uint8Array(jobs[1].env.length + 16); ext.set(jobs[1].env.subarray(0, jobs[1].env.length - 16)); ext.set(jobs[1].env.subarray(17, 33), jobs[1].env.length - 16); ext.set(jobs[1].env.subarray(jobs[1].env.length - 16), jobs[1].env.length);
  t.blockExtension = String(await outcome([{ ...jobs[1], env: ext }]));
  // A5 property: batch path == reference PMAC for all rowId lengths 1..48 and plaintext lengths 0..80 (covers full/partial last block, prefix/tail seam)
  let n = 0; const pj: Job[] = []; const want: string[] = [];
  for (let rl = 1; rl <= 48; rl++) for (let pl = 0; pl <= 80; pl += 1) { const rid = 'r'.repeat(rl), v = 'x'.repeat(pl); pj.push({ env: await seal(utf8(v), pl % 2 ? 'memo' : 'company', rid), rowId: rid, field: pl % 2 ? 'memo' : 'company' }); want.push(v); n++; }
  const got = await openBatch(pj, P); assert.deepEqual(got, want); t.batchEqualsReference = `ok (${n} envelopes)`;
  // A6 single-bit flips at every byte position of one envelope (each alone) must all fail
  let accepted = 0; const e0 = jobs[1].env;
  for (let i = 1; i < e0.length; i++) for (let bit = 0; bit < 8; bit += 7) { const e = Uint8Array.from(e0); e[i] ^= 1 << bit; const r = await outcome([{ ...jobs[1], env: e }]); if (Array.isArray(r)) accepted++; }
  t.bitFlipsAccepted = `${accepted}/${(e0.length - 1) * 2} (byte 0 excluded, see headerByte)`;
}
res.b3Attacks = t;

// ================= Part 2: alternatives =================
const aadPrefix = frame(['sealql/aad/v3', 'customers', 'FIELD', 'text', '1', 'global']);
const aadOf = (field: string, rowId: string) => frame(['sealql/aad/v3', 'customers', field, 'text', '1', 'global', scopeId, rowId]);
void aadPrefix;
// (a) GCM per field, (b) GCM per row
const kg = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(41), 'AES-GCM', false, ['encrypt', 'decrypt']);
const gcmSeal = async (p: Uint8Array, aad: Uint8Array) => { const iv = crypto.getRandomValues(new Uint8Array(12)); return { iv, c: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, kg, p)) }; };
const gField = await Promise.all(rows.flatMap(r => [gcmSeal(utf8(r.company), aadOf('company', r.id)), gcmSeal(utf8(r.memo), aadOf('memo', r.id))]));
const gRow = await Promise.all(rows.map(r => gcmSeal(frame([r.company, r.memo]), aadOf('row:company,memo', r.id))));
const gcmFieldRun = () => pool(64, gField, async (x, i) => td.decode(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: x.iv, additionalData: aadOf(i % 2 ? 'memo' : 'company', rows[i >> 1].id) }, kg, x.c))));
const gcmRowRun = () => pool(64, gRow, async (x, i) => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: x.iv, additionalData: aadOf('row:company,memo', rows[i].id) }, kg, x.c)));
assert.equal((await gcmFieldRun())[1], rows[0].memo); await gcmRowRun();

// (c)/(d) EtM CBC + HMAC.  Envelope [5][IV16][C][tag32]; MAC input = AAD || IV || C || u64be(8*|AAD|) (RFC 7518 5.2 layout)
const kc = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(51), 'AES-CBC', false, ['encrypt']); const kcB = await bk(new Uint8Array(32).fill(51));
const macKeyBytes = new Uint8Array(32).fill(52);
const km512 = await crypto.subtle.importKey('raw', macKeyBytes, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
const km256 = await crypto.subtle.importKey('raw', macKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
function macInput(aad: Uint8Array, env: Uint8Array, tagLen: number): Uint8Array { const body = env.subarray(1, env.length - tagLen); const m = new Uint8Array(aad.length + body.length + 8); m.set(aad); m.set(body, aad.length); new DataView(m.buffer).setBigUint64(m.length - 8, BigInt(aad.length * 8)); return m; }
// --- plain-JS SHA-256 / HMAC (constants derived, then differentially tested against WebCrypto) ---
const primes: number[] = []; for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
const KK = Int32Array.from(primes, p => Math.floor((Math.cbrt(p) % 1) * 2 ** 32) | 0);
const H0 = Int32Array.from(primes.slice(0, 8), p => Math.floor((Math.sqrt(p) % 1) * 2 ** 32) | 0);
const W = new Int32Array(64);
function compress(H: Int32Array, M: Uint8Array, off: number) {
  for (let i = 0; i < 16; i++) W[i] = (M[off + 4 * i] << 24) | (M[off + 4 * i + 1] << 16) | (M[off + 4 * i + 2] << 8) | M[off + 4 * i + 3];
  for (let i = 16; i < 64; i++) { const a = W[i - 15], b = W[i - 2]; W[i] = (W[i - 16] + (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + W[i - 7] + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10))) | 0; }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + KK[i] + W[i]) | 0;
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}
function finish(state: Int32Array, prefixLen: number, msg: Uint8Array, out: Uint8Array) {
  const H = Int32Array.from(state); const total = prefixLen + msg.length; const padded = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64);
  padded.set(msg); padded[msg.length] = 0x80; const dv = new DataView(padded.buffer); dv.setUint32(padded.length - 8, Math.floor(total / 2 ** 29)); dv.setUint32(padded.length - 4, (total * 8) >>> 0);
  for (let o = 0; o < padded.length; o += 64) compress(H, padded, o);
  const odv = new DataView(out.buffer, out.byteOffset); for (let i = 0; i < 8; i++) odv.setInt32(4 * i, H[i]);
}
const pad = (x: number) => { const b = new Uint8Array(64); b.set(macKeyBytes); for (let i = 0; i < 64; i++) b[i] ^= x; return b; };
const iState = Int32Array.from(H0); compress(iState, pad(0x36), 0); const oState = Int32Array.from(H0); compress(oState, pad(0x5c), 0); // key-derived constants
const inner = new Uint8Array(32);
function hmacJs(msg: Uint8Array, out: Uint8Array) { finish(iState, 64, msg, inner); finish(oState, 64, inner, out); }
{ // differential test vs WebCrypto HMAC-SHA-256, lengths 0..300 plus random
  const o = new Uint8Array(32);
  for (let L = 0; L <= 300; L++) { const m = crypto.getRandomValues(new Uint8Array(L)); hmacJs(m, o); assert.deepEqual(o, new Uint8Array(await crypto.subtle.sign('HMAC', km256, m))); }
  res.jsHmacDifferential = 'ok: 301 lengths equal to WebCrypto HMAC-SHA-256';
}
async function etmSeal(p: Uint8Array, aad: Uint8Array, js: boolean) {
  const iv = crypto.getRandomValues(new Uint8Array(16)); const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, kc, p));
  const env = new Uint8Array(1 + 16 + c.length + 32); env[0] = 5; env.set(iv, 1); env.set(c, 17);
  const mi = macInput(aad, env, 32); const tag = new Uint8Array(32);
  if (js) hmacJs(mi, tag); else tag.set(new Uint8Array(await crypto.subtle.sign('HMAC', km512, mi)).subarray(0, 32));
  env.set(tag, env.length - 32); return env;
}
/** EtM open batch: shape check -> all tags verified (constant-time compare) -> ONE CBC decrypt of only authenticated data -> full PKCS#7 check. */
async function etmOpenBatch(envs: Uint8Array[], aads: Uint8Array[], js: boolean): Promise<string[]> {
  const n = envs.length; const tags = new Uint8Array(n * 32);
  for (const e of envs) if (!(e.length >= 65 && (e.length - 49) % 16 === 0 && e[0] === 5)) throw Error('INVALID_CIPHERTEXT');
  if (js) for (let i = 0; i < n; i++) hmacJs(macInput(aads[i], envs[i], 32), tags.subarray(i * 32, i * 32 + 32));
  else await pool(64, envs, async (e, i) => { tags.set(new Uint8Array(await crypto.subtle.sign('HMAC', km512, macInput(aads[i], e, 32))).subarray(0, 32), i * 32); });
  let bad = 0; for (let i = 0; i < n; i++) { const e = envs[i], o = e.length - 32; for (let j = 0; j < 32; j++) bad |= e[o + j] ^ tags[i * 32 + j]; }
  if (bad) throw Error('AUTHENTICATION_FAILED');
  let total = 0; for (const e of envs) total += e.length - 33; const cb = new Uint8Array(total + 32); const spans = new Int32Array(n); let o = 0;
  for (let i = 0; i < n; i++) { spans[i] = o; cb.set(envs[i].subarray(1, envs[i].length - 32), o); o += envs[i].length - 33; }
  const p = await cbcRaw(kcB, cb, total); const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) { const s = spans[i] + 16, end = spans[i] + envs[i].length - 33, k = p[end - 1]; let ok = k >= 1 && k <= 16 ? 0 : 1; for (let j = 1; j <= 16; j++) ok |= (j <= k ? 1 : 0) & (p[end - j] !== k ? 1 : 0); if (ok) throw Error('INVALID_CIPHERTEXT'); out[i] = td.decode(p.subarray(s, end - k)); }
  return out;
}
const aads = rows.flatMap(r => [aadOf('company', r.id), aadOf('memo', r.id)]);
const plains = rows.flatMap(r => [r.company, r.memo]);
const eWC = await Promise.all(plains.map((v, i) => etmSeal(utf8(v), aads[i], false)));
const eJS = await Promise.all(plains.map((v, i) => etmSeal(utf8(v), aads[i], true)));
assert.deepEqual(await etmOpenBatch(eWC, aads, false), plains); assert.deepEqual(await etmOpenBatch(eJS, aads, true), plains);
{ const x = eJS.slice(0, 4).map(e => Uint8Array.from(e)); x[3][20] ^= 1; await assert.rejects(etmOpenBatch(x, aads.slice(0, 4), true), /AUTHENTICATION_FAILED/);
  await assert.rejects(etmOpenBatch([eJS[0]], [aads[2]], true), /AUTHENTICATION_FAILED/); }
res.costMs = {
  gcmField: await time(gcmFieldRun),
  gcmRow: await time(gcmRowRun),
  cbcHmacWC: await time(() => etmOpenBatch(eWC, aads, false)),
  cbcHmacJS: await time(() => etmOpenBatch(eJS, aads, true)),
  cbcHmacJS_chunks4000: await time(async () => { for (let o = 0; o < eJS.length; o += 4000) await etmOpenBatch(eJS.slice(o, o + 4000), aads.slice(o, o + 4000), true); }),
  b3: await time(() => openBatch(jobs, P)),
};
res.usPerField = Object.fromEntries(Object.entries(res.costMs).map(([k, v]) => [k, +(1000 * (v as number) / res.fields).toFixed(3)]));
res.callsPerCount = { gcmField: res.fields, gcmRow: res.rows, cbcHmacWC: res.fields + 1, cbcHmacJS: 1, b3: 3 };
res.env = { node: process.version, platform: process.platform, note: 'in-memory, no DB; median of 7 after 2 warmups; raw WebCrypto, no Sealer glue' };
writeFileSync('bench/results/2026-09-28-count-research/x3-b3-review.json', JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));

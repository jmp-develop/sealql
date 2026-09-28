/**
 * X4 CBC+HMAC core (runtime-neutral: WebCrypto + plain JS only, bundles for workerd).
 * EtM: AES-256-CBC random IV (WebCrypto) + HMAC-SHA-256 (pure JS, ARX only, no tables), RFC 7518 §5.2 MAC layout:
 *   envelope = [HDR][IV16][C][tag32],  tag = HMAC(macKey, A | IV | C | u64be(8*|A|)),  A = [HDR] | v3 AAD frame (built by caller).
 * Open order (X3 fixes): shape check -> ALL tags verified (constant-time accumulate, no early exit) -> ONE CBC decrypt call of
 * authenticated items only -> full PKCS#7 check -> strict UTF-8 (BOM rejected). Every failure = AUTHENTICATION_FAILED
 * (bad UTF-8 after a valid tag = INVALID_CIPHERTEXT, same as the product text codec).
 * Research only, not product code.
 */
export const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export const H0 = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const W = new Int32Array(64);
/** FIPS 180-4 compression over `blocks` 64-byte blocks of M starting at off. */
export function compress(H: Int32Array, M: Uint8Array, off: number, blocks: number) {
  let h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3], h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7];
  for (let blk = 0; blk < blocks; blk++, off += 64) {
    for (let i = 0; i < 16; i++) { const o = off + 4 * i; W[i] = (M[o] << 24) | (M[o + 1] << 16) | (M[o + 2] << 8) | M[o + 3]; }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      W[i] = (W[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + W[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  H[0] = h0; H[1] = h1; H[2] = h2; H[3] = h3; H[4] = h4; H[5] = h5; H[6] = h6; H[7] = h7;
}
function putLen(buf: Uint8Array, at: number, bytes: number) { // u64be(8*bytes), bytes < 2^50
  const bits = bytes * 8, hi = Math.floor(bits / 2 ** 32), lo = bits >>> 0;
  buf[at] = hi >>> 24; buf[at + 1] = hi >>> 16; buf[at + 2] = hi >>> 8; buf[at + 3] = hi;
  buf[at + 4] = lo >>> 24; buf[at + 5] = lo >>> 16; buf[at + 6] = lo >>> 8; buf[at + 7] = lo;
}
function digestOut(H: Int32Array, out: Uint8Array, o = 0) { for (let i = 0; i < 8; i++) { const v = H[i]; out[o + 4 * i] = v >>> 24; out[o + 4 * i + 1] = v >>> 16; out[o + 4 * i + 2] = v >>> 8; out[o + 4 * i + 3] = v; } }
/** Generic SHA-256 (continues from state H after `prefixBytes` already absorbed). */
export function sha256From(H: Int32Array, prefixBytes: number, msg: Uint8Array): Uint8Array {
  const S = Int32Array.from(H); const full = msg.length >> 6; compress(S, msg, 0, full);
  const rest = msg.length - full * 64; const t = new Uint8Array(rest + 9 > 64 ? 128 : 64);
  t.set(msg.subarray(full * 64)); t[rest] = 0x80; putLen(t, t.length - 8, prefixBytes + msg.length); compress(S, t, 0, t.length >> 6);
  const out = new Uint8Array(32); digestOut(S, out); return out;
}
export const sha256 = (msg: Uint8Array) => sha256From(H0, 0, msg);
/** RFC 2104 HMAC-SHA-256, any key length. */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const mk = macKey(key); const inner = sha256From(mk.i, 64, msg); return sha256From(mk.o, 64, inner);
}
export type MacKey = { i: Int32Array; o: Int32Array };
/** ipad/opad states: key-derived constants only (server-cache principle). */
export function macKey(key: Uint8Array): MacKey {
  const k = new Uint8Array(64); k.set(key.length > 64 ? sha256(key) : key);
  const pad = (x: number) => { const b = new Uint8Array(64); for (let j = 0; j < 64; j++) b[j] = k[j] ^ x; return b; };
  const i = Int32Array.from(H0); compress(i, pad(0x36), 0, 1); const o = Int32Array.from(H0); compress(o, pad(0x5c), 0, 1); return { i, o };
}
/** Inner-hash state after absorbing the full 64-byte blocks of the per-call constant prefix P (= A without the rowId part). */
export type Prefix = { h: Int32Array; rem: Uint8Array; plen: number };
export function prefix(mk: MacKey, P: Uint8Array): Prefix {
  const h = Int32Array.from(mk.i); const full = P.length >> 6; compress(h, P, 0, full); return { h, rem: P.slice(full * 64), plen: P.length };
}
let scratch = new Uint8Array(8192);
const hs = new Int32Array(8), ob = new Uint8Array(64);
/**
 * Tag over  P | u32be(len(row)) | row | body | u64be(8*|A|),  |A| = plen + 4 + len(row).  rowId must be ASCII (UUID, checked by caller).
 * Returns the final state in `hs` (8 words, big-endian digest words).
 */
function tagState(mk: MacKey, p: Prefix, rowId: string, env: Uint8Array, bs: number, be: number) {
  const rl = rowId.length, rem = p.rem, bl = be - bs, alen = p.plen + 4 + rl;
  const msgLen = rem.length + 4 + rl + bl + 8, padded = (msgLen + 9 + 63) & ~63;
  if (scratch.length < padded) scratch = new Uint8Array(padded * 2);
  const s = scratch; s.set(rem); let o = rem.length;
  s[o] = rl >>> 24; s[o + 1] = rl >>> 16; s[o + 2] = rl >>> 8; s[o + 3] = rl; o += 4;
  for (let j = 0; j < rl; j++) s[o + j] = rowId.charCodeAt(j);
  o += rl; s.set(env.subarray(bs, be), o); o += bl; putLen(s, o, alen); o += 8;
  s[o++] = 0x80; s.fill(0, o, padded - 8); putLen(s, padded - 8, 64 + p.plen + (msgLen - rem.length));
  hs.set(p.h); compress(hs, s, 0, padded >> 6);
  digestOut(hs, ob); ob[32] = 0x80; ob.fill(0, 33, 62); ob[62] = 0x03; ob[63] = 0x00; // outer: 64 + 32 bytes = 768 bits
  hs.set(mk.o); compress(hs, ob, 0, 1);
}
export function tagInto(mk: MacKey, p: Prefix, rowId: string, env: Uint8Array, bs: number, be: number, out: Uint8Array, oo: number) { tagState(mk, p, rowId, env, bs, be); digestOut(hs, out, oo); }
/** XOR-accumulated difference of the computed tag and env[to..to+32) (no early exit). */
export function tagDiff(mk: MacKey, p: Prefix, rowId: string, env: Uint8Array, bs: number, be: number, to: number): number {
  tagState(mk, p, rowId, env, bs, be); let d = 0;
  for (let i = 0; i < 8; i++) { const o = to + 4 * i; d |= hs[i] ^ ((env[o] << 24) | (env[o + 1] << 16) | (env[o + 2] << 8) | env[o + 3]); }
  return d;
}
export type Cbc = { enc: CryptoKey; dec: CryptoKey; x0: Uint8Array };
export async function cbcKeys(encBytes: Uint8Array): Promise<Cbc> {
  const enc = await crypto.subtle.importKey('raw', encBytes as Uint8Array<ArrayBuffer>, 'AES-CBC', false, ['encrypt']);
  const dec = await crypto.subtle.importKey('raw', encBytes as Uint8Array<ArrayBuffer>, 'AES-CBC', false, ['decrypt', 'encrypt']);
  // X0 = E(0x10^16): appended after a zero block so the batch always ends in valid PKCS#7 (key-derived constant)
  const x0 = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, dec, new Uint8Array(0)));
  return { enc, dec, x0: x0.subarray(0, 16) };
}
/** One WebCrypto AES-CBC decrypt over buf[0..dataLen) (+32 B trailer written here). Output block j = D(C_j) ^ C_{j-1}. */
export async function cbcRawDecrypt(k: Cbc, buf: Uint8Array, dataLen: number): Promise<Uint8Array> {
  buf.fill(0, dataLen, dataLen + 16); buf.set(k.x0, dataLen + 16);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, k.dec, buf.subarray(0, dataLen + 32) as Uint8Array<ArrayBuffer>));
}
export class CryptoError extends Error {}
const td = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export type Job = { env: Uint8Array; rowId: string; pre: Prefix };
export const stats = { macs: 0, decrypts: 0, cbcCalls: 0, macMs: 0, cbcMs: 0, decodeMs: 0 };
export function resetStats() { Object.assign(stats, { macs: 0, decrypts: 0, cbcCalls: 0, macMs: 0, cbcMs: 0, decodeMs: 0 }); }
export const now = () => performance.now();
export function shapeOk(e: unknown, hdr: number): e is Uint8Array { return e instanceof Uint8Array && e.length >= 65 && ((e.length - 49) & 15) === 0 && e[0] === hdr; }
/** Batch authenticate-then-decrypt. Throws CryptoError('AUTHENTICATION_FAILED') if ANY item fails (query-level failure). */
export async function openBatch(k: Cbc, mk: MacKey, hdr: number, jobs: Job[]): Promise<string[]> {
  const n = jobs.length; if (!n) return [];
  let total = 0;
  for (let i = 0; i < n; i++) { const e = jobs[i].env; if (!shapeOk(e, hdr)) throw new CryptoError('AUTHENTICATION_FAILED'); total += e.length - 33; }
  let t = now(); let bad = 0;
  for (let i = 0; i < n; i++) { const j = jobs[i], e = j.env, to = e.length - 32; bad |= tagDiff(mk, j.pre, j.rowId, e, 1, to, to); }
  stats.macs += n; stats.macMs += now() - t;
  if (bad !== 0) throw new CryptoError('AUTHENTICATION_FAILED');
  t = now();
  const cb = new Uint8Array(total + 32); let o = 0;
  for (let i = 0; i < n; i++) { const e = jobs[i].env; cb.set(e.subarray(1, e.length - 32), o); o += e.length - 33; }
  const p = await cbcRawDecrypt(k, cb, total); stats.cbcCalls++; stats.decrypts += n; stats.cbcMs += now() - t;
  t = now(); const out: string[] = new Array(n); o = 0; let padBad = 0;
  const ends = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const len = jobs[i].env.length - 33, end = o + len, pk = p[end - 1];
    let b = (pk < 1 || pk > 16) ? 1 : 0; for (let j = 1; j <= 16; j++) b |= (j <= pk ? 1 : 0) & (p[end - j] !== pk ? 1 : 0);
    padBad |= b; ends[i] = end - (b ? 0 : pk); o = end;
  }
  if (padBad) throw new CryptoError('AUTHENTICATION_FAILED');
  o = 0;
  for (let i = 0; i < n; i++) {
    const s = o + 16; o += jobs[i].env.length - 33;
    if (p[s] === 0xef && p[s + 1] === 0xbb && p[s + 2] === 0xbf) throw new CryptoError('INVALID_CIPHERTEXT');
    try { out[i] = td.decode(p.subarray(s, ends[i])); } catch { throw new CryptoError('INVALID_CIPHERTEXT'); }
  }
  stats.decodeMs += now() - t;
  return out;
}
/** Seal one value: 1 WebCrypto CBC encrypt + JS HMAC. */
export async function sealOne(k: Cbc, mk: MacKey, hdr: number, pre: Prefix, rowId: string, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k.enc, plain as Uint8Array<ArrayBuffer>));
  const env = new Uint8Array(49 + c.length); env[0] = hdr; env.set(iv, 1); env.set(c, 17);
  tagInto(mk, pre, rowId, env, 1, env.length - 32, env, env.length - 32); return env;
}

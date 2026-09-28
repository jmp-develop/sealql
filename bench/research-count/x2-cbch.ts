/**
 * CBC+HMAC (X3 recommended route): EtM, AES-256-CBC random IV + HMAC-SHA-256 in pure JS (ARX only), RFC 7518 5.2 layout.
 * Envelope [5][IV16][C][tag32]. MAC input = A | IV | C | u64be(8*|A|), A = header(5) | current v3 AAD
 * (frame of 'sealql/aad/v3', header, model, field, codec, codecVersion, params, keyScope, scope, rowId).
 * Keys: HKDF-SHA-384 from the root key, separate enc/mac labels. Only key-derived constants are cached (ipad/opad states).
 * Open order: shape check -> all tags (constant-time accumulate) -> ONE WebCrypto CBC decrypt of authenticated items -> full PKCS#7.
 * Research prototype, not product code.
 */
import { performance } from 'node:perf_hooks';
import { codecId, codecParameters, codecVersion } from '../../src/core/field-codec.js';
import { frame, u32, utf8 } from '../../src/core/bytes.js';
import { verifySearch } from '../../src/core/search-predicate.js';
import type { Node } from '../verify-native/r8-cases.js';
import { hkdf, bk, cbcRaw, enc, td, ring, spec, scopeA, fields, compile, leafFields, candidateSql, b3Stats, type OpenJob, type Q } from './x2-lib.js';

export const SCHEMA_CH = 'research_count_x2h';
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
const encBytes = await hkdf('x2/cbc-hmac/enc/v1'), macBytes = await hkdf('x2/cbc-hmac/mac/v1');
const ke = await crypto.subtle.importKey('raw', encBytes as Uint8Array<ArrayBuffer>, 'AES-CBC', false, ['encrypt']);
const keB = await bk(encBytes);
const pad = (x: number) => { const b = new Uint8Array(64); b.set(macBytes); for (let i = 0; i < 64; i++) b[i] ^= x; return b; };
const iState = Int32Array.from(H0); compress(iState, pad(0x36), 0); const oState = Int32Array.from(H0); compress(oState, pad(0x5c), 0);
const innerBuf = new Uint8Array(32);
export function hmacJs(msg: Uint8Array, out: Uint8Array) { finish(iState, 64, msg, innerBuf); finish(oState, 64, innerBuf, out); }
export const webHmacKey = () => crypto.subtle.importKey('raw', macBytes as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const HDR = 5;
const staticA = new Map<string, Uint8Array>();
export function aOf(field: string, scope: string, rowId: string): Uint8Array {
  let s = staticA.get(field);
  if (!s) { // frame() of the 8 static parts, part count patched to 10 (scope, rowId appended below) = same bytes as frame of all 10
    const f = frame(['sealql/aad/v3', new Uint8Array([HDR]), 'customers', field, codecId(spec), u32(codecVersion(spec)), codecParameters(spec), ring.keyScopeId]);
    s = new Uint8Array(1 + f.length); s[0] = HDR; s.set(f, 1); new DataView(s.buffer).setUint32(1, 10); staticA.set(field, s);
  }
  const sb = enc.encode(scope), rb = enc.encode(rowId); const a = new Uint8Array(s.length + 8 + sb.length + rb.length); a.set(s); const dv = new DataView(a.buffer);
  let o = s.length; dv.setUint32(o, sb.length); o += 4; a.set(sb, o); o += sb.length; dv.setUint32(o, rb.length); o += 4; a.set(rb, o); return a;
}
export function macInput(A: Uint8Array, body: Uint8Array): Uint8Array { const m = new Uint8Array(A.length + body.length + 8); m.set(A); m.set(body, A.length); new DataView(m.buffer).setBigUint64(m.length - 8, BigInt(A.length * 8)); return m; }
export async function sealCH(items: { value: string; field: string; rowId: string }[], scope = scopeA): Promise<Uint8Array[]> {
  return Promise.all(items.map(async it => {
    const iv = crypto.getRandomValues(new Uint8Array(16)); const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ke, utf8(it.value) as Uint8Array<ArrayBuffer>));
    const env = new Uint8Array(1 + 16 + c.length + 32); env[0] = HDR; env.set(iv, 1); env.set(c, 17);
    const tag = new Uint8Array(32); hmacJs(macInput(aOf(it.field, scope, it.rowId), env.subarray(1, env.length - 32)), tag); env.set(tag, env.length - 32); return env;
  }));
}
export async function openCH(jobs: OpenJob[], scope = scopeA): Promise<string[]> {
  const n = jobs.length; let total = 0;
  for (const j of jobs) { const e = j.env; if (!(e instanceof Uint8Array) || e.length < 65 || (e.length - 49) % 16 !== 0 || e[0] !== HDR) throw Error('AUTHENTICATION_FAILED'); total += e.length - 33; }
  const tag = new Uint8Array(32); let bad = 0;
  for (let i = 0; i < n; i++) { const e = jobs[i].env, o = e.length - 32; hmacJs(macInput(aOf(jobs[i].field, scope, jobs[i].rowId), e.subarray(1, o)), tag); for (let j = 0; j < 32; j++) bad |= e[o + j] ^ tag[j]; }
  if (bad) throw Error('AUTHENTICATION_FAILED');
  const cb = new Uint8Array(total + 32); const spans = new Int32Array(n); let o = 0;
  for (let i = 0; i < n; i++) { spans[i] = o; const e = jobs[i].env; cb.set(e.subarray(1, e.length - 32), o); o += e.length - 33; }
  const p = await cbcRaw(keB, cb, total); const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = spans[i] + 16, end = spans[i] + jobs[i].env.length - 33, k = p[end - 1];
    let ok = k >= 1 && k <= 16 ? 0 : 1; for (let j = 1; j <= 16; j++) ok |= (j <= k ? 1 : 0) & (p[end - j] !== k ? 1 : 0);
    if (ok) throw Error('AUTHENTICATION_FAILED'); out[i] = td.decode(p.subarray(s, end - k));
  }
  return out;
}
export async function chRun(db: Q, n: Node, mode: 'count' | 'find', schema = SCHEMA_CH, scope = scopeA) {
  const c = await compile(n, scope);
  const cond = [...leafFields(c)];
  const cols = mode === 'count' ? cond : fields;
  const { sql, params } = candidateSql(schema, c, cols, scope);
  const rows = (await db.query(sql, params)).rows;
  const seen = new Set<string>(); for (const r of rows) { if (r.scope_id !== scope || seen.has(r.id)) throw Error('AUTHENTICATION_FAILED'); seen.add(r.id); }
  const jobs: OpenJob[] = []; for (const r of rows) for (const f of cols) jobs.push({ env: r[`${f}_ct`], rowId: r.id, field: f });
  const t0 = performance.now();
  const plain = await openCH(jobs, scope);
  const t1 = performance.now(); b3Stats.fields += jobs.length; b3Stats.openMs += t1 - t0;
  const k = cols.length; const idx = Object.fromEntries(cols.map((f, i) => [f, i]));
  let count = 0; const items: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    const base = i * k;
    if (await verifySearch(c, async f => plain[base + idx[f]])) {
      count++;
      if (mode === 'find') { const it: any = { id: rows[i].id }; for (const f of cols) it[f] = plain[base + idx[f]]; items.push(it); }
    }
  }
  b3Stats.verifyMs += performance.now() - t1;
  return mode === 'count' ? count : items;
}

/**
 * X2 shared pieces: disposable pool, measurement lock, B3 batch AEAD (AES-256-CBC random IV + PMAC over AES^-1,
 * encrypt-then-MAC, row/field/scope bound), product token compile via src/core, candidate SQL (same shape as
 * src/core/candidate-sql.ts candidatePredicate + native count SELECT), R1 tags, SQL timing capture.
 * Research only. Not product code.
 */
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { createSealer } from '../../src/core/field-cipher.js';
import type { FieldSpec } from '../../src/core/field-codec.js';
import { frame, utf8 } from '../../src/core/bytes.js';
import { profiles, normalizeText, type SearchTokenCache } from '../../src/core/search-tokens.js';
import { compileSearch, verifySearch, type CompiledSearch, type SearchNode } from '../../src/core/search-predicate.js';
import { companionProfiles } from '../../src/core/companion-layout.js';
import type { SealedModelDefinition } from '../../src/core/sealed-model.js';
import type { Node, Field } from '../verify-native/r8-cases.js';

export const SCHEMA = 'research_count_x2';
export const scopeA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const fields: Field[] = ['name', 'phone', 'address', 'memo', 'email', 'company'];
export const OUT = 'bench/results/2026-09-28-count-research';

export async function openPool(max = 4) {
  const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max, options: '-c statement_timeout=0' });
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  return pool;
}
const LOCK = '.local/research/measure.lock';
export async function lock(name: string) {
  for (;;) {
    if (!existsSync(LOCK)) { try { writeFileSync(LOCK, `X2 ${name} ${new Date().toISOString()}\n`, { flag: 'wx' }); return; } catch { /* raced */ } }
    console.log(`measure.lock held; waiting (${new Date().toISOString()})`);
    await new Promise(r => setTimeout(r, 120_000));
  }
}
export function unlock() { if (existsSync(LOCK)) unlinkSync(LOCK); }

// ---------- product layout (same spec as bench/verify-native/r8-measure.ts) ----------
export const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
export const spec: FieldSpec = { type: 'text', search } as FieldSpec;
export const definition = { id: 'customers', identity: { row: 'id', scope: 'scopeId' }, fields: Object.fromEntries(fields.map(f => [f, spec])),
  columns: {}, scopeType: 'uuid', rowType: 'uuid' } as unknown as SealedModelDefinition;
export const storedProfiles = fields.flatMap(f => profiles('customers', f, spec));
export const layout = companionProfiles(definition); // indexId -> { tokens column, mode }
export const sealer = createSealer({ key: new Uint8Array(32).fill(93) });
export const ring = sealer.ring('customers');
export const tokenCache: SearchTokenCache = { profiles: new Map() };
export function toSearch(n: Node): SearchNode {
  if ('all' in n) return { op: 'all', children: n.all.map(toSearch) };
  if ('any' in n) return { op: 'any', children: n.any.map(toSearch) };
  return { op: n.op, field: n.field, value: n.value };
}
export const compile = (n: Node, scope = scopeA) => compileSearch(toSearch(n), definition, storedProfiles, ring, scope, tokenCache);
export function leafFields(c: CompiledSearch, out = new Set<string>()): Set<string> {
  if (c.op === 'leaf') out.add(c.leaf.node.field); else c.children.forEach(x => leafFields(x, out)); return out;
}
/** Token boolean expression exactly as candidatePredicate emits it (alias "__seal_idx"). Pushes params. */
export function tokenWhere(c: CompiledSearch, params: unknown[], alias = '"__seal_idx"'): string {
  if (c.op !== 'leaf') return `(${c.children.map(x => tokenWhere(x, params, alias)).join(c.op === 'all' ? ' and ' : ' or ')})`;
  const m = layout[c.leaf.profile.indexId]; assert(m && m.mode === c.leaf.profile.mode);
  if (m.mode === 'exact') { assert.equal(c.leaf.tokens.length, 1); params.push(c.leaf.tokens[0]); return `((${alias}."${m.tokens}")[1]=$${params.length}::bigint)`; }
  params.push(c.leaf.tokens); return `(${alias}."${m.tokens}" @> $${params.length}::bigint[])`;
}
/** Same SELECT shape as the product count/findMany-all SQL recorded in r8-remeasure results.json. */
export function candidateSql(schema: string, c: CompiledSearch, cols: string[], scope = scopeA) {
  const params: unknown[] = [scope, scope];
  const w = tokenWhere(c, params);
  const sql = `select "id", "scope_id", ${cols.map(f => `"${f}_ct"`).join(', ')} from "${schema}"."customers" where ("${schema}"."customers"."scope_id" = $1 and "customers"."id" in (select "__seal_idx"."row_id" from "${schema}"."customers_seal_index" as "__seal_idx" where "__seal_idx"."scope_id"=$2 and ${w})) order by "${schema}"."customers"."id" asc`;
  return { sql, params };
}

// ---------- batched AES^-1 via WebCrypto AES-CBC decrypt ----------
type BK = { k: CryptoKey; x0: Uint8Array };
export async function hkdf(label: string, bits = 256) {
  const m = await crypto.subtle.importKey('raw', Uint8Array.from(ring.key), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-384', salt: new Uint8Array(), info: frame([label, ring.keyScopeId, 'customers']) as Uint8Array<ArrayBuffer> }, m, bits));
}
export async function bk(bytes: Uint8Array): Promise<BK> {
  const k = await crypto.subtle.importKey('raw', bytes as Uint8Array<ArrayBuffer>, 'AES-CBC', false, ['encrypt', 'decrypt']);
  return { k, x0: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, k, new Uint8Array(0))) };
}
export async function cbcRaw(key: BK, buf: Uint8Array, dataLen: number): Promise<Uint8Array> {
  buf.fill(0, dataLen, dataLen + 16); buf.set(key.x0, dataLen + 16); // PKCS#7 always valid: [0^16, E(0x10^16)]
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key.k, buf.subarray(0, dataLen + 32) as Uint8Array<ArrayBuffer>));
}
async function dPoints(key: BK, buf: Uint8Array, n: number): Promise<Uint32Array> {
  const out = await cbcRaw(key, buf, n * 16);
  const o = new Uint32Array(out.buffer, 0, n * 4), x = new Uint32Array(buf.buffer, buf.byteOffset, n * 4);
  for (let i = n * 4 - 1; i >= 4; i--) o[i] ^= x[i - 4];
  return o;
}
const dbl = (b: Uint8Array) => { const r = new Uint8Array(16); let c = 0; for (let i = 15; i >= 0; i--) { r[i] = ((b[i] << 1) | c) & 0xff; c = b[i] >> 7; } if (b[0] & 0x80) r[15] ^= 0x87; return r; };
const half = (b: Uint8Array) => { const lsb = b[15] & 1; const x = Uint8Array.from(b); if (lsb) x[15] ^= 0x87; const r = new Uint8Array(16); let c = lsb; for (let i = 0; i < 16; i++) { r[i] = (x[i] >> 1) | (c << 7); c = x[i] & 1; } return r; };
const ntz = (i: number) => 31 - Math.clz32(i & -i);
type PK = BK & { L: Uint32Array; Linv: Uint32Array };
async function pk(bytes: Uint8Array): Promise<PK> {
  const b = await bk(bytes); const L0 = new Uint8Array((await dPoints(b, new Uint8Array(48), 1)).buffer.slice(0, 16));
  const L = new Uint8Array(64 * 16); let cur = L0; for (let i = 0; i < 64; i++) { L.set(cur, i * 16); cur = dbl(cur); }
  return { ...b, L: new Uint32Array(L.buffer), Linv: new Uint32Array(half(L0).buffer) };
}
// Key-derived constants only (enc key, MAC key, X0, PMAC L table): allowed by the server-cache principle.
const encBytes = await hkdf('x2/b3/enc/v1'), macBytes = await hkdf('x2/b3/mac/v1');
const ke = await crypto.subtle.importKey('raw', encBytes as Uint8Array<ArrayBuffer>, 'AES-CBC', false, ['encrypt']);
const keB = await bk(encBytes), pm = await pk(macBytes);
const constPart = (field: string, scope: string) => { const f = frame(['sealql/aad/b3-x2', 'customers', field, 'text', '1', ring.keyScopeId, scope]); const r = new Uint8Array(Math.ceil(f.length / 16) * 16); r.set(f); return r; };
type Prefix = { k: number; off: Uint32Array; sum: Uint32Array };
/** Per-call PMAC state of the constant prefix (schema + scope). Not persisted. */
export async function prefixes(fs: Iterable<string>, scope = scopeA): Promise<Map<string, Prefix>> {
  const m = new Map<string, Prefix>();
  await Promise.all([...new Set(fs)].map(async field => {
    const cp = constPart(field, scope), k = cp.length / 16; const buf = new Uint8Array(cp.length + 32); const C = new Uint32Array(cp.buffer), B = new Uint32Array(buf.buffer); const off = new Uint32Array(4);
    for (let i = 0; i < k; i++) { const l = ntz(i + 1) * 4; for (let j = 0; j < 4; j++) { off[j] ^= pm.L[l + j]; B[i * 4 + j] = C[i * 4 + j] ^ off[j]; } }
    const d = await dPoints(pm, buf, k); const sum = new Uint32Array(4); for (let i = 0; i < k; i++) for (let j = 0; j < 4; j++) sum[j] ^= d[i * 4 + j];
    m.set(field, { k, off, sum });
  }));
  return m;
}
export const enc = new TextEncoder();
/** PMAC tail = u32(rowLen) | rowId | IV | C  (body = IV|C). */
function tailOf(rowId: string, body: Uint8Array): Uint8Array { const rb = enc.encode(rowId); const t = new Uint8Array(4 + rb.length + body.length); new DataView(t.buffer).setUint32(0, rb.length); t.set(rb, 4); t.set(body, 4 + rb.length); return t; }
export type MacJob = { field: string; rowId: string; body: Uint8Array };
/** PMAC tags of many messages with 2 WebCrypto calls total. Returns n*16 bytes. */
async function macBatch(jobs: MacJob[], pre: Map<string, Prefix>): Promise<Uint8Array> {
  const n = jobs.length; let r1 = 0; const tails: Uint8Array[] = new Array(n);
  for (let i = 0; i < n; i++) { const t = tailOf(jobs[i].rowId, jobs[i].body); tails[i] = t; r1 += Math.ceil(t.length / 16) - 1; }
  const b1 = new Uint8Array(r1 * 16 + 32), B1 = new Uint32Array(b1.buffer); const sums = new Uint8Array(n * 16 + 32), S = new Uint32Array(sums.buffer);
  const starts = new Int32Array(n + 1); let at = 0; const off = new Uint32Array(4); const lastB = new Uint8Array(16), LB = new Uint32Array(lastB.buffer);
  for (let i = 0; i < n; i++) {
    const p = pre.get(jobs[i].field)!; off.set(p.off); const t = tails[i]; const m = Math.ceil(t.length / 16); starts[i] = at;
    const full = (m - 1) * 16; const tv = new Uint32Array(t.buffer, t.byteOffset, full / 4);
    for (let b = 0; b < m - 1; b++) { const l = ntz(p.k + b + 1) * 4; for (let j = 0; j < 4; j++) { off[j] ^= pm.L[l + j]; B1[(at + b) * 4 + j] = tv[b * 4 + j] ^ off[j]; } }
    at += m - 1; const tail = t.subarray(full); lastB.fill(0); lastB.set(tail);
    if (tail.length === 16) for (let j = 0; j < 4; j++) S[i * 4 + j] = p.sum[j] ^ LB[j] ^ pm.Linv[j]; else { lastB[tail.length] = 0x80; for (let j = 0; j < 4; j++) S[i * 4 + j] = p.sum[j] ^ LB[j]; }
  }
  starts[n] = at;
  const d1 = await dPoints(pm, b1, r1);
  for (let i = 0; i < n; i++) for (let b = starts[i]; b < starts[i + 1]; b++) for (let j = 0; j < 4; j++) S[i * 4 + j] ^= d1[b * 4 + j];
  const tags = await dPoints(pm, sums, n); return new Uint8Array(tags.buffer, 0, n * 16);
}
/** B3 envelope = [4][IV16][C][tag16]. Seals many (value, field, row) at once: 1 CBC encrypt per value + 2 PMAC calls. */
export async function sealB3(items: { value: string; field: string; rowId: string }[], scope = scopeA): Promise<Uint8Array[]> {
  const bodies = await Promise.all(items.map(async it => {
    const iv = crypto.getRandomValues(new Uint8Array(16)); const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ke, utf8(it.value) as Uint8Array<ArrayBuffer>));
    const body = new Uint8Array(16 + c.length); body.set(iv); body.set(c, 16); return body;
  }));
  const tags = await macBatch(items.map((it, i) => ({ field: it.field, rowId: it.rowId, body: bodies[i] })), await prefixes(items.map(i => i.field), scope));
  return bodies.map((b, i) => { const e = new Uint8Array(1 + b.length + 16); e[0] = 4; e.set(b, 1); e.set(tags.subarray(i * 16, i * 16 + 16), 1 + b.length); return e; });
}
export type OpenJob = { env: Uint8Array; rowId: string; field: string };
export const td = new TextDecoder('utf-8', { fatal: true });
/** Batch authenticate + decrypt. Throws AUTHENTICATION_FAILED on any tag/shape/padding error (tag checked first). */
export async function openB3(jobs: OpenJob[], pre: Map<string, Prefix>): Promise<string[]> {
  const n = jobs.length; let cbTotal = 0;
  for (const j of jobs) { const L = j.env.length; if (!(j.env instanceof Uint8Array) || L < 1 + 16 + 16 + 16 || (L - 33) % 16 !== 0 || j.env[0] !== 4) throw Error('AUTHENTICATION_FAILED'); cbTotal += L - 17; }
  const cb = new Uint8Array(cbTotal + 32); const spans = new Int32Array(n); let o = 0; const macJobs: MacJob[] = new Array(n);
  for (let i = 0; i < n; i++) { spans[i] = o; const e = jobs[i].env; const body = e.subarray(1, e.length - 16); cb.set(body, o); o += body.length; macJobs[i] = { field: jobs[i].field, rowId: jobs[i].rowId, body }; }
  const [T8, pOut] = await Promise.all([macBatch(macJobs, pre), cbcRaw(keB, cb, cbTotal)]);
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const e = jobs[i].env, tg = e.length - 16; let diff = 0; for (let j = 0; j < 16; j++) diff |= e[tg + j] ^ T8[i * 16 + j];
    if (diff) throw Error('AUTHENTICATION_FAILED');
    const s = spans[i] + 16, end = spans[i] + e.length - 17; const pad = pOut[end - 1]; if (pad < 1 || pad > 16) throw Error('AUTHENTICATION_FAILED');
    out[i] = td.decode(pOut.subarray(s, end - pad));
  }
  return out;
}

// ---------- B3 count / findMany over the research schema ----------
export type Q = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };
export const b3Stats = { fields: 0, openMs: 0, verifyMs: 0 };
export async function b3Run(db: Q, n: Node, mode: 'count' | 'find', schema = SCHEMA, scope = scopeA) {
  const c = await compile(n, scope);
  const cond = [...leafFields(c)];
  const cols = mode === 'count' ? cond : fields;
  const { sql, params } = candidateSql(schema, c, cols, scope);
  const rows = (await db.query(sql, params)).rows;
  const seen = new Set<string>(); for (const r of rows) { if (r.scope_id !== scope || seen.has(r.id)) throw Error('AUTHENTICATION_FAILED'); seen.add(r.id); }
  const jobs: OpenJob[] = []; for (const r of rows) for (const f of cols) jobs.push({ env: r[`${f}_ct`], rowId: r.id, field: f });
  const t0 = performance.now();
  const plain = await openB3(jobs, await prefixes(cols, scope));
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

// ---------- R1 tags ----------
const r1Keys = new Map<string, Promise<CryptoKey>>();
function r1Key(kind: 'exact' | 'sub', field: string) {
  const id = `${kind}/${field}`; let p = r1Keys.get(id);
  if (!p) { p = hkdf(`x2/r1/${id}/v1`).then(b => crypto.subtle.importKey('raw', b as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])); r1Keys.set(id, p); }
  return p;
}
const ws = new RegExp('[' + [[9, 13], [32, 32], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
export const normExact = (v: string) => normalizeText(v, 'legacy-text-v1');
export const normSub = (v: string) => normalizeText(v, 'legacy-text-v1').replace(ws, '');
/** t = HMAC-SHA256(K_field, frame(kind, scope, value)); full 32 bytes, computed only in the app. */
export async function trapdoor(kind: 'exact' | 'sub', field: string, normalized: string, scope = scopeA) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await r1Key(kind, field), frame([kind, scope, normalized]) as Uint8Array<ArrayBuffer>));
}
export function uuidBytes(id: string) { return Buffer.from(id.replaceAll('-', ''), 'hex'); }
/** tag = SHA-256(t | uuid16 | nonce16) — PostgreSQL recomputes with built-in sha256(). */
export async function r1Tag(t: Uint8Array, row16: Uint8Array, nonce: Uint8Array) {
  const m = new Uint8Array(64); m.set(t); m.set(row16, 32); m.set(nonce, 48);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', m));
}
export function substrings(normalized: string): string[] {
  const c = Array.from(normalized); const s = new Set<string>();
  for (let i = 0; i < c.length; i++) for (let j = i + 2; j <= c.length; j++) s.add(c.slice(i, j).join(''));
  return [...s];
}
export async function r1Row(id: string, v: Record<string, string>, exactFields: string[], subFields: string[], scope = scopeA) {
  const row16 = uuidBytes(id); const out: Record<string, unknown> = {};
  for (const f of exactFields) { const nonce = crypto.getRandomValues(new Uint8Array(16)); out[`${f}_nonce`] = nonce; out[`${f}_tag`] = await r1Tag(await trapdoor('exact', f, normExact(v[f]), scope), row16, nonce); }
  for (const f of subFields) {
    const nonce = crypto.getRandomValues(new Uint8Array(16)); out[`${f}_snonce`] = nonce;
    out[`${f}_subtags`] = await Promise.all(substrings(normSub(v[f])).map(async s => Buffer.from(await r1Tag(await trapdoor('sub', f, s, scope), row16, nonce))));
  }
  return out;
}

// ---------- timing capture (same method as r8-measure.ts) ----------
type Event = { start: number; end: number; rows: number };
let events: Event[] | null = null;
const originalQuery = Client.prototype.query;
(Client.prototype as any).query = function (...args: any[]) {
  const start = performance.now(); let recorded = false;
  const record = (result: any) => { if (!recorded) { recorded = true; events?.push({ start, end: performance.now(), rows: result?.rows?.length ?? 0 }); } return result; };
  const cb = args.findIndex(x => typeof x === 'function');
  if (cb >= 0) { const old = args[cb]; args[cb] = (err: any, result: any) => { record(result); old(err, result); }; }
  const result = (originalQuery as any).apply(this, args);
  return cb < 0 && result?.then ? result.then(record, (err: any) => { record(null); throw err; }) : result;
};
export async function measure<T>(fn: () => Promise<T>) {
  const ev: Event[] = []; events = ev; const start = performance.now(); let value: T;
  try { value = await fn(); } finally { events = null; }
  const end = performance.now(); const dbMs = ev.reduce((s, x) => s + x.end - x.start, 0);
  const preMs = ev.length ? ev[0].start - start : end - start, postMs = ev.length ? end - ev.at(-1)!.end : 0;
  return { value: value!, totalMs: end - start, preMs, dbMs, betweenSqlMs: end - start - preMs - dbMs - postMs, postMs, sqlCalls: ev.length, candidateRows: ev.reduce((s, x) => s + x.rows, 0) };
}
export const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
export function summary(xs: any[]) { const keys = Object.keys(xs[0]).filter(k => typeof xs[0][k] === 'number'); return Object.fromEntries(keys.map(k => [k, +median(xs.map(x => x[k])).toFixed(3)])); }
export const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? `<${x.length}B>` : x, 1) + '\n';

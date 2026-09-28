/**
 * m1-fable E2: DB-exact count designs on the disposable cluster (schema research_m1_fable_d1, derived read-only from
 * bench_realistic_100k.customers, 100k rows, 1 scope). K = 8 (max exact query length).
 *   idx64  (D1)  : exact token x_<f> bigint (64-bit HMAC) + s_<f> bigint[] = ALL substrings of length 2..K plus prefixes and
 *                  suffixes of length 2..K, 64-bit HMAC. B-tree (scope_id, x_f, row_id) per field, one multicolumn GIN over s_*.
 *   idx64t (D1p) : idx64 + per-(row,field) write nonce v_<f> + membership tags m_<f> bigint[] / mx_<f> bigint =
 *                  HMAC(tagKey, scope, field, kind, piece, row_id, nonce)[0:8]; proof variants return ids + tags, the app
 *                  recomputes tags (cheap PRF, no decryption) and counts distinct verified rows through the boolean tree.
 *   idx128 (D1)  : idx64 with 128-bit tokens (uuid / uuid[]).
 *   j16    (D3)  : today's 16-bit prefilter tokens (product-shaped pieces, scope prefix) + per-(row,field) random salt +
 *                  judgment tags jt_<f> bigint[] = sha256(k_piece || salt)[0:8] for the same 2..K pieces (jx for exact),
 *                  k_piece = HMAC(jKey, scope, field, kind, piece). The DB finishes the predicate itself: GIN prefilter, then
 *                  one sha256 per candidate row. Snapshot shows no new cross-row relation (tags are salted per row).
 *                  Also stores membership tags m_<f>/mx_<f> (HMAC with row id + salt) for the proof variant.
 * Paths per case: plain COUNT, product count (sealql drizzle API on native_verify_main, AES-GCM verification), d1_64, d1_128,
 * d1_proof_rows, d1_proof_xor (AND/leaf only), d3, d3_proof. Queries longer than K use all K-windows (necessary condition):
 * DB result is reported as candidates and asserted >= plaintext count; exactness there still needs app verification.
 * Usage: rtk proxy npx tsx bench/research-mission/m1-fable-d1.ts <load|measure|write|drop>
 */
import assert from 'node:assert/strict';
import { hash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { assertDisposable } from '../../test/disposable.js';
import { createSealer } from '../../src/core/field-cipher.js';
import { normalizeText, profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { createSealed } from '../../src/adapters/drizzle/v0.45/index.js';
import { cases, fields, plainWhere, type Case, type Field, type Node, type Leaf } from '../verify-native/r8-cases.js';

const S = 'research_m1_fable_d1', OUT = 'bench/results/2026-09-28-mission', K = 8;
const scopeA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const phase = process.argv[2]; assert(['load', 'measure', 'big', 'explain', 'write', 'drop'].includes(phase ?? ''), 'phase?');
assert(existsSync('.local/research/db-free.flag'), 'db-free.flag missing');
const LOCK = '.local/research/measure.lock';
async function lock(name: string) { for (;;) { if (!existsSync(LOCK)) { try { writeFileSync(LOCK, `M1F ${name} ${new Date().toISOString()}\n`, { flag: 'wx' }); return; } catch { /* raced */ } } console.log('measure.lock held; waiting'); await new Promise(r => setTimeout(r, 60_000)); } }
function unlock() { if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('M1F ')) unlinkSync(LOCK); }
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 4, options: '-c statement_timeout=0' });
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
mkdirSync(OUT, { recursive: true });

// ---- PRFs (research keys; product keys are HKDF-derived per profile). HMAC-SHA-256 from two one-shot hashes
// (identical output to createHmac; 3.4 us vs 26 us per call on this machine).
const tokKey = Buffer.alloc(32, 7), tagKey = Buffer.alloc(32, 9), tok16Key = Buffer.alloc(32, 5), jKey = Buffer.alloc(32, 3);
const pads = (key: Buffer) => { const i = Buffer.alloc(64, 0x36), o = Buffer.alloc(64, 0x5c); for (let k = 0; k < key.length; k++) { i[k] ^= key[k]; o[k] ^= key[k]; } return { i, o }; };
const padOf = new Map<Buffer, { i: Buffer; o: Buffer }>();
const hmacB = (key: Buffer, msg: Buffer) => { let p = padOf.get(key); if (!p) { p = pads(key); padOf.set(key, p); } return hash('sha256', Buffer.concat([p.o, hash('sha256', Buffer.concat([p.i, msg]), 'buffer')]), 'buffer'); };
const hmac = (key: Buffer, parts: string[]) => hmacB(key, Buffer.from(parts.join('\u0000')));
const norm = (v: string) => normalizeText(v, 'legacy-text-v1');
const b64 = (d: Buffer) => BigInt.asIntN(64, d.readBigUInt64BE(0)).toString();
const u128 = (d: Buffer) => { const h = d.subarray(0, 16).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const tokenBuf = (field: string, kind: string, piece: string) => hmac(tokKey, [scopeA, field, kind, piece]);
const tag = (field: string, kind: string, piece: string, rowId: string, nonce: Buffer) => b64(hmacB(tagKey, Buffer.concat([Buffer.from([scopeA, field, kind, piece, rowId].join('\u0000')), nonce])));
// D3 pieces: k_piece (32 bytes, sent to the DB at query time), judgment tag = sha256(k || salt)[0:8]
const kPiece = (field: string, kind: string, piece: string) => hmac(jKey, [scopeA, field, kind, piece]);
const judge = (k: Buffer, salt: Buffer) => b64(hash('sha256', Buffer.concat([k, salt]), 'buffer'));
// D3 prefilter: product-shaped pieces (adjacent, start/end 1-char, skip-gram) with 16-bit truncation and a 32-bit scope prefix
const scopePrefix = BigInt(hmac(tok16Key, ['scope', scopeA]).readUInt32BE(0));
const tok16 = (field: string, kind: string, piece: string) => BigInt.asIntN(64, (scopePrefix << 32n) | BigInt(hmac(tok16Key, [scopeA, field, kind, piece]).readUInt16BE(0) << 16 >>> 0)).toString();
type Pieces = { kind: string; piece: string }[];
function kgramPieces(value: string, k = K): Pieces {
  const c = Array.from(norm(value)); const out: Pieces = []; const seen = new Set<string>();
  const add = (kind: string, piece: string) => { const id = kind + '\u0000' + piece; if (!seen.has(id)) { seen.add(id); out.push({ kind, piece }); } };
  if (c.length < 2) return out;
  for (let l = 2; l <= k; l++) for (let i = 0; i + l <= c.length; i++) add('g', c.slice(i, i + l).join(''));
  for (let l = 2; l <= Math.min(k, c.length); l++) { add('s', c.slice(0, l).join('')); add('e', c.slice(c.length - l).join('')); }
  return out;
}
function productPieces(value: string, op: 'write' | 'contains' | 'startsWith' | 'endsWith' = 'write'): Pieces {
  const c = Array.from(norm(value)); const out: Pieces = []; const seen = new Set<string>();
  const add = (kind: string, piece: string) => { const id = kind + '\u0000' + piece; if (!seen.has(id)) { seen.add(id); out.push({ kind, piece }); } };
  if (c.length < 2) return out;
  for (let i = 0; i + 1 < c.length; i++) add('adjacent', c[i] + c[i + 1]);
  if (op === 'write' || op === 'startsWith') add('start', c[0]);
  if (op === 'write' || op === 'endsWith') add('end', c[c.length - 1]);
  for (let i = 0; i + 2 < c.length; i++) add('skip', c[i] + c[i + 2]);
  return out;
}
type Row = { id: string } & Record<Field, string>;
function encodeRow(r: Row) {
  const e: any = { x: {}, x128: {}, mx: {}, s: {}, s128: {}, m: {}, v: {}, t16: {}, x16: {}, salt: {}, jt: {}, jx: {}, jm: {}, jmx: {} };
  for (const f of fields) {
    const v = norm(r[f]); const xb = tokenBuf(f, 'x', v); const nonce = randomBytes(8); const salt = randomBytes(8);
    e.v[f] = nonce; e.salt[f] = salt;
    e.x[f] = b64(xb); e.x128[f] = u128(xb); e.mx[f] = tag(f, 'x', v, r.id, nonce);
    const ps = kgramPieces(r[f]); const bufs = ps.map(p => tokenBuf(f, p.kind, p.piece));
    e.s[f] = bufs.map(b64); e.s128[f] = bufs.map(u128); e.m[f] = ps.map(p => tag(f, p.kind, p.piece, r.id, nonce));
    e.t16[f] = [...new Set(productPieces(r[f]).map(p => tok16(f, p.kind, p.piece)))].sort(); e.x16[f] = tok16(f, 'x', v);
    e.jt[f] = ps.map(p => judge(kPiece(f, p.kind, p.piece), salt)); e.jx[f] = judge(kPiece(f, 'x', v), salt);
    e.jm[f] = ps.map(p => tag(f, p.kind, p.piece, r.id, salt)); e.jmx[f] = tag(f, 'x', v, r.id, salt);
  }
  return e;
}

// ---- query plans
type Width = '64' | '128';
type LeafPlan = { field: Field; pred: string; tagExpr: string; nonceExpr: string; pieces: Pieces; windows: number };
const leafKgramPieces = (leaf: Leaf): Pieces => {
  const c = Array.from(norm(leaf.value)); assert(c.length >= 2);
  if (leaf.op === 'eq') return [{ kind: 'x', piece: c.join('') }];
  if (c.length <= K) return [{ kind: leaf.op === 'contains' ? 'g' : leaf.op === 'startsWith' ? 's' : 'e', piece: c.join('') }];
  const out: Pieces = [];
  if (leaf.op === 'startsWith') out.push({ kind: 's', piece: c.slice(0, K).join('') });
  if (leaf.op === 'endsWith') out.push({ kind: 'e', piece: c.slice(c.length - K).join('') });
  const seen = new Set<string>();
  for (let i = 0; i + K <= c.length; i++) { const w = c.slice(i, i + K).join(''); if (!seen.has(w)) { seen.add(w); out.push({ kind: 'g', piece: w }); } }
  return out;
};
function d1Leaf(leaf: Leaf, params: unknown[], w: Width, tags: boolean): LeafPlan {
  const enc = w === '64' ? b64 : u128, cast = w === '64' ? 'bigint' : 'uuid';
  const pieces = leafKgramPieces(leaf); const windows = pieces.length > 1 ? pieces.length : 0;
  const ph = pieces.map(p => { params.push(enc(tokenBuf(leaf.field, p.kind, p.piece))); return `$${params.length}`; });
  if (leaf.op === 'eq') return { field: leaf.field, pred: `x_${leaf.field}=${ph[0]}`, tagExpr: `mx_${leaf.field}`, nonceExpr: `v_${leaf.field}`, pieces, windows };
  const col = `s_${leaf.field}`;
  const tagExpr = tags ? `array[${ph.map(t => `m_${leaf.field}[array_position(${col},${t})]`).join(',')}]` : '';
  return { field: leaf.field, pred: `${col} @> array[${ph.join(',')}]::${cast}[]`, tagExpr, nonceExpr: `v_${leaf.field}`, pieces, windows };
}
function d3Leaf(leaf: Leaf, params: unknown[]): LeafPlan {
  const pieces = leafKgramPieces(leaf); const windows = pieces.length > 1 ? pieces.length : 0; const f = leaf.field;
  const J = (kIdx: number) => `('x'||encode(substr(sha256($${kIdx}::bytea||salt_${f}),1,8),'hex'))::bit(64)::bigint`;
  const ks = pieces.map(p => { params.push(kPiece(f, p.kind, p.piece)); return params.length; });
  if (leaf.op === 'eq') { params.push(tok16(f, 'x', norm(leaf.value))); return { field: f, pred: `(x16_${f}=$${params.length} and jx_${f}=${J(ks[0])})`, tagExpr: `jmx_${f}`, nonceExpr: `salt_${f}`, pieces, windows }; }
  const pre = [...new Set(productPieces(leaf.value, leaf.op).map(p => tok16(f, p.kind, p.piece)))]; params.push(pre); const preIdx = params.length;
  const checks = ks.map(k => `${J(k)} = any(jt_${f})`);
  const tagExpr = `array[${ks.map(k => `jm_${f}[array_position(jt_${f},${J(k)})]`).join(',')}]`;
  return { field: f, pred: `(tokens_${f} @> $${preIdx}::bigint[] and ${checks.join(' and ')})`, tagExpr, nonceExpr: `salt_${f}`, pieces, windows };
}
type Plan = { where: string; params: unknown[]; leaves: LeafPlan[]; windows: number; tree: Node };
function plan(n: Node, kind: 'd1' | 'd3', w: Width, tags: boolean): Plan {
  const params: unknown[] = [scopeA]; const leaves: LeafPlan[] = [];
  const build = (x: Node): string => {
    if ('all' in x) return `(${x.all.map(build).join(' and ')})`;
    if ('any' in x) return `(${x.any.map(build).join(' or ')})`;
    const lp = kind === 'd1' ? d1Leaf(x, params, w, tags) : d3Leaf(x, params); leaves.push(lp); return `(${lp.pred})`;
  };
  const where = build(n);
  return { where, params, leaves, windows: leaves.reduce((a, l) => a + l.windows, 0), tree: n };
}
const leavesOf = (n: Node): Leaf[] => 'all' in n ? n.all.flatMap(leavesOf) : 'any' in n ? n.any.flatMap(leavesOf) : [n];
function evalTree(n: Node, ok: boolean[], idx: { i: number }): boolean {
  if ('all' in n) { let r = true; for (const c of n.all) r = evalTree(c, ok, idx) && r; return r; }
  if ('any' in n) { let r = false; for (const c of n.any) r = evalTree(c, ok, idx) || r; return r; }
  return ok[idx.i++];
}

// ---- product path (same construction as bench/verify-native/r8-measure.ts, read-only on native_verify_main)
const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
const sealer = createSealer({ key: new Uint8Array(32).fill(93) });
const sealed = createSealed({ sealer });
const productSchema = pgSchema('native_verify_main');
const productTable = productSchema.table('customers', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }), address: sealed.text('address', { search }),
  memo: sealed.text('memo', { search }), email: sealed.text('email', { search }), company: sealed.text('company', { search }) });
const registration = sealed.register(productTable, { row: 'id', scope: 'scopeId' });
const db = drizzle(pool);
function match(n: Node, m: any): any { if ('all' in n) return m.and(...n.all.map(x => match(x, m))); if ('any' in n) return m.or(...n.any.map(x => match(x, m))); return m[n.field][n.op](n.value); }
const productCount = (c: Case) => sealed.count(db, registration, { scope: scopeA, match: (m: any) => match(c.node, m) } as any) as Promise<number>;

const tup = (n: number, w: number) => Array.from({ length: n }, (_, r) => `(${Array.from({ length: w }, (_, c) => `$${r * w + c + 1}`).join(',')})`).join(',');
async function loadPhase() {
  await lock('load'); const res: any = { startedAt: new Date().toISOString(), schema: S, K };
  try {
    await q(`drop schema if exists ${S} cascade`); await q(`create schema ${S}`);
    await q(`set maintenance_work_mem='2GB'`);
    const src: Row[] = (await q(`select id::text id, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id`)).rows;
    assert.equal(src.length, 100000);
    const F = (t: (f: string) => string) => fields.map(f => t(f));
    await q(`create table ${S}.idx64 (scope_id uuid not null, row_id uuid not null, ${[...F(f => `x_${f} bigint not null`), ...F(f => `s_${f} bigint[] not null`)].join(',')}, primary key (scope_id,row_id))`);
    await q(`create table ${S}.idx64t (scope_id uuid not null, row_id uuid not null, ${[...F(f => `x_${f} bigint not null`), ...F(f => `s_${f} bigint[] not null`), ...F(f => `v_${f} bytea not null`), ...F(f => `mx_${f} bigint not null`), ...F(f => `m_${f} bigint[] not null`)].join(',')}, primary key (scope_id,row_id))`);
    await q(`create table ${S}.idx128 (scope_id uuid not null, row_id uuid not null, ${[...F(f => `x_${f} uuid not null`), ...F(f => `s_${f} uuid[] not null`)].join(',')}, primary key (scope_id,row_id))`);
    await q(`create table ${S}.j16 (scope_id uuid not null, row_id uuid not null, ${[...F(f => `tokens_${f} bigint[] not null`), ...F(f => `x16_${f} bigint not null`), ...F(f => `salt_${f} bytea not null`), ...F(f => `jt_${f} bigint[] not null`), ...F(f => `jx_${f} bigint not null`), ...F(f => `jm_${f} bigint[] not null`), ...F(f => `jmx_${f} bigint not null`)].join(',')}, primary key (scope_id,row_id))`);
    const tokStats = { perRow: 0, perField: Object.fromEntries(fields.map(f => [f, 0])) as Record<string, number>, prefilterPerRow: 0, perRowK: { 4: 0, 6: 0 } as Record<number, number> };
    let encodeMs = 0, insertMs = 0; const B = 200;
    for (let o = 0; o < src.length; o += B) {
      const part = src.slice(o, o + B);
      const t0 = performance.now(); const enc = part.map(encodeRow); encodeMs += performance.now() - t0;
      for (let i = 0; i < part.length; i++) for (const f of fields) { tokStats.perField[f] += enc[i].s[f].length; tokStats.perRow += enc[i].s[f].length; tokStats.prefilterPerRow += enc[i].t16[f].length; }
      if (o === 0) for (const r of part) for (const k of [4, 6]) for (const f of fields) tokStats.perRowK[k] += kgramPieces(r[f], k).length;
      const t1 = performance.now();
      const c64 = ['scope_id', 'row_id', ...F(f => `x_${f}`), ...F(f => `s_${f}`)];
      const c64t = [...c64, ...F(f => `v_${f}`), ...F(f => `mx_${f}`), ...F(f => `m_${f}`)];
      const cj = ['scope_id', 'row_id', ...F(f => `tokens_${f}`), ...F(f => `x16_${f}`), ...F(f => `salt_${f}`), ...F(f => `jt_${f}`), ...F(f => `jx_${f}`), ...F(f => `jm_${f}`), ...F(f => `jmx_${f}`)];
      const v64: unknown[] = [], v64t: unknown[] = [], v128: unknown[] = [], vj: unknown[] = [];
      part.forEach((r, i) => { const e = enc[i];
        v64.push(scopeA, r.id, ...F(f => e.x[f]), ...F(f => e.s[f]));
        v64t.push(scopeA, r.id, ...F(f => e.x[f]), ...F(f => e.s[f]), ...F(f => e.v[f]), ...F(f => e.mx[f]), ...F(f => e.m[f]));
        v128.push(scopeA, r.id, ...F(f => e.x128[f]), ...F(f => e.s128[f]));
        vj.push(scopeA, r.id, ...F(f => e.t16[f]), ...F(f => e.x16[f]), ...F(f => e.salt[f]), ...F(f => e.jt[f]), ...F(f => e.jx[f]), ...F(f => e.jm[f]), ...F(f => e.jmx[f]));
      });
      await q(`insert into ${S}.idx64 (${c64.join(',')}) values ${tup(part.length, c64.length)}`, v64);
      await q(`insert into ${S}.idx64t (${c64t.join(',')}) values ${tup(part.length, c64t.length)}`, v64t);
      await q(`insert into ${S}.idx128 (${c64.join(',')}) values ${tup(part.length, c64.length)}`, v128);
      await q(`insert into ${S}.j16 (${cj.join(',')}) values ${tup(part.length, cj.length)}`, vj);
      insertMs += performance.now() - t1;
      if (o % 20000 === 0) console.log('loaded', o, 'encodeMs', encodeMs.toFixed(0), 'insertMs', insertMs.toFixed(0));
    }
    tokStats.perRow /= src.length; tokStats.prefilterPerRow /= src.length; for (const f of fields) tokStats.perField[f] /= src.length; for (const k of [4, 6]) tokStats.perRowK[k] /= B;
    res.tokens = tokStats; res.encodeMsAll = +encodeMs.toFixed(0); res.insertMsAllTables = +insertMs.toFixed(0);
    const t2 = performance.now(); const idx: Record<string, number> = {};
    for (const t of ['idx64', 'idx64t', 'idx128', 'j16']) {
      const ti = performance.now(); const xcol = t === 'j16' ? 'x16_' : 'x_', scol = t === 'j16' ? 'tokens_' : 's_';
      for (const f of fields) await q(`create index ${t}_x_${f} on ${S}.${t} (scope_id, ${xcol}${f}, row_id)`);
      await q(`create index ${t}_gin on ${S}.${t} using gin (${fields.map(f => `${scol}${f}`).join(',')})`);
      await q(`vacuum (analyze) ${S}.${t}`); idx[t] = +(performance.now() - ti).toFixed(0);
    }
    res.indexBuildMs = idx; res.indexTotalMs = +(performance.now() - t2).toFixed(0);
    res.sizes = (await q(`select c.relname rel, pg_relation_size(c.oid) heap, coalesce(pg_total_relation_size(nullif(c.reltoastrelid,0)),0) toast, pg_indexes_size(c.oid) idx, pg_total_relation_size(c.oid) total from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname=$1 order by 1`, [S])).rows;
    res.ginSizes = (await q(`select indexrelname, pg_relation_size(indexrelid) bytes from pg_stat_user_indexes where schemaname=$1 and indexrelname like '%_gin'`, [S])).rows;
    res.productSizes = (await q(`select c.relname rel, pg_relation_size(c.oid) heap, pg_indexes_size(c.oid) idx, pg_total_relation_size(c.oid) total from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname='native_verify_main' and c.relname in ('customers','customers_seal_index') order by 1`)).rows;
    res.finishedAt = new Date().toISOString();
    writeFileSync(`${OUT}/m1-fable-d1-load.json`, JSON.stringify(res, null, 2) + '\n'); console.log(JSON.stringify(res, null, 1));
  } finally { unlock(); }
}

type Path = 'plain' | 'product' | 'd1_64' | 'd1_128' | 'd1_proof_rows' | 'd1_proof_xor' | 'd3' | 'd3_proof';
// Verify one returned row: per leaf, the tag(s) the DB returned must equal the app's recomputation with the row id and the
// returned nonce/salt (one nonce per (row, field): all leaves on a field share it). Returns whether the tree evaluates true.
function verifyRow(pl: Plan, leaves: Leaf[], row: any, tagOf: (leaf: Leaf, p: { kind: string; piece: string }, rowId: string, nonce: Buffer) => string, hmacCounter: { n: number }) {
  const ok: boolean[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const got = row[`t${i}`], nonce: Buffer | null = row[`n${i}`];
    if (got === null || got === undefined || !nonce) { ok.push(false); continue; }
    const gotArr: string[] = Array.isArray(got) ? got.map(String) : [String(got)];
    const exp = pl.leaves[i].pieces.map(p => { hmacCounter.n++; return tagOf(leaves[i], p, row.row_id, nonce); });
    ok.push(exp.length === gotArr.length && exp.every((e, j) => e === gotArr[j]));
  }
  return evalTree(pl.tree, ok, { i: 0 });
}
async function runPath(c: Case, p: Path) {
  const t0 = performance.now(); let sqlMs = 0, count = -1, rows = 0, bytes = 0, verifyMs = 0; const hm = { n: 0 };
  const timed = async (s: string, v: unknown[]) => { const t = performance.now(); const r = await q(s, v); sqlMs += performance.now() - t; return r; };
  if (p === 'plain') { const params: unknown[] = [scopeA]; const w = plainWhere(c.node, params); count = Number((await timed(`select count(*) n from bench_realistic_100k.customers where scope_id=$1 and ${w}`, params)).rows[0].n); }
  else if (p === 'product') { count = await productCount(c); }
  else if (p === 'd1_64' || p === 'd1_128') { const pl = plan(c.node, 'd1', p === 'd1_64' ? '64' : '128', false); count = Number((await timed(`select count(*) n from ${S}.${p === 'd1_64' ? 'idx64' : 'idx128'} where scope_id=$1 and ${pl.where}`, pl.params)).rows[0].n); }
  else if (p === 'd3') { const pl = plan(c.node, 'd3', '64', false); count = Number((await timed(`select count(*) n from ${S}.j16 where scope_id=$1 and ${pl.where}`, pl.params)).rows[0].n); }
  else if (p === 'd1_proof_rows' || p === 'd3_proof') {
    const pl = plan(c.node, p === 'd3_proof' ? 'd3' : 'd1', '64', true); const leaves = leavesOf(c.node); const table = p === 'd3_proof' ? 'j16' : 'idx64t';
    const sel = pl.leaves.map((l, i) => `case when ${l.pred} then ${l.tagExpr} end t${i}, ${l.nonceExpr} n${i}`);
    const r = await timed(`select row_id, ${sel.join(',')} from ${S}.${table} where scope_id=$1 and ${pl.where}`, pl.params);
    rows = r.rows.length; bytes = JSON.stringify(r.rows).length;
    const tv = performance.now(); const seen = new Set<string>(); let ok = 0;
    for (const row of r.rows) { if (seen.has(row.row_id)) continue; seen.add(row.row_id); if (verifyRow(pl, leaves, row, (leaf, pc, id, nonce) => tag(leaf.field, pc.kind, pc.piece, id, nonce), hm)) ok++; }
    verifyMs = performance.now() - tv; count = ok;
  } else {
    const pl = plan(c.node, 'd1', '64', true); const leaves = leavesOf(c.node);
    assert(!('any' in c.node), 'xor variant is for AND/leaf only');
    const sel = pl.leaves.map((l, i) => l.windows ? `null::bigint x${i}` : `bit_xor(${l.tagExpr}) x${i}`);
    const r = await timed(`select array_agg(row_id) ids, array_agg(${pl.leaves.map(l => `${l.nonceExpr}`).join('||')}) nonces, ${sel.join(',')} from ${S}.idx64t where scope_id=$1 and ${pl.where}`, pl.params);
    const ids: string[] = r.rows[0].ids ?? []; const nonces: Buffer[] = r.rows[0].nonces ?? []; rows = ids.length; bytes = JSON.stringify(r.rows[0]).length;
    const tv = performance.now(); const seen = new Set(ids); let ok = seen.size === ids.length;
    if (ok) {
      const acc = leaves.map(() => 0n);
      for (let k = 0; k < ids.length; k++) for (let i = 0; i < leaves.length; i++) { if (pl.leaves[i].windows) continue; const nonce = nonces[k].subarray(8 * i, 8 * i + 8); hm.n++; acc[i] ^= BigInt(tag(leaves[i].field, pl.leaves[i].pieces[0].kind, pl.leaves[i].pieces[0].piece, ids[k], nonce)); }
      leaves.forEach((_, i) => { if (pl.leaves[i].windows) return; if (BigInt.asIntN(64, acc[i]) !== BigInt(r.rows[0][`x${i}`] ?? 0)) ok = false; });
    }
    verifyMs = performance.now() - tv; count = ok ? ids.length : -1;
  }
  return { totalMs: performance.now() - t0, sqlMs, count, rows, bytes, verifyMs, hmacs: hm.n };
}
async function measurePhase() {
  await lock('measure'); const res: any = { startedAt: new Date().toISOString(), schema: S, K, warm: 2, rounds: 7, cases: [] as any[] };
  try {
    const selected = cases.filter(c => !c.respectWords && c.name !== 'drain101');
    for (const c of selected) {
      const isOr = 'any' in c.node;
      // d1_proof_xor dropped: integrity proofs are optional under the owner's premise (hostile-DB tampering out of scope)
      const paths: Path[] = ['plain', 'product', 'd1_64', 'd1_128', 'd1_proof_rows', 'd3', 'd3_proof']; void isOr;
      const plainN = (await runPath(c, 'plain')).count;
      const samples: Record<string, any[]> = Object.fromEntries(paths.map(p => [p, []]));
      const windows = plan(c.node, 'd1', '64', false).windows;
      for (let round = 0; round < 9; round++) {
        const order = round % 2 ? [...paths].reverse() : paths;
        for (const p of order) {
          const r = await runPath(c, p);
          if (windows && p !== 'plain' && p !== 'product') assert(r.count >= plainN, `${c.name} ${p}: candidates ${r.count} < ${plainN}`);
          else assert.equal(r.count, plainN, `${c.name} ${p}: count ${r.count} != plain ${plainN}`);
          if (round >= 2) samples[p].push(r);
        }
      }
      const row: any = { name: c.name, plainCount: plainN, windows, paths: {} };
      for (const p of paths) { const xs = samples[p]; row.paths[p] = { totalMs: +median(xs.map(x => x.totalMs)).toFixed(1), sqlMs: +median(xs.map(x => x.sqlMs)).toFixed(1), verifyMs: +median(xs.map(x => x.verifyMs)).toFixed(1), count: xs[0].count, rows: xs[0].rows, bytes: xs[0].bytes, hmacs: xs[0].hmacs }; }
      res.cases.push(row); console.log(c.name, JSON.stringify(row.paths));
    }
    res.finishedAt = new Date().toISOString();
    writeFileSync(`${OUT}/m1-fable-d1-measure.json`, JSON.stringify(res, null, 2) + '\n');
  } finally { unlock(); }
}
// Coordinator request: counts with >= 50k matches, same session as plaintext and product, plus EXPLAIN of the proposed SQL.
async function bigPhase() {
  await lock('big'); const res: any = { startedAt: new Date().toISOString(), schema: S, K, warm: 2, rounds: 7, cases: [] as any[], explain: {} as any };
  try {
    const L = (op: Leaf['op'], field: Field, value: string): Leaf => ({ op, field, value });
    const big: Case[] = [
      { name: 'big_memo_서비스', node: L('contains', 'memo', '서비스') },
      { name: 'big_company_담당_and_memo_서비스', node: { all: [L('contains', 'company', '담당'), L('contains', 'memo', '서비스')] } },
      { name: 'big_address_고객_all_rows', node: L('contains', 'address', '고객') },
      { name: 'big_company_담당_or_address_서울', node: { any: [L('contains', 'company', '담당'), L('contains', 'address', '서울')] } },
    ];
    for (const c of big) {
      const paths: Path[] = ['plain', 'product', 'd1_64', 'd3'];
      const plainN = (await runPath(c, 'plain')).count;
      const samples: Record<string, any[]> = Object.fromEntries(paths.map(p => [p, []]));
      for (let round = 0; round < 9; round++) for (const p of round % 2 ? [...paths].reverse() : paths) { const r = await runPath(c, p); assert.equal(r.count, plainN, `${c.name} ${p}: ${r.count} != ${plainN}`); if (round >= 2) samples[p].push(r); }
      const row: any = { name: c.name, plainCount: plainN, paths: {} };
      for (const p of paths) row.paths[p] = { totalMs: +median(samples[p].map(x => x.totalMs)).toFixed(1), sqlMs: +median(samples[p].map(x => x.sqlMs)).toFixed(1) };
      res.cases.push(row); console.log(c.name, JSON.stringify(row));
    }
    res.finishedAt = new Date().toISOString();
    writeFileSync(`${OUT}/m1-fable-d1-big.json`, JSON.stringify(res, null, 2) + '\n'); console.log(JSON.stringify(res.cases, null, 1));
  } finally { unlock(); }
}
// EXPLAIN (ANALYZE, BUFFERS) once, separately from the timed runs (plan shape only; not a timing measurement, no lock), for and2 and a
// large AND on each proposed layout, with and without the companion scope_id condition (tokens already carry the scope).
async function explainPhase() {
  const res: any = { startedAt: new Date().toISOString(), schema: S, explain: {} as any };
  const L = (op: Leaf['op'], field: Field, value: string): Leaf => ({ op, field, value });
  const targets: Case[] = [cases.find(c => c.name === 'and2')!, { name: 'big_and', node: { all: [L('contains', 'company', '담당'), L('contains', 'memo', '서비스')] } }];
  for (const c of targets) for (const [name, kind, table] of [['d1_64', 'd1', 'idx64'], ['d3', 'd3', 'j16']] as const) {
    const pl = plan(c.node, kind, '64', false);
    const withScope = `select count(*) from ${S}.${table} where scope_id=$1 and ${pl.where}`;
    const noScope = `select count(*) from ${S}.${table} where ${pl.where.replace(/\$(\d+)/g, (_m, n) => '$' + (Number(n) - 1))}`;
    res.explain[`${c.name}/${name}`] = { withScope: (await q(`explain (analyze, buffers, format text) ${withScope}`, pl.params)).rows.map(r => r['QUERY PLAN']), noScopeCondition: (await q(`explain (analyze, buffers, format text) ${noScope}`, pl.params.slice(1))).rows.map(r => r['QUERY PLAN']) };
  }
  res.note = 'Single-scope schema: the multi-tenant misestimation found earlier (companion scope_id x token selectivity, ~690x under-estimate at 1e8 rows) cannot be reproduced here; the proposed SQL has the same shape (scope_id AND token predicates on the companion), so the same trap and the same remedy (drop the companion scope_id condition; tokens are scope-bound) apply. Not measured at 1e8.';
  writeFileSync(`${OUT}/m1-fable-d1-explain.json`, JSON.stringify(res, null, 2) + '\n');
  for (const [k, v] of Object.entries<any>(res.explain)) { console.log('##', k, 'withScope'); console.log(v.withScope.join('\n')); console.log('##', k, 'noScope'); console.log(v.noScopeCondition.join('\n')); }
}
async function writePhase() {
  await lock('write'); const res: any = { startedAt: new Date().toISOString(), schema: S, K };
  try {
    const src: Row[] = (await q(`select id::text id, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id limit 1000`)).rows;
    const usPerRow = (t: number) => +((performance.now() - t) / src.length * 1000).toFixed(0);
    let t = performance.now(); for (const r of src) encodeRow(r); res.encodeAllDesignsUsPerRow = usPerRow(t);
    t = performance.now(); let n8 = 0; for (const r of src) for (const f of fields) { const ps = kgramPieces(r[f]); n8 += ps.length; for (const p of ps) tokenBuf(f, p.kind, p.piece); } res.encodeD1TokensOnlyUsPerRow = usPerRow(t); res.d1TokensPerRow = +(n8 / src.length).toFixed(1);
    t = performance.now(); for (const r of src) for (const f of fields) { const salt = randomBytes(8); for (const p of kgramPieces(r[f])) judge(kPiece(f, p.kind, p.piece), salt); for (const p of productPieces(r[f])) tok16(f, p.kind, p.piece); } res.encodeD3TokensAndJudgmentUsPerRow = usPerRow(t);
    const prof = fields.map(f => profiles('m', f, { type: 'text', search: { exact: true, substring: { wordBoundary: true, skipGrams: true } } } as any));
    const ring = sealer.ring('m'); const cache = { profiles: new Map<string, Promise<CryptoKey>>() };
    t = performance.now(); let np = 0;
    for (const r of src) for (let i = 0; i < fields.length; i++) for (const p of prof[i]) { const pcs = searchPieces(p, r[fields[i]]); np += pcs.length; await searchTokens(ring, scopeA, p, pcs, cache); }
    res.encodeProductWebCryptoUsPerRow = usPerRow(t); res.productPiecesPerRow = +(np / src.length).toFixed(1);
    // single-row insert cost: product companion layout copy vs idx64t (D1 + tags) vs j16 (D3), 300 rows each, removed afterwards
    await q(`create table ${S}.prod_copy (like native_verify_main.customers_seal_index including all)`);
    const defs = (await q(`select indexdef from pg_indexes where schemaname='native_verify_main' and tablename='customers_seal_index' and indexname not like '%_uq'`)).rows.map(r => r.indexdef as string);
    for (const [i, d] of defs.entries()) await q(d.replace(/INDEX \S+ ON native_verify_main\.customers_seal_index/, `INDEX prod_copy_${i} ON ${S}.prod_copy`));
    await q(`insert into ${S}.prod_copy select * from native_verify_main.customers_seal_index`); await q(`vacuum (analyze) ${S}.prod_copy`);
    const sample = src.slice(0, 300); const ids = sample.map(r => r.id);
    const prodRows = (await q(`select * from native_verify_main.customers_seal_index where row_id = any($1::uuid[])`, [ids])).rows; const cols = Object.keys(prodRows[0]);
    for (const tname of ['prod_copy', 'idx64t', 'j16']) await q(`delete from ${S}.${tname} where row_id = any($1::uuid[])`, [ids]);
    const F = (tf: (f: string) => string) => fields.map(tf);
    const c64t = ['scope_id', 'row_id', ...F(f => `x_${f}`), ...F(f => `s_${f}`), ...F(f => `v_${f}`), ...F(f => `mx_${f}`), ...F(f => `m_${f}`)];
    const cj = ['scope_id', 'row_id', ...F(f => `tokens_${f}`), ...F(f => `x16_${f}`), ...F(f => `salt_${f}`), ...F(f => `jt_${f}`), ...F(f => `jx_${f}`), ...F(f => `jm_${f}`), ...F(f => `jmx_${f}`)];
    const tp: number[] = [], td: number[] = [], tj: number[] = [];
    for (let i = 0; i < sample.length; i++) {
      const pr = prodRows[i]; let t0 = performance.now();
      await q(`insert into ${S}.prod_copy (${cols.join(',')}) values (${cols.map((_, j) => `$${j + 1}`).join(',')})`, cols.map(cn => pr[cn])); tp.push(performance.now() - t0);
      const e = encodeRow(sample[i]);
      t0 = performance.now(); await q(`insert into ${S}.idx64t (${c64t.join(',')}) values (${c64t.map((_, j) => `$${j + 1}`).join(',')})`, [scopeA, sample[i].id, ...F(f => e.x[f]), ...F(f => e.s[f]), ...F(f => e.v[f]), ...F(f => e.mx[f]), ...F(f => e.m[f])]); td.push(performance.now() - t0);
      t0 = performance.now(); await q(`insert into ${S}.j16 (${cj.join(',')}) values (${cj.map((_, j) => `$${j + 1}`).join(',')})`, [scopeA, sample[i].id, ...F(f => e.t16[f]), ...F(f => e.x16[f]), ...F(f => e.salt[f]), ...F(f => e.jt[f]), ...F(f => e.jx[f]), ...F(f => e.jm[f]), ...F(f => e.jmx[f])]); tj.push(performance.now() - t0);
    }
    res.insertMsMedian = { productLayout: +median(tp).toFixed(2), d1WithTags: +median(td).toFixed(2), d3: +median(tj).toFixed(2), rows: sample.length };
    await q(`drop table ${S}.prod_copy`);
    res.finishedAt = new Date().toISOString();
    writeFileSync(`${OUT}/m1-fable-d1-write.json`, JSON.stringify(res, null, 2) + '\n'); console.log(JSON.stringify(res, null, 1));
  } finally { unlock(); }
}
try {
  if (phase === 'load') await loadPhase();
  else if (phase === 'measure') await measurePhase();
  else if (phase === 'big') await bigPhase();
  else if (phase === 'explain') await explainPhase();
  else if (phase === 'write') await writePhase();
  else { await q(`drop schema if exists ${S} cascade`); console.log('dropped', S); }
} finally { await pool.end(); }

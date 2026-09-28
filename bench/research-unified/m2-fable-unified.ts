/**
 * Unified comparison (m2-fable): same data, same queries, plaintext = 1x.
 *   plain : normalized plaintext (customers 6 fields + tickets memo) + B-tree (exact) + pg_trgm GIN
 *   A     : current product, public API on native_verify_main (same rows)
 *   C     : MongoDB layout as-is: per-occurrence tags (B-tree side table) + counter table (esc), DB derives tags with pgcrypto
 *   D     : combination: 16-bit candidate GIN over substrings 2..K (+prefix/suffix for address/email) + row nonce + 64-bit check
 *           values, DB confirms with pgcrypto digest; list queries stop at LIMIT (index scan in id order)
 * Schema research_u_m2fable (kept for re-measurement). PRF: sha256(key||label) for tokens, sha256(token||x) for checks/tags
 * (keyed-hash proxy; pgcrypto digest() recomputes the same on the DB side). Ciphertexts: AES-256-GCM (node crypto).
 * Phases: load | measure | lists | join | write | sizes.   Run: rtk proxy npx tsx bench/research-unified/m2-fable-unified.ts <phase>
 */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, hash, randomBytes, randomUUID, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { assertDisposable } from '../../test/disposable.js';
import { cases as r8cases, condition, plainWhere, type Case as R8Case, type Node, type Leaf } from '../verify-native/r8-cases.js';
import { customersSeal, ticketsSeal, sealed, scopeId as PRODUCT_SCOPE } from '../verify-native/schema.js';
import { normalizeText } from '../../src/core/search-tokens.js';
// extra count cases requested in the shared contract (broad memo substring, OR+AND mix, 45-glyph term)
const extraCases: R8Case[] = [
  { name: 'sub_common_memo', node: { op: 'contains', field: 'memo', value: '서비스' } },
  { name: 'or_and_mix', node: { any: [{ all: [{ op: 'eq', field: 'company', value: '서울서비스 담당' }, { op: 'contains', field: 'memo', value: '서비스' }] }, { op: 'contains', field: 'memo', value: '푸른달' }] } },
  { name: 'sub45', node: { op: 'contains', field: 'memo', value: '상세안내와확인내용'.repeat(5) } },
];
const allCases: R8Case[] = [...r8cases, ...extraCases];

const { Pool } = pg;
const phase = process.argv[2]; assert(['load', 'measure', 'lists', 'join', 'write', 'sizes'].includes(phase ?? ''), 'phase');
const S = 'research_u', SRC = 'bench_realistic_100k', K = 10, OUT = 'bench/results/2026-09-28-unified', LOCK = '.local/research/measure.lock';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 10, options: '-c statement_timeout=1800000' });
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
const sqlStat = { ms: 0, n: 0, rows: 0 };
const rawQuery = pool.query.bind(pool);
(pool as any).query = async (...args: any[]) => { const t = performance.now(); try { const r = await (rawQuery as any)(...args); sqlStat.rows += r?.rowCount ?? 0; return r; } finally { sqlStat.ms += performance.now() - t; sqlStat.n++; } };
const q = async (t: string, v: unknown[] = []) => (await pool.query(t, v)).rows;
async function lock() { for (;;) { if (!existsSync(LOCK)) { try { writeFileSync(LOCK, 'm2-fable unified ' + phase + ' ' + new Date().toISOString() + '\n', { flag: 'wx' }); return; } catch { /* raced */ } } console.error('measure.lock held; waiting 60s'); await new Promise(r => setTimeout(r, 60000)); } }
function unlock() { if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('m2-fable unified')) unlinkSync(LOCK); }
mkdirSync(OUT, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(OUT + '/m2-fable-' + name + '.json', JSON.stringify(data, null, 1));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---- crypto (research keys) ----
const KEY = Buffer.alloc(32, 7), AES = Buffer.alloc(32, 93);
const tokenOf = (label: string) => hash('sha256', Buffer.concat([KEY, Buffer.from(label)]), 'buffer') as Buffer;
const trunc64 = (b: Buffer) => b.readBigInt64BE(0), trunc16 = (b: Buffer) => b.readUInt16BE(0);
const hex8 = (b: Buffer) => '\\x' + b.subarray(0, 8).toString('hex');
const chkOf = (tok: Buffer, nonce: Buffer) => hex8(hash('sha256', Buffer.concat([tok, nonce]), 'buffer') as Buffer);
const ctagOf = (tok: Buffer, n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return hex8(hash('sha256', Buffer.concat([tok, b]), 'buffer') as Buffer); };
const escId = (tok: Buffer) => hash('sha256', Buffer.concat([tok, Buffer.from('esc')]), 'buffer') as Buffer;
function encrypt(v: string) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', AES, iv); const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]); }
function decrypt(b: Buffer) { const d = createDecipheriv('aes-256-gcm', AES, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }
const FIELDS = ['name', 'phone', 'address', 'memo', 'email', 'company'] as const; type F = typeof FIELDS[number];
const AFFIX: Record<string, boolean> = { address: true, email: true }; // prefix/suffix pieces only where the queries need them
function labels(table: string, field: string, v: string): string[] {
  const c = Array.from(v), out = new Set<string>(); const p = table + '\0' + field + '\0';
  out.add(p + 'e\0' + v);
  for (let l = 2; l <= K; l++) for (let i = 0; i + l <= c.length; i++) out.add(p + 's\0' + c.slice(i, i + l).join(''));
  if (AFFIX[field]) for (let l = 2; l <= Math.min(K, c.length); l++) { out.add(p + 'p\0' + c.slice(0, l).join('')); out.add(p + 'x\0' + c.slice(c.length - l).join('')); }
  return [...out];
}
const normTerm = (s: string) => normalizeText(s, 'legacy-text-v1');

// ================= LOAD =================
if (phase === 'load') {
  await lock();
  try {
    const t0 = performance.now();
    await q('create extension if not exists pgcrypto'); await q('create extension if not exists pg_trgm');
    await q('drop schema if exists ' + S + ' cascade'); await q('create schema ' + S);
    await q(`create table ${S}.customers_plain (id uuid primary key, scope_id uuid not null, ${FIELDS.map(f => f + '_norm text not null').join(',')}, memo_len int not null)`);
    await q(`create table ${S}.tickets_plain (id uuid primary key, scope_id uuid not null, customer_id uuid not null, memo_norm text not null)`);
    await q(`create table ${S}.customers_ct (id uuid primary key, scope_id uuid not null, ${FIELDS.map(f => f + '_ct bytea not null').join(',')}, memo_len int not null)`);
    await q(`create table ${S}.tickets_ct (id uuid primary key, scope_id uuid not null, customer_id uuid not null, memo_ct bytea not null)`);
    await q(`create table ${S}.customers_d (id uuid primary key, nonce bytea not null, cand int[] not null, chk8 bytea[] not null, memo_len int not null)`);
    await q(`create table ${S}.tickets_d (id uuid primary key, customer_id uuid not null, nonce bytea not null, cand int[] not null, chk8 bytea[] not null)`);
    await q(`create table ${S}.customers_ctag (tag8 bytea not null, id uuid not null)`);
    await q(`create table ${S}.tickets_ctag (tag8 bytea not null, id uuid not null)`);
    await q(`create table ${S}.esc (tok bytea primary key, n int not null)`);
    const counters = new Map<string, number>(); let tagsC = 0, tagsT = 0;
    for (const table of ['customers', 'tickets'] as const) {
      const fields = table === 'customers' ? [...FIELDS] : ['memo'];
      const rows = await q(`select id::text, scope_id::text${table === 'tickets' ? ', customer_id::text' : ''}, ${fields.map(f => f + '_norm as ' + f).join(',')} from ${SRC}.${table} order by id`);
      assert.equal(rows.length, 100000);
      const B = 2000;
      for (let i = 0; i < rows.length; i += B) {
        const chunk = rows.slice(i, i + B);
        const pv: unknown[] = [], cv: unknown[] = [], dv: unknown[] = []; const ps: string[] = [], cs: string[] = [], ds: string[] = []; const tagArr: string[] = [], tagIds: string[] = [];
        for (const r of chunk) {
          const nonce = randomBytes(16); const cand = new Set<number>(); const chks: string[] = [];
          for (const f of fields) { for (const l of labels(table, f, r[f])) { const tok = tokenOf(l); cand.add(trunc16(tok)); chks.push(chkOf(tok, nonce)); const n = (counters.get(l) ?? 0) + 1; counters.set(l, n); tagArr.push(ctagOf(tok, n)); tagIds.push(r.id); } }
          if (table === 'customers') tagsC += chks.length; else tagsT += chks.length;
          const memoLen = Array.from(r.memo).length;
          if (table === 'customers') {
            ps.push('(' + [...Array(9)].map((_, j) => '$' + (pv.length + j + 1)).join(',') + ')'); pv.push(r.id, r.scope_id, ...fields.map(f => r[f]), memoLen);
            cs.push('(' + [...Array(9)].map((_, j) => '$' + (cv.length + j + 1)).join(',') + ')'); cv.push(r.id, r.scope_id, ...fields.map(f => encrypt(r[f])), memoLen);
            ds.push('($' + (dv.length + 1) + ',$' + (dv.length + 2) + ',$' + (dv.length + 3) + ',$' + (dv.length + 4) + '::bytea[],$' + (dv.length + 5) + ')'); dv.push(r.id, nonce, [...cand], chks, memoLen);
          } else {
            ps.push('(' + [...Array(4)].map((_, j) => '$' + (pv.length + j + 1)).join(',') + ')'); pv.push(r.id, r.scope_id, r.customer_id, r.memo);
            cs.push('(' + [...Array(4)].map((_, j) => '$' + (cv.length + j + 1)).join(',') + ')'); cv.push(r.id, r.scope_id, r.customer_id, encrypt(r.memo));
            ds.push('($' + (dv.length + 1) + ',$' + (dv.length + 2) + ',$' + (dv.length + 3) + ',$' + (dv.length + 4) + ',$' + (dv.length + 5) + '::bytea[])'); dv.push(r.id, r.customer_id, nonce, [...cand], chks);
          }
        }
        await q(`insert into ${S}.${table}_plain values ` + ps.join(','), pv);
        await q(`insert into ${S}.${table}_ct values ` + cs.join(','), cv);
        await q(`insert into ${S}.${table}_d values ` + ds.join(','), dv);
        await q(`insert into ${S}.${table}_ctag select unnest($1::bytea[]), unnest($2::uuid[])`, [tagArr, tagIds]);
        if (i % 20000 === 0) console.log(table, 'loaded', i + chunk.length, ((performance.now() - t0) / 1000).toFixed(0) + 's', 'tags', tagArr.length);
      }
    }
    const ev: unknown[] = []; const es: string[] = []; let flushed = 0;
    for (const [l, n] of counters) { es.push('($' + (ev.length + 1) + ',$' + (ev.length + 2) + ')'); ev.push(escId(tokenOf(l)), n); if (es.length === 5000) { await q(`insert into ${S}.esc values ` + es.join(','), ev); flushed += es.length; es.length = 0; ev.length = 0; } }
    if (es.length) { await q(`insert into ${S}.esc values ` + es.join(','), ev); flushed += es.length; }
    const tIdx = performance.now();
    for (const f of FIELDS) { await q(`create index on ${S}.customers_plain (${f}_norm)`); await q(`create index on ${S}.customers_plain using gin (${f}_norm gin_trgm_ops)`); }
    await q(`create index on ${S}.tickets_plain (customer_id)`); await q(`create index on ${S}.tickets_plain using gin (memo_norm gin_trgm_ops)`);
    await q(`create index on ${S}.tickets_ct (customer_id)`);
    await q(`create index on ${S}.customers_d using gin (cand)`); await q(`create index on ${S}.tickets_d using gin (cand)`); await q(`create index on ${S}.tickets_d (customer_id)`);
    await q(`create index on ${S}.customers_ctag (tag8, id)`); await q(`create index on ${S}.tickets_ctag (tag8, id)`);
    for (const t of ['customers_plain', 'tickets_plain', 'customers_ct', 'tickets_ct', 'customers_d', 'tickets_d', 'customers_ctag', 'tickets_ctag', 'esc']) await q(`vacuum analyze ${S}.${t}`);
    const out = { rows: { customers: 100000, tickets: 100000 }, K, affixFields: Object.keys(AFFIX), tagsPerCustomer: +(tagsC / 100000).toFixed(1), tagsPerTicket: +(tagsT / 100000).toFixed(1), distinctLabels: counters.size, escRows: flushed, loadSec: +((tIdx - t0) / 1000).toFixed(0), indexSec: +((performance.now() - tIdx) / 1000).toFixed(0) };
    console.log(JSON.stringify(out)); save('load', out);
    const truth: any[] = []; for (const c of allCases) { const p: unknown[] = []; const w = plainWhere(c.node, p); truth.push({ name: c.name, condition: condition(c.node), respectWords: !!c.respectWords, count: Number((await q(`select count(*) n from ${S}.customers_plain where ${w}`, p))[0].n) }); }
    truth.push({ name: 'join', condition: 'tickets.memo contains "서비스" AND customers.company = "서울서비스 담당"', count: Number((await q(`select count(*) n from ${S}.tickets_plain t join ${S}.customers_plain c on c.id = t.customer_id where t.memo_norm like '%서비스%' and c.company_norm = '서울서비스담당'`))[0].n) });
    truth.push({ name: 'sum', condition: 'sum(memo_len) where memo contains "서비스"', count: Number((await q(`select sum(memo_len) n from ${S}.customers_plain where memo_norm like '%서비스%'`))[0].n) });
    save('truth', truth); console.log(JSON.stringify(truth));
  } finally { unlock(); }
}

// ================= query compilers =================
type Leaf2 = Leaf & { respectWords?: boolean };
const leafLabel = (table: string, l: Leaf) => { const t = normTerm(l.value); const kind = l.op === 'eq' ? 'e' : l.op === 'contains' ? 's' : l.op === 'startsWith' ? 'p' : 'x'; return { term: t, kind, label: table + '\0' + l.field + '\0' + kind + '\0' + t }; };
const longTerm = (l: Leaf) => l.op !== 'eq' && Array.from(normTerm(l.value)).length > K; // window AND + app verification
type Compiled = { where: string; params: unknown[]; verify: Leaf[] };
// D: candidate GIN pre-filter + per-row check; long terms -> all K-windows as candidates, verified in the app.
function compileD(table: string, n: Node, params: unknown[], verify: Leaf[], respectWords = false): string {
  if ('all' in n) return '(' + n.all.map(x => compileD(table, x, params, verify, respectWords)).join(' and ') + ')';
  if ('any' in n) return '(' + n.any.map(x => compileD(table, x, params, verify, respectWords)).join(' or ') + ')';
  const { term, kind } = leafLabel(table, n);
  if (longTerm(n) || respectWords) { // window AND on 16-bit candidates + check values of the windows; final answer verified by the app
    const c = Array.from(term); const parts: string[] = []; verify.push(n);
    for (let i = 0; i + K <= c.length || (i === 0 && c.length < K); i += K) { const w = c.slice(i, Math.min(i + K, c.length)).join(''); const tok = tokenOf(table + '\0' + n.field + '\0s\0' + w); params.push(trunc16(tok), tok); parts.push(`(cand @> array[$${params.length - 1}::int] and substr(digest($${params.length}::bytea || nonce, 'sha256'), 1, 8) = any(chk8))`); }
    return '(' + parts.join(' and ') + ')';
  }
  const tok = tokenOf(table + '\0' + n.field + '\0' + kind + '\0' + term); params.push(trunc16(tok), tok);
  return `(cand @> array[$${params.length - 1}::int] and substr(digest($${params.length}::bytea || nonce, 'sha256'), 1, 8) = any(chk8))`;
}
// C: per-occurrence tags; DB derives the tag list from the counter table; long terms -> window AND + app verification
const genTags = (i: number) => `array(select substr(digest($${i}::bytea || int4send(g), 'sha256'), 1, 8) from generate_series(1, coalesce((select n from ${S}.esc where tok = digest($${i}::bytea || 'esc'::bytea, 'sha256')), 0)) g)`;
function compileC(table: string, n: Node, params: unknown[], verify: Leaf[], respectWords = false): string {
  if ('all' in n) return '(' + n.all.map(x => compileC(table, x, params, verify, respectWords)).join(' intersect ') + ')';
  if ('any' in n) return '(' + n.any.map(x => compileC(table, x, params, verify, respectWords)).join(' union ') + ')';
  const { term, kind } = leafLabel(table, n);
  const one = (label: string) => { const tok = tokenOf(label); params.push(tok); return `select id from ${S}.${table}_ctag where tag8 = any(${genTags(params.length)})`; };
  if (longTerm(n) || respectWords) { const c = Array.from(term); const parts: string[] = []; verify.push(n); for (let i = 0; i + K <= c.length || (i === 0 && c.length < K); i += K) parts.push(one(table + '\0' + n.field + '\0s\0' + c.slice(i, Math.min(i + K, c.length)).join(''))); return '(' + parts.join(' intersect ') + ')'; }
  return one(table + '\0' + n.field + '\0' + kind + '\0' + term);
}
function verifyRow(row: Record<string, string>, leaf: Leaf, respectWords: boolean): boolean {
  const v = row[leaf.field] ?? ''; const t = normTerm(leaf.value);
  if (respectWords) { const words = v; return words.includes(t); } // ponytail: word-boundary semantics approximated as substring of the no-space string; recorded in the report
  return leaf.op === 'contains' ? v.includes(t) : leaf.op === 'startsWith' ? v.startsWith(t) : leaf.op === 'endsWith' ? v.endsWith(t) : v === t;
}
function evalNode(row: Record<string, string>, n: Node, respectWords: boolean): boolean { if ('all' in n) return n.all.every(x => evalNode(row, x, respectWords)); if ('any' in n) return n.any.some(x => evalNode(row, x, respectWords)); return verifyRow(row, n, respectWords); }
// app-side verification for long terms: fetch ciphertexts of candidates, decrypt, re-evaluate the whole predicate
const dec = { count: 0 };
async function fetchDecrypt(table: string, ids: string[]) { if (!ids.length) return; const fields = table === 'customers' ? [...FIELDS] : ['memo']; const rows = await q(`select id::text, ${fields.map(f => f + '_ct').join(',')} from ${S}.${table}_ct where id = any($1::uuid[])`, [ids]); for (const r of rows) for (const f of fields) { decrypt(r[f + '_ct']); dec.count++; } }
async function appVerify(table: string, ids: string[], c: R8Case): Promise<string[]> {
  if (!ids.length) return [];
  const fields = table === 'customers' ? [...FIELDS] : ['memo'];
  const rows = await q(`select id::text, ${fields.map(f => f + '_ct').join(',')} from ${S}.${table}_ct where id = any($1::uuid[])`, [ids]);
  const ok: string[] = [];
  for (const r of rows) { const plain: Record<string, string> = {}; for (const f of fields) { plain[f] = decrypt(r[f + '_ct']); dec.count++; } if (evalNode(plain, c.node, !!c.respectWords)) ok.push(r.id); }
  return ok.sort();
}

// ---- paths ----
type Res = { n?: number; ids?: string[]; app: number; decrypts: number; sql: number; dbMs: number };
function wrap<T>(fn: () => Promise<T>) { return async () => { const s0 = { ...sqlStat }; dec.count = 0; const r: any = await fn(); return { ...(r as object), decrypts: dec.count, sql: sqlStat.n - s0.n, dbMs: sqlStat.ms - s0.ms, app: r.app >= 0 ? r.app : sqlStat.rows - s0.rows } as Res; }; }
const plainCountSql = (table: string, c: R8Case) => { const p: unknown[] = []; const w = plainWhere(c.node, p); return { text: `select count(*) n from ${S}.${table}_plain where ${w}`, p }; };
async function plainCount(table: string, c: R8Case) { const { text, p } = plainCountSql(table, c); return { n: Number((await q(text, p))[0].n), app: 0 }; }
async function plainList(table: string, c: R8Case, limit?: number) { const p: unknown[] = []; const w = plainWhere(c.node, p); const rows = await q(`select id::text from ${S}.${table}_plain where ${w} order by id${limit ? ' limit ' + limit : ''}`, p); return { ids: rows.map(r => r.id), app: rows.length }; }
async function dCount(table: string, c: R8Case) { const params: unknown[] = [], verify: Leaf[] = []; const w = compileD(table, c.node, params, verify, !!c.respectWords);
  if (!verify.length) return { n: Number((await q(`select count(*) n from ${S}.${table}_d where ${w}`, params))[0].n), app: 0 };
  const ids = (await q(`select id::text from ${S}.${table}_d where ${w}`, params)).map(r => r.id); const ok = await appVerify(table, ids, c); return { n: ok.length, app: ids.length + ok.length }; }
async function dList(table: string, c: R8Case, limit?: number) { const params: unknown[] = [], verify: Leaf[] = []; const w = compileD(table, c.node, params, verify, !!c.respectWords);
  if (!verify.length) { const rows = await q(`select id::text from ${S}.${table}_d where ${w} order by id${limit ? ' limit ' + limit : ''}`, params); const ids = rows.map(r => r.id); await fetchDecrypt(table, ids); return { ids, app: rows.length * 2 }; }
  const ids = (await q(`select id::text from ${S}.${table}_d where ${w} order by id`, params)).map(r => r.id); const ok = await appVerify(table, ids, c); const out = limit ? ok.slice(0, limit) : ok; return { ids: out, app: ids.length + ok.length }; }
async function cCount(table: string, c: R8Case) { const params: unknown[] = [], verify: Leaf[] = []; const w = compileC(table, c.node, params, verify, !!c.respectWords);
  if (!verify.length) return { n: Number((await q(`select count(*) n from (${w}) x`, params))[0].n), app: 0 };
  const ids = (await q(`select id::text from (${w}) x`, params)).map(r => r.id); const ok = await appVerify(table, ids, c); return { n: ok.length, app: ids.length + ok.length }; }
async function cList(table: string, c: R8Case, limit?: number) { const params: unknown[] = [], verify: Leaf[] = []; const w = compileC(table, c.node, params, verify, !!c.respectWords);
  if (!verify.length) { const rows = await q(`select id::text from (${w}) x order by id${limit ? ' limit ' + limit : ''}`, params); const ids = rows.map(r => r.id); await fetchDecrypt(table, ids); return { ids, app: rows.length * 2 }; }
  const ids = (await q(`select id::text from (${w}) x order by id`, params)).map(r => r.id); const ok = await appVerify(table, ids, c); const out = limit ? ok.slice(0, limit) : ok; return { ids: out, app: ids.length + ok.length }; }
// A: current product public API
const db = drizzle(pool);
function matchOf(n: Node, m: any): any { if ('all' in n) return m.and(...n.all.map(x => matchOf(x, m))); if ('any' in n) return m.or(...n.any.map(x => matchOf(x, m))); return m[n.field][n.op](n.value); }
async function aCount(c: R8Case) { const n = await sealed.count(db, customersSeal, { scope: PRODUCT_SCOPE, match: (m: any) => matchOf(c.node, m) } as any); return { n: Number(n), app: -1 }; }
async function aList(c: R8Case, limit?: number) { const r: any = await sealed.findMany(db, customersSeal, { scope: PRODUCT_SCOPE, match: (m: any) => matchOf(c.node, m), columns: { name: true, phone: true, address: true, memo: true, email: true, company: true }, ...(limit ? { limit } : {}) } as any); return { ids: r.items.map((x: any) => String(x.id)), app: -1 }; }

async function bench(label: string, truthFn: () => Promise<any>, paths: Record<string, () => Promise<Res>>, kind: 'count' | 'list') {
  const truth = await truthFn(); const names = Object.keys(paths); const runs: Record<string, number[]> = {}, dbs: Record<string, number[]> = {}, meta: Record<string, any> = {}, failed: Record<string, string> = {};
  for (const n of names) { runs[n] = []; dbs[n] = []; }
  for (let i = 0; i < 10; i++) { const order = i === 0 ? names : [...names.slice(i % names.length), ...names.slice(0, i % names.length)];
    for (const n of order) { if (failed[n]) continue; const t = performance.now(); let r: Res; try { r = await paths[n](); } catch (e) { failed[n] = String((e as Error).message).slice(0, 100); console.log('FAILED', label, n, failed[n]); continue; } const ms = performance.now() - t;
      const ok = kind === 'count' ? r.n === truth.n : (r.ids!.length === truth.ids.length && r.ids!.every((x, j) => x === truth.ids[j]));
      if (!ok) { failed[n] = 'mismatch ' + (kind === 'count' ? r.n : r.ids!.length) + ' vs ' + (kind === 'count' ? truth.n : truth.ids.length); console.log('FAILED', label, n, failed[n]); continue; }
      if (i >= 3) { runs[n].push(ms); dbs[n].push(r.dbMs); } meta[n] = { app: r.app, decrypts: r.decrypts, sql: r.sql }; } }
  const ok = names.filter(n => !failed[n]);
  const row = { label, truth: kind === 'count' ? truth.n : truth.ids.length, medians: Object.fromEntries(ok.map(n => [n, +median(runs[n]).toFixed(1)])), dbMedians: Object.fromEntries(ok.map(n => [n, +median(dbs[n]).toFixed(1)])), meta: Object.fromEntries(ok.map(n => [n, meta[n]])), failed };
  console.log(JSON.stringify(row)); return row;
}

if (phase === 'measure') { // all r8 count cases on customers: plain / A / C / D
  await lock();
  try { const results: any[] = [];
    for (const c of allCases) results.push(await bench('count ' + c.name + ' | ' + condition(c.node), () => plainCount('customers', c), { plain: wrap(() => plainCount('customers', c)), A: wrap(() => aCount(c)), C: wrap(() => cCount('customers', c)), D: wrap(() => dCount('customers', c)) }, 'count'));
    save('measure', results); } finally { unlock(); }
}
if (phase === 'lists') { // representative 6 cases x limit 20 / 200 / all
  await lock();
  try { const results: any[] = []; const pick = ['exact_common', 'sub_rare', 'starts', 'and2', 'or2', 'and6'];
    for (const name of pick) { const c = allCases.find(x => x.name === name)!; for (const limit of [20, 200, undefined]) results.push(await bench('list ' + name + ' limit ' + (limit ?? 'all'), () => plainList('customers', c, limit), { plain: wrap(() => plainList('customers', c, limit)), A: wrap(() => aList(c, limit)), C: wrap(() => cList('customers', c, limit)), D: wrap(() => dList('customers', c, limit)) }, 'list')); }
    save('lists', results); } finally { unlock(); }
}
if (phase === 'join') { // JOIN: tickets memo contains 서비스 AND customer company = 서울서비스 담당 (count + list 20); SUM over customers memo contains 서비스
  await lock();
  try { const results: any[] = [];
    const tk: R8Case = { name: 'join', node: { op: 'contains', field: 'memo', value: '서비스' } }; const cu: R8Case = { name: 'join', node: { op: 'eq', field: 'company', value: '서울서비스 담당' } };
    const pj = (limit?: number) => async () => { const p1: unknown[] = []; const w1 = plainWhere(tk.node, p1); const p2: unknown[] = []; const w2 = plainWhere(cu.node, p2).replace(/\$1/g, '$' + (p1.length + 1)); const rows = await q(`select t.id::text from ${S}.tickets_plain t join ${S}.customers_plain c on c.id = t.customer_id where ${w1} and ${w2}${limit ? ' order by t.id limit ' + limit : ''}`, [...p1, ...p2]); return limit ? { ids: rows.map(r => r.id), app: rows.length } : { n: rows.length, app: 0 }; };
    const pjc = async () => { const p1: unknown[] = []; const w1 = plainWhere(tk.node, p1); const p2: unknown[] = []; const w2 = plainWhere(cu.node, p2).replace(/\$1/g, '$' + (p1.length + 1)); return { n: Number((await q(`select count(*) n from ${S}.tickets_plain t join ${S}.customers_plain c on c.id = t.customer_id where ${w1} and ${w2}`, [...p1, ...p2]))[0].n), app: 0 }; };
    const dj = (limit?: number) => async () => { const params: unknown[] = [], v: Leaf[] = []; const w1 = compileD('tickets', tk.node, params, v); const w2 = compileD('customers', cu.node, params, v); const sql = `from ${S}.tickets_d t join ${S}.customers_d c on c.id = t.customer_id where ${w1.replace(/cand @>/g, 't.cand @>').replace(/nonce/g, 't.nonce').replace(/any\(chk8\)/g, 'any(t.chk8)')} and ${w2.replace(/cand @>/g, 'c.cand @>').replace(/nonce/g, 'c.nonce').replace(/any\(chk8\)/g, 'any(c.chk8)')}`; if (limit) { const rows = await q(`select t.id::text ${sql} order by t.id limit ${limit}`, params); return { ids: rows.map(r => r.id), app: rows.length }; } return { n: Number((await q(`select count(*) n ${sql}`, params))[0].n), app: 0 }; };
    const cj = (limit?: number) => async () => { const params: unknown[] = [], v: Leaf[] = []; const w1 = compileC('tickets', tk.node, params, v); const w2 = compileC('customers', cu.node, params, v); const sql = `from (${w1}) t join ${S}.tickets_d td on td.id = t.id join (${w2}) c on c.id = td.customer_id`; if (limit) { const rows = await q(`select t.id::text ${sql} order by t.id limit ${limit}`, params); return { ids: rows.map(r => r.id), app: rows.length }; } return { n: Number((await q(`select count(*) n ${sql}`, params))[0].n), app: 0 }; };
    results.push(await bench('join count tickets.memo~서비스 AND customer.company=서울서비스담당', pjc, { plain: wrap(pjc), C: wrap(cj()), D: wrap(dj()) }, 'count'));
    results.push(await bench('join list 20', pj(20), { plain: wrap(pj(20)), C: wrap(cj(20)), D: wrap(dj(20)) }, 'list'));
    // SUM (premise: a plaintext-derived number memo_len is stored beside the row; the encrypted designs sum it over rows their predicate selects)
    const sc: R8Case = { name: 'sum', node: { op: 'contains', field: 'memo', value: '서비스' } };
    const ps = async () => { const p: unknown[] = []; const w = plainWhere(sc.node, p); return { n: Number((await q(`select sum(memo_len) n from ${S}.customers_plain where ${w}`, p))[0].n), app: 0 }; };
    const ds = async () => { const params: unknown[] = [], v: Leaf[] = []; const w = compileD('customers', sc.node, params, v); return { n: Number((await q(`select sum(memo_len) n from ${S}.customers_d where ${w}`, params))[0].n), app: 0 }; };
    const cs = async () => { const params: unknown[] = [], v: Leaf[] = []; const w = compileC('customers', sc.node, params, v); return { n: Number((await q(`select sum(memo_len) n from ${S}.customers_ct where id in (${w})`, params))[0].n), app: 0 }; };
    results.push(await bench('sum(memo_len) memo~서비스', ps, { plain: wrap(ps), C: wrap(cs), D: wrap(ds) }, 'count'));
    save('join', results); } finally { unlock(); }
}
if (phase === 'sizes') {
  const sizes = await q("select c.relname, pg_relation_size(c.oid) as bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind in ('r','i') order by 1", [S]);
  const prod = await q("select c.relname, pg_relation_size(c.oid) as bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='native_verify_main' and c.relname in ('customers','tickets','customers_seal_index','tickets_seal_index') or (n.nspname='native_verify_main' and c.relkind='i' and (c.relname like 'customers%' or c.relname like 'tickets%')) order by 1");
  console.log(JSON.stringify({ unified: sizes, product: prod })); save('sizes', { unified: sizes, product: prod });
}
if (phase === 'write') { // per-row insert (commit), partial update of one field, delete, 8 concurrent writers; count correctness afterwards
  await lock();
  try {
    for (const t of ['w_plain', 'w_ct', 'w_d', 'w_ctag', 'w_esc']) await q(`drop table if exists ${S}.${t}`);
    await q(`create table ${S}.w_plain (like ${S}.customers_plain including all)`); await q(`create table ${S}.w_ct (like ${S}.customers_ct including all)`); await q(`create table ${S}.w_d (like ${S}.customers_d including all)`);
    await q(`create table ${S}.w_ctag (like ${S}.customers_ctag including all)`); await q(`create table ${S}.w_esc (tok bytea primary key, n int not null)`);
    const src = await q(`select id::text, scope_id::text, ${FIELDS.map(f => f + '_norm as ' + f).join(',')} from ${SRC}.customers order by id limit 12000`);
    const retries = { deadlock: 0 };
    async function insPlain(c: pg.PoolClient, r: any) { await c.query(`insert into ${S}.w_plain values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), r.scope_id, ...FIELDS.map(f => r[f]), Array.from(r.memo).length]); }
    async function insD(c: pg.PoolClient, r: any) { const nonce = randomBytes(16); const cand = new Set<number>(); const chks: string[] = []; for (const f of FIELDS) for (const l of labels('customers', f, r[f])) { const tok = tokenOf(l); cand.add(trunc16(tok)); chks.push(chkOf(tok, nonce)); }
      await c.query('begin'); const id = randomUUID(); await c.query(`insert into ${S}.w_ct values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, r.scope_id, ...FIELDS.map(f => encrypt(r[f])), Array.from(r.memo).length]); await c.query(`insert into ${S}.w_d values ($1,$2,$3,$4::bytea[],$5)`, [id, nonce, [...cand], chks, Array.from(r.memo).length]); await c.query('commit'); return id; }
    async function insC(c: pg.PoolClient, r: any) { const ls: string[] = []; for (const f of FIELDS) ls.push(...labels('customers', f, r[f])); const toks = ls.map(tokenOf);
      for (let attempt = 0; ; attempt++) { try { await c.query('begin'); const id = randomUUID(); await c.query(`insert into ${S}.w_ct values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, r.scope_id, ...FIELDS.map(f => encrypt(r[f])), Array.from(r.memo).length]);
        const ns = await c.query(`insert into ${S}.w_esc (tok, n) select t, 1 from unnest($1::bytea[]) u(t) order by t on conflict (tok) do update set n = ${S}.w_esc.n + 1 returning tok, n`, [toks.map(escId)]); const byTok = new Map(ns.rows.map(x => [Buffer.from(x.tok).toString('hex'), x.n as number]));
        const tags = toks.map(tok => ctagOf(tok, byTok.get(escId(tok).toString('hex'))!)); await c.query(`insert into ${S}.w_ctag select unnest($1::bytea[]), $2::uuid`, [tags, id]); await c.query('commit'); return id; }
        catch (e) { await c.query('rollback').catch(() => {}); if ((e as any).code === '40P01' && attempt < 50) { retries.deadlock++; continue; } throw e; } } }
    const out: any = {}; const idsD: string[] = [], idsC: string[] = [];
    for (const [name, fn] of [['plain', insPlain], ['D', insD], ['C', insC]] as const) { const c = await pool.connect(); const lat: number[] = []; try { for (let i = 0; i < 300; i++) { const t = performance.now(); const id = await (fn as any)(c, src[i]); lat.push(performance.now() - t); if (name === 'D') idsD.push(id); if (name === 'C') idsC.push(id); } } finally { c.release(); } out['insert ' + name + ' ms/row median'] = +median(lat.slice(50)).toFixed(2); save('write', out); }
    // partial update of one field (memo) : D = recompute memo pieces of that row; C = new occurrences for the new memo pieces, old tags of that field removed
    const upd: number[] = []; { const c = await pool.connect(); try { for (let i = 0; i < 100; i++) { const id = idsD[i]; const r = src[i]; const newMemo = r.memo + '추가'; const t = performance.now(); await c.query('begin');
      const row = (await c.query(`select nonce, chk8 from ${S}.w_d where id = $1`, [id])).rows[0]; const nonce: Buffer = row.nonce; const oldMemo = new Set(labels('customers', 'memo', r.memo).map(l => chkOf(tokenOf(l), nonce))); const kept = (row.chk8 as Buffer[]).map(b => '\\x' + Buffer.from(b).toString('hex')).filter(x => !oldMemo.has(x)); const add = labels('customers', 'memo', newMemo).map(l => chkOf(tokenOf(l), nonce));
      const cand = new Set<number>(); for (const f of FIELDS) for (const l of labels('customers', f, f === 'memo' ? newMemo : r[f])) cand.add(trunc16(tokenOf(l)));
      await c.query(`update ${S}.w_ct set memo_ct = $2 where id = $1`, [id, encrypt(newMemo)]); await c.query(`update ${S}.w_d set chk8 = $2::bytea[], cand = $3 where id = $1`, [id, [...kept, ...add], [...cand]]); await c.query('commit'); upd.push(performance.now() - t); } } finally { c.release(); } }
    out['update D 1 field ms median'] = +median(upd).toFixed(2);
    const del: number[] = []; { for (let i = 100; i < 200; i++) { const t = performance.now(); await q(`delete from ${S}.w_d where id = $1`, [idsD[i]]); await q(`delete from ${S}.w_ct where id = $1`, [idsD[i]]); del.push(performance.now() - t); } }
    out['delete D ms median'] = +median(del).toFixed(2);
    const delC: number[] = []; { for (let i = 0; i < 100; i++) { const t = performance.now(); await q(`delete from ${S}.w_ctag where id = $1`, [idsC[i]]); await q(`delete from ${S}.w_ct where id = $1`, [idsC[i]]); delC.push(performance.now() - t); } }
    out['delete C ms median (tags removed with the row; counters untouched)'] = +median(delC).toFixed(2);
    for (const [name, fn] of [['plain', insPlain], ['D', insD], ['C', insC]] as const) { const before = retries.deadlock; const t = performance.now(); await Promise.all(Array.from({ length: 8 }, async (_, w) => { const c = await pool.connect(); try { for (let i = 0; i < 1000; i++) await (fn as any)(c, src[2000 + w * 1000 + i]); } finally { c.release(); } })); out['8 writers ' + name + ' rows/s'] = +(8000 / ((performance.now() - t) / 1000)).toFixed(0); if (name === 'C') out['8 writers C deadlock retries'] = retries.deadlock - before; save('write', out); }
    // count correctness after all writes: company = 서울서비스담당 among the written rows, D vs C vs expected from src
    const X = '서울서비스담당'; const expected = src.slice(0, 300).filter(r => r.company === X).length * 2 + src.slice(2000, 10000).filter(r => r.company === X).length * 2 - idsD.slice(100, 200).filter((_, i) => src[100 + i].company === X).length - idsC.slice(0, 100).filter((_, i) => src[i].company === X).length;
    const tok = tokenOf('customers\0company\0e\0' + X);
    const dCnt = Number((await q(`select count(*) n from ${S}.w_d where cand @> array[$1::int] and substr(digest($2::bytea || nonce, 'sha256'), 1, 8) = any(chk8)`, [trunc16(tok), tok]))[0].n);
    const cCnt = Number((await q(`select count(*) n from (select id from ${S}.w_ctag where tag8 = any(array(select substr(digest($1::bytea || int4send(g), 'sha256'), 1, 8) from generate_series(1, coalesce((select n from ${S}.w_esc where tok = digest($1::bytea || 'esc'::bytea, 'sha256')), 0)) g))) x`, [tok]))[0].n);
    out.countAfterWrites = { expectedDplusC: expected, D: dCnt, C: cCnt, note: 'expected counts D and C rows together; D and C each hold half' };
    console.log(JSON.stringify(out, null, 1)); save('write', out);
  } finally { unlock(); }
}
await pool.end();

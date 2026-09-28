/**
 * m2-fable: PostgreSQL emulation of MongoDB Queryable Encryption's search layouts, on the 100k fixture (one scope).
 * Layouts derived from bench_realistic_100k.customers (read-only source) into schema research_m2_fable_qe:
 *   plain  : id, company, memo (normalized plaintext) + B-tree(company)                         -- plaintext control
 *   det    : id, tags bigint[]  full-width (64-bit) DETERMINISTIC tokens: exact(company) + every substring 2..K of memo; GIN
 *   occ    : id, tags bigint[]  PER-OCCURRENCE tags HMAC64(tokenOf(label), ordinal) (MongoDB ESC/EDC "tag" path); GIN
 *   occ_tag: (tag bigint, id uuid) side table + B-tree(tag)                                     -- MongoDB __safeContent__ index analogue
 *   esc    : (tok bytea PK, n int) per-label occurrence counter (MongoDB ESC analogue, plaintext count, cf=0)
 *   chk    : id, nonce bytea, cand int[] (16-bit deterministic candidate tokens, like the product), chks bigint[] = HMAC64(tokenOf(label), nonce)
 *            -- MongoDB's second mechanism: server-side per-document verification with a value-derived token (collscan mode)
 * Phases: load | measure | explain | write | attack | drop.   Run: rtk proxy npx tsx bench/research-mission/m2-fable-qe-pg.ts <phase>
 * Lock: .local/research/measure.lock is created for load/measure/write and removed afterwards.
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';
import { assertDisposable } from '../../test/disposable.js';

const { Pool } = pg;
const phase = process.argv[2]; assert(['load', 'load2', 'measure', 'measure2', 'explain', 'write', 'attack', 'drop', 'hmacbench', 'verify'].includes(phase ?? ''), 'phase');
const lite = phase === 'load2'; // load2: only plain, chk, occ_tag, esc (no det / occ GIN tables)
const S = 'research_m2_fable_qe', SRC = 'bench_realistic_100k', K = 10, OUT = 'bench/results/2026-09-28-mission';
const LOCK = '.local/research/measure.lock';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 10, options: '-c statement_timeout=900000' });
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
// SQL accounting for the split (pre / DB round trips / between / post): every pool.query and qGin client query is timed.
const sqlStat = { ms: 0, n: 0 };
const rawPoolQuery = pool.query.bind(pool);
(pool as any).query = async (...args: any[]) => { const t = performance.now(); try { return await (rawPoolQuery as any)(...args); } finally { sqlStat.ms += performance.now() - t; sqlStat.n++; } };
const q = async (t: string, v: unknown[] = []) => (await pool.query(t, v)).rows;
async function lock() { for (;;) { if (!existsSync(LOCK)) { try { writeFileSync(LOCK, 'm2-fable ' + phase + ' ' + new Date().toISOString() + '\n', { flag: 'wx' }); return; } catch { /* raced */ } } console.error('measure.lock held; waiting 60s'); await new Promise(r => setTimeout(r, 60000)); } }
function unlock() { if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('m2-fable ')) unlinkSync(LOCK); }
mkdirSync(OUT, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(OUT + '/m2-fable-qe-' + name + '.json', JSON.stringify(data, null, 1));

// ---- crypto (research keys; not product keys) ----
const KEY = Buffer.alloc(32, 7);
const tokenOf = (label: string) => createHmac('sha256', KEY).update(label).digest();            // value-derived token (32 B): what the app hands the DB at query time
const trunc64 = (b: Buffer) => b.readBigInt64BE(0);                                             // 64-bit token/tag stored as bigint
const trunc16 = (b: Buffer) => b.readUInt16BE(0);                                               // 16-bit candidate token (product width)
const detTag = (label: string) => trunc64(tokenOf(label));                                      // deterministic layout
const occTag = (tok: Buffer, n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return trunc64(createHmac('sha256', tok).update(b).digest()); }; // per-occurrence tag
const chkTag = (tok: Buffer, nonce: Buffer) => trunc64(createHmac('sha256', tok).update(nonce).digest()); // per-row blinded check value
const escId = (tok: Buffer) => createHmac('sha256', tok).update('esc').digest();                // counter row id (unlinkable without tok)
const subs = (s: string) => { const c = Array.from(s), set = new Set<string>(); for (let l = 2; l <= K; l++) for (let i = 0; i + l <= c.length; i++) set.add(c.slice(i, i + l).join('')); return [...set]; };
const labels = (company: string, memo: string) => ['e\0' + company, ...subs(memo).map(x => 's\0' + x)];
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---- reference queries (normalized text; substring on code points) ----
const CO = '서울서비스담당';   // company_norm of "서울서비스 담당" (legacy-text-v1 strips whitespace)
type Cond = { e: string } | { s: string };
type Case = { name: string; op: 'and' | 'or'; cs: Cond[] };
const cases: Case[] = [
  { name: 'Q1 company=서울서비스담당', op: 'and', cs: [{ e: CO }] },
  { name: 'Q2 memo~서비스', op: 'and', cs: [{ s: '서비스' }] },
  { name: 'Q3 Q1 AND memo~서비스', op: 'and', cs: [{ e: CO }, { s: '서비스' }] },
  { name: 'Q4 Q1 OR memo~푸른달', op: 'or', cs: [{ e: CO }, { s: '푸른달' }] },
  { name: 'Q5 company=한빛테크중앙지사 AND memo~서비스', op: 'and', cs: [{ e: '한빛테크중앙지사' }, { s: '서비스' }] },
  { name: 'Q6 Q1 OR memo~서비스 (47k)', op: 'or', cs: [{ e: CO }, { s: '서비스' }] },
];
const RAW: Record<string, string> = { [CO]: '서울서비스 담당', '한빛테크중앙지사': '한빛테크 중앙지사' }; // un-normalized values for the product API
const lab = (c: Cond) => 'e' in c ? 'e\0' + c.e : 's\0' + c.s;
const plainSql = (c: Cond, i: number, col = (f: string) => f) => 'e' in c ? col('company') + ' = $' + i : col('memo') + " like '%' || $" + i + " || '%'";
const plainVal = (c: Cond) => 'e' in c ? c.e : c.s;

if (phase === 'load' || phase === 'load2') {
  await lock();
  try {
    const t0 = performance.now();
    await q('drop schema if exists ' + S + ' cascade'); await q('create schema ' + S);
    await q('create extension if not exists pgcrypto');
    await q('create table ' + S + '.plain (id uuid primary key, company text not null, memo text not null)');
    if (!lite) await q('create table ' + S + '.det (id uuid primary key, tags bigint[] not null)');
    if (!lite) await q('create table ' + S + '.occ (id uuid primary key, tags bigint[] not null)');
    await q('create table ' + S + '.occ_tag (tag bigint not null, id uuid not null)');
    await q('create table ' + S + '.esc (tok bytea primary key, n int not null)');
    await q('create table ' + S + '.chk (id uuid primary key, nonce bytea not null, cand int[] not null, chks bigint[] not null)');
    const rows = await q('select id::text, company_norm as company, memo_norm as memo from ' + SRC + '.customers order by id');
    assert.equal(rows.length, 100000);
    const counters = new Map<string, number>(); // label -> n (in-memory ESC while bulk loading; persisted at the end)
    let tagsDet = 0, tagsOcc = 0, cand16 = 0;
    const B = 2000;
    for (let i = 0; i < rows.length; i += B) {
      const chunk = rows.slice(i, i + B);
      const pv: unknown[] = [], dv: unknown[] = [], ov: unknown[] = [], tv: unknown[] = [], cv: unknown[] = [];
      const ps: string[] = [], ds: string[] = [], os: string[] = [], ts: string[] = [], cs: string[] = [];
      for (const r of chunk) {
        const ls = labels(r.company, r.memo); const toks = ls.map(tokenOf);
        const det = toks.map(trunc64); const occ: bigint[] = [];
        for (let j = 0; j < ls.length; j++) { const n = (counters.get(ls[j]) ?? 0) + 1; counters.set(ls[j], n); occ.push(occTag(toks[j], n)); }
        const nonce = randomBytes(16); const cand = [...new Set(toks.map(trunc16))]; const chks = toks.map(t => chkTag(t, nonce));
        tagsDet += det.length; tagsOcc += occ.length; cand16 += cand.length;
        ps.push('($' + (pv.length + 1) + ',$' + (pv.length + 2) + ',$' + (pv.length + 3) + ')'); pv.push(r.id, r.company, r.memo);
        ds.push('($' + (dv.length + 1) + ',$' + (dv.length + 2) + ')'); dv.push(r.id, det.map(String));
        os.push('($' + (ov.length + 1) + ',$' + (ov.length + 2) + ')'); ov.push(r.id, occ.map(String));
        ts.push('($' + (tv.length + 1) + '::bigint[],$' + (tv.length + 2) + '::uuid)'); tv.push(occ.map(String), r.id);
        cs.push('($' + (cv.length + 1) + ',$' + (cv.length + 2) + ',$' + (cv.length + 3) + ',$' + (cv.length + 4) + ')'); cv.push(r.id, nonce, cand, chks.map(String));
      }
      await q('insert into ' + S + '.plain values ' + ps.join(','), pv);
      if (!lite) await q('insert into ' + S + '.det values ' + ds.join(','), dv);
      if (!lite) await q('insert into ' + S + '.occ values ' + os.join(','), ov);
      await q('insert into ' + S + '.occ_tag select unnest(t), i from (values ' + ts.join(',') + ') v(t,i)', tv);
      await q('insert into ' + S + '.chk values ' + cs.join(','), cv);
      if (i % 20000 === 0) console.log('loaded', i + chunk.length, ((performance.now() - t0) / 1000).toFixed(0) + 's');
    }
    const ev: unknown[] = []; const es: string[] = []; let flushed = 0;
    for (const [l, n] of counters) { es.push('($' + (ev.length + 1) + ',$' + (ev.length + 2) + ')'); ev.push(escId(tokenOf(l)), n); if (es.length === 5000) { await q('insert into ' + S + '.esc values ' + es.join(','), ev); flushed += es.length; es.length = 0; ev.length = 0; } }
    if (es.length) { await q('insert into ' + S + '.esc values ' + es.join(','), ev); flushed += es.length; }
    const tIdx = performance.now();
    await q('create index plain_company on ' + S + '.plain (company)');
    if (!lite) await q('create index det_gin on ' + S + '.det using gin (tags)');
    if (!lite) await q('create index occ_gin on ' + S + '.occ using gin (tags)');
    await q('create index occ_tag_btree on ' + S + '.occ_tag (tag)');
    await q('create index chk_gin on ' + S + '.chk using gin (cand)');
    for (const t of lite ? ['plain', 'occ_tag', 'esc', 'chk'] : ['plain', 'det', 'occ', 'occ_tag', 'esc', 'chk']) await q('vacuum analyze ' + S + '.' + t);
    const sizes = await q("select c.relname, pg_size_pretty(pg_relation_size(c.oid)) as size, pg_relation_size(c.oid) as bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind in ('r','i') order by 1", [S]);
    const hist = [...counters.values()].sort((a, b) => b - a);
    const out = { rows: rows.length, K, tagsPerRowDet: +(tagsDet / rows.length).toFixed(1), tagsPerRowOcc: +(tagsOcc / rows.length).toFixed(1), cand16PerRow: +(cand16 / rows.length).toFixed(1), distinctLabels: counters.size, escRows: flushed, counterTop: hist.slice(0, 10), loadSec: +((tIdx - t0) / 1000).toFixed(1), indexSec: +((performance.now() - tIdx) / 1000).toFixed(1), sizes };
    console.log(JSON.stringify(out, null, 1)); save('load', out);
  } finally { unlock(); }
}

async function timed<T>(fn: () => Promise<T>) { const s0 = { ...sqlStat }; const t = performance.now(); const r = await fn(); return { ms: performance.now() - t, dbMs: sqlStat.ms - s0.ms, sqlN: sqlStat.n - s0.n, r }; }
type St = { sql: number; tags: number; genMs: number; cand?: number };
const st0 = (): St => ({ sql: 0, tags: 0, genMs: 0 });
// ---- query paths ----
async function plainCount(k: Case) {
  return Number((await q('select count(*) n from ' + S + '.plain where ' + k.cs.map((c, i) => plainSql(c, i + 1)).join(' ' + k.op + ' '), k.cs.map(plainVal)))[0].n);
}
async function plainSrcCount(k: Case) { // original wide fixture table without indexes (as in earlier reports)
  return Number((await q('select count(*) n from ' + SRC + '.customers where ' + k.cs.map((c, i) => plainSql(c, i + 1, f => f + '_norm')).join(' ' + k.op + ' '), k.cs.map(plainVal)))[0].n);
}
async function detCount(k: Case) { // 1 SQL, 1 token per condition
  const toks = k.cs.map(c => String(detTag(lab(c))));
  if (k.op === 'and') return Number((await q('select count(*) n from ' + S + '.det where tags @> $1', [toks]))[0].n);
  return Number((await q('select count(*) n from ' + S + '.det where tags && $1', [toks]))[0].n);
}
async function occTagsApp(cs: Cond[], st: St) { // SQL#1: read counters; the app generates the tags
  const toks = cs.map(c => tokenOf(lab(c)));
  const ns = await q('select e.tok, e.n from unnest($1::bytea[]) u(tok) join ' + S + '.esc e on e.tok = u.tok', [toks.map(escId)]); st.sql++;
  const byTok = new Map(ns.map(r => [Buffer.from(r.tok).toString('hex'), r.n as number]));
  const t = performance.now();
  const sets = toks.map(tok => { const n = byTok.get(escId(tok).toString('hex')) ?? 0; const a = new Array<string>(n); for (let i = 1; i <= n; i++) a[i - 1] = String(occTag(tok, i)); return a; });
  st.genMs += performance.now() - t; st.tags += sets.reduce((s, x) => s + x.length, 0);
  return sets;
}
// GIN paths: the planner picks a sequential scan for large query arrays, and array overlap is then evaluated per row
// (O(row elements x query elements)), which ran for minutes. Force the index path so the GIN cost itself is measured.
async function qGin(text: string, values: unknown[]) {
  const c = await pool.connect();
  try { await c.query('set enable_seqscan = off'); await c.query('set statement_timeout = 120000'); const t = performance.now(); try { return (await c.query(text, values)).rows; } finally { sqlStat.ms += performance.now() - t; sqlStat.n++; } }
  finally { try { await c.query('reset enable_seqscan'); await c.query('reset statement_timeout'); } catch { /* cancelled */ } c.release(); }
}
async function occCountGinApp(k: Case, st: St) {
  const sets = await occTagsApp(k.cs, st);
  const r = await qGin('select count(*) n from ' + S + '.occ where ' + sets.map((_, i) => 'tags && $' + (i + 1) + '::bigint[]').join(' ' + k.op + ' '), sets); st.sql++; return Number(r[0].n);
}
async function occCountBtreeApp(k: Case, st: St) {
  const sets = await occTagsApp(k.cs, st);
  const parts = sets.map((_, i) => 'select id from ' + S + '.occ_tag where tag = any($' + (i + 1) + '::bigint[])');
  const r = await q('select count(*) n from (' + parts.join(k.op === 'and' ? ' intersect ' : ' union ') + ') x', sets); st.sql++; return Number(r[0].n);
}
// 1 SQL: the DB reads the counter and derives the tags itself with pgcrypto (the app only sends the value token, as MongoDB's driver does)
const genSql = (i: number) => "array(select ('x' || encode(substr(hmac(int4send(g), $" + i + "::bytea, 'sha256'), 1, 8), 'hex'))::bit(64)::bigint from generate_series(1, (select n from " + S + ".esc where tok = hmac('esc'::bytea, $" + i + "::bytea, 'sha256'))) g)";
async function occCountGinDb(k: Case, st: St) {
  const toks = k.cs.map(c => tokenOf(lab(c)));
  const r = await qGin('select count(*) n from ' + S + '.occ where ' + toks.map((_, i) => 'tags && ' + genSql(i + 1)).join(' ' + k.op + ' '), toks); st.sql++; return Number(r[0].n);
}
async function occCountBtreeDb(k: Case, st: St) {
  const toks = k.cs.map(c => tokenOf(lab(c)));
  const parts = toks.map((_, i) => 'select id from ' + S + '.occ_tag where tag = any(' + genSql(i + 1) + ')');
  const r = await q('select count(*) n from (' + parts.join(k.op === 'and' ? ' intersect ' : ' union ') + ') x', toks); st.sql++; return Number(r[0].n);
}
// chk: 16-bit candidate tokens (GIN) pre-filter, then per-row HMAC verification inside PostgreSQL with the value token.
const chkExpr = (i: number) => "(('x' || encode(substr(hmac(nonce, $" + i + "::bytea, 'sha256'), 1, 8), 'hex'))::bit(64)::bigint = any(chks))";
async function chkCount(k: Case, st: St) {
  const toks = k.cs.map(c => tokenOf(lab(c)));
  const cand = toks.map(t => trunc16(t));
  const pre = k.op === 'and' ? 'cand @> $' + (toks.length + 1) + '::int[]' : 'cand && $' + (toks.length + 1) + '::int[]';
  const r = await q('select count(*) n from ' + S + '.chk where ' + pre + ' and (' + toks.map((_, i) => chkExpr(i + 1)).join(' ' + k.op + ' ') + ')', [...toks, cand]); st.sql++;
  return Number(r[0].n);
}
async function chkCandidates(k: Case) { // how many rows the 16-bit pre-filter admits (HMACs the DB must compute)
  const cand = k.cs.map(c => trunc16(tokenOf(lab(c))));
  return Number((await q('select count(*) n from ' + S + '.chk where ' + (k.op === 'and' ? 'cand @> $1::int[]' : 'cand && $1::int[]'), [cand]))[0].n);
}

if (phase === 'verify') { // one pass, no lock: every path must equal the plaintext count
  for (const k of cases) { const truth = await plainCount(k); const st = st0();
    const got = { det: await detCount(k), occGinApp: await occCountGinApp(k, st), occBtreeApp: await occCountBtreeApp(k, st), occGinDb: await occCountGinDb(k, st), occBtreeDb: await occCountBtreeDb(k, st), chk: await chkCount(k, st), chkCandidates: await chkCandidates(k) };
    console.log(k.name, 'truth', truth, JSON.stringify(got)); for (const [n, v] of Object.entries(got)) if (n !== 'chkCandidates') assert.equal(v, truth, k.name + ' ' + n); }
  console.log('verify ok');
}

// Current product via the public Drizzle API on native_verify_main (same 100k rows, product format with 6 searchable fields).
const sealed = createSealed({ sealer: () => createSealer({ key: new Uint8Array(32).fill(93) }) });
const productSearch = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
const productTable = pgSchema('native_verify_main').table('customers', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search: productSearch }), phone: sealed.text('phone', { search: productSearch }), address: sealed.text('address', { search: productSearch }),
  memo: sealed.text('memo', { search: productSearch }), email: sealed.text('email', { search: productSearch }), company: sealed.text('company', { search: productSearch }) });
const productReg = sealed.register(productTable, { row: 'id', scope: 'scopeId' });
const productDb = drizzle(pool);
const PRODUCT_SCOPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function productCount(k: Case) {
  const leaf = (c: Cond, m: any) => 'e' in c ? m.company.eq(RAW[c.e] ?? c.e) : m.memo.contains(c.s);
  return sealed.count(productDb, productReg, { scope: PRODUCT_SCOPE, match: (m: any) => k.op === 'and' ? m.and(...k.cs.map(c => leaf(c, m))) : m.or(...k.cs.map(c => leaf(c, m))) } as any) as Promise<number>;
}

if (phase === 'measure') {
  await lock();
  try {
    const results: any[] = [];
    for (const k of cases) {
      const truth = await plainCount(k); assert.equal(await plainSrcCount(k), truth, 'norm vs src');
      const candidates = await chkCandidates(k);
      const paths: Record<string, () => Promise<{ n: number; st?: St }>> = {
        'plain(idx)': async () => ({ n: await plainCount(k) }),
        'plain(src,wide,noidx)': async () => ({ n: await plainSrcCount(k) }),
        'product(current, API)': async () => ({ n: await productCount(k) }),
        'det GIN 1sql': async () => ({ n: await detCount(k) }),
        'occ GIN app-tags 2sql': async () => { const st = st0(); return { n: await occCountGinApp(k, st), st }; },
        'occ Btree app-tags 2sql': async () => { const st = st0(); return { n: await occCountBtreeApp(k, st), st }; },
        'occ GIN db-tags 1sql': async () => { const st = st0(); return { n: await occCountGinDb(k, st), st }; },
        'occ Btree db-tags 1sql': async () => { const st = st0(); return { n: await occCountBtreeDb(k, st), st }; },
        'chk cand16+dbHMAC 1sql': async () => { const st = st0(); return { n: await chkCount(k, st), st }; },
      };
      const names = Object.keys(paths).filter(n => !process.env.M2_PATHS || process.env.M2_PATHS.split(',').includes(n)); const runs: Record<string, number[]> = Object.fromEntries(names.map(n => [n, []])); const dbRuns: Record<string, number[]> = Object.fromEntries(names.map(n => [n, []])); const sqlN: Record<string, number> = {}; const first: Record<string, number> = {}; const stats: Record<string, St | undefined> = {}; const failed: Record<string, string> = {};
      for (let i = 0; i < 10; i++) { // first + 2 warm-up + 7 rotated
        const order = i === 0 ? names : [...names.slice(i % names.length), ...names.slice(0, i % names.length)];
        for (const n of order) {
          if (failed[n]) continue;
          let res: { ms: number; dbMs: number; sqlN: number; r: { n: number; st?: St } };
          try { res = await timed(paths[n]); } catch (e) { failed[n] = String((e as Error).message).slice(0, 120); console.log('FAILED', k.name, n, failed[n]); continue; }
          if (res.r.n !== truth) { failed[n] = 'wrong count ' + res.r.n + ' != ' + truth; console.log('FAILED', k.name, n, failed[n]); continue; }
          if (i === 0) first[n] = res.ms; else if (i >= 3) { runs[n].push(res.ms); dbRuns[n].push(res.dbMs); } sqlN[n] = res.sqlN; stats[n] = res.r.st;
        }
      }
      const ok = names.filter(n => !failed[n]);
      const row = { case: k.name, truth, chkCandidates: candidates, medians: Object.fromEntries(ok.map(n => [n, +median(runs[n]).toFixed(1)])), dbMedians: Object.fromEntries(ok.map(n => [n, +median(dbRuns[n]).toFixed(1)])), sqlCalls: Object.fromEntries(ok.map(n => [n, sqlN[n]])), first: Object.fromEntries(ok.map(n => [n, +first[n].toFixed(1)])), failed, tags: Object.fromEntries(ok.filter(n => stats[n]).map(n => [n, { tags: stats[n]!.tags, sql: stats[n]!.sql, appGenMs: +stats[n]!.genMs.toFixed(1) }])) };
      console.log(JSON.stringify(row)); results.push(row);
    }
    save('measure' + (process.env.M2_SUFFIX ?? ''), results);
  } finally { unlock(); }
}

if (phase === 'hmacbench') { // cost of one pgcrypto HMAC-SHA-256 + bigint cast inside SQL
  // aggregate over the expression so the planner cannot drop it as dead
  const r = await q("explain (analyze, format json) select sum(v) from (select ('x' || encode(substr(hmac(int4send(g), 'k', 'sha256'), 1, 8), 'hex'))::bit(64)::bigint v from generate_series(1, 200000) g) x");
  const t = r[0]['QUERY PLAN'][0]['Execution Time']; console.log('pgcrypto hmac+cast per call (us):', (t * 1000 / 200000).toFixed(2), 'total ms', t);
  const r2 = await q("explain (analyze, format json) select sum(length(v)) from (select hmac(int4send(g), 'k', 'sha256') v from generate_series(1, 200000) g) x");
  const t2 = r2[0]['QUERY PLAN'][0]['Execution Time']; console.log('pgcrypto hmac only per call (us):', (t2 * 1000 / 200000).toFixed(2));
  const r0 = await q("explain (analyze, format json) select sum(g) from generate_series(1, 200000) g");
  console.log('generate_series baseline per row (us):', (r0[0]['QUERY PLAN'][0]['Execution Time'] * 1000 / 200000).toFixed(2));
  const t3 = performance.now(); const tok = tokenOf('x'); for (let i = 1; i <= 200000; i++) occTag(tok, i); console.log('node createHmac per tag (us):', ((performance.now() - t3) * 1000 / 200000).toFixed(2));
  save('hmacbench', { pgHmacCastUs: +(t * 1000 / 200000).toFixed(2), pgHmacUs: +(t2 * 1000 / 200000).toFixed(2), nodeHmacUs: +((performance.now() - t3) * 1000 / 200000).toFixed(2) });
}

if (phase === 'explain') {
  for (const k of [cases[2], cases[1]]) {
    const st = st0(); const sets = await occTagsApp(k.cs, st);
    let e1: any[]; try { e1 = await qGin('explain (analyze, buffers, format json) select count(*) n from ' + S + '.occ where ' + sets.map((_, i) => 'tags && $' + (i + 1) + '::bigint[]').join(' ' + k.op + ' '), sets); } catch (e) { e1 = [{ 'QUERY PLAN': [{ 'Execution Time': null, error: String((e as Error).message).slice(0, 120) }] }]; }
    const e2 = await q('explain (analyze, buffers, format json) select count(*) n from (' + sets.map((_, i) => 'select id from ' + S + '.occ_tag where tag = any($' + (i + 1) + '::bigint[])').join(k.op === 'and' ? ' intersect ' : ' union ') + ') x', sets);
    const e3 = await q('explain (analyze, buffers, format json) select count(*) n from ' + S + '.det where tags @> $1', [k.cs.map(c => String(detTag(lab(c))))]);
    const toks = k.cs.map(c => tokenOf(lab(c))); const cand = toks.map(trunc16);
    const e4 = await q('explain (analyze, buffers, format json) select count(*) n from ' + S + '.chk where cand @> $' + (toks.length + 1) + '::int[] and (' + toks.map((_, i) => chkExpr(i + 1)).join(' and ') + ')', [...toks, cand]);
    save('explain-' + k.name.slice(0, 2), { case: k.name, occGin: e1[0]['QUERY PLAN'], occBtree: e2[0]['QUERY PLAN'], det: e3[0]['QUERY PLAN'], chk: e4[0]['QUERY PLAN'] });
    console.log(k.name, 'occGin', e1[0]['QUERY PLAN'][0]['Execution Time'], 'occBtree', e2[0]['QUERY PLAN'][0]['Execution Time'], 'det', e3[0]['QUERY PLAN'][0]['Execution Time'], 'chk', e4[0]['QUERY PLAN'][0]['Execution Time']);
  }
}

if (phase === 'write') {
  // Managed single-row insert cost. det: tokens + 1 INSERT. chk: tokens + 1 INSERT. occ: transaction { upsert counters RETURNING n; INSERT row+tags }.
  // Rows are fixture rows re-inserted with fresh ids into scratch tables (same values; dropped in 'drop').
  await lock();
  try {
    for (const t of ['w_det', 'w_chk', 'w_occ', 'w_esc']) await q('drop table if exists ' + S + '.' + t);
    await q('create table ' + S + '.w_det (like ' + S + '.det including all)');
    await q('create table ' + S + '.w_chk (like ' + S + '.chk including all)');
    await q('create table ' + S + '.w_occ (like ' + S + '.occ including all)');
    await q('create table ' + S + '.w_esc (tok bytea not null, part smallint not null, n int not null, primary key (tok, part))');
    const src = await q('select company_norm as company, memo_norm as memo from ' + SRC + '.customers order by id limit 16000');
    async function insDet(client: pg.PoolClient, r: any) { const ls = labels(r.company, r.memo); await client.query('insert into ' + S + '.w_det values ($1,$2)', [randomUUID(), ls.map(l => String(detTag(l)))]); }
    async function insChk(client: pg.PoolClient, r: any) { const toks = labels(r.company, r.memo).map(tokenOf); const nonce = randomBytes(16); await client.query('insert into ' + S + '.w_chk values ($1,$2,$3,$4)', [randomUUID(), nonce, [...new Set(toks.map(trunc16))], toks.map(t => String(chkTag(t, nonce)))]); }
    // Counter upsert locks the ~84 counter rows of a row's labels. Without a deterministic lock order, 8 concurrent writers
    // deadlocked within seconds (PostgreSQL 40P01, first run). Fix as a real implementation would: ORDER BY the counter key so
    // every transaction takes locks in the same order, and retry on deadlock/serialization failure (MongoDB's insert path is
    // likewise wrapped in SyncTransactionWithRetries). Retries are counted and reported.
    const retries = { deadlock: 0, other: 0 };
    async function insOcc(client: pg.PoolClient, r: any, cf: number) {
      const ls = labels(r.company, r.memo); const toks = ls.map(tokenOf); const parts = toks.map(() => cf === 0 ? 0 : randomInt(cf));
      for (let attempt = 0; ; attempt++) {
        try {
          await client.query('begin');
          const ns = await client.query('insert into ' + S + '.w_esc (tok, part, n) select t, p, 1 from unnest($1::bytea[], $2::smallint[]) u(t,p) order by t, p on conflict (tok, part) do update set n = ' + S + '.w_esc.n + 1 returning tok, part, n', [toks.map(escId), parts]);
          const byKey = new Map(ns.rows.map(x => [Buffer.from(x.tok).toString('hex') + ':' + x.part, x.n as number]));
          const tags = toks.map((tok, i) => { const n = byKey.get(escId(tok).toString('hex') + ':' + parts[i])!; const b = Buffer.alloc(6); b.writeUInt16BE(parts[i]); b.writeUInt32BE(n, 2); return String(trunc64(createHmac('sha256', tok).update(b).digest())); });
          await client.query('insert into ' + S + '.w_occ values ($1,$2)', [randomUUID(), tags]);
          await client.query('commit'); return;
        } catch (e) {
          await client.query('rollback').catch(() => {});
          const code = (e as { code?: string }).code;
          if ((code === '40P01' || code === '40001') && attempt < 50) { if (code === '40P01') retries.deadlock++; else retries.other++; continue; }
          throw e;
        }
      }
    }
    const variants = [['det', (c: pg.PoolClient, r: any) => insDet(c, r)], ['chk', (c: pg.PoolClient, r: any) => insChk(c, r)], ['occ cf0', (c: pg.PoolClient, r: any) => insOcc(c, r, 0)], ['occ cf8', (c: pg.PoolClient, r: any) => insOcc(c, r, 8)]] as const;
    const out: any = {};
    for (const [name, fn] of variants) { // single connection latency
      const c = await pool.connect(); const lat: number[] = [];
      try { for (let i = 0; i < 300; i++) { const t = performance.now(); await fn(c, src[i]); lat.push(performance.now() - t); } } finally { c.release(); }
      out['single ' + name + ' ms/row median'] = +median(lat.slice(50)).toFixed(2); save('write', out);
    }
    for (const [name, fn] of variants) { // 8 concurrent writers, 1000 rows each
      const before = { ...retries }; const t = performance.now();
      await Promise.all(Array.from({ length: 8 }, async (_, w) => { const c = await pool.connect(); try { for (let i = 0; i < 1000; i++) await fn(c, src[1000 + w * 1000 + i]); } finally { c.release(); } }));
      out['8 writers ' + name + ' rows/s'] = +(8000 / ((performance.now() - t) / 1000)).toFixed(0);
      out['8 writers ' + name + ' retries'] = { deadlock: retries.deadlock - before.deadlock, other: retries.other - before.other }; save('write', out);
    }
    // (6) Usability invariants for the counter/tag path: after concurrent inserts the DB count via tags must equal the number of
    // rows inserted with that value; then delete 1,000 matching rows; then partially update 500 rows' company X -> Y.
    const X = CO, Y = '한빛테크중앙지사';
    const cnt = (a: number, b: number, v: string) => src.slice(a, b).filter(r => r.company === v).length;
    let expX = 2 * cnt(0, 300, X) + 2 * cnt(1000, 9000, X), expY = 2 * cnt(0, 300, Y) + 2 * cnt(1000, 9000, Y); // single cf0+cf8 (300 each) + 8-writer cf0+cf8 (8,000 each)
    async function tagsFor(label: string) { const tok = tokenOf(label); const rows = await q('select part, n from ' + S + '.w_esc where tok = $1', [escId(tok)]); const o: string[] = []; for (const r of rows) for (let n = 1; n <= r.n; n++) { const b = Buffer.alloc(6); b.writeUInt16BE(r.part); b.writeUInt32BE(n, 2); o.push(String(trunc64(createHmac('sha256', tok).update(b).digest()))); } return o; }
    const countVia = async (label: string) => Number((await qGin('select count(*) n from ' + S + '.w_occ where tags && $1::bigint[]', [await tagsFor(label)]))[0].n);
    const consistency: any = { afterConcurrentInserts: { expectedX: expX, viaTagsX: await countVia('e ' + X), expectedY: expY, viaTagsY: await countVia('e ' + Y) } };
    let tagsX = await tagsFor('e ' + X);
    const del = (await qGin('select id from ' + S + '.w_occ where tags && $1::bigint[] limit 1000', [tagsX])).map(r => r.id);
    await q('delete from ' + S + '.w_occ where id = any($1::uuid[])', [del]); expX -= del.length;
    consistency.afterDelete1000 = { deleted: del.length, expectedX: expX, viaTagsX: await countVia('e ' + X) };
    const ids = (await qGin('select id from ' + S + '.w_occ where tags && $1::bigint[] limit 500', [tagsX])).map(r => r.id);
    const c = await pool.connect();
    try { for (const id of ids) { await c.query('begin'); const tokY = tokenOf('e ' + Y); const r = await c.query('insert into ' + S + '.w_esc (tok, part, n) values ($1, 0, 1) on conflict (tok, part) do update set n = ' + S + '.w_esc.n + 1 returning n', [escId(tokY)]); const b = Buffer.alloc(6); b.writeUInt32BE(r.rows[0].n, 2); const newTag = String(trunc64(createHmac('sha256', tokY).update(b).digest())); await c.query('update ' + S + '.w_occ set tags = array(select unnest(tags) except select unnest($2::bigint[])) || $3::bigint[] where id = $1', [id, tagsX, [newTag]]); await c.query('commit'); } } finally { c.release(); }
    expX -= ids.length; expY += ids.length;
    consistency.afterPartialUpdate500 = { updated: ids.length, expectedX: expX, viaTagsX: await countVia('e ' + X), expectedY: expY, viaTagsY: await countVia('e ' + Y) };
    out.consistency = consistency; console.log(JSON.stringify(consistency));
    console.log(JSON.stringify(out, null, 1)); save('write', out);
  } finally { unlock(); }
}

if (phase === 'attack') {
  // Mechanical static-snapshot checks (T1/T3) on the loaded layouts.
  // det: tokens repeat across rows -> known-row labelling. occ/chk: every tag must be unique -> nothing links. esc: frequency histogram only.
  const detDup = await q('select count(*) filter (where c > 1) as repeated_tokens, count(*) as distinct_tokens, max(c) as max_rows_per_token from (select t, count(*) c from ' + S + '.det, unnest(tags) t group by t) x');
  const occDup = await q('select count(*) filter (where c > 1) as repeated_tags, count(*) as distinct_tags from (select t, count(*) c from ' + S + '.occ, unnest(tags) t group by t) x');
  const chkDup = await q('select count(*) filter (where c > 1) as repeated_chks, count(*) as distinct_chks from (select t, count(*) c from ' + S + '.chk, unnest(chks) t group by t) x');
  // Known-row attack curve on the deterministic layouts of the same fixture (memo field), realistic priors:
  //   known rows k = 10 (0.01%), 100 (0.1%), 1,000 (1%), 10,000 (10%, upper reference).
  //   Stage 1 (seed): tokens of known rows get labelled with their piece. Metric on unknown rows: share of tokens whose label is
  //   correct, share of rows with >= 80% tokens correctly labelled ("rows80", the metric of decisions 004/010).
  //   Stage 2 (propagation, attacker upper bound): a row whose 2-glyph tokens are all correctly labelled is treated as fully
  //   reconstructed; all its tokens become labelled; repeat to a fixed point. (Assumes string assembly from bigrams succeeds.)
  //   Layouts: bigram16 = adjacent pieces at 16 bits (product-like width; no skip/start/end pieces), bigram64 = same at 64 bits,
  //   sub16 = substrings 2..K at 16 bits (= chk.cand as seen by a snapshot attacker), sub64 = substrings 2..K at 64 bits (= det).
  const rows = await q('select p.id, p.company, p.memo from ' + S + '.plain p order by p.id');
  const bigrams = (s: string) => { const c = Array.from(s), set = new Set<string>(); for (let i = 0; i + 2 <= c.length; i++) set.add(c.slice(i, i + 2).join('')); return [...set]; };
  type Tok = { t: string; p: string; two: boolean };
  const variants: Record<string, (memo: string) => Tok[]> = {
    bigram16: m => bigrams(m).map(x => ({ t: String(trunc16(tokenOf('s\0' + x))), p: x, two: true })),
    bigram64: m => bigrams(m).map(x => ({ t: String(detTag('s\0' + x)), p: x, two: true })),
    sub16: m => subs(m).map(x => ({ t: String(trunc16(tokenOf('s\0' + x))), p: x, two: Array.from(x).length === 2 })),
    sub64: m => subs(m).map(x => ({ t: String(detTag('s\0' + x)), p: x, two: Array.from(x).length === 2 })),
  };
  const memoAttack: Record<string, Record<string, unknown>> = {};
  for (const [name, fn] of Object.entries(variants)) {
    const tokRows = rows.map(r => fn(r.memo)); memoAttack[name] = {};
    for (const k of [10, 100, 1000, 10000]) {
      const step = Math.floor(rows.length / k); const known = new Set<number>(); const label = new Map<string, string>();
      for (let i = 0; i < rows.length; i += step) { if (known.size >= k) break; known.add(i); for (const x of tokRows[i]) label.set(x.t, x.p); }
      const score = () => { let r80 = 0, tot = 0, ok = 0, unk = 0, full = 0; for (let i = 0; i < rows.length; i++) { if (known.has(i)) continue; unk++; const t = tokRows[i]; let n = 0; for (const x of t) if (label.get(x.t) === x.p) n++; tot += t.length; ok += n; if (t.length && n >= 0.8 * t.length) r80++; if (t.length && n === t.length) full++; } return { tokensCorrectShare: +(ok / tot).toFixed(4), rows80share: +(r80 / unk).toFixed(4), rowsFullShare: +(full / unk).toFixed(4) }; };
      const seed = score();
      let changed = true, decoded = 0; const done = new Set<number>();
      while (changed) { changed = false; for (let i = 0; i < rows.length; i++) { if (known.has(i) || done.has(i)) continue; const t = tokRows[i]; const twos = t.filter(x => x.two); if (!twos.length || !twos.every(x => label.get(x.t) === x.p)) continue; done.add(i); decoded++; changed = true; for (const x of t) label.set(x.t, x.p); } }
      memoAttack[name]['k' + k] = { knownRows: known.size, seed, propagated: { ...score(), rowsReconstructed: decoded, rowsReconstructedShare: +(decoded / (rows.length - known.size)).toFixed(4) } };
    }
    memoAttack[name].distinctTokens = new Set(tokRows.flat().map(x => x.t)).size;
  }
  // Exact-match field (company, 16 distinct values): a public list of company names + token frequency rank identifies deterministic
  // tokens without any known row. det: every row's company is then revealed. occ: the counter table reveals only the 16 frequencies.
  const companyFreq = await q('select company, count(*) n from ' + S + '.plain group by 1 order by 2 desc');
  const esc = await q('select n from ' + S + '.esc order by n desc');
  const out = { memoKnownRowCurve: memoAttack, company: { distinctValues: companyFreq.length, note: 'det/chk16: deterministic token per value -> frequency-rank match against a public company list labels every row (upper bound 100%); occ: counter rows leak the 16 frequencies but no row linkage' }, detDup: detDup[0], occ: { ...occDup[0] }, chk: { ...chkDup[0] }, esc: { counters: esc.length, top: esc.slice(0, 5).map(r => r.n), distinctCountValues: new Set(esc.map(r => r.n)).size } };
  console.log(JSON.stringify(out, null, 1)); save('attack', out);
}

if (phase === 'measure2') { // combination study: count paths incl. full-scan fallback; find (limit 200) paths. Warm-up 2 + 7 rotated, medians.
  await lock();
  try {
    const results: any[] = [];
    const scanCount = async (k: Case) => { const toks = k.cs.map(c => tokenOf(lab(c))); return Number((await q('select count(*) n from ' + S + '.chk where ' + toks.map((_, i) => chkExpr(i + 1)).join(' ' + k.op + ' '), toks))[0].n); };
    const plainFind = async (k: Case) => (await q('select id from ' + S + '.plain where ' + k.cs.map((c, i) => plainSql(c, i + 1)).join(' ' + k.op + ' ') + ' order by id limit 200', k.cs.map(plainVal))).map(r => r.id);
    const chkFind = async (k: Case) => { const toks = k.cs.map(c => tokenOf(lab(c))); const cand = toks.map(trunc16); const pre = k.op === 'and' ? 'cand @> $' + (toks.length + 1) + '::int[]' : 'cand && $' + (toks.length + 1) + '::int[]'; return (await q('select id from ' + S + '.chk where ' + pre + ' and (' + toks.map((_, i) => chkExpr(i + 1)).join(' ' + k.op + ' ') + ') order by id limit 200', [...toks, cand])).map(r => r.id); };
    const occFind = async (k: Case) => { const toks = k.cs.map(c => tokenOf(lab(c))); const parts = toks.map((_, i) => 'select id from ' + S + '.occ_tag where tag = any(' + genSql(i + 1) + ')'); return (await q('select id from (' + parts.join(k.op === 'and' ? ' intersect ' : ' union ') + ') x order by id limit 200', toks)).map(r => r.id); };
    const productFind = async (k: Case) => { const leaf = (c: Cond, m: any) => 'e' in c ? m.company.eq(RAW[c.e] ?? c.e) : m.memo.contains(c.s); const r: any = await sealed.findMany(productDb, productReg, { scope: PRODUCT_SCOPE, match: (m: any) => k.op === 'and' ? m.and(...k.cs.map(c => leaf(c, m))) : m.or(...k.cs.map(c => leaf(c, m))), columns: { company: true, memo: true }, limit: 200 } as any); return r.items.map((x: any) => x.id); };
    for (const k of cases) {
      const truth = await plainCount(k); const truthIds = await plainFind(k);
      const paths: Record<string, () => Promise<{ n?: number; ids?: string[] }>> = {
        'count plain(idx)': async () => ({ n: await plainCount(k) }),
        'count product(current, API)': async () => ({ n: await productCount(k) }),
        'count chk cand16+dbHMAC 1sql': async () => ({ n: await chkCount(k, st0()) }),
        'count occ Btree db-tags 1sql': async () => ({ n: await occCountBtreeDb(k, st0()) }),
        'count scan-fallback dbHMAC all rows 1sql': async () => ({ n: await scanCount(k) }),
        'find200 plain(idx)': async () => ({ ids: await plainFind(k) }),
        'find200 product(current, API, decrypted)': async () => ({ ids: await productFind(k) }),
        'find200 chk ids 1sql': async () => ({ ids: await chkFind(k) }),
        'find200 occ Btree db-tags ids 1sql': async () => ({ ids: await occFind(k) }),
      };
      const names = Object.keys(paths).filter(n => !process.env.M2_PATHS || process.env.M2_PATHS.split(',').includes(n)); const runs: Record<string, number[]> = Object.fromEntries(names.map(n => [n, []])); const dbRuns: Record<string, number[]> = Object.fromEntries(names.map(n => [n, []])); const sqlN: Record<string, number> = {}; const failed: Record<string, string> = {};
      for (let i = 0; i < 10; i++) {
        const order = i === 0 ? names : [...names.slice(i % names.length), ...names.slice(0, i % names.length)];
        for (const n of order) {
          if (failed[n]) continue;
          let res: { ms: number; dbMs: number; sqlN: number; r: { n?: number; ids?: string[] } };
          try { res = await timed(paths[n]); } catch (e) { failed[n] = String((e as Error).message).slice(0, 120); console.log('FAILED', k.name, n, failed[n]); continue; }
          const okv = res.r.n !== undefined ? res.r.n === truth : (res.r.ids!.length === truthIds.length && res.r.ids!.every((x, j) => String(x) === String(truthIds[j])));
          if (!okv) { failed[n] = 'mismatch'; console.log('FAILED', k.name, n, 'mismatch', res.r.n ?? res.r.ids!.length); continue; }
          if (i >= 3) { runs[n].push(res.ms); dbRuns[n].push(res.dbMs); } sqlN[n] = res.sqlN;
        }
      }
      const ok = names.filter(n => !failed[n]);
      const row = { case: k.name, truth, find200: truthIds.length, medians: Object.fromEntries(ok.map(n => [n, +median(runs[n]).toFixed(1)])), dbMedians: Object.fromEntries(ok.map(n => [n, +median(dbRuns[n]).toFixed(1)])), sqlCalls: Object.fromEntries(ok.map(n => [n, sqlN[n]])), failed };
      console.log(JSON.stringify(row)); results.push(row);
    }
    save('measure2', results);
  } finally { unlock(); }
}

if (phase === 'drop') { await q('drop schema if exists ' + S + ' cascade'); console.log('dropped', S); }
await pool.end();

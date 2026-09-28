/**
 * List limit 300 + count, fixed criteria (list300-brief): plaintext, A (product API), B (m1-astra tables + query builders),
 * C (per-occurrence tags + counters), D2 (per-field 16-bit candidate arrays + per-field check values) — one session, interleaved.
 * Same implementation level: lists stop at LIMIT in SQL (order by id limit 300); terms longer than K (10; B: 8) or with spaces
 * narrow candidates in the DB, then the app decrypts ONLY the condition fields; D uses per-field arrays.
 * Data: research_u (customers 100k, one scope). Plaintext = 1x. Warm-up 2 + 7 rotated, medians. Every run asserts count / id
 * order / returned values (C, D, B: normalized values vs customers_plain; A returns original strings so ids only).
 * Phases: load (D2 tables) | measure.   Run: rtk proxy npx tsx bench/research-list300/m2-fable-list300.ts <phase>
 */
import assert from 'node:assert/strict';
import { createDecipheriv, hash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { assertDisposable } from '../../test/disposable.js';
import { cases as r8cases, condition, plainWhere, type Case as R8Case, type Node, type Leaf } from '../verify-native/r8-cases.js';
import { customersSeal, sealed, scopeId as PRODUCT_SCOPE } from '../verify-native/schema.js';
import { normalizeText } from '../../src/core/search-tokens.js';
import { verification as bVerification, B_K } from '../research-unified/b-codec.js';
import { candidate as bCandidate } from '../research-unified/b-product.js';
import { runBShared } from '../research-unified/b-list300.js';

const { Pool } = pg;
const phase = process.argv[2]; assert(['load', 'measure'].includes(phase ?? ''), 'phase');
const S = 'research_u', K = 10, LIMIT = 300, OUT = 'bench/results/2026-09-29-list300', LOCK = '.local/research/measure.lock';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 10, options: '-c statement_timeout=1800000' });
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
const sqlStat = { ms: 0, n: 0, rows: 0 }; const events: { s: number; e: number }[] = [];
const rawQuery = pool.query.bind(pool);
(pool as any).query = async (...args: any[]) => { const t = performance.now(); try { const r = await (rawQuery as any)(...args); sqlStat.rows += r?.rowCount ?? 0; return r; } finally { const e = performance.now(); sqlStat.ms += e - t; sqlStat.n++; events.push({ s: t, e }); } };
const q = async (t: string, v: unknown[] = []) => (await pool.query(t, v)).rows;
async function lock() { for (;;) { if (!existsSync(LOCK)) { try { writeFileSync(LOCK, 'm2-fable list300 ' + phase + ' ' + new Date().toISOString() + '\n', { flag: 'wx' }); return; } catch { /* raced */ } } console.error('measure.lock held; waiting 60s'); await new Promise(r => setTimeout(r, 60000)); } }
function unlock() { if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('m2-fable list300')) unlinkSync(LOCK); }
mkdirSync(OUT, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(OUT + '/m2-fable-' + name + '.json', JSON.stringify(data, null, 1));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---- shared research keys (contract: prfKey 0x07*32, aesKey 0x5d*32) ----
const KEY = Buffer.alloc(32, 7), AES = Buffer.alloc(32, 93);
const tokenOf = (label: string) => hash('sha256', Buffer.concat([KEY, Buffer.from(label)]), 'buffer') as Buffer;
const trunc16 = (b: Buffer) => b.readUInt16BE(0);
const hex8 = (b: Buffer) => '\\x' + b.subarray(0, 8).toString('hex');
const chkOf = (tok: Buffer, nonce: Buffer) => hex8(hash('sha256', Buffer.concat([tok, nonce]), 'buffer') as Buffer);
const dec = { count: 0 };
function decrypt(b: Buffer) { dec.count++; const d = createDecipheriv('aes-256-gcm', AES, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }
const FIELDS = ['name', 'phone', 'address', 'memo', 'email', 'company'] as const;
const AFFIX: Record<string, boolean> = { address: true, email: true };
const normTerm = (s: string) => normalizeText(s, 'legacy-text-v1');
function labels(field: string, v: string): string[] {
  const c = Array.from(v), out = new Set<string>(); const p = 'customers\0' + field + '\0';
  out.add(p + 'e\0' + v);
  for (let l = 2; l <= K; l++) for (let i = 0; i + l <= c.length; i++) out.add(p + 's\0' + c.slice(i, i + l).join(''));
  if (AFFIX[field]) for (let l = 2; l <= Math.min(K, c.length); l++) { out.add(p + 'p\0' + c.slice(0, l).join('')); out.add(p + 'x\0' + c.slice(c.length - l).join('')); }
  return [...out];
}

// ================= LOAD: D2 = per-field candidate arrays + per-field check values =================
if (phase === 'load') {
  await lock();
  try {
    const t0 = performance.now();
    await q(`drop table if exists ${S}.customers_d2`);
    await q(`create table ${S}.customers_d2 (id uuid primary key, nonce bytea not null, ${FIELDS.map(f => `cand_${f} int[] not null, chk8_${f} bytea[] not null`).join(', ')}, memo_len int not null)`);
    const rows = await q(`select id::text, ${FIELDS.map(f => f + '_norm as ' + f).join(',')}, memo_len from ${S}.customers_plain order by id`);
    assert.equal(rows.length, 100000);
    const B = 2000;
    for (let i = 0; i < rows.length; i += B) {
      const chunk = rows.slice(i, i + B); const vals: unknown[] = []; const tuples: string[] = [];
      for (const r of chunk) {
        const nonce = randomBytes(16); const parts: unknown[] = [r.id, nonce];
        for (const f of FIELDS) { const cand = new Set<number>(); const chks: string[] = []; for (const l of labels(f, r[f])) { const tok = tokenOf(l); cand.add(trunc16(tok)); chks.push(chkOf(tok, nonce)); } parts.push([...cand], chks); }
        parts.push(r.memo_len);
        tuples.push('(' + parts.map((_, j) => '$' + (vals.length + j + 1) + (j >= 2 && j < 14 && j % 2 === 1 ? '::bytea[]' : '')).join(',') + ')'); vals.push(...parts);
      }
      await q(`insert into ${S}.customers_d2 values ` + tuples.join(','), vals);
      if (i % 20000 === 0) console.log('loaded', i + chunk.length, ((performance.now() - t0) / 1000).toFixed(0) + 's');
    }
    const tIdx = performance.now();
    await q(`create index customers_d2_gin on ${S}.customers_d2 using gin (${FIELDS.map(f => 'cand_' + f).join(', ')})`);
    await q(`vacuum analyze ${S}.customers_d2`);
    const size = await q(`select pg_total_relation_size('${S}.customers_d2') as total, pg_relation_size('${S}.customers_d2') as heap, pg_indexes_size('${S}.customers_d2') as idx`);
    const out = { rows: rows.length, K, loadSec: +((tIdx - t0) / 1000).toFixed(0), indexSec: +((performance.now() - tIdx) / 1000).toFixed(0), size: size[0] };
    console.log(JSON.stringify(out)); save('load', out);
  } finally { unlock(); }
}

// ================= cases =================
const pick = (n: string) => r8cases.find(c => c.name === n)!;
const L = (op: Leaf['op'], field: any, value: string): Leaf => ({ op, field, value });
const CO = L('eq', 'company', '서울서비스 담당'), MEMO = L('contains', 'memo', '서비스'), RARE = L('contains', 'memo', '푸른달'), ADDR = L('contains', 'address', '서울');
const MORE_CASES: R8Case[] = [
  { name: 'zero_and_common2', node: { all: [CO, L('contains', 'company', '물류')] } },
  { name: 'zero_and_common3', node: { all: [CO, L('contains', 'company', '물류'), MEMO] } },
  { name: 'zero_fragment', node: L('contains', 'memo', '상담서비스') },
  { name: 'zero_fragment_long', node: L('contains', 'memo', '서비스상담서비스상담요청') },
  { name: 'zero_or_all', node: { any: [L('contains', 'memo', '상담서비스'), L('contains', 'name', '서비스상'), L('contains', 'address', '담당서울')] } },
  pick('exact_zero'), pick('sub_zero'),
  { name: 'or4', node: { any: [CO, RARE, L('eq', 'phone', '42-5748-1542'), L('contains', 'name', 'pshxt')] } },
  { name: 'or5', node: { any: [CO, RARE, L('eq', 'phone', '42-5748-1542'), L('contains', 'name', 'pshxt'), L('contains', 'address', '세종대로')] } },
  { name: 'or6', node: { any: [CO, RARE, L('eq', 'phone', '42-5748-1542'), L('contains', 'name', 'pshxt'), L('contains', 'address', '세종대로'), L('endsWith', 'email', 'biz.test')] } },
  { name: 'and2_or_and2', node: { any: [{ all: [CO, MEMO] }, { all: [ADDR, L('contains', 'memo', '상담')] }] } },
  { name: 'or2_and_or2', node: { all: [{ any: [CO, RARE] }, { any: [ADDR, L('contains', 'email', 'service')] }] } },
  { name: 'and3_or_rare', node: { any: [{ all: [CO, MEMO, ADDR] }, RARE] } },
  { name: 'nested3', node: { all: [{ any: [{ all: [CO, MEMO] }, { all: [ADDR, L('contains', 'email', 'test')] }] }, { any: [L('contains', 'phone', '-5'), L('contains', 'name', '민서')] }] } },
  pick('exact_mid'), pick('exact_one'), pick('sub2_common'), pick('sub_mid_space'), pick('sub_long'), pick('word_inside_longer'),
];
const structure = (n: Node): string => 'all' in n ? (n.all.every(x => !('all' in x) && !('any' in x)) ? 'AND ' + n.all.length : '(' + n.all.map(structure).join(') AND (') + ')') : 'any' in n ? (n.any.every(x => !('all' in x) && !('any' in x)) ? 'OR ' + n.any.length : '(' + n.any.map(structure).join(') OR (') + ')') : '1';
const CASES: R8Case[] = [
  pick('exact_common'), { name: 'sub_common_memo', node: { op: 'contains', field: 'memo', value: '서비스' } }, pick('sub_mid'), pick('sub_rare'), pick('starts'), pick('ends'),
  pick('and2'), pick('and4'), pick('and6'), pick('or2'), pick('or3'),
  { name: 'or_and_mix', node: { any: [pick('and2').node, pick('sub_rare').node] } },
  { name: 'word_boundary', node: { op: 'contains', field: 'memo', value: '서비스 상담' }, respectWords: true },
  { name: 'sub45', node: { op: 'contains', field: 'memo', value: '상세안내와확인내용'.repeat(5) } },
];
const leafFields = (n: Node, acc = new Set<string>()): Set<string> => { if ('all' in n) n.all.forEach(x => leafFields(x, acc)); else if ('any' in n) n.any.forEach(x => leafFields(x, acc)); else acc.add(n.field); return acc; };
// Space rule: with M2_NOSPACE set, the meaning is "substring after removing spaces", so a spaced term whose normalized length is <= K stays in the DB
const spaceTriggers = (v: string) => !process.env.M2_NOSPACE && /\s/.test(v);
const needsApp = (n: Node, k: number): boolean => 'all' in n ? n.all.some(x => needsApp(x, k)) : 'any' in n ? n.any.some(x => needsApp(x, k)) : (n.op !== 'eq' && (Array.from(normTerm(n.value)).length > k || spaceTriggers(n.value)));
const SPACE_CASES: R8Case[] = [
  { name: 'space_memo', node: { op: 'contains', field: 'memo', value: '서비스 상담' } },
  { name: 'space_address', node: { op: 'contains', field: 'address', value: '세종대로 25' } },
  { name: 'space_inside', node: { op: 'contains', field: 'memo', value: '비스 상' } },
];
function evalNode(row: Record<string, string>, n: Node): boolean { if ('all' in n) return n.all.every(x => evalNode(row, x)); if ('any' in n) return n.any.some(x => evalNode(row, x)); const v = row[n.field] ?? '', t = normTerm(n.value); return n.op === 'contains' ? v.includes(t) : n.op === 'startsWith' ? v.startsWith(t) : n.op === 'endsWith' ? v.endsWith(t) : v === t; }
// app verification of candidates: decrypt ONLY the condition fields
async function appVerify(ids: string[], c: R8Case) {
  if (!ids.length) return [] as string[];
  const fs = [...leafFields(c.node)];
  const rows = await q(`select id::text, ${fs.map(f => f + '_ct').join(',')} from ${S}.customers_ct where id = any($1::uuid[]) order by id`, [ids]);
  const ok: string[] = []; for (const r of rows) { const plain: Record<string, string> = {}; for (const f of fs) plain[f] = decrypt(r[f + '_ct']); if (evalNode(plain, c.node)) ok.push(r.id); }
  return ok;
}
async function fetchDecryptRows(ids: string[]) { // list results: the app decrypts all six fields of the returned rows
  if (!ids.length) return [] as any[];
  const rows = await q(`select id::text, ${FIELDS.map(f => f + '_ct').join(',')} from ${S}.customers_ct where id = any($1::uuid[]) order by id`, [ids]);
  return rows.map(r => ({ id: r.id, ...Object.fromEntries(FIELDS.map(f => [f, decrypt(r[f + '_ct'])])) }));
}

// ---- D2 (per-field arrays) ----
function compileD2(n: Node, params: unknown[]): string {
  if ('all' in n) return '(' + n.all.map(x => compileD2(x, params)).join(' and ') + ')';
  if ('any' in n) return '(' + n.any.map(x => compileD2(x, params)).join(' or ') + ')';
  const term = normTerm(n.value); const kind = n.op === 'eq' ? 'e' : n.op === 'contains' ? 's' : n.op === 'startsWith' ? 'p' : 'x';
  const one = (label: string) => { const tok = tokenOf(label); params.push(trunc16(tok), tok); return `(cand_${n.field} @> array[$${params.length - 1}::int] and substr(digest($${params.length}::bytea || nonce, 'sha256'), 1, 8) = any(chk8_${n.field}))`; };
  if (n.op !== 'eq' && (Array.from(term).length > K || spaceTriggers(n.value))) { const c = Array.from(term); const parts: string[] = []; for (let i = 0; i + K <= c.length || (i === 0 && c.length < K); i += K) parts.push(one('customers\0' + n.field + '\0s\0' + c.slice(i, Math.min(i + K, c.length)).join(''))); return '(' + parts.join(' and ') + ')'; }
  return one('customers\0' + n.field + '\0' + kind + '\0' + term);
}
function candOnlyD2(n: Node, params: unknown[]): string { // candidate predicate only (for the candidate count)
  if ('all' in n) return '(' + n.all.map(x => candOnlyD2(x, params)).join(' and ') + ')';
  if ('any' in n) return '(' + n.any.map(x => candOnlyD2(x, params)).join(' or ') + ')';
  const term = normTerm(n.value); const kind = n.op === 'eq' ? 'e' : n.op === 'contains' ? 's' : n.op === 'startsWith' ? 'p' : 'x';
  const one = (label: string) => { params.push(trunc16(tokenOf(label))); return `cand_${n.field} @> array[$${params.length}::int]`; };
  if (n.op !== 'eq' && (Array.from(term).length > K || spaceTriggers(n.value))) { const c = Array.from(term); const parts: string[] = []; for (let i = 0; i + K <= c.length || (i === 0 && c.length < K); i += K) parts.push(one('customers\0' + n.field + '\0s\0' + c.slice(i, Math.min(i + K, c.length)).join(''))); return '(' + parts.join(' and ') + ')'; }
  return one('customers\0' + n.field + '\0' + kind + '\0' + term);
}
// ---- C (tags + counters) ----
const genTags = (i: number) => `array(select substr(digest($${i}::bytea || int4send(g), 'sha256'), 1, 8) from generate_series(1, coalesce((select n from ${S}.esc where tok = digest($${i}::bytea || 'esc'::bytea, 'sha256')), 0)) g)`;
function compileC(n: Node, params: unknown[]): string {
  if ('all' in n) return '(' + n.all.map(x => compileC(x, params)).join(' intersect ') + ')';
  if ('any' in n) return '(' + n.any.map(x => compileC(x, params)).join(' union ') + ')';
  const term = normTerm(n.value); const kind = n.op === 'eq' ? 'e' : n.op === 'contains' ? 's' : n.op === 'startsWith' ? 'p' : 'x';
  const one = (label: string) => { params.push(tokenOf(label)); return `select id from ${S}.customers_ctag where tag8 = any(${genTags(params.length)})`; };
  if (n.op !== 'eq' && (Array.from(term).length > K || spaceTriggers(n.value))) { const c = Array.from(term); const parts: string[] = []; for (let i = 0; i + K <= c.length || (i === 0 && c.length < K); i += K) parts.push(one('customers\0' + n.field + '\0s\0' + c.slice(i, Math.min(i + K, c.length)).join(''))); return '(' + parts.join(' intersect ') + ')'; }
  return one('customers\0' + n.field + '\0' + kind + '\0' + term);
}
// ---- B (m1-astra tables/builders): candidate = product tokens on b_customers_tags, verification = per-row salted judge tags ----
async function compileB(n: Node) { const params: unknown[] = [PRODUCT_SCOPE]; const cand = await bCandidate(n, 'customers', params, 'j'); const ver = bVerification(n, 'customers', params, 'j'); return { params, cand, ver }; }

// ---- paths ----
type R = { n?: number; ids?: string[]; rows?: any[]; app?: number };
const plainCount = async (c: R8Case): Promise<R> => { const p: unknown[] = []; const w = plainWhere(c.node, p); return { n: Number((await q(`select count(*) n from ${S}.customers_plain where ${w}`, p))[0].n), app: 0 }; };
const plainList = async (c: R8Case): Promise<R> => { const p: unknown[] = []; const w = plainWhere(c.node, p); const rows = await q(`select id::text, ${FIELDS.map(f => f + '_norm as ' + f).join(',')} from ${S}.customers_plain where ${w} order by id limit ${LIMIT}`, p); return { ids: rows.map(r => r.id), rows, app: rows.length }; };
const db = drizzle(pool);
function matchOf(n: Node, m: any): any { if ('all' in n) return m.and(...n.all.map(x => matchOf(x, m))); if ('any' in n) return m.or(...n.any.map(x => matchOf(x, m))); return m[n.field][n.op](n.value); }
const aCount = async (c: R8Case): Promise<R> => ({ n: Number(await sealed.count(db, customersSeal, { scope: PRODUCT_SCOPE, match: (m: any) => matchOf(c.node, m) } as any)), app: -1 });
const aList = async (c: R8Case): Promise<R> => { const r: any = await sealed.findMany(db, customersSeal, { scope: PRODUCT_SCOPE, match: (m: any) => matchOf(c.node, m), columns: Object.fromEntries(FIELDS.map(f => [f, true])), limit: LIMIT } as any); return { ids: r.items.map((x: any) => String(x.id)), rows: r.items, app: -1 }; };
async function d2Count(c: R8Case): Promise<R> { const p: unknown[] = []; const w = compileD2(c.node, p);
  if (!needsApp(c.node, K)) return { n: Number((await q(`select count(*) n from ${S}.customers_d2 where ${w}`, p))[0].n), app: 0 };
  const ids = (await q(`select id::text from ${S}.customers_d2 where ${w}`, p)).map(r => r.id); return { n: (await appVerify(ids, c)).length, app: ids.length * 2 }; }
async function d2List(c: R8Case): Promise<R> { const p: unknown[] = []; const w = compileD2(c.node, p);
  if (!needsApp(c.node, K)) { const ids = (await q(`select id::text from ${S}.customers_d2 where ${w} order by id limit ${LIMIT}`, p)).map(r => r.id); const rows = await fetchDecryptRows(ids); return { ids, rows, app: ids.length * 2 }; }
  const cand = (await q(`select id::text from ${S}.customers_d2 where ${w} order by id`, p)).map(r => r.id); const ok = (await appVerify(cand, c)).slice(0, LIMIT); const rows = await fetchDecryptRows(ok); return { ids: ok, rows, app: cand.length * 2 + ok.length }; }
async function cCount(c: R8Case): Promise<R> { const p: unknown[] = []; const w = compileC(c.node, p);
  if (!needsApp(c.node, K)) return { n: Number((await q(`select count(*) n from (${w}) x`, p))[0].n), app: 0 };
  const ids = (await q(`select id::text from (${w}) x`, p)).map(r => r.id); return { n: (await appVerify(ids, c)).length, app: ids.length * 2 }; }
async function cList(c: R8Case): Promise<R> { const p: unknown[] = []; const w = compileC(c.node, p);
  if (!needsApp(c.node, K)) { const ids = (await q(`select id::text from (${w}) x order by id limit ${LIMIT}`, p)).map(r => r.id); const rows = await fetchDecryptRows(ids); return { ids, rows, app: ids.length * 2 }; }
  const cand = (await q(`select id::text from (${w}) x order by id`, p)).map(r => r.id); const ok = (await appVerify(cand, c)).slice(0, LIMIT); const rows = await fetchDecryptRows(ok); return { ids: ok, rows, app: cand.length * 2 + ok.length }; }
const bHost = { query: (text: string, params: unknown[]) => pool.query(text, params) as Promise<{ rows: any[] }>, open: (_f: any, ct: Buffer) => decrypt(ct) };
async function bCount(c: R8Case): Promise<R> { const { params, cand, ver } = await compileB(c.node);
  if (!needsApp(c.node, B_K)) return { n: Number((await q(`select count(*) n from ${S}.b_customers_tags j where j.scope_id = $1 and ${cand} and ${ver}`, params))[0].n), app: 0 };
  const r = await runBShared(c.node, { mode: 'count', batch: 300 }, bHost); return { n: r.value as number, app: r.appRows }; }
async function bList(c: R8Case): Promise<R> { const { params, cand, ver } = await compileB(c.node);
  if (!needsApp(c.node, B_K)) { const rows = await q(`with matched as materialized (select j.id from (select j.* from ${S}.b_customers_tags j where j.scope_id = $1 and ${cand} order by j.id offset 0) j where ${ver} order by j.id limit ${LIMIT}) select p.id::text, ${FIELDS.map(f => 'p.' + f + '_ct ' + f).join(',')} from matched m join ${S}.customers_ct p on p.id = m.id order by p.id`, params); const out = rows.map(r => ({ id: r.id, ...Object.fromEntries(FIELDS.map(f => [f, decrypt(r[f])])) })); return { ids: out.map(x => x.id), rows: out, app: rows.length }; }
  const r = await runBShared(c.node, { mode: 'list', limit: LIMIT, batch: 300 }, bHost); const out = (r.value as any[]).map(x => ({ ...x, id: String(x.id) })); return { ids: out.map(x => x.id), rows: out, app: r.appRows }; }
// candidate counts (untimed): rows the DB pre-filter admits before confirmation
async function candidates(c: R8Case) {
  const pd: unknown[] = []; const d2 = Number((await q(`select count(*) n from ${S}.customers_d2 where ${candOnlyD2(c.node, pd)}`, pd))[0].n);
  const pb: unknown[] = [PRODUCT_SCOPE]; const candB = await bCandidate(c.node, 'customers', pb, 'j'); const b = Number((await q(`select count(*) n from ${S}.b_customers_tags j where j.scope_id = $1 and ${candB}`, pb))[0].n);
  const pc: unknown[] = []; const cc = Number((await q(`select count(*) n from (${compileC(c.node, pc)}) x`, pc))[0].n);
  return { B: b, C: cc, D: d2 };
}

type Timing = { total: number; db: number; pre: number; between: number; post: number; sql: number; rows: number; decrypts: number; app: number };
async function timed(fn: () => Promise<R>) { const s0 = { ...sqlStat }; events.length = 0; dec.count = 0; const t = performance.now(); const r = await fn(); const end = performance.now();
  const ev = [...events].sort((a, b) => a.s - b.s); let wall = 0, right = -Infinity; for (const e of ev) { wall += Math.max(0, e.e - Math.max(e.s, right)); right = Math.max(right, e.e); }
  const pre = ev.length ? ev[0].s - t : end - t, post = ev.length ? end - right : 0;
  const timing: Timing = { total: end - t, db: sqlStat.ms - s0.ms, pre, between: Math.max(0, end - t - pre - wall - post), post, sql: sqlStat.n - s0.n, rows: sqlStat.rows - s0.rows, decrypts: dec.count, app: (r.app ?? -1) >= 0 ? r.app! : sqlStat.rows - s0.rows };
  return { r, timing }; }

if (phase === 'measure') {
  await lock();
  try {
    const results: any[] = [];
    for (const c of (process.env.M2_CASES === 'more' ? MORE_CASES : process.env.M2_CASES === 'space' ? SPACE_CASES : CASES)) {
      const cond = condition(c.node) + (c.respectWords ? ' (띄어쓰기 포함, 정규화 부분 문자열 의미)' : '');
      const truthN = (await plainCount(c)).n!; const truthL = (await plainList(c));
      const candN = await candidates(c);
      for (const kind of ['count', 'list300'] as const) {
        const paths: Record<string, () => Promise<R>> = kind === 'count'
          ? { plain: () => plainCount(c), A: () => aCount(c), B: () => bCount(c), C: () => cCount(c), D: () => d2Count(c) }
          : { plain: () => plainList(c), A: () => aList(c), B: () => bList(c), C: () => cList(c), D: () => d2List(c) };
        const names = Object.keys(paths); const runs: Record<string, Timing[]> = Object.fromEntries(names.map(n => [n, []])); const wrong: Record<string, string> = {}; const stop: Record<string, boolean> = {};
        for (let i = 0; i < 10; i++) {
          const order = i === 0 ? names : [...names.slice(i % names.length), ...names.slice(0, i % names.length)];
          for (const n of order) {
            if (stop[n]) continue;
            let out: { r: R; timing: Timing };
            try { out = await timed(paths[n]); } catch (e) { wrong[n] = '오류: ' + String((e as Error).message).slice(0, 100); stop[n] = true; continue; }
            let ok = true;
            if (kind === 'count') { if (out.r.n !== truthN) { ok = false; wrong[n] = '틀림(센 값 ' + out.r.n + ', 정답 ' + truthN + ')'; } }
            else { const ids = out.r.ids!; if (ids.length !== truthL.ids!.length || ids.some((x, j) => x !== truthL.ids![j])) { ok = false; wrong[n] = '틀림(ID ' + ids.length + '건, 정답 ' + truthL.ids!.length + '건' + (ids.length === truthL.ids!.length ? ', 순서/집합 불일치' : '') + ')'; }
              else if (n !== 'A') { const bad = out.r.rows!.findIndex((row: any, j: number) => FIELDS.some(f => row[f] !== truthL.rows![j][f])); if (bad >= 0) { ok = false; wrong[n] = '틀림(값 불일치 행 ' + bad + ')'; } } }
            if (!ok) { stop[n] = true; continue; }
            if (i >= 3) runs[n].push(out.timing);
          }
        }
        const med = (n: string, k: keyof Timing) => runs[n].length ? +median(runs[n].map(x => x[k])).toFixed(1) : null;
        const row = { case: c.name, kind, condition: cond, structure: structure(c.node), targetRows: 100000, scopeRows: 100000, matches: truthN, results: kind === 'count' ? 1 : truthL.ids!.length, candidates: candN, wrong, paths: Object.fromEntries(names.map(n => [n, runs[n].length ? { total: med(n, 'total'), db: med(n, 'db'), pre: med(n, 'pre'), between: med(n, 'between'), post: med(n, 'post'), sql: med(n, 'sql'), appRows: med(n, 'app'), decrypts: med(n, 'decrypts'), ratio: runs.plain.length ? +(med(n, 'total')! / med('plain', 'total')!).toFixed(2) : null } : null])) };
        console.log(JSON.stringify(row)); results.push(row); save('measure' + (process.env.M2_SUFFIX ?? ''), results);
      }
    }
  } finally { unlock(); }
}
await pool.end();

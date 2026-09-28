/**
 * Test A in the 100M multi-tenant environment (company B = 100k rows inside 100M): candidates from the EXISTING 100M companion
 * GIN (unchanged), joined to research_t_fable.b_tags (per-row salt + judgment tags), judged in SQL, count(*) / findMany / SUM.
 * Paths: plain (native_scale_100m.customers_plain), product (sealql drizzle count/findMany on native_scale_100m),
 * A_scope (companion subquery keeps scope_id = B), A_noscope (scope condition dropped: tokens carry the scope prefix;
 * the b_tags join restricts to company B anyway). Warm 2, 7 interleaved rounds, medians; every run asserts equality with
 * plaintext (count value / ordered ids and decrypted values / sum).
 * Usage: rtk proxy npx tsx bench/research-test/t-fable-measure.ts <count|find|sum|explain|all>
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealed } from '../../src/adapters/drizzle/v0.45/index.js';
import type { CompiledSearch } from '../../src/core/search-predicate.js';
import { cases, fields, plainWhere, type Case, type Node } from '../verify-native/r8-cases.js';
import { compile, tokenWhere, sealer } from '../research-count/x2-lib.js';
import { S, OUT, K, scopeB, lock, unlock, norm, kPiece, pool, guard } from './t-fable-load.js';

const phase = process.argv[2] ?? 'all'; assert(['count', 'find', 'sum', 'explain', 'all', 'verify'].includes(phase));
await guard();
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const COMP = 'native_scale_100m.customers_seal_index', PLAIN = 'native_scale_100m.customers_plain', PARENT = 'native_scale_100m.customers';
const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
const sealed = createSealed({ sealer: () => sealer });
const table = pgSchema('native_scale_100m').table('customers', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }), address: sealed.text('address', { search }),
  memo: sealed.text('memo', { search }), email: sealed.text('email', { search }), company: sealed.text('company', { search }) });
const registration = sealed.register(table, { row: 'id', scope: 'scopeId' });
const db = drizzle(pool);
const columns = Object.fromEntries(fields.map(f => [f, true]));
function match(n: Node, m: any): any { if ('all' in n) return m.and(...n.all.map(x => match(x, m))); if ('any' in n) return m.or(...n.any.map(x => match(x, m))); return m[n.field][n.op](n.value); }
const condition = (n: Node): string => 'all' in n ? `(${n.all.map(condition).join(' AND ')})` : 'any' in n ? `(${n.any.map(condition).join(' OR ')})` : `${n.field} ${n.op === 'eq' ? '=' : n.op} "${n.value}"`;

// ---- A SQL: per leaf (product token predicate on the companion) AND (judgment on b_tags)
function aWhere(c: CompiledSearch, params: unknown[]): string {
  if (c.op !== 'leaf') return `(${c.children.map(x => aWhere(x, params)).join(c.op === 'all' ? ' and ' : ' or ')})`;
  const tok = tokenWhere(c, params, '"__seal_idx"');
  const n = (c as any).leaf.node as { field: string; op: string; value: string }; const f = n.field; const chars = Array.from(norm(n.value));
  const J = (k: Buffer) => { params.push(k); return `('x'||encode(substr(sha256($${params.length}::bytea||t.salt_${f}),1,8),'hex'))::bit(64)::bigint`; };
  let judge: string;
  if (n.op === 'eq') judge = `t.jx_${f} = ${J(kPiece(f, 'x', chars.join('')))}`;
  else if (chars.length <= K) judge = `${J(kPiece(f, n.op === 'contains' ? 'g' : n.op === 'startsWith' ? 's' : 'e', chars.join('')))} = any(t.jt_${f})`;
  else { const ws: string[] = []; if (n.op === 'startsWith') ws.push(`${J(kPiece(f, 's', chars.slice(0, K).join('')))} = any(t.jt_${f})`); if (n.op === 'endsWith') ws.push(`${J(kPiece(f, 'e', chars.slice(chars.length - K).join('')))} = any(t.jt_${f})`); const seen = new Set<string>(); for (let i = 0; i + K <= chars.length; i++) { const w = chars.slice(i, i + K).join(''); if (!seen.has(w)) { seen.add(w); ws.push(`${J(kPiece(f, 'g', w))} = any(t.jt_${f})`); } } judge = ws.join(' and '); }
  return `(${tok} and ${judge})`;
}
type Plan = { where: string; params: unknown[]; scopeParam: string; preMs: number };
async function planA(c: Case, withScope: boolean): Promise<Plan> {
  const t = performance.now(); const compiled = await compile(c.node, scopeB); const params: unknown[] = []; let where = aWhere(compiled, params);
  let scopeParam = '';
  if (withScope) { params.push(scopeB); scopeParam = `$${params.length}`; where = `"__seal_idx".scope_id = ${scopeParam} and ${where}`; } // no-scope variant: no scope parameter at all
  return { where, params, scopeParam, preMs: performance.now() - t };
}
const aSub = (p: Plan) => `select "__seal_idx".row_id from ${COMP} as "__seal_idx" join ${S}.b_tags t on t.row_id = "__seal_idx".row_id where ${p.where}`;
async function candidatesOnly(c: Case) { // prefilter-only rows (DB 후보 수), untimed
  const compiled = await compile(c.node, scopeB); const params: unknown[] = []; const w = tokenWhere(compiled, params, '"__seal_idx"'); params.push(scopeB);
  return Number((await q(`select count(*) n from ${COMP} as "__seal_idx" join ${S}.b_tags t on t.row_id = "__seal_idx".row_id where "__seal_idx".scope_id = $${params.length} and ${w}`, params)).rows[0].n);
}
const plainParams = (c: Case) => { const params: unknown[] = [scopeB]; const w = plainWhere(c.node, params); return { w, params }; };

type Timing = { totalMs: number; preMs: number; dbMs: number; postMs: number; sqlCalls: number; value: any; rows?: number };
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> { const t = performance.now(); const value = await fn(); return { ms: performance.now() - t, value }; }
async function runCount(c: Case, path: string): Promise<Timing> {
  const t0 = performance.now();
  if (path === 'plain') { const { w, params } = plainParams(c); const r = await timed(() => q(`select count(*) n from ${PLAIN} where scope_id=$1 and ${w}`, params)); return { totalMs: performance.now() - t0, preMs: 0, dbMs: r.ms, postMs: 0, sqlCalls: 1, value: Number(r.value.rows[0].n) }; }
  if (path === 'product') { const n = await sealed.count(db, registration, { scope: scopeB, match: (m: any) => match(c.node, m) } as any); return { totalMs: performance.now() - t0, preMs: -1, dbMs: -1, postMs: -1, sqlCalls: 1, value: n }; }
  const p = await planA(c, path === 'A_scope'); const r = await timed(() => q(`select count(*) n from ${COMP} as "__seal_idx" join ${S}.b_tags t on t.row_id = "__seal_idx".row_id where ${p.where}`, p.params));
  return { totalMs: performance.now() - t0, preMs: p.preMs, dbMs: r.ms, postMs: 0, sqlCalls: 1, value: Number(r.value.rows[0].n) };
}
const ctCols = fields.map(f => `${f}_ct`);
async function runFind(c: Case, path: string, limit: number | null): Promise<Timing & { ids: string[]; values: Record<string, string>[] }> {
  const t0 = performance.now(); const lim = limit === null ? '' : ` limit ${limit}`;
  if (path === 'plain') { const { w, params } = plainParams(c); const r = await timed(() => q(`select id::text id, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from ${PLAIN} where scope_id=$1 and ${w} order by id${lim}`, params)); return { totalMs: performance.now() - t0, preMs: 0, dbMs: r.ms, postMs: 0, sqlCalls: 1, value: r.value.rows.length, rows: r.value.rows.length, ids: r.value.rows.map((x: any) => x.id), values: r.value.rows }; }
  if (path === 'product') { const opts: any = { scope: scopeB, match: (m: any) => match(c.node, m), columns }; if (limit !== null) opts.limit = limit; const res: any = await sealed.findMany(db, registration, opts); const items = res.items as any[]; return { totalMs: performance.now() - t0, preMs: -1, dbMs: -1, postMs: -1, sqlCalls: -1, value: items.length, rows: items.length, ids: items.map(x => x.id), values: items }; }
  const p = await planA(c, true);
  const r = await timed(() => q(`select c.id::text id, c.scope_id, ${ctCols.map(x => `c.${x}`).join(',')} from ${PARENT} c where c.scope_id = ${p.scopeParam} and c.id in (${aSub(p)}) order by c.id${lim}`, p.params));
  const tp = performance.now();
  const opened: any[] = await (sealed as any).openRaw(registration, r.value.rows, { columns: { id: 'id', scopeId: 'scope_id', ...Object.fromEntries(fields.map(f => [f, `${f}_ct`])) }, scope: scopeB });
  const postMs = performance.now() - tp;
  // openRaw returns the decrypted values under the mapped column keys (name_ct ...): normalize to field names for comparison
  const values = opened.map(x => ({ id: String(x.id), ...Object.fromEntries(fields.map(f => [f, x[`${f}_ct`] ?? x[f]])) }));
  return { totalMs: performance.now() - t0, preMs: p.preMs, dbMs: r.ms, postMs, sqlCalls: 1, value: opened.length, rows: opened.length, ids: values.map(x => x.id), values };
}
async function runSum(c: Case, path: string): Promise<Timing> {
  const t0 = performance.now();
  if (path === 'plain') { const { w, params } = plainParams(c); const r = await timed(() => q(`select sum(char_length(memo_plain)) s from ${PLAIN} where scope_id=$1 and ${w}`, params)); return { totalMs: performance.now() - t0, preMs: 0, dbMs: r.ms, postMs: 0, sqlCalls: 1, value: Number(r.value.rows[0].s) }; }
  const p = await planA(c, true);
  const r = await timed(() => q(`select sum(char_length(p.memo_plain)) s from ${PLAIN} p where p.scope_id = ${p.scopeParam} and p.id in (${aSub(p)})`, p.params));
  return { totalMs: performance.now() - t0, preMs: p.preMs, dbMs: r.ms, postMs: 0, sqlCalls: 1, value: Number(r.value.rows[0].s) };
}
function summarize(xs: Timing[]) { return { totalMs: +median(xs.map(x => x.totalMs)).toFixed(1), preMs: +median(xs.map(x => x.preMs)).toFixed(1), dbMs: +median(xs.map(x => x.dbMs)).toFixed(1), postMs: +median(xs.map(x => x.postMs)).toFixed(1), sqlCalls: xs[0].sqlCalls, value: xs[0].value, rows: xs[0].rows ?? null }; }
async function protocol<T extends Timing>(paths: string[], run: (p: string) => Promise<T>, check: (r: T, ref: T) => void) {
  const ref = await run(paths[0]); const samples: Record<string, T[]> = Object.fromEntries(paths.map(p => [p, []]));
  for (let round = 0; round < 9; round++) for (const p of round % 2 ? [...paths].reverse() : paths) { const r = await run(p); check(r, ref); if (round >= 2) samples[p].push(r); }
  return Object.fromEntries(paths.map(p => [p, summarize(samples[p])]));
}
const sameValues = (a: Record<string, string>[], b: Record<string, string>[]) => { assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) { assert.equal(String(a[i].id), String(b[i].id), `id ${i}`); for (const f of fields) assert.equal(String(a[i][f]), String(b[i][f]), `${f} ${i}`); } };

const selected = cases.filter(c => ['and2', 'and4', 'and6', 'or2', 'or3', 'exact_common', 'sub_mid', 'sub_rare', 'starts', 'ends'].includes(c.name));
const res: any = { startedAt: new Date().toISOString(), env: '1억 속 회사 B (native_scale_100m, scope B 100,000 rows)', protocol: 'warm 2, 7 interleaved rounds, medians; equality with plaintext asserted every run', count: [], find: [], sum: [], explain: {} };
if (phase === 'verify') { // correctness only, single run each, NO timing reported, no measurement lock
  const v: any = { startedAt: new Date().toISOString(), count: [], find: [], sum: [] };
  for (const c of selected) { const pl = await runCount(c, 'plain'), a = await runCount(c, 'A_scope'), b = await runCount(c, 'A_noscope'); v.count.push({ case: c.name, condition: condition(c.node), plain: pl.value, A_scope: a.value, A_noscope: b.value, candidates: await candidatesOnly(c), equal: pl.value === a.value && pl.value === b.value }); console.log('verify count', JSON.stringify(v.count.at(-1))); }
  for (const c of selected.filter(x => ['and2', 'or2', 'exact_common', 'starts', 'ends'].includes(x.name))) for (const limit of [20, 200]) { const pl = await runFind(c, 'plain', limit), a = await runFind(c, 'A_scope', limit); let equal = true; try { sameValues(a.values, pl.values); } catch { equal = false; } v.find.push({ case: c.name, limit, plainRows: pl.rows, aRows: a.rows, equal }); console.log('verify find', JSON.stringify(v.find.at(-1))); }
  for (const c of selected.filter(x => ['and2', 'or2', 'exact_common', 'and6'].includes(x.name))) { const pl = await runSum(c, 'plain'), a = await runSum(c, 'A_scope'); v.sum.push({ case: c.name, plain: pl.value, A: a.value, equal: pl.value === a.value }); console.log('verify sum', JSON.stringify(v.sum.at(-1))); }
  v.finishedAt = new Date().toISOString(); writeFileSync(`${OUT}/t-fable-verify.json`, JSON.stringify(v, null, 2) + '\n'); await pool.end(); process.exit(0);
}
await lock('measure');
try {
  if (phase === 'count' || phase === 'all') for (const c of selected) {
    const paths = ['plain', 'product', 'A_scope', 'A_noscope'];
    const out = await protocol(paths, p => runCount(c, p), (r, ref) => assert.equal(r.value, ref.value, `${c.name}: count ${r.value} != ${ref.value}`));
    const row = { case: c.name, condition: condition(c.node), targetRows: 100000, matches: out.plain.value, candidates: await candidatesOnly(c), paths: out };
    res.count.push(row); console.log('count', c.name, JSON.stringify(row));
    writeFileSync(`${OUT}/t-fable-measure.json`, JSON.stringify(res, null, 2) + '\n');
  }
  if (phase === 'find' || phase === 'all') for (const c of selected.filter(x => ['and2', 'or2', 'exact_common'].includes(x.name))) for (const limit of [20, 200, null]) {
    const paths = ['plain', 'product', 'A_scope'];
    const out = await protocol(paths, p => runFind(c, p, limit), (r, ref) => sameValues(r.values, ref.values));
    const row = { case: c.name, condition: condition(c.node), limit: limit ?? 'all', targetRows: 100000, matches: res.count.find((x: any) => x.case === c.name)?.matches ?? null, paths: out };
    res.find.push(row); console.log('find', c.name, limit, JSON.stringify(row));
    writeFileSync(`${OUT}/t-fable-measure.json`, JSON.stringify(res, null, 2) + '\n');
  }
  if (phase === 'sum' || phase === 'all') for (const c of selected.filter(x => ['and2', 'or2', 'exact_common', 'and6'].includes(x.name))) {
    const out = await protocol(['plain', 'A_scope'], p => runSum(c, p), (r, ref) => assert.equal(r.value, ref.value, `${c.name}: sum ${r.value} != ${ref.value}`));
    const row = { case: c.name, condition: `SUM(char_length(memo_plain)) WHERE ${condition(c.node)}`, premise: 'fixture has no numeric column: plaintext derivative char_length(memo_plain) on customers_plain, filtered by the encrypted predicate', paths: out };
    res.sum.push(row); console.log('sum', c.name, JSON.stringify(row));
    writeFileSync(`${OUT}/t-fable-measure.json`, JSON.stringify(res, null, 2) + '\n');
  }
  if (phase === 'explain' || phase === 'all') for (const c of selected.filter(x => ['and2', 'or2', 'exact_common'].includes(x.name))) for (const ws of [true, false]) {
    const p = await planA(c, ws);
    const plan = (await q(`explain (analyze, buffers, format text) select count(*) from ${COMP} as "__seal_idx" join ${S}.b_tags t on t.row_id = "__seal_idx".row_id where ${p.where}`, p.params)).rows.map((r: any) => r['QUERY PLAN']);
    res.explain[`${c.name}/${ws ? 'A_scope' : 'A_noscope'}`] = plan; console.log('explain', c.name, ws, plan.slice(0, 6).join(' | ').slice(0, 400));
    writeFileSync(`${OUT}/t-fable-measure.json`, JSON.stringify(res, null, 2) + '\n');
  }
  res.finishedAt = new Date().toISOString(); writeFileSync(`${OUT}/t-fable-measure.json`, JSON.stringify(res, null, 2) + '\n');
} finally { unlock(); await pool.end(); }

/**
 * X2 timed runs (under measure.lock): plaintext vs product (native_verify_main, read-only) vs B3 prototype
 * (research_count_x2) vs R1 server-side exact tags, on the 5 reference queries + equality-leaf cases.
 * Warmup 2, 7 crossed runs (rotating path order), medians; every run asserted against plaintext.
 * Then (untimed) leakage counts per leaf and B3 tamper rejection through the DB path.
 * Usage: rtk proxy npx tsx bench/research-count/x2-measure.ts [count|find|leak|all]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';
import { assertDisposable } from '../../test/disposable.js';
import { cases, combos, condition, plainWhere, type Case, type Node } from '../verify-native/r8-cases.js';
import { SCHEMA, OUT, fields, scopeA, lock, unlock, compile, candidateSql, leafFields, tokenWhere, b3Run, b3Stats, trapdoor, normExact, normSub, measure, summary, json } from './x2-lib.js';
import type { CompiledSearch } from '../../src/core/search-predicate.js';
import { SCHEMA_CH, chRun } from './x2-cbch.js';

const phase = process.argv[2] ?? 'all';
const ro = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 4, options: '-c default_transaction_read_only=on -c statement_timeout=600000' });
await assertDisposable(ro); assert.equal(Number((await ro.query('show port')).rows[0].port), 56439);

// ---- product (same construction as r8-measure.ts) ----
const opens = { count: 0 };
const sealed = createSealed({ sealer: () => { const s = createSealer({ key: new Uint8Array(32).fill(93) }); const o = s.open.bind(s); s.open = async (...a: Parameters<typeof s.open>) => { opens.count++; return o(...a); }; return s; } });
const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
const table = pgSchema('native_verify_main').table('customers', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }), address: sealed.text('address', { search }),
  memo: sealed.text('memo', { search }), email: sealed.text('email', { search }), company: sealed.text('company', { search }) });
const reg = sealed.register(table, { row: 'id', scope: 'scopeId' });
const db = drizzle(ro);
const columns = Object.fromEntries(fields.map(f => [f, true])) as any;
function match(n: Node, m: any): any { return 'all' in n ? m.and(...n.all.map(x => match(x, m))) : 'any' in n ? m.or(...n.any.map(x => match(x, m))) : m[n.field][n.op](n.value); }
const productCount = (c: Case) => sealed.count(db, reg, { scope: scopeA, match: (m: any) => match(c.node, m) } as any);
const productFind = (c: Case) => sealed.findMany(db, reg, { scope: scopeA, match: (m: any) => match(c.node, m), columns } as any).then((r: any) => r.items);
// ---- plaintext ----
const plainArgs = (c: Case) => { const params: unknown[] = [scopeA]; return { where: plainWhere(c.node, params), params }; };
const plainCount = async (c: Case) => { const { where, params } = plainArgs(c); return Number((await ro.query(`select count(*) n from bench_realistic_100k.customers where scope_id=$1 and ${where}`, params)).rows[0].n); };
const plainFind = async (c: Case) => { const { where, params } = plainArgs(c); return (await ro.query(`select id,${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers where scope_id=$1 and ${where} order by id`, params)).rows; };
// ---- R1 (server-side exact tags on idx_r1) ----
const R1_EXACT = ['company', 'phone'], R1_SUB = ['name', 'phone'];
async function r1Where(c: CompiledSearch, params: unknown[]): Promise<string | null> {
  if (c.op !== 'leaf') { const parts = await Promise.all(c.children.map(x => r1Where(x, params))); return parts.includes(null) ? null : `(${parts.join(c.op === 'all' ? ' and ' : ' or ')})`; }
  const { node } = c.leaf; const f = node.field; const v = node.value as string;
  const tok = tokenWhere(c, params, 'c');
  if (node.op === 'eq' && R1_EXACT.includes(f)) { params.push(Buffer.from(await trapdoor('exact', f, normExact(v)))); return `(${tok} and sha256($${params.length}::bytea||uuid_send(c.row_id)||c.${f}_nonce)=c.${f}_tag)`; }
  if (node.op === 'contains' && R1_SUB.includes(f)) { params.push(Buffer.from(await trapdoor('sub', f, normSub(v)))); return `(${tok} and sha256($${params.length}::bytea||uuid_send(c.row_id)||c.${f}_snonce)=any(c.${f}_subtags))`; }
  return null;
}
async function r1Count(c: Case) {
  const params: unknown[] = [scopeA]; const w = await r1Where(await compile(c.node), params);
  if (!w) return null;
  return { sql: `select count(*) n from ${SCHEMA}.idx_r1 as c where c.scope_id=$1 and ${w}`, params };
}
const r1Run = async (c: Case) => { const q = (await r1Count(c))!; return Number((await ro.query(q.sql, q.params)).rows[0].n); };

// ---- timing loop ----
const idHash = (xs: any[]) => createHash('sha256').update(xs.map(x => x.id).sort().join('\n')).digest('hex');
function same(mode: string, a: any, b: any, label: string) {
  if (mode === 'count') { assert.equal(b, a, label); return; }
  assert.equal(b.length, a.length, label); assert.equal(idHash(b), idHash(a), label);
  for (let i = 0; i < a.length; i++) { assert.equal(b[i].id, a[i].id, label); for (const f of fields) assert.equal(b[i][f], a[i][f], `${label} ${f}`); }
}
type Path = { name: string; run: () => Promise<any>; stats?: () => any };
async function bench(c: Case, mode: 'count' | 'find', paths: Path[]) {
  const truth = mode === 'count' ? await plainCount(c) : await plainFind(c);
  const first: any = {};
  for (const p of paths) { opens.count = 0; Object.assign(b3Stats, { fields: 0, openMs: 0, verifyMs: 0 }); const m = await measure(p.run); same(mode, truth, m.value, `${c.name}/${p.name}/first`); first[p.name] = { ...m, value: undefined, opens: opens.count, b3: { ...b3Stats } }; }
  for (let w = 0; w < 2; w++) for (const p of paths) same(mode, truth, await p.run(), `${c.name}/${p.name}/warm${w}`);
  const runs: Record<string, any[]> = Object.fromEntries(paths.map(p => [p.name, []]));
  for (let i = 0; i < 7; i++) {
    const order = paths.map((_, k) => paths[(k + i) % paths.length]);
    for (const p of order) {
      opens.count = 0; Object.assign(b3Stats, { fields: 0, openMs: 0, verifyMs: 0 });
      const m = await measure(p.run); same(mode, truth, m.value, `${c.name}/${p.name}/run${i}`);
      runs[p.name].push({ ...m, value: undefined, opens: opens.count, b3Fields: b3Stats.fields, b3OpenMs: b3Stats.openMs, b3VerifyMs: b3Stats.verifyMs });
    }
  }
  const out = { case: c.name, condition: condition(c.node), mode, matches: mode === 'count' ? truth : truth.length, first,
    summary: Object.fromEntries(paths.map(p => [p.name, summary(runs[p.name])])), runs };
  console.log(JSON.stringify({ case: c.name, mode, matches: out.matches, ...Object.fromEntries(paths.map(p => [p.name, out.summary[p.name].totalMs])) }));
  return out;
}

const byName = (n: string) => cases.find(c => c.name === n)!;
const leafCases = ['exact_common', 'exact_mid', 'exact_one', 'exact_zero', 'sub_name_suffix'].map(byName);
const res: any = { startedAt: new Date().toISOString(), git: readFileSync('.git/HEAD', 'utf8').trim() };
try {
  // candidate SQL equivalence with the product (recorded r8 SQL)
  const r8 = JSON.parse(readFileSync('bench/results/2026-09-28-r8-remeasure/results.json', 'utf8'));
  for (const c of combos) {
    const ev = r8.rows.find((x: any) => x.environment === '10만 단독' && x.mode === 'count' && x.case === c.name).runs.product[0].sqlEvents[0];
    const cc = await compile(c.node); const { sql, params } = candidateSql('native_verify_main', cc, [...leafFields(cc)]);
    assert.equal(sql, ev.sql, `${c.name} SQL shape`);
    assert.deepEqual(params.map(p => Array.isArray(p) ? `{${p.join(',')}}` : p), ev.params, `${c.name} tokens`);
  }
  res.sqlShapeCheck = 'candidate SQL text and token params identical to r8 product SQL for the 5 queries (schema name substituted at run time)';

  if (phase === 'count' || phase === 'all') {
    await lock('count'); try {
      res.count = [];
      for (const c of combos) {
        const paths: Path[] = [{ name: 'plain', run: () => plainCount(c) }, { name: 'product', run: () => productCount(c) }, { name: 'cbch', run: () => chRun(ro, c.node, 'count') }, { name: 'b3', run: () => b3Run(ro, c.node, 'count') }];
        if (await r1Count(c)) paths.push({ name: 'r1', run: () => r1Run(c) });
        res.count.push(await bench(c, 'count', paths));
        writeFileSync(`${OUT}/x2-measure-count.json`, json(res));
      }
      for (const c of leafCases) {
        const paths: Path[] = [{ name: 'plain', run: () => plainCount(c) }, { name: 'product', run: () => productCount(c) }, { name: 'cbch', run: () => chRun(ro, c.node, 'count') }, { name: 'b3', run: () => b3Run(ro, c.node, 'count') }];
        if (await r1Count(c)) paths.push({ name: 'r1', run: () => r1Run(c) });
        res.count.push(await bench(c, 'count', paths));
        writeFileSync(`${OUT}/x2-measure-count.json`, json(res));
      }
    } finally { unlock(); }
  }
  if (phase === 'find' || phase === 'all') {
    await lock('find'); try {
      res.find = [];
      for (const c of combos) {
        res.find.push(await bench(c, 'find', [{ name: 'plain', run: () => plainFind(c) }, { name: 'product', run: () => productFind(c) }, { name: 'cbch', run: () => chRun(ro, c.node, 'find') }, { name: 'b3', run: () => b3Run(ro, c.node, 'find') }]));
        writeFileSync(`${OUT}/x2-measure-find.json`, json({ startedAt: res.startedAt, find: res.find }));
      }
    } finally { unlock(); }
  }
  if (phase === 'leak' || phase === 'all') {
    // Untimed. Per leaf: token candidates in the whole scope vs true matches; per query: candidates vs matches.
    const leak: any[] = [];
    const cand = async (cc: CompiledSearch) => { const params: unknown[] = [scopeA]; const w = tokenWhere(cc, params, 'c'); return Number((await ro.query(`select count(*) n from ${SCHEMA}.customers_seal_index c where c.scope_id=$1 and ${w}`, params)).rows[0].n); };
    const leavesOf = (n: Node): Node[] => 'all' in n ? n.all.flatMap(leavesOf) : 'any' in n ? n.any.flatMap(leavesOf) : [n];
    for (const c of [...combos, ...leafCases]) {
      const cc = await compile(c.node); const q = { case: c.name, condition: condition(c.node), candidates: await cand(cc), matches: await plainCount(c), r1: null as any, leaves: [] as any[] };
      const r1 = await r1Count(c); if (r1) q.r1 = Number((await ro.query(r1.sql, r1.params)).rows[0].n);
      if (q.r1 !== null) assert.equal(q.r1, q.matches, `${c.name} R1 exact`);
      for (const l of leavesOf(c.node)) {
        const lc: Case = { name: 'leaf', node: l }; const lcc = await compile(l); const r1l = await r1Count(lc);
        const x = { leaf: condition(l), candidates: await cand(lcc), matches: await plainCount(lc), r1Covered: !!r1l, r1Exact: r1l ? Number((await ro.query(r1l.sql, r1l.params)).rows[0].n) : null };
        if (x.r1Exact !== null) assert.equal(x.r1Exact, x.matches, `${c.name} leaf ${x.leaf} R1 exact`);
        q.leaves.push({ ...x, newlyRevealedIfCovered: x.r1Covered ? x.candidates - x.matches : 0 });
      }
      leak.push(q); console.log(JSON.stringify(q));
    }
    res.leak = leak;
    // B3 tamper rejection through the DB path (rolled-back transactions on the research table).
    const rw = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1 });
    await assertDisposable(rw); assert.equal(Number((await rw.query('show port')).rows[0].port), 56439);
    const and2 = combos.find(c => c.name === 'and2')!;
    const [A, B] = (await ro.query(`select id::text from bench_realistic_100k.customers where scope_id=$1 and company_norm=$2 and memo_norm like '%서비스%' and octet_length(memo_plain) >= 16 order by id limit 2`, [scopeA, normExact('서울서비스 담당')])).rows.map(r => r.id);
    res.tamper = [];
    for (const fmt of [{ name: 'cbch', schema: SCHEMA_CH, run: chRun }, { name: 'b3 (rejected by review; reference only)', schema: SCHEMA, run: b3Run }]) {
      const T = `${fmt.schema}.customers`;
      const tampers: [string, string][] = [
        ['control (no change)', `select 1`],
        ['header byte changed', `update ${T} set memo_ct = set_byte(memo_ct, 0, 3) where id='${A}'`],
        ['bit flip in ciphertext block', `update ${T} set memo_ct = set_byte(memo_ct, 20, get_byte(memo_ct, 20) # 1) where id='${A}'`],
        ['bit flip in IV', `update ${T} set memo_ct = set_byte(memo_ct, 3, get_byte(memo_ct, 3) # 128) where id='${A}'`],
        ['bit flip in tag', `update ${T} set memo_ct = set_byte(memo_ct, octet_length(memo_ct)-1, get_byte(memo_ct, octet_length(memo_ct)-1) # 1) where id='${A}'`],
        ['row swap (memo A<->B)', `update ${T} t set memo_ct = s.memo_ct from ${T} s where (t.id='${A}' and s.id='${B}') or (t.id='${B}' and s.id='${A}')`],
        ['field swap (company_ct := memo_ct, same row)', `update ${T} set company_ct = memo_ct where id='${A}'`],
        ['truncate: drop last 16 bytes', `update ${T} set memo_ct = substring(memo_ct from 1 for octet_length(memo_ct)-16) where id='${A}'`],
        ['truncate: drop first ciphertext block', `update ${T} set memo_ct = substring(memo_ct from 1 for 17) || substring(memo_ct from 34) where id='${A}'`],
        ['truncate: drop 1 byte (unaligned)', `update ${T} set memo_ct = substring(memo_ct from 1 for octet_length(memo_ct)-1) where id='${A}'`],
        ['omission: parent row moved to another scope (not detectable)', `update ${T} set scope_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id='${A}'`],
      ];
      for (const [name, sql] of tampers) {
        const cl = await rw.connect();
        try {
          await cl.query('begin'); const upd = await cl.query(sql);
          let outcome: string;
          try { outcome = `count=${await fmt.run(cl, and2.node, 'count')}`; } catch (e: any) { outcome = `rejected: ${e.message}`; }
          res.tamper.push({ format: fmt.name, name, rowsChanged: upd.rowCount, outcome }); console.log(fmt.name, name, '->', outcome);
        } finally { await cl.query('rollback'); cl.release(); }
      }
    }
    await rw.end();
    for (const t of res.tamper) {
      if (t.name.startsWith('control')) assert.equal(t.outcome, 'count=21176');
      else if (t.name.startsWith('omission')) assert.equal(t.outcome, 'count=21175');
      else assert.match(t.outcome, /AUTHENTICATION_FAILED/, `${t.format} ${t.name}`);
    }
    writeFileSync(`${OUT}/x2-leak-tamper.json`, json({ startedAt: res.startedAt, leak: res.leak, tamper: res.tamper }));
  }
  res.finishedAt = new Date().toISOString();
} finally { await ro.end(); }

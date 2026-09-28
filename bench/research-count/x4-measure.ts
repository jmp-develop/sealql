/**
 * X4 timed runs (under measure.lock): plaintext vs product (native_verify_main via dist, read-only) vs X4 combined prototype
 * (research_count_x4) on the 5 reference queries. Warmup 2 + 7 rotated runs, medians; first run recorded; every run asserted.
 * Phases: count | find (limit 20, 200, all) | anatomy (floor pieces) | tamper (DB-path properties, rolled back)
 * Usage: rtk proxy npx tsx bench/research-count/x4-measure.ts <count|find|anatomy|tamper>
 */
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';
import { assertDisposable } from '../../test/disposable.js';
import { combos, condition, plainWhere, type Case } from '../verify-native/r8-cases.js';
import { OUT, measure, json, median } from './x2-lib.js';
import { SCHEMA4, fields, scopeA, lock, unlock, x4Count, x4Find, makePlan, planSql, toRow, decide, prefixes, capture, check, mk, cbc, now, type Timing } from './x4-lib.js';
import { tagDiff, cbcRawDecrypt, openBatch } from './x4-crypto.js';

const { Pool, Query } = pg;
const phase = process.argv[2];
assert(['count', 'find', 'anatomy', 'tamper'].includes(phase));
const ro = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 4, options: '-c default_transaction_read_only=on -c statement_timeout=600000' });
await assertDisposable(ro); assert.equal(Number((await ro.query('show port')).rows[0].port), 56439);
assert.equal((await ro.query('show default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');

// ---- product (same construction as r8-measure / x2-measure) ----
const opens = { count: 0 };
const sealed = createSealed({ sealer: () => { const s = createSealer({ key: new Uint8Array(32).fill(93) }); const o = s.open.bind(s); s.open = async (...a: Parameters<typeof s.open>) => { opens.count++; return o(...a); }; return s; } });
const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
const table = pgSchema('native_verify_main').table('customers', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }), address: sealed.text('address', { search }),
  memo: sealed.text('memo', { search }), email: sealed.text('email', { search }), company: sealed.text('company', { search }) });
const reg = sealed.register(table, { row: 'id', scope: 'scopeId' });
const db = drizzle(ro);
const columns = Object.fromEntries(fields.map(f => [f, true])) as any;
function match(n: any, m: any): any { return 'all' in n ? m.and(...n.all.map((x: any) => match(x, m))) : 'any' in n ? m.or(...n.any.map((x: any) => match(x, m))) : m[n.field][n.op](n.value); }
const productCount = (c: Case) => sealed.count(db, reg, { scope: scopeA, match: (m: any) => match(c.node, m) } as any);
const productFind = (c: Case, limit?: number) => sealed.findMany(db, reg, { scope: scopeA, match: (m: any) => match(c.node, m), columns, ...(limit === undefined ? {} : { limit }) } as any).then((r: any) => r.items);
// ---- plaintext ----
const plainArgs = (c: Case) => { const params: unknown[] = [scopeA]; return { where: plainWhere(c.node, params), params }; };
const plainCount = async (c: Case) => { const { where, params } = plainArgs(c); return Number((await ro.query(`select count(*) n from bench_realistic_100k.customers where scope_id=$1 and ${where}`, params)).rows[0].n); };
const plainFind = async (c: Case, limit?: number) => { const { where, params } = plainArgs(c);
  return (await ro.query(`select id,${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers where scope_id=$1 and ${where} order by id${limit === undefined ? '' : ` limit ${limit}`}`, params)).rows; };

const idHash = (xs: any[]) => createHash('sha256').update(xs.map(x => x.id).join('\n')).digest('hex');
function same(mode: string, truth: any, got: any, label: string) {
  if (mode === 'count') { assert.equal(got, truth, label); return; }
  assert.equal(got.length, truth.length, label); assert.equal(idHash(got), idHash(truth), label);
  for (let i = 0; i < truth.length; i++) { assert.equal(got[i].id, truth[i].id, label); for (const f of fields) assert.equal(got[i][f], truth[i][f], `${label} ${f}`); }
}
type Path = { name: string; run: () => Promise<any> };
const KEYS = ['totalMs', 'preMs', 'dbMs', 'betweenSqlMs', 'postMs', 'sqlCalls', 'candidateRows', 'opens', 'macs', 'decrypts', 'cbcCalls', 'rounds', 'macMs', 'cbcMs', 'decodeMs', 'verifyMs', 'overlapDecrypts'];
const summary = (xs: any[]) => Object.fromEntries(KEYS.filter(k => typeof xs[0][k] === 'number').map(k => [k, +median(xs.map(x => x[k])).toFixed(3)]));
async function timedProduct(fn: () => Promise<any>) { opens.count = 0; const m = await measure(fn); return { ...m, opens: opens.count }; }
async function timedX4(fn: () => Promise<Timing>) { const m = await fn(); return { ...m, opens: m.decrypts }; }
async function bench(label: string, mode: 'count' | 'find', truth: any, paths: Path[]) {
  const first: any = {}; const runs: Record<string, any[]> = Object.fromEntries(paths.map(p => [p.name, []]));
  for (let i = 0; i < 10; i++) { // first + 2 warm-up + 7 rotated
    const order = paths.map((_, k) => paths[(k + i) % paths.length]);
    for (const p of order) {
      const m = await p.run(); same(mode, truth, m.value, `${label}/${p.name}/${i}`);
      const { value, ...rest } = m; if (i === 0) first[p.name] = rest; else if (i >= 3) runs[p.name].push(rest);
    }
  }
  const s = Object.fromEntries(paths.map(p => [p.name, summary(runs[p.name])]));
  console.log(JSON.stringify({ label, ...Object.fromEntries(paths.map(p => [p.name, `${s[p.name].totalMs} (db ${s[p.name].dbMs}, post ${s[p.name].postMs}, sql ${s[p.name].sqlCalls})`])) }));
  return { label, summary: s, first, runs };
}
const res: any = { startedAt: new Date().toISOString(), schema: SCHEMA4, method: 'first + 2 warm-up + 7 rotated, medians of the 7' };
try {
  if (phase === 'count') {
    // one untimed self-check: A3 fast verify == src verifySearch on every evaluated leaf
    check.enabled = true; for (const c of combos) assert.equal((await x4Count(ro, c.node, false)).value, await plainCount(c)); res.a3Check = { compared: check.compared, mismatches: 0 }; check.enabled = false;
    await lock('count'); try {
      res.rows = [];
      for (const c of combos) {
        const truth = await plainCount(c);
        res.rows.push({ case: c.name, condition: condition(c.node), matches: truth, ...await bench(c.name, 'count', truth, [
          { name: 'plain', run: () => measure(() => plainCount(c)) },
          { name: 'product', run: () => timedProduct(() => productCount(c)) },
          { name: 'x4', run: () => timedX4(() => x4Count(ro, c.node, false)) },
          { name: 'x4stream', run: () => timedX4(() => x4Count(ro, c.node, true)) },
        ]) });
        writeFileSync(`${OUT}/x4-count.json`, json(res));
      }
    } finally { unlock(); }
  }
  if (phase === 'find') {
    await lock('find'); try {
      res.rows = [];
      for (const limit of [20, 200, undefined]) for (const c of combos) {
        const truth = await plainFind(c, limit);
        const paths: Path[] = [
          { name: 'plain', run: () => measure(() => plainFind(c, limit)) },
          { name: 'product', run: () => timedProduct(() => productFind(c, limit)) },
          { name: 'x4', run: () => timedX4(() => x4Find(ro, c.node, limit, false)) },
        ];
        if (limit === undefined) paths.push({ name: 'x4stream', run: () => timedX4(() => x4Find(ro, c.node, undefined, true)) });
        res.rows.push({ case: c.name, mode: limit === undefined ? 'findMany all' : `findMany ${limit}`, condition: condition(c.node), matches: truth.length,
          ...await bench(`${c.name}/${limit ?? 'all'}`, 'find', truth, paths) });
        writeFileSync(`${OUT}/x4-find.json`, json(res));
      }
    } finally { unlock(); }
  }
  if (phase === 'anatomy') {
    await lock('anatomy'); try {
      res.rows = [];
      const time = async (fn: () => Promise<unknown> | unknown) => { const t: number[] = []; for (let i = 0; i < 9; i++) { const s = now(); await fn(); if (i >= 2) t.push(now() - s); } return +median(t).toFixed(3); };
      for (const c of combos) {
        const p = await makePlan(c.node); const { text, params } = planSql(p, { cols: p.condFields, orderBy: false });
        const dbStreamMs = await time(async () => { const cl = await ro.connect(); try { await new Promise<void>((ok, bad) => { const q = new Query({ text, values: params } as any); q.on('row', () => {}); q.on('end', () => ok()); q.on('error', bad); cl.query(q as any); }); } finally { cl.release(); } });
        const dbQueryMs = await time(() => ro.query({ text, values: params } as any));
        const raw = (await ro.query({ text, values: params } as any)).rows;
        const toRowsMs = await time(() => { const seen = new Set<string>(); for (const r of raw) toRow(r, p, p.condFields, seen, null); });
        // minimal certificate jobs = what decide() opens
        const pre = prefixes(scopeA); const rows = raw.map((r: any) => toRow(r, p, p.condFields, new Set(), null));
        capture.jobs = []; const m = await decide(p, rows, pre); const jobs = capture.jobs; capture.jobs = null;
        assert.equal(m.reduce((a, b) => a + b, 0), await plainCount(c));
        const macOnlyMs = await time(() => { let d = 0; for (const j of jobs) { const e = j.env, to = e.length - 32; d |= tagDiff(mk, j.pre, j.rowId, e, 1, to, to); } assert.equal(d, 0); });
        const total = jobs.reduce((a, j) => a + j.env.length - 33, 0);
        const cbcOnlyMs = await time(async () => { const cb = new Uint8Array(total + 32); let o = 0; for (const j of jobs) { cb.set(j.env.subarray(1, j.env.length - 32), o); o += j.env.length - 33; } await cbcRawDecrypt(cbc, cb, total); });
        const openBatchMs = await time(() => openBatch(cbc, mk, 5, jobs));
        const decideMs = await time(() => decide(p, raw.map((r: any) => toRow(r, p, p.condFields, new Set(), null)), pre));
        const x = { case: c.name, candidates: raw.length, certificateFields: jobs.length, dbStreamMs, dbQueryMs, toRowsMs, macOnlyMs, cbcOnlyMs, openBatchMs, decideIncludingToRowMs: decideMs,
          usPerMac: +(1000 * macOnlyMs / Math.max(jobs.length, 1)).toFixed(3), usPerCbcField: +(1000 * cbcOnlyMs / Math.max(jobs.length, 1)).toFixed(3),
          floorSerialMs: +(Math.min(dbStreamMs, dbQueryMs + toRowsMs) + macOnlyMs + cbcOnlyMs).toFixed(3), floorOverlapMs: +Math.max(dbStreamMs, macOnlyMs + cbcOnlyMs).toFixed(3) };
        res.rows.push(x); console.log(JSON.stringify(x));
      }
      writeFileSync(`${OUT}/x4-anatomy.json`, json(res));
    } finally { unlock(); }
  }
  if (phase === 'tamper') {
    await lock('tamper');
    // DB path: modify research rows inside a transaction, run the X4 count/find path on that connection, ROLLBACK.
    const rw = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1 });
    await assertDisposable(rw); assert.equal(Number((await rw.query('show port')).rows[0].port), 56439);
    const and6 = combos.find(c => c.name === 'and6')!, or2 = combos.find(c => c.name === 'or2')!;
    const T = `${SCHEMA4}.customers`;
    const cand = (await ro.query(`select id::text from bench_realistic_100k.customers where scope_id=$1 and ${plainArgs(and6).where} order by id`, plainArgs(and6).params)).rows.map(r => r.id);
    const truth6 = cand.length; assert.equal(truth6, 624);
    const kinds: [string, (f: string, id: string, id2: string) => string][] = [
      ['bit flip at random byte', (f, id) => `update ${T} set ${f}_ct = set_byte(${f}_ct, g.p, get_byte(${f}_ct, g.p) # (1 << g.b)) from (select floor(random()*octet_length(${f}_ct))::int p, floor(random()*8)::int b from ${T} where id='${id}') g where id='${id}'`],
      ['header byte', (f, id) => `update ${T} set ${f}_ct = set_byte(${f}_ct, 0, 6) where id='${id}'`],
      ['truncate 16 B', (f, id) => `update ${T} set ${f}_ct = substring(${f}_ct from 1 for octet_length(${f}_ct)-16) where id='${id}'`],
      ['truncate 1 B', (f, id) => `update ${T} set ${f}_ct = substring(${f}_ct from 1 for octet_length(${f}_ct)-1) where id='${id}'`],
      ['drop first C block', (f, id) => `update ${T} set ${f}_ct = substring(${f}_ct from 1 for 17) || substring(${f}_ct from 34) where id='${id}'`],
      ['swap IV and first C block', (f, id) => `update ${T} set ${f}_ct = substring(${f}_ct from 1 for 1) || substring(${f}_ct from 18 for 16) || substring(${f}_ct from 2 for 16) || substring(${f}_ct from 34) where id='${id}'`],
      ['row swap same field', (f, id, id2) => `update ${T} t set ${f}_ct = s.${f}_ct from ${T} s where (t.id='${id}' and s.id='${id2}') or (t.id='${id2}' and s.id='${id}')`],
      ['field swap same row', (f, id) => `update ${T} set ${f}_ct = ${f === 'memo' ? 'name' : 'memo'}_ct where id='${id}'`],
      ['tag from other row', (f, id, id2) => `update ${T} t set ${f}_ct = substring(t.${f}_ct from 1 for octet_length(t.${f}_ct)-32) || substring(s.${f}_ct from octet_length(s.${f}_ct)-31) from ${T} s where t.id='${id}' and s.id='${id2}'`],
    ];
    const out: any[] = []; const agg: Record<string, { tried: number; rejected: number }> = {};
    const N = Number(process.argv[3] ?? 40);
    for (const [kind, sqlOf] of kinds) for (let k = 0; k < N; k++) {
      const f = fields[randomInt(6)], id = cand[randomInt(cand.length)]; let id2 = cand[randomInt(cand.length)]; while (id2 === id) id2 = cand[randomInt(cand.length)];
      const path = k % 2 ? 'find' : 'count';
      const cl = await rw.connect(); let outcome = '';
      try {
        await cl.query('begin'); const u = await cl.query(sqlOf(f, id, id2)); assert(u.rowCount! >= 1);
        const shim = { connect: async () => ({ query: cl.query.bind(cl), release: () => {} }) } as any;
        try { const r = path === 'count' ? await x4Count(shim, and6.node, false) : await x4Find(shim, and6.node, undefined, false); outcome = `accepted ${path === 'count' ? r.value : r.value.length}`; }
        catch (e: any) { outcome = `rejected ${e.message}`; }
      } finally { await cl.query('rollback'); cl.release(); }
      const a = (agg[kind] ??= { tried: 0, rejected: 0 }); a.tried++; if (outcome.startsWith('rejected AUTHENTICATION_FAILED')) a.rejected++;
      out.push({ kind, field: f, path, outcome });
    }
    // controls + omission (not detectable, same as product) + OR path (flags): tamper memo of a row decided by company leaf -> not opened
    const ctl = await x4Count(ro, and6.node, false); assert.equal(ctl.value, truth6);
    const cl = await rw.connect(); const extra: any = {};
    try {
      await cl.query('begin'); await cl.query(`update ${T} set scope_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id='${cand[0]}'`);
      const shim = { connect: async () => ({ query: cl.query.bind(cl), release: () => {} }) } as any;
      extra.omission = `count=${(await x4Count(shim, and6.node, false)).value} (truth ${truth6}; omission is not detectable, same as product)`;
      await cl.query('rollback'); await cl.query('begin');
      const orRow = (await ro.query(`select id::text from bench_realistic_100k.customers where scope_id=$1 and company_norm=$2 limit 1`, [scopeA, '서울서비스담당'])).rows[0]?.id
        ?? (await ro.query(`select id::text from bench_realistic_100k.customers where scope_id=$1 and company_plain='서울서비스 담당' limit 1`, [scopeA])).rows[0].id;
      await cl.query(`update ${T} set memo_ct = set_byte(memo_ct, 20, get_byte(memo_ct, 20) # 1) where id='${orRow}'`);
      try { extra.orUnopenedFieldTamper = `count=${(await x4Count(shim, or2.node, false)).value} (A1: memo of a row already true by company is not opened -> not detected in this call)`; }
      catch (e: any) { extra.orUnopenedFieldTamper = `rejected ${e.message}`; }
      await cl.query(`update ${T} set company_ct = set_byte(company_ct, 20, get_byte(company_ct, 20) # 1) where id='${orRow}'`);
      try { extra.orDecidingFieldTamper = `accepted ${(await x4Count(shim, or2.node, false)).value}`; } catch (e: any) { extra.orDecidingFieldTamper = `rejected ${e.message}`; }
    } finally { await cl.query('rollback'); cl.release(); }
    await rw.end();
    for (const [k, v] of Object.entries(agg)) assert.equal(v.rejected, v.tried, k);
    assert.match(extra.orDecidingFieldTamper, /AUTHENTICATION_FAILED/);
    res.tamper = { query: 'and6 (624 rows, all 6 fields opened), count and findMany-all paths alternating', perKind: agg, extra, cases: out };
    writeFileSync(`${OUT}/x4-tamper.json`, json(res)); console.log(JSON.stringify({ agg, extra }, null, 1));
  }
  res.finishedAt = new Date().toISOString();
} finally { unlock(); await ro.end(); }

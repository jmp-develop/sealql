/** R8 comparison with the three V3 JOIN cases. Run after the main matrix. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';
import { assertDisposable } from '../../test/disposable.js';
import { fields } from './r8-cases.js';

type Predicate = { field: 'memo' | 'company'; op: 'eq' | 'contains'; term: string };
const cases: { name: string; ticket: Predicate; customer: Predicate }[] = [
  { name: 'join_rare', ticket: { field: 'memo', op: 'contains', term: '푸른달' }, customer: { field: 'memo', op: 'contains', term: '푸른달' } },
  { name: 'join_broad', ticket: { field: 'memo', op: 'contains', term: '서비스' }, customer: { field: 'company', op: 'eq', term: '서울서비스 담당' } },
  { name: 'join_zero', ticket: { field: 'memo', op: 'contains', term: '없는표식' }, customer: { field: 'company', op: 'eq', term: '서울서비스 담당' } },
];
const scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const out = 'bench/results/2026-09-28-r8-remeasure';
const extraTables = ['native_verify_main.tickets', 'native_verify_main.tickets_seal_index'];
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 3,
  options: '-c statement_timeout=300000' });
const db = drizzle(pool);
let openStats: { count: number; intervals: { start: number; end: number }[] } | null = null;
const sealer = createSealer({ key: new Uint8Array(32).fill(93) });
const originalOpen = sealer.open.bind(sealer);
sealer.open = async (...args: Parameters<typeof sealer.open>) => {
  const start = performance.now();
  try { return await originalOpen(...args); }
  finally { if (openStats) { openStats.count++; openStats.intervals.push({ start, end: performance.now() }); } }
};
const sealed = createSealed({ sealer });
const schema = pgSchema('native_verify_main');
const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
const customers = schema.table('customers', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }),
  address: sealed.text('address', { search }), memo: sealed.text('memo', { search }),
  email: sealed.text('email', { search }), company: sealed.text('company', { search }),
});
const customersSeal = sealed.register(customers, { row: 'id', scope: 'scopeId' });
const tickets = schema.table('tickets', {
  id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(), customerId: uuid('customer_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }),
  address: sealed.text('address', { search }), memo: sealed.text('memo', { search }),
  email: sealed.text('email', { search }), company: sealed.text('company', { search }),
});
const ticketsSeal = sealed.register(tickets, { row: 'id', scope: 'scopeId' });
type Event = { start: number; end: number; rows: number; sql: string; params: unknown[] };
let events: Event[] | null = null;
const originalQuery = Client.prototype.query;
(Client.prototype as any).query = function (...args: any[]) {
  const start = performance.now(), sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
  const params = Array.isArray(args[1]) ? args[1] : args[0]?.values ?? [];
  let recorded = false;
  const record = (result: any) => { if (!recorded) { recorded = true; events?.push({ start, end: performance.now(), rows: result?.rows?.length ?? 0, sql, params }); } return result; };
  const i = args.findIndex(x => typeof x === 'function');
  if (i >= 0) { const cb = args[i]; args[i] = (err: any, result: any) => { record(result); cb(err, result); }; }
  const result = (originalQuery as any).apply(this, args);
  return i < 0 && result?.then ? result.then(record, (e: any) => { record(null); throw e; }) : result;
};
function norm(v: string) { return v.normalize('NFC').replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, ''); }
function pred(alias: string, p: Predicate, ph: string) {
  return p.op === 'eq' ? `${alias}.${p.field}_norm=${ph}` : `${alias}.${p.field}_norm like '%'||${ph}||'%'`;
}
function plain(c: typeof cases[number]) {
  const sql = `select t.id,${fields.map(f => `t.${f}_plain t_${f},c.${f}_plain c_${f}`).join(',')}
    from bench_realistic_100k.tickets t join bench_realistic_100k.customers c on c.scope_id=t.scope_id and c.id=t.customer_id
    where t.scope_id=$1 and ${pred('t', c.ticket, '$2')} and ${pred('c', c.customer, '$3')} order by t.id limit 20`;
  return pool.query(sql, [scope, norm(c.ticket.term), norm(c.customer.term)]).then(r => r.rows);
}
function product(c: typeof cases[number]) {
  return sealed.search(db, { scope,
    match: { t: [ticketsSeal, (m: any) => m[c.ticket.field][c.ticket.op](c.ticket.term)],
      c: [customersSeal, (m: any) => m[c.customer.field][c.customer.op](c.customer.term)] },
    limit: 20, query: ({ where, after, orderBy, flags, limit }: any) => db.select({ t: tickets, c: customers, ...flags }).from(tickets)
      .innerJoin(customers, eq(tickets.customerId, customers.id)).where(and(where, after)).orderBy(...orderBy).limit(limit),
  } as any).then((r: any) => r.items);
}
function flat(row: any) { return { id: row.t.id, ...Object.fromEntries(fields.flatMap(f => [[`t_${f}`, row.t[f]], [`c_${f}`, row.c[f]]])) }; }
function same(actual: any[], expected: any[], label: string) {
  assert.equal(actual.length, expected.length, `${label}/count`);
  for (let i = 0; i < actual.length; i++) assert.deepEqual(flat(actual[i]), expected[i], `${label}/${i}`);
}
function openWall(xs: { start: number; end: number }[]) {
  let start = 0, end = 0, total = 0;
  for (const x of [...xs].sort((a, b) => a.start - b.start)) {
    if (x.start > end) { total += end - start; start = x.start; end = x.end; } else end = Math.max(end, x.end);
  }
  return total + end - start;
}
async function measure(fn: () => Promise<any[]>) {
  const ev: Event[] = [], op = { count: 0, intervals: [] as { start: number; end: number }[] };
  events = ev; openStats = op; const start = performance.now();
  let value: any[];
  try { value = await fn(); } finally { events = null; openStats = null; }
  const end = performance.now(), dbMs = ev.reduce((s, x) => s + x.end - x.start, 0);
  const preMs = ev.length ? ev[0].start - start : end - start;
  const postMs = ev.length ? end - ev.at(-1)!.end : 0;
  return { value: value!, totalMs: end - start, preMs, dbMs, betweenSqlMs: end - start - preMs - dbMs - postMs,
    postMs, sqlCalls: ev.length, candidateRows: ev.reduce((s, x) => s + x.rows, 0),
    openCount: op.count, openWallMs: openWall(op.intervals), sqlEvents: ev };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const keys = ['totalMs', 'preMs', 'dbMs', 'betweenSqlMs', 'postMs', 'sqlCalls', 'candidateRows', 'openCount', 'openWallMs'] as const;
function summary(xs: any[]) { return Object.fromEntries(keys.map(k => [k, median(xs.map(x => x[k]))])); }
function compact(m: any) { const { value, ...rest } = m; return rest; }
const old = JSON.parse(await readFile('bench/results/2026-09-27-native-verification/v3/join.json', 'utf8'));
let state: any = { before: [], changed: [], ginBefore: [], ginAfter: [] };
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  for (const table of extraTables) {
    const options = (await pool.query('select reloptions from pg_class where oid=$1::regclass', [table])).rows[0].reloptions;
    assert(!options?.some((x: string) => x.startsWith('autovacuum_enabled=')));
    state.before.push({ table, reloptions: options });
  }
  const gin = (await pool.query(`select indexname from pg_indexes where schemaname='native_verify_main'
    and tablename='tickets_seal_index' and indexdef ilike '%using gin%'`)).rows;
  assert.equal(gin.length, 1);
  const ginName = `native_verify_main.${gin[0].indexname}`;
  state.ginBefore = (await pool.query('select pending_pages,pending_tuples from pgstatginindex($1::regclass)', [ginName])).rows[0];
  await writeFile(`${out}/join-db-state.json`, JSON.stringify(state, null, 2) + '\n');
  for (const table of extraTables) {
    await pool.query(`alter table ${table} set (autovacuum_enabled=false)`);
    state.changed.push(table);
    await writeFile(`${out}/join-db-state.json`, JSON.stringify(state, null, 2) + '\n');
  }
  const report: any[] = [];
  for (const c of cases) {
    const firstPlain = await measure(() => plain(c)), expected = firstPlain.value;
    const firstProduct = await measure(() => product(c)); same(firstProduct.value, expected, `${c.name}/first`);
    for (let i = 0; i < 2; i++) { assert.deepEqual(await plain(c), expected); same(await product(c), expected, `${c.name}/warmup${i}`); }
    const runs: { plain: any[]; product: any[] } = { plain: [], product: [] };
    for (let i = 0; i < 7; i++) for (const path of (i % 2 ? ['product', 'plain'] : ['plain', 'product']) as ('plain' | 'product')[]) {
      const result = await measure(path === 'plain' ? () => plain(c) : () => product(c));
      if (path === 'plain') assert.deepEqual(result.value, expected, `${c.name}/plain${i}`);
      else same(result.value, expected, `${c.name}/product${i}`);
      runs[path].push(compact(result));
    }
    const prior = old.find((x: any) => x.case === c.name);
    assert(prior);
    const row = { case: c.name, condition: `ticket.${c.ticket.field} ${c.ticket.op} "${c.ticket.term}" AND customer.${c.customer.field} ${c.customer.op} "${c.customer.term}"`,
      environment: '10만 단독', mode: 'search JOIN 20', matches: expected.length, returned: expected.length,
      first: { plain: compact(firstPlain), product: compact(firstProduct) },
      plain: summary(runs.plain), product: summary(runs.product), previous: { totalMs: prior.summary.product.totalMs, dbMs: prior.summary.product.sqlMs }, runs };
    report.push(row);
    await writeFile(`${out}/join.json`, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ case: c.name, plain: row.plain, product: row.product, previous: row.previous }));
  }
  const slower = report.filter(r => r.product.dbMs > r.previous.dbMs);
  const plans: any[] = [];
  for (const r of slower) {
    const ev = r.runs.product.flatMap((x: any) => x.sqlEvents).filter((x: Event) => /^\s*(select|with)\b/i.test(x.sql))
      .sort((a: Event, b: Event) => (b.end - b.start) - (a.end - a.start))[0];
    if (!ev) continue;
    const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${ev.sql}`, ev.params);
    plans.push({ case: r.case, sql: ev.sql, plan: result.rows[0]['QUERY PLAN'] });
  }
  await writeFile(`${out}/join-explain.json`, JSON.stringify(plans, null, 2) + '\n');
} finally {
  Client.prototype.query = originalQuery;
  try {
    if (state.changed.length) {
      state.ginAfter = (await pool.query('select pending_pages,pending_tuples from pgstatginindex($1::regclass)',
        [`native_verify_main.${(await pool.query(`select indexname from pg_indexes where schemaname='native_verify_main'
          and tablename='tickets_seal_index' and indexdef ilike '%using gin%'`)).rows[0].indexname}`])).rows[0];
      for (const table of [...state.changed].reverse()) await pool.query(`alter table ${table} reset (autovacuum_enabled)`);
      state.after = await Promise.all(extraTables.map(async table => ({ table,
        reloptions: (await pool.query('select reloptions from pg_class where oid=$1::regclass', [table])).rows[0].reloptions })));
      for (const x of state.before) assert.deepEqual(state.after.find((y: any) => y.table === x.table).reloptions, x.reloptions);
      await writeFile(`${out}/join-db-state.json`, JSON.stringify(state, null, 2) + '\n');
    }
  } finally { await pool.end(); }
}

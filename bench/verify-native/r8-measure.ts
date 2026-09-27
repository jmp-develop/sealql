/** Run only after the coordinator supplies the completed R8 commit and start approval. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer, normalizeWords } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';
import { assertDisposable } from '../../test/disposable.js';
import { cases, combos, condition, fields, plainWhere, type Case, type Node } from './r8-cases.js';

const commit = process.argv[2];
assert(/^[0-9a-f]{7,40}$/.test(commit ?? ''), 'Supply the coordinator-approved R8 commit');
const phase = process.argv[3];
assert(['phase1', 'phase2', 'count-b', 'find-rest', 'finish', 'r8c-200'].includes(phase ?? ''), 'Unknown phase');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert(head.startsWith(commit), 'HEAD differs from approved R8 commit');
const scopeA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scopeB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const outDir = 'bench/results/2026-09-28-r8-remeasure';
const resultFile = phase === 'r8c-200' ? `${outDir}/r8c-200.json` : `${outDir}/results.json`;
const reportFile = phase === 'r8c-200' ? `${outDir}/r8c-200-report.md` : `${outDir}/report-ko.md`;
const columns = Object.fromEntries(fields.map(f => [f, true])) as any;
type Env = { name: string; schema: string; plainTable: string; scope: string; rows: number };
const environments: Env[] = [
  { name: '10만 단독', schema: 'native_verify_main', plainTable: 'bench_realistic_100k.customers', scope: scopeA, rows: 100000 },
  { name: '1억 속 회사 B', schema: 'native_scale_100m', plainTable: 'native_scale_100m.customers_plain', scope: scopeB, rows: 100000 },
];

let opens: { count: number; sumMs: number; intervals: { start: number; end: number }[] } | null = null;
function instrumentedSealer() {
  const sealer = createSealer({ key: new Uint8Array(32).fill(93) });
  const original = sealer.open.bind(sealer);
  sealer.open = async (...args: Parameters<typeof sealer.open>) => {
    const start = performance.now();
    try { return await original(...args); }
    finally { if (opens) { const end = performance.now(); opens.count++; opens.sumMs += end - start; opens.intervals.push({ start, end }); } }
  };
  return sealer;
}
const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
function productTable(name: string) {
  const sealed = createSealed({ sealer: instrumentedSealer });
  const schema = pgSchema(name);
  const table = schema.table('customers', {
    id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
    name: sealed.text('name', { search }), phone: sealed.text('phone', { search }),
    address: sealed.text('address', { search }), memo: sealed.text('memo', { search }),
    email: sealed.text('email', { search }), company: sealed.text('company', { search }),
  });
  return { sealed, registration: sealed.register(table, { row: 'id', scope: 'scopeId' }) };
}
const tables = new Map(environments.map(e => [e.name, productTable(e.schema)]));
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 4,
  options: '-c default_transaction_read_only=on -c statement_timeout=300000' });
const db = drizzle(pool);
type Event = { start: number; end: number; rows: number; sql: string; params: unknown[] };
let events: Event[] | null = null;
const originalQuery = Client.prototype.query;
(Client.prototype as any).query = function (...args: any[]) {
  const start = performance.now();
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
  const params = (Array.isArray(args[1]) ? args[1] : args[0]?.values ?? []) as unknown[];
  let recorded = false;
  const record = (result: any) => {
    if (!recorded) { recorded = true; events?.push({ start, end: performance.now(), rows: result?.rows?.length ?? 0, sql, params }); }
    return result;
  };
  const callback = args.findIndex(x => typeof x === 'function');
  if (callback >= 0) { const old = args[callback]; args[callback] = (err: any, result: any) => { record(result); old(err, result); }; }
  const result = (originalQuery as any).apply(this, args);
  return callback < 0 && result?.then ? result.then(record, (err: any) => { record(null); throw err; }) : result;
};
function match(n: Node, m: any, respectWords = false): any {
  if ('all' in n) return m.and(...n.all.map(x => match(x, m, respectWords)));
  if ('any' in n) return m.or(...n.any.map(x => match(x, m, respectWords)));
  return n.op === 'contains' && respectWords ? m[n.field].contains(n.value, { respectWords: true }) : m[n.field][n.op](n.value);
}
function argsFor(c: Case, e: Env) { const params: unknown[] = [e.scope]; return { where: plainWhere(c.node, params), params }; }
async function plainFind(c: Case, e: Env, limit?: number) {
  const { where, params } = argsFor(c, e);
  // Word-boundary cases follow the old matrix: SQL on *_norm, then word verification on *_plain.
  const sql = `select id,${fields.map(f => `${f}_plain as ${f}`).join(',')} from ${e.plainTable} where scope_id=$1 and ${where} order by id${c.respectWords ? '' : limit === undefined ? '' : ` limit ${limit}`}`;
  const rows = (await pool.query(sql, params)).rows;
  return c.respectWords ? rows.filter(r => normalizeWords(r.memo).includes(normalizeWords((c.node as any).value))).slice(0, limit) : rows;
}
async function plainCount(c: Case, e: Env) {
  const { where, params } = argsFor(c, e);
  return Number((await pool.query(`select count(*) n from ${e.plainTable} where scope_id=$1 and ${where}`, params)).rows[0].n);
}
function productFind(c: Case, e: Env, limit?: number) {
  const options: any = { scope: e.scope, match: (m: any) => match(c.node, m, c.respectWords), columns };
  if (limit !== undefined) options.limit = limit;
  const entry = tables.get(e.name)!;
  return entry.sealed.findMany(db, entry.registration, options).then((r: any) => r.items);
}
function productCount(c: Case, e: Env) {
  const entry = tables.get(e.name)!;
  return entry.sealed.count(db, entry.registration, { scope: e.scope, match: (m: any) => match(c.node, m) } as any);
}
function openWall(intervals: { start: number; end: number }[]) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let start = 0, end = 0, total = 0;
  for (const x of sorted) {
    if (x.start > end) { total += end - start; start = x.start; end = x.end; }
    else end = Math.max(end, x.end);
  }
  return total + end - start;
}
async function measure<T>(fn: () => Promise<T>) {
  const ev: Event[] = []; const op = { count: 0, sumMs: 0, intervals: [] as { start: number; end: number }[] };
  events = ev; opens = op; const start = performance.now();
  let value: T;
  try { value = await fn(); }
  finally { events = null; opens = null; }
  const end = performance.now();
  const dbMs = ev.reduce((s, x) => s + x.end - x.start, 0);
  const preMs = ev.length ? ev[0].start - start : end - start;
  const postMs = ev.length ? end - ev.at(-1)!.end : 0;
  return { value: value!, totalMs: end - start, preMs, dbMs,
    betweenSqlMs: end - start - preMs - dbMs - postMs, postMs, sqlCalls: ev.length,
    candidateRows: ev.reduce((s, x) => s + x.rows, 0), openCount: op.count, openSumMs: op.sumMs,
    openWallMs: openWall(op.intervals), sqlEvents: ev };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const metricKeys = ['totalMs', 'preMs', 'dbMs', 'betweenSqlMs', 'postMs', 'sqlCalls', 'candidateRows', 'openCount', 'openSumMs', 'openWallMs'] as const;
function summary(xs: any[]) { return Object.fromEntries(metricKeys.map(k => [k, median(xs.map(x => x[k]))])); }
function sameRows(a: any[], b: any[], label: string) {
  assert.equal(a.length, b.length, `${label}: row count`);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].id, b[i].id, `${label}: id ${i}`);
    for (const f of fields) assert.equal(a[i][f], b[i][f], `${label}: ${f} ${i}`);
  }
}
function idHash(xs: any[]) { return createHash('sha256').update(xs.map(x => x.id).sort().join('\n')).digest('hex'); }
function compact(m: any) { const { value, ...rest } = m; return rest; }
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
async function digestDist() {
  const hash = createHash('sha256');
  async function walk(dir: string) {
    for (const ent of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, ent.name); if (ent.isDirectory()) await walk(path);
      else { hash.update(path.replace(/\\/g, '/')); hash.update(await readFile(path)); }
    }
  }
  await walk('dist'); return hash.digest('hex');
}
const priorB = JSON.parse(await readFile('bench/results/2026-09-27-native-scale-100m/scope-b/matrix.json', 'utf8')).report;
const priorA = JSON.parse(await readFile('bench/results/2026-09-27-native-verification/v3/matrix.json', 'utf8')).report;
const priorCombo = JSON.parse(await readFile('bench/results/2026-09-27-native-scale-100m/scope-b/combo-results.json', 'utf8')).report;
function previous(e: Env, c: Case, mode: string) {
  if (mode === 'findMany 20') {
    const r = (e.name === '10만 단독' ? priorA : priorB).find((x: any) => x.case === c.name);
    return r ? { totalMs: r.summary.product.totalMs, dbMs: r.summary.product.sqlMs } : null;
  }
  if (e.name === '1억 속 회사 B' && mode === 'findMany 200') {
    const r = priorCombo.find((x: any) => x.case === c.name);
    return r ? { totalMs: r.find.product.totalMs, dbMs: r.find.product.sqlMs } : null;
  }
  if (e.name === '1억 속 회사 B' && mode === 'count') {
    const r = priorCombo.find((x: any) => x.case === c.name);
    return r ? { totalMs: r.count.product.totalMs, dbMs: r.count.product.sqlMs } : null;
  }
  return null;
}
type Row = { case: string; condition: string; environment: string; mode: string; targetRows: number;
  matches: number; returned: number; plain: any; product: any; first: any; runs: any; previous: any };
function report(rows: Row[], metadata: any) {
  const header = '| 조회 방식 | 조건 전문 | 환경 | 대상 행 수 | 실제 일치 | 결과 수 | DB 후보 수 | SQL 회수 | 인증 복호화 필드 수 | 평문 SQL / 합계 ms | 제품 전처리 / DB / SQL 사이 / 후처리 / 합계 ms | 복호화 wall ms | R8 전 합계 / DB ms | 평문 대비 DB / 합계 배율 |';
  const fmt = (n: number) => Number(n.toFixed(2));
  const lines = rows.map(r => {
    const p = r.plain, x = r.product, old = r.previous;
    return `| ${r.mode} | ${r.condition} | ${r.environment} | ${r.targetRows} | ${r.matches} | ${r.returned} | ${x.candidateRows} | ${x.sqlCalls} | ${x.openCount} | ${fmt(p.dbMs)} / ${fmt(p.totalMs)} | ${fmt(x.preMs)} / ${fmt(x.dbMs)} / ${fmt(x.betweenSqlMs)} / ${fmt(x.postMs)} / ${fmt(x.totalMs)} | ${fmt(x.openWallMs)} | ${old ? `${fmt(old.totalMs)} / ${fmt(old.dbMs)}` : '없음'} | ${fmt(x.dbMs / p.dbMs)} / ${fmt(x.totalMs / p.totalMs)} |`;
  });
  return `# R8 재측정\n\n커밋: ${metadata.commit}; dist SHA-256 전: ${metadata.distBefore}; 후: ${metadata.distAfter ?? '진행 중'}\n\n` +
    `예열 2회, 평문·제품 교차 7회. 지표별 중앙값이므로 합산이 일치하지 않을 수 있다. 첫 측정 값은 JSON에 별도 기록했다. ` +
    `DB 후보 수는 제품 SQL 응답 행 수의 합계다. C 로캘의 한글 LIKE 평문 배율은 판정 제외. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.\n\n` +
    header + '\n|' + '---|'.repeat(14) + '\n' + lines.join('\n') + '\n';
}
async function explainSlow(rows: Row[]) {
  const plans: any[] = [];
  for (const r of rows) {
    if (r.environment === '1억 속 회사 B' && r.case === 'or2' && r.mode === 'findMany 200') continue;
    if (!(r.product.dbMs > 2 * r.plain.dbMs || (r.environment === '1억 속 회사 B' && r.mode === 'count' && ['and4', 'and6'].includes(r.case)))) continue;
    const ev = [...r.runs.product].flatMap((x: any) => x.sqlEvents as Event[])
      .filter((x: Event) => /^\s*(select|with)\b/i.test(x.sql)).sort((a: Event, b: Event) => (b.end - b.start) - (a.end - a.start))[0];
    if (!ev) { plans.push({ case: r.case, mode: r.mode, environment: r.environment, error: 'No SELECT SQL recorded' }); continue; }
    try {
      const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${ev.sql}`, ev.params);
      plans.push({ case: r.case, mode: r.mode, environment: r.environment, sql: ev.sql, plan: result.rows[0]['QUERY PLAN'] });
    } catch (e: any) { plans.push({ case: r.case, mode: r.mode, environment: r.environment, error: String(e?.message ?? e) }); }
  }
  return plans;
}
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n), 1000);
  await mkdir(outDir, { recursive: true });
  const priorRun = phase === 'phase1' || phase === 'r8c-200' ? null : JSON.parse(await readFile(resultFile, 'utf8'));
  const metadata: any = priorRun?.metadata ?? { commit: head, distBefore: await digestDist(), startedAt: new Date().toISOString() };
  assert.equal(metadata.commit, head);
  assert.equal(await digestDist(), metadata.distBefore, 'dist changed since first phase');
  const rows: Row[] = priorRun?.rows ?? [];
  assert(phase === 'phase1' || phase === 'r8c-200' ? rows.length === 0 : rows.length >= 21, 'Unexpected phase input row count');
  if (phase !== 'phase1' && phase !== 'r8c-200') assert.equal(metadata.phase1Done, true);
  const work: { e: Env; mode: string; selected: Case[]; limit?: number }[] = phase === 'phase1'
    ? [{ e: environments[0], mode: 'findMany 20', selected: cases, limit: 20 }]
    : phase === 'r8c-200' ? environments.map(e => ({ e, mode: 'findMany 200', selected: combos, limit: 200 }))
    : phase === 'count-b' ? [
      { e: environments[1], mode: 'count', selected: combos },
    ] : phase === 'find-rest' ? [
      { e: environments[1], mode: 'findMany 200', selected: combos, limit: 200 },
      { e: environments[1], mode: 'findMany 전부', selected: combos },
    ] : [
      ...[environments[0]].flatMap(e => [
        { e, mode: 'findMany 200', selected: combos, limit: 200 },
        { e, mode: 'findMany 전부', selected: combos },
        { e, mode: 'count', selected: combos },
      ]),
      { e: environments[1], mode: 'findMany 20', selected: cases, limit: 20 },
      ...[environments[1]].flatMap(e => [
        { e, mode: 'findMany 200', selected: combos, limit: 200 },
        { e, mode: 'findMany 전부', selected: combos },
        { e, mode: 'count', selected: combos },
      ]),
    ];
  for (const { e, mode, selected, limit } of work) for (const c of selected) {
    if (rows.some(r => r.environment === e.name && r.mode === mode && r.case === c.name)) continue;
    const count = await plainCount(c, e);
    const plain = () => mode === 'count' ? plainCount(c, e) : plainFind(c, e, limit);
    const product = () => mode === 'count' ? productCount(c, e) : productFind(c, e, limit);
    const verify = (a: any, b: any, label: string) => {
      if (mode === 'count') assert.equal(b, a, label);
      else if (mode === 'findMany 전부') {
        assert.equal(b.length, a.length, `${label}: full row count`);
        assert.equal(idHash(b), idHash(a), `${label}: ID set SHA-256`);
        sameRows(b, a, label);
      } else sameRows(b, a, label);
    };
    const firstPlain = await measure<any>(plain), firstProduct = await measure<any>(product);
    verify(firstPlain.value, firstProduct.value, `${e.name}/${c.name}/${mode}/first`);
    for (let i = 0; i < 2; i++) { const a = await plain(); const b = await product(); verify(a, b, `${e.name}/${c.name}/${mode}/warmup${i}`); }
    const runs: { plain: any[]; product: any[] } = { plain: [], product: [] };
    let expected: any;
    for (let i = 0; i < 7; i++) for (const path of (i % 2 ? ['product', 'plain'] : ['plain', 'product']) as ('plain' | 'product')[]) {
      const m = await measure<any>(path === 'plain' ? plain : product);
      if (path === 'plain') { if (expected !== undefined) verify(expected, m.value, `${e.name}/${c.name}/${mode}/plain${i}`); else expected = m.value; }
      else { if (expected === undefined) expected = await plain(); verify(expected, m.value, `${e.name}/${c.name}/${mode}/product${i}`); }
      runs[path].push(compact(m));
    }
    if (mode === 'count') assert.equal(expected, count);
    else if (mode === 'findMany 전부') assert.equal(expected.length, count);
    else assert.equal(expected.length, Math.min(count, limit!));
    const row: Row = { case: c.name, condition: condition(c.node), environment: e.name, mode, targetRows: e.rows,
      matches: count, returned: mode === 'count' ? expected : expected.length,
      plain: summary(runs.plain), product: summary(runs.product), first: { plain: compact(firstPlain), product: compact(firstProduct) }, runs,
      previous: previous(e, c, mode) };
    rows.push(row);
    await writeFile(resultFile, json({ metadata, rows }));
    await writeFile(reportFile, report(rows, metadata));
    console.log(JSON.stringify({ case: c.name, mode, environment: e.name, count, productMs: row.product.totalMs }));
  }
  if (phase === 'phase1') {
    const regressions = rows.filter(r => r.product.dbMs > 1.2 * r.previous.dbMs);
    metadata.phase1Done = true;
    metadata.distPhase1 = await digestDist();
    assert.equal(metadata.distPhase1, metadata.distBefore, 'dist changed in phase1');
    await writeFile(`${outDir}/phase1-regressions.json`, json({ regressions: regressions.map(r => ({
      case: r.case, condition: r.condition, productDbMs: r.product.dbMs, v3ProductSqlMs: r.previous.dbMs,
    })), plans: regressions.length ? await explainSlow(regressions) : [] }));
    await writeFile(resultFile, json({ metadata, rows }));
    await writeFile(reportFile, report(rows, metadata));
    console.log(JSON.stringify({ phase1Done: true, regressions: regressions.map(r => r.case) }));
  } else if (phase === 'count-b') {
    metadata.countsDone = true;
    metadata.distCountPhase = await digestDist();
    assert.equal(metadata.distCountPhase, metadata.distBefore, 'dist changed in count phase');
    await writeFile(resultFile, json({ metadata, rows }));
    await writeFile(reportFile, report(rows, metadata));
    console.log(JSON.stringify({ countsDone: true, countRows: rows.filter(r => r.mode === 'count').length }));
  } else if (phase === 'find-rest') {
    metadata.findDone = true;
    metadata.distFindPhase = await digestDist();
    assert.equal(metadata.distFindPhase, metadata.distBefore, 'dist changed in find phase');
    await writeFile(resultFile, json({ metadata, rows }));
    await writeFile(reportFile, report(rows, metadata));
    console.log(JSON.stringify({ findDone: true, findRows: rows.filter(r => r.mode === 'findMany 200' || r.mode === 'findMany 전부').length }));
  } else if (phase === 'r8c-200') {
    assert.equal(rows.length, 10);
    metadata.distAfter = await digestDist();
    assert.equal(metadata.distAfter, metadata.distBefore, 'dist changed during R8c measurement');
    metadata.finishedAt = new Date().toISOString();
    await writeFile(resultFile, json({ metadata, rows }));
    await writeFile(reportFile, report(rows, metadata));
    console.log(JSON.stringify({ r8cDone: true, rows: rows.length, distBefore: metadata.distBefore, distAfter: metadata.distAfter }));
  } else {
  await writeFile(`${outDir}/explain.json`, json(await explainSlow(rows)));
  metadata.distAfter = await digestDist();
  assert.equal(metadata.distAfter, metadata.distBefore, 'dist changed during measurement');
  metadata.finishedAt = new Date().toISOString();
  await writeFile(resultFile, json({ metadata, rows }));
  await writeFile(reportFile, report(rows, metadata));
  }
} finally { Client.prototype.query = originalQuery; await pool.end(); }

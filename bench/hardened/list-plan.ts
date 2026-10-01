import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableColumns } from 'drizzle-orm';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as core from '../../src/index.js';
import * as adapter from '../../src/adapters/drizzle/v0.45/index.js';
import { disposablePool } from '../common/db.js';

// Extract src at 9f19c2e into this directory before running; no DB data is created there.
const beforeRoot = resolve(process.argv[2] ?? '.local/hardened-list-before/src');
const beforeCore = await import(pathToFileURL(resolve(beforeRoot, 'index.ts')).href);
const beforeAdapter = await import(pathToFileURL(resolve(beforeRoot, 'adapters/drizzle/v0.45/index.ts')).href);
const output = process.argv[3] ?? 'bench/results/2026-10-02-hardened/list-plan';
mkdirSync(output, { recursive: true });
const schemaName = 'hardened_list_perf', schema = pgSchema(schemaName);
const previous = JSON.parse(readFileSync('bench/results/2026-10-02-hardened/perf/raw.json', 'utf8'));
const cases = previous.secure.filter((r: any) => r.mode === 'list20');
const result: any = { before: '9f19c2e', after: 'working tree', warmups: 2, repetitions: 7,
  source: 'bench_realistic_100k', derivative: 'test_p1_verify', rows: [], counts: [], checks: 0, plans: [], complete: false };
const persist = () => writeFileSync(`${output}/raw.json`, JSON.stringify(result, null, 2));
let active: any[] | undefined, opens = 0;
for (const c of [beforeCore, core]) {
  const original = c.Sealer.prototype.open;
  c.Sealer.prototype.open = function (...args: any[]) { if (active) opens++; return original.apply(this, args as never); };
}
const originalQuery = Client.prototype.query;
(Client.prototype as any).query = function (...args: any[]) {
  const events = active, start = performance.now(); let done = false;
  const statement = { text: typeof args[0] === 'string' ? args[0] : args[0]?.text,
    values: Array.isArray(args[1]) ? args[1] : args[0]?.values ?? [] };
  const record = (r: any) => { if (!done) { done = true; events?.push({ ms: performance.now() - start, rows: r?.rows?.length ?? 0, statement }); } return r; };
  const cb = args.findIndex(a => typeof a === 'function');
  if (cb >= 0) { const f = args[cb]; args[cb] = (e: any, r: any) => { record(r); f(e, r); }; }
  const pending = (originalQuery as any).apply(this, args);
  return cb < 0 && pending?.then ? pending.then(record, (e: any) => { record(null); throw e; }) : pending;
};
async function timed(fn: () => Promise<any>) {
  active = []; opens = 0; const start = performance.now();
  try { const value = await fn(); return { value, totalMs: performance.now() - start,
    sqlMs: active.reduce((sum, r) => sum + r.ms, 0), sqlCalls: active.length,
    wireRows: active.reduce((sum, r) => sum + r.rows, 0), opens, statements: active.map(r => r.statement) }; }
  finally { active = undefined; }
}
const median = (v: number[]) => v.toSorted((a, b) => a - b)[Math.floor(v.length / 2)];
function summary(runs: any[]) {
  const value: any = {};
  for (const key of ['totalMs', 'sqlMs', 'sqlCalls', 'wireRows', 'opens']) {
    const v = runs.map(r => r[key]); value[key] = median(v); value[`${key}Runs`] = v;
    if (key.endsWith('Ms')) value[`${key}Mad`] = median(v.map(n => Math.abs(n - value[key])));
  }
  return value;
}
function model(c: any, a: any, name: string, hard: string[]) {
  const cipher = c.createSealer({ key: new Uint8Array(32).fill(93) }), sealed = a.createSealed({ sealer: cipher });
  const table = schema.table(name, { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
    name: sealed.text('name', { ...(hard.includes('name') ? { hardened: true } : {}), search: { exact: true, substring: true } }),
    phone: sealed.text('phone', { ...(hard.includes('phone') ? { hardened: true } : {}), search: { exact: true, substring: true } }) });
  const seal = sealed.register(table, { row: 'id', scope: 'scopeId', model: 'customers' });
  return { cipher, sealed, table, seal, name };
}
function match(node: any, m: any): any {
  if (node.op === 'all' || node.op === 'any') return m[node.op === 'all' ? 'and' : 'or'](...node.children.map((n: any) => match(n, m)));
  return m[node.field][node.op](node.value);
}
function plainCondition(node: any, params: any[]): string {
  if (node.op === 'all' || node.op === 'any') return `(${node.children.map((n: any) => plainCondition(n, params)).join(node.op === 'all' ? ' and ' : ' or ')})`;
  params.push(node.op === 'contains' ? `%${node.value}%` : node.op === 'startsWith' ? `${node.value}%` : node.op === 'endsWith' ? `%${node.value}` : node.value);
  return `${node.field}_norm ${node.op === 'eq' ? '=' : 'like'} $${params.length}`;
}
const pool = await disposablePool(1), db = drizzle(pool); let created = false;
try {
  assert.equal((await pool.query('select to_regnamespace($1) name', [schemaName])).rows[0].name, null);
  const source = (await pool.query('select id,scope_id,name_plain,phone_plain,name_norm,phone_norm from bench_realistic_100k.customers order by id')).rows;
  assert.equal(source.length, 100000);
  const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex'); result.sourceHash = sourceHash;
  const scope = source[0].scope_id; assert.ok(source.every(r => r.scope_id === scope));
  await pool.query(`create schema "${schemaName}"`); created = true;
  const models: any = {};
  for (const n of [10000, 100000]) {
    await pool.query(`create table "${schemaName}".plain_${n} as select id,scope_id,name_plain as name,phone_plain as phone,name_norm,phone_norm from bench_realistic_100k.customers where id<=$1::uuid`, [source[n - 1].id]);
    await pool.query(`create unique index plain_${n}_id on "${schemaName}".plain_${n}(id)`);
    for (const f of ['name', 'phone']) {
      await pool.query(`create index plain_${n}_${f}_bt on "${schemaName}".plain_${n}(scope_id,${f}_norm)`);
      await pool.query(`create index plain_${n}_${f}_gin on "${schemaName}".plain_${n} using gin(${f}_norm gin_trgm_ops)`);
    }
    models[n] = {};
    for (const kind of ['ordinary', 'phone', 'name']) {
      const hard = kind === 'ordinary' ? [] : [kind], m = model(core, adapter, `${kind}_${n}`, hard);
      for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ parent: m.table, companion: m.seal }))) await pool.query(statement);
      for (const statement of m.sealed.extraMigrationSql(m.seal)) await pool.query(statement);
      await pool.query(`insert into "${schemaName}"."${m.name}"(id,scope_id,name_ct,phone_ct) select id,scope_id,name_ct,phone_ct from test_p1_verify.customers where id<=$1::uuid`, [source[n - 1].id]);
      const columns = Object.values(getTableColumns(m.seal)).map((c: any) => `"${c.name}"`).join(',');
      await pool.query(`insert into "${schemaName}"."${m.name}_seal_index"(${columns}) select ${columns} from test_p1_verify.customers_seal_index where row_id<=$1::uuid`, [source[n - 1].id]);
      assert.equal((await pool.query(`select count(*)::int n from "${schemaName}"."${m.name}_seal_index"`)).rows[0].n, n);
      const opened = await m.sealed.open(await db.select().from(m.table).orderBy(m.table.id).limit(10));
      assert.deepEqual(opened.map((r: any) => [r.id, r.name, r.phone]), source.slice(0, 10).map(r => [r.id, r.name_plain, r.phone_plain]));
      await pool.query(`analyze "${schemaName}"."${m.name}"`); await pool.query(`analyze "${schemaName}"."${m.name}_seal_index"`);
      models[n][kind] = { after: m, before: model(beforeCore, beforeAdapter, m.name, hard) };
    }
    await pool.query(`analyze "${schemaName}".plain_${n}`);
  }
  for (const row of cases) {
    const n = row.range, field = row.node.field ?? 'phone';
    const hard = models[n][field], ordinary = models[n].ordinary.after;
    const params: any[] = [scope], condition = plainCondition(row.node, params);
    const plainSql = `select id,name,phone from "${schemaName}".plain_${n} where scope_id=$1 and ${condition} order by id limit 20`;
    const expected = (await pool.query(plainSql, params)).rows.map(r => [r.id, r.name, r.phone]);
    const paths = ['plain', 'ordinary', 'before', 'after'], runs: any = Object.fromEntries(paths.map(p => [p, []])), first: any = {}, statements: any = {};
    const exec = async (path: string) => {
      if (path === 'plain') return (await pool.query(plainSql, params)).rows;
      const m = path === 'ordinary' ? ordinary : hard[path];
      return (await m.sealed.findMany(db, m.seal, { scope, match: (m: any) => match(row.node, m), limit: 20, columns: { id: true, name: true, phone: true } })).items;
    };
    // First invocation separate, then exactly two warmups and seven alternating repetitions.
    for (let i = -1; i < 9; i++) for (const path of i % 2 === 0 ? paths : [...paths].reverse()) {
      const r = await timed(() => exec(path));
      assert.deepEqual(r.value.map((v: any) => [v.id, v.name, v.phone]), expected); result.checks++;
      if (i === -1) first[path] = { totalMs: r.totalMs, sqlMs: r.sqlMs };
      if (i >= 2) { const { value, statements: sql, ...metrics } = r; runs[path].push(metrics); statements[path] ??= sql; }
    }
    const outputRow = { range: n, label: row.label, node: row.node, matched: row.matched, returned: expected.length, first,
      paths: Object.fromEntries(paths.map(path => [path, summary(runs[path])])) };
    result.rows.push(outputRow); persist();
    console.log(JSON.stringify({ range: n, label: row.label, before: outputRow.paths.before.totalMs, after: outputRow.paths.after.totalMs }));
    if (['phone-eq', 'phone-contains-absent', 'phone-LIKE'].includes(row.label)) {
      const countRuns: any[] = []; let countStatement: any;
      for (let i = -1; i < 9; i++) {
        const r = await timed(() => hard.after.sealed.count(db, hard.after.seal, { scope, match: (m: any) => match(row.node, m) }));
        assert.equal(r.value, row.matched); result.checks++;
        if (i >= 2) { const { value, statements, ...metrics } = r; countRuns.push(metrics); countStatement ??= statements[0]; }
      }
      result.counts.push({ range: n, label: row.label, ...summary(countRuns) }); persist();
      if (n === 100000) {
        const plan = (await pool.query(`explain (analyze,buffers,format json) ${countStatement.text}`, countStatement.values)).rows[0]['QUERY PLAN'];
        result.plans.push({ label: row.label, path: 'count', statement: countStatement, plan }); persist();
      }
    }
    if (n === 100000 && ['phone-eq', 'phone-contains-absent', 'phone-LIKE', 'name-contains-absent', 'mixed-AND'].includes(row.label)) {
      for (const path of ['before', 'after']) {
        const query = statements[path].find((q: any) => /^select/i.test(q.text)); assert.ok(query);
        const plan = (await pool.query(`explain (analyze,buffers,format json) ${query.text}`, query.values)).rows[0]['QUERY PLAN'];
        result.plans.push({ label: row.label, path, statement: query, plan }); persist();
      }
    }
  }
  const after = (await pool.query('select id,scope_id,name_plain,phone_plain,name_norm,phone_norm from bench_realistic_100k.customers order by id')).rows;
  assert.equal(createHash('sha256').update(JSON.stringify(after)).digest('hex'), sourceHash); result.sourceUnchanged = true; result.complete = true;
} catch (error) { result.error = String(error); throw error; }
finally {
  if (created) { await pool.query(`drop schema "${schemaName}" cascade`); result.schemaDropped = true; }
  await pool.end(); persist();
}

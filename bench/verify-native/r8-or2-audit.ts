/** Compare stored R8-before SQL bytes and run one separate R8 plan for B/or2/200. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const dir = 'bench/results/2026-09-28-r8-remeasure';
const current = JSON.parse(await readFile(`${dir}/results.json`, 'utf8')).rows.find((r: any) =>
  r.environment === '1억 속 회사 B' && r.mode === 'findMany 200' && r.case === 'or2');
const before = JSON.parse(await readFile('bench/results/2026-09-27-native-scale-100m/scope-b/combo-results.json', 'utf8'))
  .report.find((r: any) => r.case === 'or2').find;
assert(current && before);
const oldSql = before.runs.product.flatMap((r: any) => r.sql ?? []);
const newEvents = current.runs.product.flatMap((r: any) => r.sqlEvents ?? []);
const newSql = newEvents.map((r: any) => r.sql);
const differences: any[] = [];
for (let i = 0; i < Math.max(oldSql.length, newSql.length); i++) {
  if (oldSql[i] === newSql[i]) continue;
  const a = oldSql[i] ?? '', b = newSql[i] ?? '';
  let offset = 0; while (offset < Math.min(a.length, b.length) && a[offset] === b[offset]) offset++;
  differences.push({ index: i, offset, beforeLength: a.length, currentLength: b.length,
    beforeContext: a.slice(Math.max(0, offset - 80), offset + 160),
    currentContext: b.slice(Math.max(0, offset - 80), offset + 160) });
}
const oldParams = before.runs.product.map((r: any) => r.params ?? r.sqlParams ?? null);
const dbRuns = current.runs.product.map((r: any) => r.dbMs);
const sorted = [...newEvents].sort((a: any, b: any) => (a.end - a.start) - (b.end - b.start));
const event = sorted[sorted.length >> 1];
assert(event);
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=300000' });
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${event.sql}`, event.params)).rows[0]['QUERY PLAN'];
  const audit = { case: 'or2', mode: 'findMany 200', environment: '1억 속 회사 B',
    sqlEqual: oldSql.length === newSql.length && differences.length === 0,
    oldSqlStatements: oldSql.length, newSqlStatements: newSql.length, differences,
    oldParamsRecorded: oldParams.every((x: any) => x !== null), oldParams,
    currentParams: event.params, dbRuns, dbMinMs: Math.min(...dbRuns), dbMaxMs: Math.max(...dbRuns),
    oldDbMedianMs: before.product.dbMs ?? before.product.sqlMs,
    currentDbMedianMs: current.product.dbMs, oldPlanRecorded: false, plan };
  await writeFile(`${dir}/or2-200-audit.json`, JSON.stringify(audit, null, 2) + '\n');
  console.log(JSON.stringify({ ...audit, plan: plan?.[0]?.Plan, oldParams: undefined, currentParams: undefined }));
} finally { await pool.end(); }

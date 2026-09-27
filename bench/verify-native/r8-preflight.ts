/** Read-only R8 fixture check. No product code or benchmark calls. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { cases, condition, plainWhere } from './r8-cases.js';

const scopeA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scopeB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=300000' });
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const scaleReport = JSON.parse(await readFile('bench/results/2026-09-27-native-scale-100m/scope-b/matrix.json', 'utf8')).report;
  const prior = new Map<string, number>(scaleReport.map((r: any) => [r.case, r.actualMatches]));
  const scopeRows = (await pool.query('select scope_id, count(*)::int n from native_verify_main.customers group by scope_id')).rows;
  assert.deepEqual(scopeRows, [{ scope_id: scopeA, n: 100000 }]);
  const bRows = Number((await pool.query('select count(*)::int n from native_scale_100m.customers where scope_id=$1', [scopeB])).rows[0].n);
  assert.equal(bRows, 100000);
  const copies = Number((await pool.query('select count(*)::int n from native_scale_100m.progress')).rows[0].n);
  assert.equal(copies, 1000);
  const estimate = Number((await pool.query("select reltuples::bigint n from pg_class where oid='native_scale_100m.customers'::regclass")).rows[0].n);
  console.log(JSON.stringify({ fixture: { mainScopes: scopeRows, companyBRows: bRows, completedCopies: copies,
    totalRowsDerived: copies * 100000, totalRowsCatalogEstimate: estimate } }));
  let mismatches = 0;
  for (const c of cases) {
    for (const [environment, table, scope] of [
      ['10만 단독', 'bench_realistic_100k.customers', scopeA],
      ['1억 속 회사 B', 'native_scale_100m.customers_plain', scopeB],
    ] as const) {
      const params: unknown[] = [scope];
      const where = plainWhere(c.node, params);
      const actual = Number((await pool.query(`select count(*)::int n from ${table} where scope_id=$1 and ${where}`, params)).rows[0].n);
      const previous = prior.get(c.name);
      assert.notEqual(previous, undefined, c.name);
      const same = actual === previous;
      if (!same) mismatches++;
      console.log(JSON.stringify({ case: c.name, condition: condition(c.node), environment, actual, previous, same,
        note: c.respectWords ? '이전 보고값은 단어 경계 재확인 전 SQL 일치 수' : undefined }));
    }
  }
  console.log(JSON.stringify({ result: 'complete', cases: cases.length, rows: cases.length * 2, mismatches }));
  if (mismatches) process.exitCode = 1;
} finally {
  await pool.end();
}

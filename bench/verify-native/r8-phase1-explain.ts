/** One separate plan per phase-one V3 SQL regression; no timed run is repeated. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const dir = 'bench/results/2026-09-28-r8-remeasure';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=300000' });
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const data = JSON.parse(await readFile(`${dir}/results.json`, 'utf8'));
  assert.equal(data.metadata.phase1Done, true);
  const regressions = data.rows.filter((r: any) => r.product.dbMs > r.previous.dbMs * 1.2);
  const plans: any[] = [];
  for (const r of regressions) {
    const event = r.runs.product.flatMap((x: any) => x.sqlEvents)
      .filter((x: any) => /^\s*(select|with)\b/i.test(x.sql))
      .sort((a: any, b: any) => (b.end - b.start) - (a.end - a.start))[0];
    assert(event, `${r.case}: no SELECT SQL captured`);
    try {
      const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${event.sql}`, event.params);
      plans.push({ case: r.case, condition: r.condition, productDbMs: r.product.dbMs,
        v3ProductSqlMs: r.previous.dbMs, sql: event.sql, plan: result.rows[0]['QUERY PLAN'] });
    } catch (e: any) {
      plans.push({ case: r.case, condition: r.condition, error: String(e?.message ?? e) });
    }
  }
  await writeFile(`${dir}/phase1-explain.json`, JSON.stringify(plans, null, 2) + '\n');
  console.log(JSON.stringify(plans.map(x => ({ case: x.case, condition: x.condition,
    productDbMs: x.productDbMs, v3ProductSqlMs: x.v3ProductSqlMs,
    plan: x.plan?.[0]?.Plan, error: x.error }))));
} finally { await pool.end(); }

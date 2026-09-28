/** X5: planner estimates (plain EXPLAIN, no execution) vs true counts for each clause of and4, both schemas. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=600000' });
const rec = JSON.parse(await readFile('bench/results/2026-09-28-count-research/x5-recorded-sql.json', 'utf8'));
const out: any[] = [];
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  for (const [env, schema] of [['10만 단독', 'native_verify_main'], ['1억 속 회사 B', 'native_scale_100m']]) {
    const { sql, params } = rec[`and4|${env}|count`][0];
    const cols = [...sql.matchAll(/"__seal_idx"\."(tokens_[0-9a-f]+)"\)?(\[1\])?(=|\s@>)\s?\$(\d)/g)].map(m => ({ col: m[1], exact: !!m[2], p: +m[4] }));
    const t = `${schema}.customers_seal_index`;
    const clauses: [string, string, unknown[]][] = [['scope', `scope_id=$1`, [params[1]]]];
    for (const c of cols) {
      const pred = c.exact ? `(${c.col})[1]=$1::bigint` : `${c.col} @> $1::bigint[]`;
      clauses.push([`${c.col}${c.exact ? '[1]=' : ' @>'}`, pred, [params[c.p - 1]]]);
      clauses.push([`scope AND ${c.col}`, `scope_id=$2 and ${pred}`, [params[c.p - 1], params[1]]]);
    }
    const all = cols.map(c => c.exact ? `(${c.col})[1]=$${c.p}::bigint` : `${c.col} @> $${c.p}::bigint[]`).join(' and ');
    clauses.push(['scope AND all4', `$1::uuid is not null and scope_id=$2 and ${all}`, params]);
    for (const [label, where, ps] of clauses) {
      const used = Math.max(...[...where.matchAll(/\$(\d+)/g)].map(m => +m[1]));
      const p = label === 'scope AND all4' ? params.slice(0, used) : ps;
      const plan = (await pool.query(`explain (format json) select count(*) from ${t} where ${where}`, p)).rows[0]['QUERY PLAN'][0].Plan;
      const est = plan.Plans?.[0]?.['Plan Rows'] ?? plan['Plan Rows'];
      const actual = +(await pool.query(`select count(*) n from ${t} where ${where}`, p)).rows[0].n;
      out.push({ env, clause: label, estimated: est, actual, ratio: actual / Math.max(est, 1) });
      console.log(env.padEnd(10), label.padEnd(36), 'est', String(est).padStart(9), 'actual', String(actual).padStart(9));
    }
  }
  await writeFile('bench/results/2026-09-28-count-research/x5-estimates.json', JSON.stringify(out, null, 1) + '\n');
} finally { await pool.end(); }

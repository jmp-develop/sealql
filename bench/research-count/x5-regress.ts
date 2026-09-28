/** X5: remedy side effects. Count-shape candidate SQL built from recorded product SQL/tokens; EXPLAIN ANALYZE x3 per variant.
 * usage: x5-regress.ts <tag>  -- takes .local/research/measure.lock */
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const tag = process.argv[2] ?? 'run';
const lock = '.local/research/measure.lock';
const rec = JSON.parse(await readFile('bench/results/2026-09-28-count-research/x5-recorded-sql.json', 'utf8'));
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=600000' });
const envs = [['10만 단독', 'native_verify_main'], ['1억 속 회사 B', 'native_scale_100m']] as const;
const p = (key: string) => rec[key][0].params as string[];
function cases(env: string, schema: string) {
  const and2 = p(`and2|${env}|count`), one = p(`exact_one|${env}|findMany 20`), common = p(`exact_common|${env}|findMany 20`);
  const t = (pred: string, params: unknown[]) => ({ params, sql: `select "id","scope_id" from "${schema}"."customers" where ("${schema}"."customers"."scope_id" = $1 and "customers"."id" in (select "__seal_idx"."row_id" from "${schema}"."customers_seal_index" as "__seal_idx" where "__seal_idx"."scope_id"=$2 and (${pred}))) order by "${schema}"."customers"."id" asc` });
  return {
    exact_one: t(`("__seal_idx"."tokens_c44ae523cca61a0b")[1]=$3::bigint`, one.slice(0, 3)),
    exact_common: t(`("__seal_idx"."tokens_a106c26102b707f0")[1]=$3::bigint`, common.slice(0, 3)),
    // selective exact AND broad substring: the case where keeping the btree path matters
    'phone= AND memo 서비스': t(`(("__seal_idx"."tokens_c44ae523cca61a0b")[1]=$3::bigint) and ("__seal_idx"."tokens_a639b11c8130dcf7" @> $4::bigint[])`, [...one.slice(0, 3), and2[3]]),
    or3: rec[`or3|${env}|count`][0],
    and4: rec[`and4|${env}|count`][0],
    and2: rec[`and2|${env}|count`][0],
  } as Record<string, { sql: string; params: unknown[] }>;
}
const variants: Record<string, (s: string) => string> = {
  'as-is': s => s,
  'exact-as-filter': s => /@>/.test(s) ? s.replace(/\)\[1\]=\$(\d+)::bigint/g, ')[1]+0=$$$1::bigint') : s,
  'no-inner-scope': s => s.replace('"__seal_idx"."scope_id"=$2 and', '$2::uuid is not null and'),
};
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  try { await stat(lock); throw Error('measure.lock held'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  await writeFile(lock, `X5 ${new Date().toISOString()}\n`);
  const out: any[] = [];
  try {
    const av = (await pool.query(`select count(*)::int n from pg_stat_activity where backend_type='autovacuum worker'`)).rows[0].n;
    for (const [env, schema] of envs) for (const [name, c] of Object.entries(cases(env, schema))) for (const [v, f] of Object.entries(variants)) {
      const sql = f(c.sql);
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push((await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, c.params)).rows[0]['QUERY PLAN'][0]);
      const rows = runs[2].Plan['Actual Rows'];
      const txt = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, c.params)).rows.map((x: any) => x['QUERY PLAN']).join('\n');
      out.push({ env, case: name, variant: v, autovacuumWorkers: av, rows, execMs: runs.map(r => r['Execution Time']), sql, params: c.params, text4: txt });
      console.log(env.padEnd(10), name.padEnd(22), v.padEnd(16), 'rows', String(rows).padStart(6), 'exec', runs.map(r => r['Execution Time'].toFixed(1)).join('/'));
    }
  } finally { await unlink(lock); }
  await writeFile(`bench/results/2026-09-28-count-research/x5-regress-${tag}.json`, JSON.stringify(out, null, 1) + '\n');
} finally { await pool.end(); }

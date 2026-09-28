/** X5: EXPLAIN (ANALYZE, BUFFERS, SETTINGS) of recorded product candidate SQL in both schemas.
 * usage: x5-explain.ts <tag> [variant...]  -- takes .local/research/measure.lock */
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const tag = process.argv[2] ?? 'base';
const variants = process.argv.slice(3).length ? process.argv.slice(3) : ['as-is'];
const lock = '.local/research/measure.lock';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=600000' });
const recorded = JSON.parse(await readFile('bench/results/2026-09-28-count-research/x5-recorded-sql.json', 'utf8')) as Record<string, { sql: string; params: unknown[] }[]>;
const pick = ['and4|10만 단독|count', 'and4|1억 속 회사 B|count', 'and6|10만 단독|count', 'and6|1억 속 회사 B|count',
  'and4|10만 단독|findMany 200', 'and4|1억 속 회사 B|findMany 200', 'and2|10만 단독|count', 'and2|1억 속 회사 B|count'];
// Variants are per-statement settings or shape rewrites the library could emit; none touches stored data.
const shape: Record<string, { set?: string[]; rewrite?: (s: string) => string }> = {
  'as-is': {},
  'no-nestloop': { set: ['enable_nestloop=off'] },
  'no-indexscan-parent': { set: ['enable_indexscan=off'] },
  'no-bitmap': { set: ['enable_bitmapscan=off'] },
  'no-parallel': { set: ['max_parallel_workers_per_gather=0'] },
  'jit-off': { set: ['jit=off'] },
  'bitmap-only': { set: ['enable_indexscan=off'] },
  // forces the 1억 plan shape (exact btree index scan + array filter) onto the 10만 schema
  'force-btree': { set: ['enable_bitmapscan=off', 'enable_seqscan=off'] },
  // exact-token btree kept out of the plan when the AND also has GIN leaves: exact becomes a recheck filter
  'exact-as-filter': { rewrite: s => s.replace(/\)\[1\]=\$(\d+)::bigint/g, ')[1]+0=$$$1::bigint') },
  // companion scope equality removed (tokens carry the 32-bit scope prefix; parent keeps scope_id=$1 and AAD binds scope)
  'no-inner-scope': { rewrite: s => s.replace('"__seal_idx"."scope_id"=$2 and', '$2::uuid is not null and') },
  'inner-only': { rewrite: s => s.match(/in \((select "__seal_idx"\."row_id".*)\)\) order by/s)![1].replace(/\)$/, '') },
};
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  try { await stat(lock); throw Error('measure.lock held by another agent'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  await writeFile(lock, `X5 ${new Date().toISOString()}\n`);
  const out: any[] = [];
  try {
    for (const v of variants) for (const key of pick) {
      const ev = recorded[key][0];
      const cfg = shape[v];
      let sql = cfg.rewrite ? cfg.rewrite(ev.sql) : ev.sql;
      let params = ev.params;
      if (cfg.rewrite) { const used = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map(m => +m[1])); params = params.slice(0, used); }
      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const s of cfg.set ?? []) await client.query(`set local ${s}`);
        const av = (await client.query(`select count(*)::int n from pg_stat_activity where backend_type='autovacuum worker'`)).rows[0].n;
        const runs = [];
        for (let i = 0; i < 3; i++) {
          const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${sql}`, params);
          runs.push(r.rows[0]['QUERY PLAN'][0]);
        }
        await client.query('rollback');
        const txt = (await (async () => { await client.query('begin'); for (const s of cfg.set ?? []) await client.query(`set local ${s}`);
          const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${sql}`, params); await client.query('rollback'); return r.rows.map((x: any) => x['QUERY PLAN']).join('\n'); })());
        out.push({ key, variant: v, autovacuumWorkers: av, execMs: runs.map(r => r['Execution Time']), planMs: runs.map(r => r['Planning Time']), runs, text4: txt });
        console.log(`${v.padEnd(20)} ${key.padEnd(30)} av=${av} exec=${runs.map(r => r['Execution Time'].toFixed(1)).join('/')} last=${txt.match(/Execution Time: ([\d.]+)/)![1]}`);
      } finally { client.release(); }
    }
  } finally { await unlink(lock); }
  await writeFile(`bench/results/2026-09-28-count-research/x5-explain-${tag}.json`, JSON.stringify(out, null, 1) + '\n');
} finally { await pool.end(); }

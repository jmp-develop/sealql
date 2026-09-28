/** X5: read-only catalog/statistics state of both companion tables (no timing). */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=600000' });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
try {
  await assertDisposable(pool);
  assert.equal(Number((await q('show port'))[0].port), 56439);
  const out: any = { at: new Date().toISOString() };
  out.settings = await q(`select name, setting, unit from pg_settings where name in ('work_mem','shared_buffers','effective_cache_size','random_page_cost','seq_page_cost','max_parallel_workers_per_gather','jit','gin_fuzzy_search_limit','default_statistics_target','enable_bitmapscan','effective_io_concurrency','server_version','autovacuum')`);
  out.indexes = await q(`select schemaname, tablename, indexname, indexdef, pg_relation_size((schemaname||'.'||indexname)::regclass) bytes
    from pg_indexes where schemaname in ('native_verify_main','native_scale_100m') order by 1,2,3`);
  out.tables = await q(`select n.nspname, c.relname, c.reltuples::bigint, c.relpages, pg_relation_size(c.oid) bytes, c.reloptions
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('native_verify_main','native_scale_100m') and c.relkind='r' order by 1,2`);
  out.statAll = await q(`select schemaname, relname, n_live_tup, n_dead_tup, last_analyze, last_autoanalyze, last_vacuum, last_autovacuum, n_mod_since_analyze
    from pg_stat_all_tables where schemaname in ('native_verify_main','native_scale_100m') order by 1,2`);
  out.stats = await q(`select schemaname, tablename, attname, null_frac, n_distinct, correlation,
      array_length(most_common_vals::text::text[],1) mcv_n, (most_common_freqs)[1:5] mcf5,
      array_length(most_common_elems::text::text[],1) mce_n, (most_common_elem_freqs)[1:5] mcef5,
      (select count(*) from unnest(histogram_bounds::text::text[])) hist_n
    from pg_stats where schemaname in ('native_verify_main','native_scale_100m') and tablename in ('customers','customers_seal_index') order by 1,2,3`);
  out.attStatTarget = await q(`select n.nspname, c.relname, a.attname, a.attstattarget from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('native_verify_main','native_scale_100m') and c.relname='customers_seal_index' and a.attnum>0 and not a.attisdropped`);
  try { await q('create extension if not exists pgstattuple'); } catch {}
  out.gin = [];
  for (const i of out.indexes.filter((x: any) => /using gin/i.test(x.indexdef))) {
    try { out.gin.push({ index: `${i.schemaname}.${i.indexname}`, ...(await q(`select * from pgstatginindex($1::regclass)`, [`${i.schemaname}.${i.indexname}`]))[0] }); }
    catch (e: any) { out.gin.push({ index: i.indexname, error: String(e.message) }); }
  }
  out.activity = await q(`select pid, backend_type, state, left(query,120) query from pg_stat_activity where backend_type<>'client backend' or query ilike '%vacuum%'`);
  out.progressVacuum = await q('select * from pg_stat_progress_vacuum');
  await writeFile('bench/results/2026-09-28-count-research/x5-state.json', JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out, null, 1));
} finally { await pool.end(); }

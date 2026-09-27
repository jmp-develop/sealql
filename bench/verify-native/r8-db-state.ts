/** Reversible measurement-only table settings and GIN/statistics snapshot. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const action = process.argv[2];
assert(['prepare', 'finish'].includes(action), 'Pass prepare or finish');
const tag = process.argv[3];
assert(tag === undefined || tag === 'r8c', 'Optional tag must be r8c');
const output = `bench/results/2026-09-28-r8-remeasure/${tag ? `${tag}-` : ''}db-state.json`;
const tables = [
  'native_scale_100m.customers', 'native_scale_100m.customers_seal_index',
  'native_scale_100m.customers_plain', 'native_verify_main.customers',
  'native_verify_main.customers_seal_index',
];
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c statement_timeout=300000' });
async function snapshot() {
  const state: any[] = [];
  for (const table of tables) {
    const rel = (await pool.query('select reloptions from pg_class where oid=$1::regclass', [table])).rows[0];
    assert(rel, `Missing ${table}`);
    const [schema, name] = table.split('.');
    const stats = (await pool.query(`select n_live_tup,n_dead_tup,last_vacuum,last_autovacuum,last_analyze,last_autoanalyze,
      vacuum_count,autovacuum_count,analyze_count,autoanalyze_count from pg_stat_all_tables
      where schemaname=$1 and relname=$2`, [schema, name])).rows[0];
    state.push({ table, reloptions: rel.reloptions, stats });
  }
  const gin: any[] = [];
  for (const schema of ['native_verify_main', 'native_scale_100m']) {
    const indexes = (await pool.query(`select schemaname,indexname from pg_indexes
      where schemaname=$1 and tablename='customers_seal_index' and indexdef ilike '%using gin%'`, [schema])).rows;
    assert.equal(indexes.length, 1, `${schema} GIN index count`);
    const index = `${schema}.${indexes[0].indexname}`;
    gin.push({ index, ...(await pool.query('select pending_pages,pending_tuples from pgstatginindex($1::regclass)', [index])).rows[0] });
  }
  return { tables: state, gin };
}
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  await mkdir('bench/results/2026-09-28-r8-remeasure', { recursive: true });
  if (action === 'prepare') {
    const before = await snapshot();
    assert(before.tables.every(x => !x.reloptions?.some((o: string) => o.startsWith('autovacuum_enabled='))),
      'Pre-existing autovacuum setting needs explicit review');
    const state: any = { preparedAt: new Date().toISOString(), before, changed: [], cancelled: [], cleaned: [] };
    await writeFile(output, JSON.stringify(state, null, 2) + '\n');
    for (const t of tables) {
      await pool.query(`alter table ${t} set (autovacuum_enabled=false)`);
      state.changed.push(t);
      await writeFile(output, JSON.stringify(state, null, 2) + '\n');
    }
    const active = (await pool.query(`select pid,query from pg_stat_activity where backend_type='autovacuum worker'
      and query like '%native_scale_100m.customers_seal_index%'`)).rows;
    for (const row of active) {
      const cancelled = (await pool.query('select pg_cancel_backend($1) cancelled', [row.pid])).rows[0].cancelled;
      state.cancelled.push({ pid: row.pid, query: row.query, cancelled });
    }
    for (const g of before.gin) if (Number(g.pending_pages) > 0) {
      const cleanedPages = (await pool.query('select gin_clean_pending_list($1::regclass) pages', [g.index])).rows[0].pages;
      state.cleaned.push({ index: g.index, pendingBefore: g.pending_pages, cleanedPages });
    }
    state.ready = await snapshot();
    await writeFile(output, JSON.stringify(state, null, 2) + '\n');
    console.log(JSON.stringify(state));
  } else {
    const state = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(state.changed, tables, 'Expected all five tables to be paused');
    state.measurementEnd = await snapshot();
    await writeFile(output, JSON.stringify(state, null, 2) + '\n');
    for (const t of [...tables].reverse()) {
      await pool.query(`alter table ${t} reset (autovacuum_enabled)`);
      state.restored ??= []; state.restored.push(t);
      await writeFile(output, JSON.stringify(state, null, 2) + '\n');
    }
    state.finishedAt = new Date().toISOString();
    state.after = await snapshot();
    for (const old of state.before.tables) {
      const now = state.after.tables.find((x: any) => x.table === old.table);
      assert.deepEqual(now.reloptions, old.reloptions, `${old.table} reloptions not restored`);
    }
    await writeFile(output, JSON.stringify(state, null, 2) + '\n');
    console.log(JSON.stringify(state));
  }
} finally { await pool.end(); }

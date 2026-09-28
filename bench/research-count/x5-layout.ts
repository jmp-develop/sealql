/** X5: physical placement of company B rows (companion + parent) in both schemas. Read-only; holds measure.lock for its I/O. */
import assert from 'node:assert/strict';
import { writeFile, stat, unlink } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const lock = '.local/research/measure.lock';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=900000' });
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  try { await stat(lock); throw Error('measure.lock held'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  await writeFile(lock, `X5 layout ${new Date().toISOString()}\n`);
  const out: any[] = [];
  try {
    for (const [schema, scope] of [['native_verify_main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], ['native_scale_100m', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']]) for (const table of ['customers_seal_index', 'customers']) {
      const r = (await pool.query(`select count(*)::int n, count(distinct (ctid::text::point)[0])::int blocks, min((ctid::text::point)[0])::bigint first_block, max((ctid::text::point)[0])::bigint last_block,
        (select relpages from pg_class where oid='${schema}.${table}'::regclass) relpages
        from ${schema}.${table} where scope_id=$1`, [scope])).rows[0];
      out.push({ schema, table, ...r }); console.log(schema, table, JSON.stringify(r));
    }
  } finally { await unlink(lock); }
  await writeFile('bench/results/2026-09-28-count-research/x5-layout.json', JSON.stringify(out, null, 1) + '\n');
} finally { await pool.end(); }

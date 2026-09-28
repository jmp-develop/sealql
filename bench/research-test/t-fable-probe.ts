// read-only probe of native_scale_100m for the company-B test
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1, options: '-c default_transaction_read_only=on' });
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
const q = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows;
console.log('tables', JSON.stringify(await q(`select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) sz from pg_stat_user_tables where schemaname='native_scale_100m' order by 1`)));
for (const t of ['customers', 'customers_seal_index', 'customers_plain']) console.log(t, JSON.stringify(await q(`select column_name, data_type from information_schema.columns where table_schema='native_scale_100m' and table_name=$1 order by ordinal_position`, [t])));
console.log('idx', JSON.stringify(await q(`select indexname, indexdef from pg_indexes where schemaname='native_scale_100m' order by 1`)));
console.log('B rows plain', JSON.stringify(await q(`select count(*) n from native_scale_100m.customers_plain where scope_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`)));
console.log('B sample', JSON.stringify(await q(`select * from native_scale_100m.customers_plain where scope_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' order by id limit 2`)));
console.log('schemas research_t', JSON.stringify(await q(`select nspname from pg_namespace where nspname like 'research_t%'`)));
await pool.end();

/** Read-only: inspect native_verify_main layout (tables, columns, indexes, sizes) for X2 research schema design. */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1, options: '-c default_transaction_read_only=on' });
try {
  await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const q = async (s: string) => (await pool.query(s)).rows;
  console.log(await q(`select table_name, column_name, data_type from information_schema.columns where table_schema='native_verify_main' order by table_name, ordinal_position`));
  console.log(await q(`select tablename, indexdef from pg_indexes where schemaname='native_verify_main'`));
  console.log(await q(`select c.relname, pg_total_relation_size(c.oid) tot, pg_relation_size(c.oid) heap from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='native_verify_main' and c.relkind in ('r','i')`));
  console.log(await q(`select count(*), count(distinct scope_id) from native_verify_main.customers`));
  console.log(await q(`select (select count(*) from native_verify_main.customers a join bench_realistic_100k.customers b using(id)) same_ids`));
  console.log(await q(`select avg(octet_length(company_ct)) c, avg(octet_length(memo_ct)) m, avg(octet_length(name_ct)) n, avg(octet_length(phone_ct)) p, avg(octet_length(address_ct)) a, avg(octet_length(email_ct)) e from native_verify_main.customers`));
  console.log(await q(`select nspname from pg_namespace where nspname like 'research%'`));
  console.log(await q(`select column_name from information_schema.columns where table_schema='bench_realistic_100k' and table_name='customers'`));
} finally { await pool.end(); }

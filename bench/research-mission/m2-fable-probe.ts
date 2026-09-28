// m2-fable: read-only probe of the disposable cluster (schemas, sizes, fixture stats). No writes.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=300000' });
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const q = async (t: string) => (await pool.query(t)).rows;
  console.log(JSON.stringify(await q(`select nspname from pg_namespace where nspname not like 'pg_%' and nspname<>'information_schema' order by 1`)));
  console.log(JSON.stringify(await q(`select schemaname||'.'||relname as rel, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) as sz from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 40`)));
  console.log(JSON.stringify(await q(`select extname, extversion from pg_extension`)));
  console.log(JSON.stringify(await q(`select name from pg_available_extensions where name in ('pgcrypto','pg_trgm','pgstattuple')`)));
  console.log(JSON.stringify(await q(`select count(*) n, count(distinct company_plain) companies, count(distinct scope_id) scopes, avg(length(memo_plain))::int memo_avg, max(length(memo_plain)) memo_max, avg(length(company_plain))::int company_avg, max(length(company_plain)) company_max, avg(length(name_plain))::int name_avg, max(length(name_plain)) name_max from bench_realistic_100k.customers`)));
  console.log(JSON.stringify(await q(`select count(*) filter (where company_plain='서울서비스 담당') c_company, count(*) filter (where memo_plain like '%서비스%') c_memo, count(*) filter (where company_plain='서울서비스 담당' and memo_plain like '%서비스%') c_and, count(*) filter (where company_plain='서울서비스 담당' or memo_plain like '%푸른달%') c_or from bench_realistic_100k.customers`)));
  console.log(JSON.stringify(await q(`select company_plain, count(*) from bench_realistic_100k.customers group by 1 order by 2 desc limit 20`)));
  console.log(JSON.stringify(await q(`select column_name, data_type from information_schema.columns where table_schema='bench_realistic_100k' and table_name='customers' order by ordinal_position`)));
} finally { await pool.end(); }

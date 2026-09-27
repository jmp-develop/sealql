import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
try {
  await assertDisposable(pool);
  if (Number((await pool.query('show port')).rows[0].port) !== 56439) throw new Error('Wrong port');
  console.log(JSON.stringify({
    columns: (await pool.query("select table_name,column_name,data_type from information_schema.columns where table_schema='bench_realistic_100k' and table_name in ('customers','tickets') order by table_name,ordinal_position")).rows,
    counts: (await pool.query("select 'customers' as t,count(*) from bench_realistic_100k.customers union all select 'tickets',count(*) from bench_realistic_100k.tickets")).rows,
    indexes: (await pool.query("select table_name,column_name from information_schema.columns where table_schema='bench_realistic_100k' and table_name like 'customers%idx' order by table_name,ordinal_position")).rows,
  }, null, 2));
} finally { await pool.end(); }

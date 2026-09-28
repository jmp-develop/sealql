/** X5: print autovacuum progress (read-only). */
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1 });
try { await assertDisposable(pool);
  console.log(JSON.stringify((await pool.query(`select a.pid, left(a.query,80) q, p.phase, p.heap_blks_scanned, p.heap_blks_total, p.indexes_processed, p.indexes_total from pg_stat_activity a left join pg_stat_progress_vacuum p using(pid) where a.backend_type='autovacuum worker'`)).rows));
} finally { await pool.end(); }

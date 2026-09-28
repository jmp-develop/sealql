/** Read-only catalog progress, not a performance query; disposable guard is in runtime. */
import {pool,S} from './b-runtime.js';
try{console.log(JSON.stringify((await pool.query(`SELECT relname,n_tup_ins::text,n_live_tup::text FROM pg_stat_user_tables WHERE schemaname=$1 ORDER BY relname`,[S])).rows));console.log(JSON.stringify((await pool.query(`SELECT state,wait_event_type,wait_event,clock_timestamp()-query_start AS age FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid()`)).rows));}finally{await pool.end();}

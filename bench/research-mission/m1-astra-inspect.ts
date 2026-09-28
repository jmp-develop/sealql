import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try {
 await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
 console.log((await pool.query(`select count(*),min(length(memo_plain)),max(length(memo_plain)),avg(length(memo_plain)) from bench_realistic_100k.customers`)).rows);
 console.log((await pool.query(`select extname from pg_extension`)).rows);
 console.log((await pool.query(`select scope_id,count(*) from bench_realistic_100k.customers group by scope_id`)).rows);
 console.log({remainingOwnSchemas:(await pool.query(`select nspname from pg_namespace where nspname='research_m1_astra_count'`)).rows});
} finally {await pool.end();}

import {Pool} from 'pg';
import assert from 'node:assert/strict';
import {assertDisposable} from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1});
try{
 await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
 console.log(JSON.stringify((await pool.query("select n.nspname,c.relname,c.reltuples::bigint estimate from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('research_u','native_verify_main','bench_realistic_100k') order by n.nspname,c.relname")).rows));
 console.log(JSON.stringify((await pool.query("select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname='research_u' and tablename in ('customers_plain','pb_4_final')")).rows));
}finally{await pool.end();}

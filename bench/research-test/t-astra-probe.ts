import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
const p=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c default_transaction_read_only=on'});
await assertDisposable(p);assert.equal(Number((await p.query('show port')).rows[0].port),56439);
for(const s of ['bench_realistic_100k','native_verify_main'])console.log(s,JSON.stringify((await p.query(`select table_name,column_name,data_type from information_schema.columns where table_schema=$1 and table_name in ('customers','tickets','customers_seal_index') order by table_name,ordinal_position`,[s])).rows));
console.log('sample',JSON.stringify((await p.query('select * from bench_realistic_100k.tickets order by id limit 1')).rows));
await p.end();

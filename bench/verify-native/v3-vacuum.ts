import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  for(const table of ['customers','customers_seal_index']){
    await pool.query(`vacuum (analyze) native_verify_main.${table}`);
    console.log(`vacuum (analyze) native_verify_main.${table}`);
  }
}finally{await pool.end();}

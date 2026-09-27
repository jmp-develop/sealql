import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { customersWriteSeal, probeSeal, sealed } from './schema.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  for(const table of ['customers','tickets'])assert.equal(Number((await pool.query(`select count(*) n from native_verify_main.${table}`)).rows[0].n),100000);
  for(const table of ['customers_write','probe'])assert.equal((await pool.query('select to_regclass($1) rel',[`native_verify_main.${table}`])).rows[0].rel,null);
  const result=spawnSync(process.execPath,['node_modules/drizzle-kit/bin.cjs','migrate','--config=bench/verify-native/drizzle.config.ts'],
    {encoding:'utf8',timeout:120000});
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);console.log(result.stdout);
  for(const seal of [customersWriteSeal,probeSeal])for(const statement of sealed.extraMigrationSql(seal))await pool.query(statement);
  console.log('extraMigrationSql applied');
}finally{await pool.end();}

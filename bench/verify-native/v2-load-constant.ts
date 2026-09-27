/** Derive a 40k-row constant-scope attack table from the read-only fixture. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { assertDisposable } from '../../test/disposable.js';
import { attackCustomersSeal, sealed, scopeId } from './schema.js';

const pool = new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:4,
  options:'-c statement_timeout=120000'});
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from bench_realistic_100k.customers where scope_id=$1',[scopeId])).rows[0].n),100000);
  const generate=spawnSync(process.execPath,['node_modules/drizzle-kit/bin.cjs','generate','--config=bench/verify-native/drizzle.config.ts'],
    {encoding:'utf8',timeout:120000});
  assert.equal(generate.status,0,`${generate.stdout}\n${generate.stderr}`);
  const migrate=spawnSync(process.execPath,['node_modules/drizzle-kit/bin.cjs','migrate','--config=bench/verify-native/drizzle.config.ts'],
    {encoding:'utf8',timeout:120000});
  assert.equal(migrate.status,0,`${migrate.stdout}\n${migrate.stderr}`);
  if (!(await pool.query("select to_regclass('native_verify_main.attack_customers_seal_index') rel")).rows[0].rel)
    for (const statement of sealed.extraMigrationSql(attackCustomersSeal)) await pool.query(statement);
  const db=drizzle(pool);
  let count=Number((await pool.query("select count(*) n from native_verify_main.attack_customers where scope_id='_'" )).rows[0].n);
  assert.equal(count%1000,0);
  let after=count?(await pool.query("select id from native_verify_main.attack_customers where scope_id='_' order by id desc limit 1")).rows[0].id as string:undefined;
  while(count<40000){
    const rows=(await pool.query(`select id,memo_plain from bench_realistic_100k.customers
      where scope_id=$1 ${after?'and id>$2':''} order by id limit 1000`,after?[scopeId,after]:[scopeId])).rows;
    assert.equal(rows.length,1000);
    await sealed.insert(db,attackCustomersSeal,rows.map(r=>({id:r.id,scopeId:'_',memo:r.memo_plain})));
    count+=1000;after=rows.at(-1).id;
    console.log(JSON.stringify({derived:count}));
  }
  assert.equal(Number((await pool.query("select count(*) n from native_verify_main.attack_customers_seal_index where scope_id='_'" )).rows[0].n),40000);
  await pool.query('analyze native_verify_main.attack_customers');
  await pool.query('analyze native_verify_main.attack_customers_seal_index');
} finally { await pool.end(); }

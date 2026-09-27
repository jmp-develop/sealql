import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { sealed, customersSeal, ticketsSeal, customersWriteSeal, probeSeal } from './schema.js';

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres' });
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const existing = (await pool.query("select nspname from pg_namespace where nspname in ('native_verify_main','native_verify_meta')")).rows;
  assert.equal(existing.length, 0, `Refusing migration against existing schemas: ${JSON.stringify(existing)}`);
  const generated = spawnSync(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'generate', '--config=bench/verify-native/drizzle.config.ts'],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  console.log(generated.stdout);
  const result = spawnSync(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'migrate', '--config=bench/verify-native/drizzle.config.ts'],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  console.log(result.stdout);
  for (const seal of [customersSeal, ticketsSeal, customersWriteSeal, probeSeal])
    for (const statement of sealed.extraMigrationSql(seal)) await pool.query(statement);
  console.log('extraMigrationSql applied');
} finally { await pool.end(); }

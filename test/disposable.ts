import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
/** Fail before any destructive fixture DDL if this is not our exact owned disposable cluster. */
export async function assertDisposable(pool:Pool) {
  const expected=fileURLToPath(new URL('../.local/pg-test',import.meta.url)).replace(/\\/g,'/').toLowerCase();
  const actual=(await pool.query('show data_directory')).rows[0].data_directory.replace(/\\/g,'/').toLowerCase();
  assert.equal(actual,expected,'Refusing destructive fixture DDL outside the owned disposable cluster');
  assert.equal((await pool.query('select current_user')).rows[0].current_user,'sealql_test');
}

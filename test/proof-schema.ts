import type { Pool } from 'pg';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { registrationOf } from '../src/adapters/drizzle/v0.45/native.js';
import { assertDisposable } from './disposable.js';
import assert from 'node:assert/strict';
import { stampMigrationSql } from '../src/core/stamp-sql.js';

/** Extend only the newly created test companion with its declared proof columns. */
export async function installProofColumns(pool: Pool, seal: object): Promise<void> {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const reg = registrationOf(seal), config = getTableConfig(reg.index);
  assert.ok(config.schema?.startsWith('test_'));
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const table = `${quote(config.schema!)}.${quote(config.name)}`;
  for (const [key, column] of Object.entries(getTableColumns(reg.index))) {
    if (key === 'scopeId' || key === 'rowId' || key.startsWith('tokens_')) continue;
    await pool.query(`alter table ${table} add column ${quote(column.name)} ${column.getSQLType()}`);
  }
  for (const constraint of config.checks) {
    const expression = new PgDialect().sqlToQuery(constraint.value).sql;
    await pool.query(`alter table ${table} add constraint ${quote(constraint.name)} check (${expression})`);
  }
  for (const statement of stampMigrationSql(config.schema!)) await pool.query(statement);
}

import assert from 'node:assert/strict';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { customer, customerSeal, configureKey, exampleSchemaName, sealed } from './schema.js';
import { insertCustomer, reindexCustomers } from './managed-writes.js';

export type DatabaseGuard = (pool: InstanceType<typeof Pool>) => Promise<void>;

export async function runExample(assertDatabase: DatabaseGuard, rootKey: Uint8Array) {
  const pool = new Pool({
    host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  });
  let ownsSchema = false;
  try {
    await assertDatabase(pool);
    assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
    const existing = await pool.query('select 1 from pg_namespace where nspname=$1', [exampleSchemaName]);
    assert.equal(existing.rowCount, 0, `Refusing to replace existing schema ${exampleSchemaName}`);
    ownsSchema = true;
    await pool.query(`create schema "${exampleSchemaName}"`);

    const migration = await generateMigration(
      generateDrizzleJson({}), generateDrizzleJson({ customer, customerSeal }),
    );
    for (const statement of migration) await pool.query(statement);
    for (const statement of sealed.extraMigrationSql(customerSeal)) await pool.query(statement);

    configureKey(rootKey);
    const db = drizzle(pool);
    assert.deepEqual(await reindexCustomers(db), { rows: 0 });

    const fixture = (await pool.query(`select id, scope_id, name_plain, phone_plain, memo_plain
      from bench_realistic_100k.customers order by id limit 1`)).rows[0];
    assert.ok(fixture, 'The read-only fixture is required');
    await insertCustomer(db, {
      id: fixture.id, tenantId: fixture.scope_id, name: fixture.name_plain,
      phone: fixture.phone_plain, memo: fixture.memo_plain,
    });

    const prefix = Array.from(fixture.name_plain.replace(/\s/g, '')).slice(0, 2).join('');
    const found = await sealed.findMany(db, customerSeal, {
      scope: fixture.scope_id, match: m => m.name.contains(prefix), limit: 20,
    });
    const count = await sealed.count(db, customerSeal, {
      scope: fixture.scope_id, match: m => m.phone.eq(fixture.phone_plain),
    });
    assert.equal(found.items.length, 1);
    assert.equal(count, 1);
    return { rows: found.items.length, count };
  } finally {
    if (ownsSchema) await pool.query(`drop schema if exists "${exampleSchemaName}" cascade`);
    await pool.end();
  }
}

/** Re-encrypt the two existing 100k fixtures through the published managed API. */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { assertDisposable } from '../../test/disposable.js';
import { customersSeal, fields, sealed, ticketsSeal, scopeId } from './schema.js';

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 4,
  options: '-c statement_timeout=120000' });
const db = drizzle(pool);
type Table = 'customers' | 'tickets';
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  for (const table of ['customers', 'tickets'] as Table[]) {
    const sourceCount = Number((await pool.query(`select count(*) n from bench_realistic_100k.${table} where scope_id=$1`, [scopeId])).rows[0].n);
    assert.equal(sourceCount, 100000);
    let count = Number((await pool.query(`select count(*) n from native_verify_main.${table} where scope_id=$1`, [scopeId])).rows[0].n);
    assert.equal(count % 1000, 0, 'Only completed batches can be resumed');
    let after = count ? (await pool.query(`select id from native_verify_main.${table} where scope_id=$1 order by id desc limit 1`, [scopeId])).rows[0].id as string : undefined;
    while (count < sourceCount) {
      const args: unknown[] = [scopeId];
      let where = 'scope_id=$1';
      if (after) { args.push(after); where += ' and id>$2'; }
      const rows = (await pool.query(`select id,scope_id${table === 'tickets' ? ',customer_id' : ''},${fields.map(f => `${f}_plain`).join(',')}
        from bench_realistic_100k.${table} where ${where} order by id limit 1000`, args)).rows;
      assert.equal(rows.length, 1000);
      const values = rows.map(row => ({ id: row.id, scopeId: row.scope_id,
        ...(table === 'tickets' ? { customerId: row.customer_id } : {}),
        ...Object.fromEntries(fields.map(f => [f, row[`${f}_plain`]])),
      }));
      if (table === 'customers') await sealed.insert(db, customersSeal, values as any);
      else await sealed.insert(db, ticketsSeal, values as any);
      count += rows.length; after = rows.at(-1).id;
      console.log(JSON.stringify({ table, count }));
    }
    assert.equal(count, 100000);
    assert.equal(Number((await pool.query(`select count(*) n from native_verify_main.${table}_seal_index where scope_id=$1`, [scopeId])).rows[0].n), count);
    await pool.query(`analyze native_verify_main.${table}`);
    await pool.query(`analyze native_verify_main.${table}_seal_index`);
  }
} finally { await pool.end(); }

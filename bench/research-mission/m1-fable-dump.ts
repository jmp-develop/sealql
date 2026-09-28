// m1-fable: read-only dump of fixture plaintext for in-memory attack simulation (derived data, kept under .local).
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
assert(existsSync('.local/research/db-free.flag'), 'db-free.flag missing');
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1, options: '-c default_transaction_read_only=on' });
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
const rows = (await pool.query(`select id::text id, name_plain name, company_plain company, address_plain address, memo_plain memo, email_plain email, phone_plain phone from bench_realistic_100k.customers order by id`)).rows;
assert.equal(rows.length, 100000);
writeFileSync('.local/research/m1-fable-src/fixture-customers.json', JSON.stringify(rows));
console.log('dumped', rows.length);
await pool.end();

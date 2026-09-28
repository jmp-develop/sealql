// Read-only export of normalized customer values for the MongoDB QE comparison.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool = new pg.Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', options: '-c default_transaction_read_only=on' });
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
const { rows } = await pool.query('select id::text, name_norm, phone_norm, address_norm, memo_norm, email_norm, company_norm from research_u.customers_plain order by id');
writeFileSync(process.argv[2], JSON.stringify(rows));
console.log('rows', rows.length);
await pool.end();

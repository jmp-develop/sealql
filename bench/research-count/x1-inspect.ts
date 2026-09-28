/** X1: read-only inspection — product count SQL text and companion layout. */
import assert from 'node:assert/strict';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';
import { assertDisposable } from '../../test/disposable.js';

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 2,
  options: '-c default_transaction_read_only=on' });
const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
const sealed = createSealed({ sealer: () => createSealer({ key: new Uint8Array(32).fill(93) }) });
const t = pgSchema('native_verify_main').table('customers', { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
  name: sealed.text('name', { search }), phone: sealed.text('phone', { search }), address: sealed.text('address', { search }),
  memo: sealed.text('memo', { search }), email: sealed.text('email', { search }), company: sealed.text('company', { search }) });
const reg = sealed.register(t, { row: 'id', scope: 'scopeId' });
const orig = Client.prototype.query;
(Client.prototype as any).query = function (...a: any[]) { const s = typeof a[0] === 'string' ? a[0] : a[0]?.text; if (/seal_idx/.test(s)) console.log('SQL:', s, JSON.stringify(a[1] ?? a[0]?.values)); return (orig as any).apply(this, a); };
try {
  await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  for (const s of ['native_verify_main', 'native_scale_100m']) {
    const r = await pool.query(`select table_name, column_name, data_type from information_schema.columns where table_schema=$1 order by table_name, ordinal_position`, [s]);
    console.log(s, JSON.stringify(r.rows.map(x => `${x.table_name}.${x.column_name}:${x.data_type}`)));
    const i = await pool.query(`select indexname, indexdef from pg_indexes where schemaname=$1`, [s]);
    console.log(JSON.stringify(i.rows));
  }
  const db = drizzle(pool);
  const n = await sealed.count(db, reg, { scope: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', match: (m: any) => m.and(m.company.eq('서울서비스 담당'), m.memo.contains('서비스')) } as any);
  console.log('count', n);
} finally { await pool.end(); }

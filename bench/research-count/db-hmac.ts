/** Read-only: server-side HMAC-SHA256 cost with built-in sha256() (no extension), for design D (DB-certified equality). */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

assert(existsSync('.local/research/db-free.flag'), 'DB busy: flag missing');
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1,
  options: '-c default_transaction_read_only=on -c statement_timeout=300000' });
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
async function t(sql: string, params: unknown[] = []) { const x: number[] = []; for (let i = 0; i < 9; i++) { const s = performance.now(); await pool.query(sql, params); if (i >= 2) x.push(performance.now() - s); } return +med(x).toFixed(2); }
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const ext = (await pool.query('select extname from pg_extension')).rows.map(r => r.extname);
  const version = (await pool.query('show server_version')).rows[0].server_version;
  const ipad = Buffer.alloc(64, 0x36 ^ 7), opad = Buffer.alloc(64, 0x5c ^ 7);
  const n = 21176;
  const base = await t(`select count(*) from generate_series(1,$1) g where md5(g::text) <> ''`, [n]);
  const hmac = await t(`select count(*) from generate_series(1,$1) g where sha256($3::bytea || sha256($2::bytea || convert_to('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(g::text,12,'0'),'UTF8'))) <> '\\x00'::bytea`, [n, ipad, opad]);
  const out = { version, extensions: ext, rows: n, baselineMs: base, hmacSha256Ms: hmac, usPerRowHmacMinusBaseline: +((hmac - base) * 1000 / n).toFixed(3) };
  console.log(out);
  writeFileSync('bench/results/2026-09-28-count-research/r2-db-hmac.json', JSON.stringify(out, null, 1));
} finally { await pool.end(); }

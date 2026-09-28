/**
 * X2 load for CBC+HMAC: research_count_x2h.customers (6 fields, CBC+HMAC envelopes, same IDs/values from
 * bench_realistic_100k.customers, read-only source) + customers_seal_index copied from native_verify_main with the same indexes.
 * Usage: rtk proxy npx tsx bench/research-count/x2-load-cbch.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { OUT, fields, scopeA, openPool, lock, unlock, json } from './x2-lib.js';
import { SCHEMA_CH, sealCH } from './x2-cbch.js';

const S = SCHEMA_CH;
const pool = await openPool(2);
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const res: any = { startedAt: new Date().toISOString() };
await lock('load-cbch');
try {
  await q(`drop schema if exists ${S} cascade`); await q(`create schema ${S}`);
  const src = (await q(`select id::text, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id`)).rows;
  assert.equal(src.length, 100000);
  await q(`create table ${S}.customers (id uuid primary key, scope_id uuid not null, ${fields.map(f => `${f}_ct bytea not null`).join(', ')})`);
  let sealMs = 0, insMs = 0;
  for (let o = 0; o < src.length; o += 2000) {
    const part = src.slice(o, o + 2000); let t = performance.now();
    const env = await sealCH(part.flatMap(r => fields.map(f => ({ value: r[f], field: f, rowId: r.id }))));
    sealMs += performance.now() - t; t = performance.now();
    await q(`insert into ${S}.customers select * from unnest($1::uuid[], $2::uuid[], ${fields.map((_, i) => `$${i + 3}::bytea[]`).join(', ')})`,
      [part.map(r => r.id), part.map(() => scopeA), ...fields.map((_, fi) => part.map((_, ri) => Buffer.from(env[ri * 6 + fi])))]);
    insMs += performance.now() - t;
  }
  res.load = { sealMs, insMs, sealUsPerRow: 1000 * sealMs / src.length };
  await q(`create table ${S}.customers_seal_index as select * from native_verify_main.customers_seal_index`);
  const defs = (await q(`select indexdef from pg_indexes where schemaname='native_verify_main' and tablename='customers_seal_index'`)).rows.map(r => r.indexdef as string);
  for (const [i, d] of defs.entries()) await q(d.replace(/INDEX \S+ ON native_verify_main\.customers_seal_index/, `INDEX x2h_idx_${i} ON ${S}.customers_seal_index`));
  for (const t of ['customers', 'customers_seal_index']) await q(`vacuum (analyze) ${S}.${t}`);
  res.sizes = (await q(`select c.relname rel, pg_relation_size(c.oid) heap, coalesce(pg_total_relation_size(nullif(c.reltoastrelid,0)),0) toast, pg_indexes_size(c.oid) idx, pg_total_relation_size(c.oid) total
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname='${S}'`)).rows;
  res.ctAvgBytes = (await q(`select ${fields.map(f => `avg(octet_length(${f}_ct))::float8 ${f}`).join(',')} from ${S}.customers`)).rows[0];
  res.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/x2-load-cbch.json`, json(res)); console.log(json(res));
} finally { unlock(); await pool.end(); }

/**
 * X6 load: research_count_x6 = X4 layout (CBC+HMAC parent, exact copy of product companion + indexes), derived from
 * bench_realistic_100k (read-only), plus STORAGE VARIANT customers_seal_index_ct = companion rows + the same 6 ciphertext
 * bytes copied from the parent (no new information; same AAD binding row/field/scope). Same indexes.
 * Usage: rtk proxy npx tsx bench/research-count/x6-load.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { OUT, openPool, json } from './x2-lib.js';
import { fields, scopeA, prefixes, sealValue, open } from './x4-lib.js';
import { SCHEMA6 as S, lock, unlock } from './x6-lib.js';

const pool = await openPool(2);
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const res: any = { startedAt: new Date().toISOString(), schema: S };
await lock('load');
try {
  await q(`drop schema if exists ${S} cascade`); await q(`create schema ${S}`);
  const src = (await q(`select id::text, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id`)).rows;
  assert.equal(src.length, 100000);
  await q(`create table ${S}.customers (id uuid primary key, scope_id uuid not null, ${fields.map(f => `${f}_ct bytea not null`).join(', ')})`);
  const pre = prefixes(scopeA);
  for (let o = 0; o < src.length; o += 2000) {
    const part = src.slice(o, o + 2000);
    const env = await Promise.all(part.flatMap(r => fields.map(f => sealValue(pre, f, r.id, r[f]))));
    await q(`insert into ${S}.customers select * from unnest($1::uuid[], $2::uuid[], ${fields.map((_, i) => `$${i + 3}::bytea[]`).join(', ')})`,
      [part.map(r => r.id), part.map(() => scopeA), ...fields.map((_, fi) => part.map((_, ri) => Buffer.from(env[ri * 6 + fi])))]);
  }
  const defs = (await q(`select indexdef from pg_indexes where schemaname='native_verify_main' and tablename='customers_seal_index'`)).rows.map(r => r.indexdef as string);
  await q(`create table ${S}.customers_seal_index as select * from native_verify_main.customers_seal_index`);
  await q(`create table ${S}.customers_seal_index_ct as select i.*, ${fields.map(f => `c.${f}_ct`).join(', ')} from ${S}.customers_seal_index i join ${S}.customers c on c.id = i.row_id`);
  for (const t of ['customers_seal_index', 'customers_seal_index_ct'])
    for (const [i, d] of defs.entries()) await q(d.replace(/INDEX \S+ ON native_verify_main\.customers_seal_index/, `INDEX ${t === 'customers_seal_index' ? 'x6' : 'x6ct'}_idx_${i} ON ${S}.${t}`));
  res.companionIndexes = defs;
  for (const t of ['customers', 'customers_seal_index', 'customers_seal_index_ct']) await q(`vacuum (analyze) ${S}.${t}`);
  assert.equal(Number((await q(`select count(*) n from ${S}.customers_seal_index_ct`)).rows[0].n), 100000);
  // open check on 1,000 rows of the copy table (same bytes must authenticate against row/field/scope)
  const sample = src.filter((_, i) => i % 100 === 0); const byId = new Map(sample.map(r => [r.id, r]));
  const cts = (await q(`select row_id::text id, ${fields.map(f => `${f}_ct`).join(',')} from ${S}.customers_seal_index_ct where row_id = any($1::uuid[])`, [sample.map(r => r.id)])).rows;
  const vals = await open(cts.flatMap(r => fields.map(f => ({ env: new Uint8Array(r[`${f}_ct`]), rowId: r.id, pre: pre.get(f)! }))));
  cts.forEach((r, i) => fields.forEach((f, k) => assert.equal(vals[i * 6 + k], byId.get(r.id)![f])));
  res.openCheck = { rows: cts.length, fields: vals.length, equal: true };
  res.sizes = (await q(`select c.relname rel, pg_relation_size(c.oid) heap, coalesce(pg_total_relation_size(nullif(c.reltoastrelid,0)),0) toast, pg_indexes_size(c.oid) idx, pg_total_relation_size(c.oid) total
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname='${S}' order by 1`)).rows;
  res.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/x6-load.json`, json(res)); console.log(json(res));
} finally { unlock(); await pool.end(); }

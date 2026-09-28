/**
 * X4 load: research_count_x4 derived from bench_realistic_100k.customers (read-only source, same IDs/values, scope A).
 *  - customers: 6 fields sealed in the X4 CBC+HMAC format.
 *  - customers_seal_index: exact copy of native_verify_main.customers_seal_index (product tokens, key fill(93)) + same indexes.
 *  - checks: 1,000 rows x 12 profiles tokens recomputed with src/core == copy; 1,000 rows x 6 fields opened == fixture plaintext.
 * Usage: rtk proxy npx tsx bench/research-count/x4-load.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { OUT, openPool, storedProfiles, layout, ring, tokenCache, json } from './x2-lib.js';
import { SCHEMA4 as S, fields, scopeA, prefixes, sealValue, open, lock, unlock } from './x4-lib.js';

const pool = await openPool(2);
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const res: any = { startedAt: new Date().toISOString() };
await lock('load');
try {
  await q(`drop schema if exists ${S} cascade`); await q(`create schema ${S}`);
  const src = (await q(`select id::text, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id`)).rows;
  assert.equal(src.length, 100000);
  await q(`create table ${S}.customers (id uuid primary key, scope_id uuid not null, ${fields.map(f => `${f}_ct bytea not null`).join(', ')})`);
  const pre = prefixes(scopeA); let sealMs = 0, insMs = 0;
  for (let o = 0; o < src.length; o += 2000) {
    const part = src.slice(o, o + 2000); let t = performance.now();
    const env = await Promise.all(part.flatMap(r => fields.map(f => sealValue(pre, f, r.id, r[f]))));
    sealMs += performance.now() - t; t = performance.now();
    await q(`insert into ${S}.customers select * from unnest($1::uuid[], $2::uuid[], ${fields.map((_, i) => `$${i + 3}::bytea[]`).join(', ')})`,
      [part.map(r => r.id), part.map(() => scopeA), ...fields.map((_, fi) => part.map((_, ri) => Buffer.from(env[ri * 6 + fi])))]);
    insMs += performance.now() - t;
  }
  res.load = { sealMs, insMs, sealUsPerRow: 1000 * sealMs / src.length };
  await q(`create table ${S}.customers_seal_index as select * from native_verify_main.customers_seal_index`);
  const defs = (await q(`select indexdef from pg_indexes where schemaname='native_verify_main' and tablename='customers_seal_index'`)).rows.map(r => r.indexdef as string);
  for (const [i, d] of defs.entries()) await q(d.replace(/INDEX \S+ ON native_verify_main\.customers_seal_index/, `INDEX x4_idx_${i} ON ${S}.customers_seal_index`));
  res.companionIndexes = defs;
  for (const t of ['customers', 'customers_seal_index']) await q(`vacuum (analyze) ${S}.${t}`);
  // token check (src/core) + open check on 1,000 rows
  const sample = src.filter((_, i) => i % 100 === 0);
  const got = new Map((await q(`select row_id::text id, * from ${S}.customers_seal_index where row_id = any($1::uuid[])`, [sample.map(r => r.id)])).rows.map(r => [r.id, r]));
  let checked = 0;
  for (const r of sample) for (const p of storedProfiles) {
    const expect = await searchTokens(ring, scopeA, p, searchPieces(p, r[p.fieldId], 'write'), tokenCache);
    const stored = (got.get(r.id)[layout[p.indexId].tokens] as string[]).map(String);
    assert.deepEqual([...stored].sort(), [...expect].sort(), `${r.id} ${p.indexId}`); checked++;
  }
  res.tokenCheck = { rows: sample.length, columnsCompared: checked, equal: true };
  const cts = (await q(`select id::text, ${fields.map(f => `${f}_ct`).join(',')} from ${S}.customers where id = any($1::uuid[]) order by id`, [sample.map(r => r.id)])).rows;
  assert.equal(cts.length, sample.length);
  const vals = await open(cts.flatMap(r => fields.map(f => ({ env: new Uint8Array(r[`${f}_ct`]), rowId: r.id, pre: pre.get(f)! }))));
  const byId = new Map(sample.map(r => [r.id, r]));
  cts.forEach((r, i) => fields.forEach((f, k) => assert.equal(vals[i * 6 + k], byId.get(r.id)![f], `${r.id} ${f}`)));
  res.openCheck = { rows: cts.length, fields: vals.length, equal: true };
  res.sizes = (await q(`select c.relname rel, pg_relation_size(c.oid) heap, coalesce(pg_total_relation_size(nullif(c.reltoastrelid,0)),0) toast, pg_indexes_size(c.oid) idx, pg_total_relation_size(c.oid) total
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('${S}','native_verify_main') and c.relname='customers'`)).rows;
  const avg = (s: string) => `select ${fields.map(f => `avg(octet_length(${f}_ct))::float8 ${f}`).join(',')} from ${s}.customers`;
  res.ctAvgBytes = { x4: (await q(avg(S))).rows[0], gcmProduct: (await q(avg('native_verify_main'))).rows[0] };
  res.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/x4-load.json`, json(res)); console.log(json(res));
} finally { unlock(); await pool.end(); }

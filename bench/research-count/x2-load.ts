/**
 * X2 load: research_count_x2 derived from bench_realistic_100k.customers (read-only source, same IDs/values).
 *  - customers: 6 fields in B3 format (sealB3), scope A.
 *  - customers_seal_index: exact copy of native_verify_main.customers_seal_index (product tokens, key fill(93), scope A)
 *    with the same indexes; 1,000 sample rows recomputed with src/core searchPieces/searchTokens and compared.
 *  - r1_tags / idx_r1: R1-A exact tags (company, phone) + R1-B all-substring tags (name, phone); idx_r1 = companion + tags.
 * Usage: rtk proxy npx tsx bench/research-count/x2-load.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { SCHEMA, OUT, fields, scopeA, openPool, lock, unlock, sealB3, r1Row, storedProfiles, layout, ring, tokenCache, json } from './x2-lib.js';

const pool = await openPool(2);
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const res: any = { startedAt: new Date().toISOString() };
await lock('load');
try {
  await q(`drop schema if exists ${SCHEMA} cascade`);
  await q(`create schema ${SCHEMA}`);
  const src = (await q(`select id::text, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id`)).rows;
  assert.equal(src.length, 100000);
  // --- B3 parent ---
  await q(`create table ${SCHEMA}.customers (id uuid primary key, scope_id uuid not null, ${fields.map(f => `${f}_ct bytea not null`).join(', ')})`);
  let sealMs = 0, insMs = 0;
  for (let o = 0; o < src.length; o += 2000) {
    const part = src.slice(o, o + 2000);
    let t = performance.now();
    const env = await sealB3(part.flatMap(r => fields.map(f => ({ value: r[f], field: f, rowId: r.id }))));
    sealMs += performance.now() - t; t = performance.now();
    await q(`insert into ${SCHEMA}.customers select * from unnest($1::uuid[], $2::uuid[], ${fields.map((_, i) => `$${i + 3}::bytea[]`).join(', ')})`,
      [part.map(r => r.id), part.map(() => scopeA), ...fields.map((_, fi) => part.map((_, ri) => Buffer.from(env[ri * 6 + fi])))]);
    insMs += performance.now() - t;
  }
  res.b3Load = { sealMs, insMs, sealUsPerRow: 1000 * sealMs / src.length };
  // --- companion copy ---
  await q(`create table ${SCHEMA}.customers_seal_index as select * from native_verify_main.customers_seal_index`);
  const defs = (await q(`select indexdef from pg_indexes where schemaname='native_verify_main' and tablename='customers_seal_index'`)).rows.map(r => r.indexdef as string);
  const idxDefs = (table: string) => defs.map((d, i) => d.replace(/INDEX \S+ ON native_verify_main\.customers_seal_index/, `INDEX ${table}_x2_${i} ON ${SCHEMA}.${table}`));
  for (const d of idxDefs('customers_seal_index')) await q(d);
  res.companionIndexes = defs;
  // --- token recomputation check (src/core) on 1,000 rows ---
  const sample = src.filter((_, i) => i % 100 === 0);
  const got = new Map((await q(`select row_id::text id, * from ${SCHEMA}.customers_seal_index where row_id = any($1::uuid[])`, [sample.map(r => r.id)])).rows.map(r => [r.id, r]));
  let checked = 0;
  for (const r of sample) for (const p of storedProfiles) {
    const expect = await searchTokens(ring, scopeA, p, searchPieces(p, r[p.fieldId], 'write'), tokenCache);
    const stored = (got.get(r.id)[layout[p.indexId].tokens] as string[]).map(String);
    assert.deepEqual([...stored].sort(), [...expect].sort(), `${r.id} ${p.indexId}`); checked++;
  }
  res.tokenCheck = { rows: sample.length, columnsCompared: checked, equal: true };
  // --- R1 tags ---
  await q(`create table ${SCHEMA}.r1_tags (scope_id uuid not null, row_id uuid not null, company_nonce bytea not null, company_tag bytea not null,
    phone_nonce bytea not null, phone_tag bytea not null, name_snonce bytea not null, name_subtags bytea[] not null, phone_snonce bytea not null, phone_subtags bytea[] not null, primary key (scope_id, row_id))`);
  let r1Ms = 0, r1Ins = 0, nSub = 0;
  for (let o = 0; o < src.length; o += 1000) {
    const part = src.slice(o, o + 1000); let t = performance.now();
    const tags = await Promise.all(part.map(r => r1Row(r.id, r, ['company', 'phone'], ['name', 'phone'])));
    r1Ms += performance.now() - t; t = performance.now();
    const params: unknown[] = []; const vals: string[] = [];
    part.forEach((r, i) => { const x = tags[i] as any; nSub += x.name_subtags.length + x.phone_subtags.length;
      const row = [scopeA, r.id, x.company_nonce, x.company_tag, x.phone_nonce, x.phone_tag, x.name_snonce, x.name_subtags, x.phone_snonce, x.phone_subtags].map(v => v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v);
      vals.push(`(${row.map(v => { params.push(v); return `$${params.length}`; }).join(',')})`); });
    await q(`insert into ${SCHEMA}.r1_tags values ${vals.join(',')}`, params);
    r1Ins += performance.now() - t;
  }
  res.r1Load = { computeMs: r1Ms, insertMs: r1Ins, subTagsTotal: nSub };
  await q(`create table ${SCHEMA}.idx_r1 as select c.*, r.company_nonce, r.company_tag, r.phone_nonce, r.phone_tag, r.name_snonce, r.name_subtags, r.phone_snonce, r.phone_subtags
    from ${SCHEMA}.customers_seal_index c join ${SCHEMA}.r1_tags r using (scope_id, row_id)`);
  for (const d of idxDefs('idx_r1')) await q(d);
  for (const t of ['customers', 'customers_seal_index', 'r1_tags', 'idx_r1']) await q(`vacuum (analyze) ${SCHEMA}.${t}`);
  res.sizes = (await q(`select n.nspname||'.'||c.relname rel, c.reltuples::bigint tuples, pg_relation_size(c.oid) heap, coalesce(pg_total_relation_size(nullif(c.reltoastrelid,0)),0) toast,
    pg_indexes_size(c.oid) idx, pg_total_relation_size(c.oid) total from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and ((n.nspname='${SCHEMA}') or (n.nspname='native_verify_main' and c.relname in ('customers','customers_seal_index')))`)).rows;
  const avg = (s: string) => fields.map(f => `avg(octet_length(${f}_ct))::float8 ${f}`).join(',') + ` from ${s}.customers`;
  res.ctAvgBytes = { b3: (await q(`select ${avg(SCHEMA)}`)).rows[0], gcm: (await q(`select ${avg('native_verify_main')}`)).rows[0] };
  res.r1AvgBytes = (await q(`select avg(pg_column_size(company_nonce)+pg_column_size(company_tag))::float8 exact_pair, avg(pg_column_size(name_subtags))::float8 name_subtags,
    avg(pg_column_size(phone_subtags))::float8 phone_subtags, avg(cardinality(name_subtags))::float8 name_n, avg(cardinality(phone_subtags))::float8 phone_n from ${SCHEMA}.r1_tags`)).rows[0];
  res.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/x2-load.json`, json(res));
  console.log(json(res));
} finally { unlock(); await pool.end(); }

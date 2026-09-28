/**
 * X2 write cost (under measure.lock): encrypt/compute + insert 1,000 fixture rows into research_count_x2 write tables.
 *  gcm   : product Sealer.seal (AES-256-GCM) x 6 fields           -> w_gcm
 *  cbch  : CBC+HMAC-SHA-256 EtM (x2-cbch.ts) x 6 fields        -> w_cbch
 *  b3    : sealB3 (CBC + batched PMAC) x 6 fields                -> w_b3
 *  tokens: product searchTokens, 12 profiles (common to gcm/b3)  -> w_idx (same indexes as the product companion)
 *  r1a   : R1-A exact tags, 6 fields (nonce16 + SHA-256 tag32)   -> w_r1a
 *  r1b4  : R1-B all-substring tags, name/phone/email/company     -> w_r1b4
 *  r1b6  : R1-B all-substring tags, all 6 fields                 -> w_r1b6
 * Warmup 2, 7 rotated runs, truncate between runs (not timed). Raw insert via pg, not the product managed-write path.
 * Usage: rtk proxy npx tsx bench/research-count/x2-write.ts
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { sealCH } from './x2-cbch.js';
import { SCHEMA, OUT, fields, scopeA, openPool, lock, unlock, sealB3, r1Row, storedProfiles, layout, ring, tokenCache, sealer, spec, median, json } from './x2-lib.js';

const pool = await openPool(2);
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const S = SCHEMA;
const res: any = { startedAt: new Date().toISOString(), rows: 1000 };
const tokenCols = Object.values(layout).map(x => x.tokens);
const src = (await q(`select id::text, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id limit 1000`)).rows;
const buf = (v: any) => v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v;
async function valuesInsert(table: string, rows: unknown[][]) {
  const params: unknown[] = []; const vals = rows.map(r => `(${r.map(v => { params.push(buf(v)); return `$${params.length}`; }).join(',')})`);
  await q(`insert into ${S}.${table} values ${vals.join(',')}`, params);
}
const ctInsert = (table: string, env: Uint8Array[]) => q(`insert into ${S}.${table} select * from unnest($1::uuid[], $2::uuid[], ${fields.map((_, i) => `$${i + 3}::bytea[]`).join(', ')})`,
  [src.map(r => r.id), src.map(() => scopeA), ...fields.map((_, fi) => src.map((_, ri) => Buffer.from(env[ri * 6 + fi])))]);
const sub4 = ['name', 'phone', 'email', 'company'];
const variants: Record<string, { table: string; crypto: () => Promise<unknown>; insert: (x: any) => Promise<unknown> }> = {
  gcm: { table: 'w_gcm', crypto: () => Promise.all(src.flatMap(r => fields.map(f => sealer.seal(r[f], { modelId: 'customers', fieldId: f, keyScopeId: ring.keyScopeId, scopeId: scopeA, rowId: r.id, spec }, ring)))), insert: env => ctInsert('w_gcm', env) },
  cbch: { table: 'w_cbch', crypto: () => sealCH(src.flatMap(r => fields.map(f => ({ value: r[f], field: f, rowId: r.id })))), insert: env => ctInsert('w_cbch', env) },
  b3: { table: 'w_b3', crypto: () => sealB3(src.flatMap(r => fields.map(f => ({ value: r[f], field: f, rowId: r.id })))), insert: env => ctInsert('w_b3', env) },
  tokens: { table: 'w_idx', crypto: () => Promise.all(src.map(async r => [scopeA, r.id, ...await Promise.all(storedProfiles.map(p => searchTokens(ring, scopeA, p, searchPieces(p, r[p.fieldId], 'write'), tokenCache)))])),
    insert: rows => valuesInsert('w_idx', rows) },
  r1a: { table: 'w_r1a', crypto: () => Promise.all(src.map(async r => { const x: any = await r1Row(r.id, r, fields, []); return [scopeA, r.id, ...fields.flatMap(f => [x[`${f}_nonce`], x[`${f}_tag`]])]; })), insert: rows => valuesInsert('w_r1a', rows) },
  r1b4: { table: 'w_r1b4', crypto: () => Promise.all(src.map(async r => { const x: any = await r1Row(r.id, r, [], sub4); return [scopeA, r.id, ...sub4.flatMap(f => [x[`${f}_snonce`], x[`${f}_subtags`]])]; })), insert: rows => valuesInsert('w_r1b4', rows) },
  r1b6: { table: 'w_r1b6', crypto: () => Promise.all(src.map(async r => { const x: any = await r1Row(r.id, r, [], fields); return [scopeA, r.id, ...fields.flatMap(f => [x[`${f}_snonce`], x[`${f}_subtags`]])]; })), insert: rows => valuesInsert('w_r1b6', rows) },
};
await lock('write');
try {
  for (const t of Object.values(variants)) await q(`drop table if exists ${S}.${t.table}`);
  for (const t of ['w_gcm', 'w_cbch', 'w_b3']) await q(`create table ${S}.${t} (id uuid primary key, scope_id uuid not null, ${fields.map(f => `${f}_ct bytea not null`).join(', ')})`);
  await q(`create table ${S}.w_idx (scope_id uuid not null, row_id uuid not null, ${tokenCols.map(c => `${c} bigint[] not null`).join(', ')})`);
  const defs = (await q(`select indexdef from pg_indexes where schemaname='native_verify_main' and tablename='customers_seal_index'`)).rows.map(r => r.indexdef as string);
  for (const [i, d] of defs.entries()) await q(d.replace(/INDEX \S+ ON native_verify_main\.customers_seal_index/, `INDEX w_idx_x2_${i} ON ${S}.w_idx`));
  await q(`create table ${S}.w_r1a (scope_id uuid not null, row_id uuid not null, ${fields.map(f => `${f}_nonce bytea not null, ${f}_tag bytea not null`).join(', ')}, primary key (scope_id, row_id))`);
  await q(`create table ${S}.w_r1b4 (scope_id uuid not null, row_id uuid not null, ${sub4.map(f => `${f}_snonce bytea not null, ${f}_subtags bytea[] not null`).join(', ')}, primary key (scope_id, row_id))`);
  await q(`create table ${S}.w_r1b6 (scope_id uuid not null, row_id uuid not null, ${fields.map(f => `${f}_snonce bytea not null, ${f}_subtags bytea[] not null`).join(', ')}, primary key (scope_id, row_id))`);
  const names = Object.keys(variants); const runs: Record<string, { cryptoMs: number; insertMs: number; totalMs: number }[]> = Object.fromEntries(names.map(n => [n, []]));
  for (let i = 0; i < 9; i++) for (const n of names.map((_, k) => names[(k + i) % names.length])) {
    const v = variants[n]; await q(`truncate ${S}.${v.table}`);
    const t0 = performance.now(); const x = await v.crypto(); const t1 = performance.now(); await v.insert(x); const t2 = performance.now();
    if (i >= 2) runs[n].push({ cryptoMs: t1 - t0, insertMs: t2 - t1, totalMs: t2 - t0 });
  }
  res.variants = {};
  for (const n of names) {
    const r = runs[n]; const t = variants[n].table;
    const size = (await q(`select pg_total_relation_size('${S}.${t}') total, pg_relation_size('${S}.${t}') heap, pg_indexes_size('${S}.${t}') idx, count(*) n, avg(pg_column_size(x.*))::float8 row_bytes from ${S}.${t} x`)).rows[0];
    res.variants[n] = { cryptoMs: +median(r.map(x => x.cryptoMs)).toFixed(2), insertMs: +median(r.map(x => x.insertMs)).toFixed(2), totalMs: +median(r.map(x => x.totalMs)).toFixed(2),
      usPerRow: +(median(r.map(x => x.totalMs)) * 1000 / src.length).toFixed(1), cryptoUsPerRow: +(median(r.map(x => x.cryptoMs)) * 1000 / src.length).toFixed(1), insertUsPerRow: +(median(r.map(x => x.insertMs)) * 1000 / src.length).toFixed(1),
      tableTotalBytesPerRow: +(Number(size.total) / Number(size.n)).toFixed(1), avgRowBytes: +Number(size.row_bytes).toFixed(1), rows: Number(size.n), runs: r };
    console.log(n, JSON.stringify({ ...res.variants[n], runs: undefined }));
  }
  res.ctAvgBytes = { gcm: (await q(`select ${fields.map(f => `avg(octet_length(${f}_ct))::float8 ${f}`).join(',')} from ${S}.w_gcm`)).rows[0], cbch: (await q(`select ${fields.map(f => `avg(octet_length(${f}_ct))::float8 ${f}`).join(',')} from ${S}.w_cbch`)).rows[0], b3: (await q(`select ${fields.map(f => `avg(octet_length(${f}_ct))::float8 ${f}`).join(',')} from ${S}.w_b3`)).rows[0] };
  res.r1bTagCounts = (await q(`select ${fields.map(f => `avg(cardinality(${f}_subtags))::float8 ${f}`).join(',')} from ${S}.w_r1b6`)).rows[0];
  res.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/x2-write.json`, json(res));
} finally { unlock(); await pool.end(); }

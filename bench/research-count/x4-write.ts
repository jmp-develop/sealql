/**
 * X4 write cost (under measure.lock): 1,000 fixture rows x 6 fields, current GCM (src Sealer.seal) vs X4 CBC+HMAC.
 *  encrypt only (per row, fields in parallel like a managed insert) and full insert (encrypt + 1 INSERT per row, autocommit)
 *  into research_count_x4w (created here, dropped at the end). Warm-up 2 + 7 rotated, medians. Ciphertext sizes.
 * Usage: rtk proxy npx tsx bench/research-count/x4-write.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { OUT, openPool, sealer, ring, spec, json, median } from './x2-lib.js';
import { fields, scopeA, prefixes, sealValue, open, lock, unlock, now } from './x4-lib.js';

const pool = await openPool(2);
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const S = 'research_count_x4w';
const res: any = { startedAt: new Date().toISOString(), rows: 1000 };
try {
  const src = (await q(`select id::text, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id limit 1000`)).rows;
  assert.equal(src.length, 1000);
  const gcmRow = (r: any) => Promise.all(fields.map(f => sealer.seal(r[f], { modelId: 'customers', fieldId: f, keyScopeId: ring.keyScopeId, scopeId: scopeA, rowId: r.id, spec }, ring)));
  const x4Row = (r: any, pre: ReturnType<typeof prefixes>) => Promise.all(fields.map(f => sealValue(pre, f, r.id, r[f])));
  await q(`drop schema if exists ${S} cascade`); await q(`create schema ${S}`);
  for (const t of ['gcm', 'x4']) await q(`create table ${S}.${t} (id uuid primary key, scope_id uuid not null, ${fields.map(f => `${f}_ct bytea not null`).join(', ')})`);
  const ins = (t: string, r: any, env: Uint8Array[]) => q(`insert into ${S}.${t} values ($1,$2,${fields.map((_, i) => `$${i + 3}`).join(',')})`, [r.id, scopeA, ...env.map(e => Buffer.from(e))]);
  const paths: Record<string, () => Promise<number>> = {
    gcmEncrypt: async () => { const s = now(); for (const r of src) await gcmRow(r); return now() - s; },
    x4Encrypt: async () => { const s = now(); const pre = prefixes(scopeA); for (const r of src) await x4Row(r, pre); return now() - s; },
    gcmInsert: async () => { await q(`truncate ${S}.gcm`); const s = now(); for (const r of src) await ins('gcm', r, await gcmRow(r)); return now() - s; },
    x4Insert: async () => { await q(`truncate ${S}.x4`); const s = now(); const pre = prefixes(scopeA); for (const r of src) await ins('x4', r, await x4Row(r, pre)); return now() - s; },
  };
  await lock('write');
  try {
    const names = Object.keys(paths); const runs: Record<string, number[]> = Object.fromEntries(names.map(n => [n, []]));
    for (let i = 0; i < 9; i++) for (const n of names.map((_, k) => names[(k + i) % names.length])) { const ms = await paths[n](); if (i >= 2) runs[n].push(ms); }
    res.usPerRow = Object.fromEntries(names.map(n => [n, +(median(runs[n]) * 1000 / src.length).toFixed(1)]));
    res.runsMs = runs;
  } finally { unlock(); }
  // correctness + sizes
  const back = (await q(`select id::text, ${fields.map(f => `${f}_ct`).join(',')} from ${S}.x4 order by id`)).rows; const pre = prefixes(scopeA);
  const vals = await open(back.flatMap(r => fields.map(f => ({ env: new Uint8Array(r[`${f}_ct`]), rowId: r.id, pre: pre.get(f)! }))));
  back.forEach((r, i) => fields.forEach((f, k) => assert.equal(vals[i * 6 + k], src.find(x => x.id === r.id)[f])));
  const avg = (t: string) => q(`select ${fields.map(f => `avg(octet_length(${f}_ct))::float8 ${f}`).join(',')}, avg(${fields.map(f => `octet_length(${f}_ct)`).join('+')})::float8 row_total, pg_total_relation_size('${S}.${t}') table_bytes from ${S}.${t}`).then(r => r.rows[0]);
  res.ctBytes = { gcm: await avg('gcm'), x4: await avg('x4') };
  res.note = 'GCM envelope = 1+12+|P|+16 (29 B overhead); X4 = 1+16+pad16(|P|+1)+32 (49-64 B overhead). Product managed insert also computes 12 token profiles (X2: ~4.2 ms/row), not included here.';
  res.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/x4-write.json`, json(res)); console.log(json(res));
} finally { await q(`drop schema if exists ${S} cascade`); await pool.end(); }

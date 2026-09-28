/**
 * Test A (row verification) in the 100M multi-tenant environment: build judgment tags for company B only.
 * Reads native_scale_100m.customers_plain (scope B, 100k rows) READ-ONLY; writes new schema research_t_fable.b_tags
 * (row_id, per-field salt, per-piece judgment tags jt_<f> bigint[] for all substrings 2..K + prefixes/suffixes 2..K,
 * exact-value tag jx_<f>). Candidate selection later uses the existing 100M companion GIN unchanged.
 * Usage: rtk proxy npx tsx bench/research-test/t-fable-load.ts
 */
import assert from 'node:assert/strict';
import { hash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { normalizeText } from '../../src/core/search-tokens.js';
import { fields, type Field } from '../verify-native/r8-cases.js';

export const S = 'research_t_fable', OUT = 'bench/results/2026-09-28-count-test', K = 8;
export const scopeB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOCK = '.local/research/measure.lock';
export async function lock(name: string) { for (;;) { if (!existsSync(LOCK)) { try { writeFileSync(LOCK, `M1T ${name} ${new Date().toISOString()}\n`, { flag: 'wx' }); return; } catch { /* raced */ } } console.log('measure.lock held; waiting'); await new Promise(r => setTimeout(r, 30_000)); } }
export function unlock() { if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('M1T ')) unlinkSync(LOCK); }
const jKey = Buffer.alloc(32, 3);
const pads = (key: Buffer) => { const i = Buffer.alloc(64, 0x36), o = Buffer.alloc(64, 0x5c); for (let k = 0; k < key.length; k++) { i[k] ^= key[k]; o[k] ^= key[k]; } return { i, o }; };
const jp = pads(jKey);
const hmacJ = (msg: string) => hash('sha256', Buffer.concat([jp.o, hash('sha256', Buffer.concat([jp.i, Buffer.from(msg)]), 'buffer')]), 'buffer');
export const norm = (v: string) => normalizeText(v, 'legacy-text-v1');
export const b64 = (d: Buffer) => BigInt.asIntN(64, d.readBigUInt64BE(0)).toString();
export const kPiece = (field: string, kind: string, piece: string) => hmacJ([scopeB, field, kind, piece].join('\u0000'));
export const judge = (k: Buffer, salt: Buffer) => b64(hash('sha256', Buffer.concat([k, salt]), 'buffer'));
export type Pieces = { kind: string; piece: string }[];
export function kgramPieces(value: string, k = K): Pieces {
  const c = Array.from(norm(value)); const out: Pieces = []; const seen = new Set<string>();
  const add = (kind: string, piece: string) => { const id = kind + '\u0000' + piece; if (!seen.has(id)) { seen.add(id); out.push({ kind, piece }); } };
  if (c.length < 2) return out;
  for (let l = 2; l <= k; l++) for (let i = 0; i + l <= c.length; i++) add('g', c.slice(i, i + l).join(''));
  for (let l = 2; l <= Math.min(k, c.length); l++) { add('s', c.slice(0, l).join('')); add('e', c.slice(c.length - l).join('')); }
  return out;
}
export const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 4, options: '-c statement_timeout=0' });
export async function guard() { await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439); }

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('t-fable-load.ts')) {
  await guard(); mkdirSync(OUT, { recursive: true });
  await lock('load'); const res: any = { startedAt: new Date().toISOString(), schema: S, K, scope: scopeB };
  try {
    const q = (s: string, p: unknown[] = []) => pool.query(s, p);
    await q(`drop schema if exists ${S} cascade`); await q(`create schema ${S}`);
    await q(`create table ${S}.b_tags (row_id uuid primary key, ${fields.map(f => `salt_${f} bytea not null, jt_${f} bigint[] not null, jx_${f} bigint not null`).join(', ')})`);
    const t0 = performance.now(); let n = 0, tags = 0, encodeMs = 0;
    for (;;) {
      const rows: ({ id: string } & Record<Field, string>)[] = (await q(`select id::text id, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from native_scale_100m.customers_plain where scope_id=$1 order by id offset $2 limit 500`, [scopeB, n])).rows;
      if (!rows.length) break;
      const te = performance.now(); const vals: unknown[] = [];
      for (const r of rows) {
        vals.push(r.id);
        for (const f of fields) { const salt = randomBytes(8); const ps = kgramPieces(r[f]); const jt = ps.map(p => judge(kPiece(f, p.kind, p.piece), salt)); tags += jt.length + 1; vals.push(salt, jt, judge(kPiece(f, 'x', norm(r[f])), salt)); }
      }
      encodeMs += performance.now() - te;
      const w = 1 + fields.length * 3;
      await q(`insert into ${S}.b_tags values ${rows.map((_, r) => `(${Array.from({ length: w }, (_, c) => `$${r * w + c + 1}`).join(',')})`).join(',')}`, vals);
      n += rows.length; if (n % 20000 === 0) console.log('loaded', n);
    }
    assert.equal(n, 100000);
    await q(`vacuum (analyze) ${S}.b_tags`);
    res.rows = n; res.tagsPerRow = +(tags / n).toFixed(1); res.encodeMs = +encodeMs.toFixed(0); res.totalMs = +(performance.now() - t0).toFixed(0);
    res.sizes = (await q(`select c.relname rel, pg_relation_size(c.oid) heap, coalesce(pg_total_relation_size(nullif(c.reltoastrelid,0)),0) toast, pg_indexes_size(c.oid) idx, pg_total_relation_size(c.oid) total from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where c.relkind='r' and ns.nspname=$1`, [S])).rows;
    res.finishedAt = new Date().toISOString();
    writeFileSync(`${OUT}/t-fable-load.json`, JSON.stringify(res, null, 2) + '\n'); console.log(JSON.stringify(res, null, 1));
  } finally { unlock(); await pool.end(); }
}

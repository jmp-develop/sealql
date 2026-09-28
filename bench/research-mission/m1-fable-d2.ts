/**
 * m1-fable E2b: STATEFUL per-occurrence tags (design D2, MongoDB Queryable Encryption family) with SERVER-SIDE tag
 * enumeration, as a research prototype on the disposable cluster. Purpose: measure what decision 011 rejected
 * (client-side tag preparation, 533 ms for 28k tags) when the DB itself derives the tags from a per-query token.
 *   Schema research_m1_fable_d2 (derived read-only from bench_realistic_100k.customers, 100k rows, 1 scope):
 *     esc(scope_id, field, key bigint, n int)     counter per (field, piece): key = HMAC_esc(piece), n = occurrences (STATE)
 *     rows(scope_id, row_id, t_<f> bigint[])       per-occurrence tags tag_i = first 8 bytes of sha256(T_piece || int4 i),
 *                                                  T_piece = HMAC_tag(piece); i = 1..n. Exact value = piece of kind 'x'.
 *     tagmap(scope_id, tag bigint, row_id)         same tags as a posting table (alternative access path)
 *   Query: client sends (E=HMAC_esc(piece), T=HMAC_tag(piece)) per leaf; SQL reads n from esc, generates tags 1..n with
 *   sha256() in the database, then t_<f> && tags (GIN) or joins tagmap. Count is exact (no false positives).
 *   Also: qsim = memory-only simulation of cumulative query-time exposure (fraction of piece occurrences whose piece has
 *   been queried) because every query reveals the whole equality class of the queried piece.
 * Usage: rtk proxy npx tsx bench/research-mission/m1-fable-d2.ts <load|measure|write|qsim|drop>
 */
import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { normalizeText } from '../../src/core/search-tokens.js';
import { cases, fields, plainWhere, type Case, type Field, type Node, type Leaf } from '../verify-native/r8-cases.js';

const S = 'research_m1_fable_d2', OUT = 'bench/results/2026-09-28-mission', K = 8;
const scopeA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const phase = process.argv[2]; assert(['load', 'measure', 'write', 'qsim', 'drop'].includes(phase ?? ''), 'phase?');
const LOCK = '.local/research/measure.lock';
async function lock(name: string) { for (;;) { if (!existsSync(LOCK)) { try { writeFileSync(LOCK, `M1F ${name} ${new Date().toISOString()}\n`, { flag: 'wx' }); return; } catch { /* raced */ } } console.log('measure.lock held; waiting'); await new Promise(r => setTimeout(r, 60_000)); } }
function unlock() { if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('M1F ')) unlinkSync(LOCK); }
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
mkdirSync(OUT, { recursive: true });

const escKey = Buffer.alloc(32, 11), tagKey = Buffer.alloc(32, 13);
const norm = (v: string) => normalizeText(v, 'legacy-text-v1');
const pads = (key: Buffer) => { const i = Buffer.alloc(64, 0x36), o = Buffer.alloc(64, 0x5c); for (let k = 0; k < key.length; k++) { i[k] ^= key[k]; o[k] ^= key[k]; } return { i, o }; };
const padOf = new Map<Buffer, { i: Buffer; o: Buffer }>();
const hmac = (key: Buffer, parts: string[]) => { let p = padOf.get(key); if (!p) { p = pads(key); padOf.set(key, p); } return hash('sha256', Buffer.concat([p.o, hash('sha256', Buffer.concat([p.i, Buffer.from(parts.join('\u0000'))]), 'buffer')]), 'buffer'); };
const b64 = (d: Buffer) => BigInt.asIntN(64, d.readBigUInt64BE(0)).toString();
const E = (field: string, kind: string, piece: string) => b64(hmac(escKey, [scopeA, field, kind, piece]));
const T = (field: string, kind: string, piece: string) => hmac(tagKey, [scopeA, field, kind, piece]);
const tagOf = (t: Buffer, i: number) => { const b = Buffer.alloc(4); b.writeInt32BE(i); return b64(hash('sha256', Buffer.concat([t, b]), 'buffer')); };
type Pieces = { kind: string; piece: string }[];
function piecesOf(field: Field, value: string): Pieces {
  const c = Array.from(norm(value)); const out: Pieces = [{ kind: 'x', piece: c.join('') }]; const seen = new Set<string>();
  const add = (kind: string, piece: string) => { const id = kind + '\u0000' + piece; if (!seen.has(id)) { seen.add(id); out.push({ kind, piece }); } };
  if (c.length < 2) return out;
  for (let l = 2; l <= K; l++) for (let i = 0; i + l <= c.length; i++) add('g', c.slice(i, i + l).join(''));
  for (let l = 1; l <= Math.min(K, c.length); l++) { add('s', c.slice(0, l).join('')); add('e', c.slice(c.length - l).join('')); }
  return out;
}
const leafPieces = (leaf: Leaf): { kind: string; piece: string }[] => {
  const c = Array.from(norm(leaf.value)); assert(c.length >= 2);
  if (leaf.op === 'eq') return [{ kind: 'x', piece: c.join('') }];
  if (c.length <= K) return [{ kind: leaf.op === 'contains' ? 'g' : leaf.op === 'startsWith' ? 's' : 'e', piece: c.join('') }];
  const out: { kind: string; piece: string }[] = [];
  if (leaf.op === 'startsWith') out.push({ kind: 's', piece: c.slice(0, K).join('') });
  if (leaf.op === 'endsWith') out.push({ kind: 'e', piece: c.slice(c.length - K).join('') });
  const seen = new Set<string>();
  for (let i = 0; i + K <= c.length; i++) { const w = c.slice(i, i + K).join(''); if (!seen.has(w)) { seen.add(w); out.push({ kind: 'g', piece: w }); } }
  return out;
};
// SQL tag-set generation in the database from (E, T): the DB never sees the piece.
const TAGS = (field: string, e: string, t: string) => `select coalesce(array_agg(('x'||encode(substr(sha256(${t}::bytea||int4send(i)),1,8),'hex'))::bit(64)::bigint), '{}') a from (select coalesce((select n from ${S}.esc where scope_id=$1 and field='${field}' and key=${e}),0) n) esc_n, lateral generate_series(1, esc_n.n) i`;
type Plan = { where: string; params: unknown[]; ctes: string[]; kind: 'and' | 'or' | 'leaf'; windows: number };
function plan(n: Node, path: 'gin' | 'tagmap'): Plan {
  const params: unknown[] = [scopeA]; const ctes: string[] = []; let windows = 0;
  const build = (x: Node): string => {
    if ('all' in x) return `(${x.all.map(build).join(' and ')})`;
    if ('any' in x) return `(${x.any.map(build).join(' or ')})`;
    const ps = leafPieces(x); if (ps.length > 1) windows += ps.length;
    const parts = ps.map(p => {
      params.push(E(x.field, p.kind, p.piece)); const eIdx = params.length; params.push(T(x.field, p.kind, p.piece)); const tIdx = params.length;
      const cte = `c${ctes.length}`;
      ctes.push(`${cte} as materialized (${TAGS(x.field, `$${eIdx}`, `$${tIdx}`)})`);
      return path === 'gin' ? `t_${x.field} && (select a from ${cte})` : `r.row_id in (select row_id from ${S}.tagmap where scope_id=$1 and tag = any((select a from ${cte})::bigint[]))`;
    });
    return `(${parts.join(' and ')})`;
  };
  const where = build(n);
  return { where, params, ctes, kind: 'all' in n ? 'and' : 'any' in n ? 'or' : 'leaf', windows };
}
const countSql = (p: Plan) => `with ${p.ctes.join(',')} select count(*) n from ${S}.rows r where r.scope_id=$1 and ${p.where}`;

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 4, options: '-c statement_timeout=0' });
type Row = { id: string } & Record<Field, string>;
async function main() {
  await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  const q = (s: string, p: unknown[] = []) => pool.query(s, p);
  if (phase === 'drop') { await q(`drop schema if exists ${S} cascade`); console.log('dropped'); return; }
  if (phase === 'qsim') return qsim();
  assert(existsSync('.local/research/db-free.flag'), 'db-free.flag missing');
  if (phase === 'load') {
    await lock('d2-load'); const res: any = { startedAt: new Date().toISOString(), schema: S, K };
    try {
      await q(`drop schema if exists ${S} cascade`); await q(`create schema ${S}`); await q(`set maintenance_work_mem='2GB'`);
      await q(`create table ${S}.esc (scope_id uuid not null, field text not null, key bigint not null, n int not null, primary key (scope_id, field, key))`);
      await q(`create table ${S}.rows (scope_id uuid not null, row_id uuid not null, ${fields.map(f => `t_${f} bigint[] not null`).join(',')}, primary key (scope_id,row_id))`);
      await q(`create table ${S}.tagmap (scope_id uuid not null, tag bigint not null, row_id uuid not null)`);
      const src: Row[] = (await q(`select id::text id, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id`)).rows;
      assert.equal(src.length, 100000);
      // ordinal per (field, kind, piece) in insertion order = counter state after the static build
      const counters = new Map<string, number>(); const tcache = new Map<string, Buffer>();
      const t0 = performance.now(); let tagsTotal = 0; const B = 200;
      for (let o = 0; o < src.length; o += B) {
        const part = src.slice(o, o + B); const vals: unknown[] = []; const mapTags: string[] = [], mapRows: string[] = [];
        for (const r of part) {
          const arrs: string[][] = [];
          for (const f of fields) {
            const arr: string[] = [];
            for (const p of piecesOf(f, r[f])) {
              const id = f + '\u0000' + p.kind + '\u0000' + p.piece; const i = (counters.get(id) ?? 0) + 1; counters.set(id, i);
              let t = tcache.get(id); if (!t) { t = T(f, p.kind, p.piece); tcache.set(id, t); }
              const tg = tagOf(t, i); arr.push(tg); mapTags.push(tg); mapRows.push(r.id);
            }
            arrs.push(arr); tagsTotal += arr.length;
          }
          vals.push(scopeA, r.id, ...arrs);
        }
        const w = 2 + fields.length;
        await q(`insert into ${S}.rows (scope_id,row_id,${fields.map(f => `t_${f}`).join(',')}) values ${part.map((_, r) => `(${Array.from({ length: w }, (_, c) => `$${r * w + c + 1}`).join(',')})`).join(',')}`, vals);
        await q(`insert into ${S}.tagmap select $1, unnest($2::bigint[]), unnest($3::uuid[])`, [scopeA, mapTags, mapRows]);
        if (o % 20000 === 0) console.log('loaded', o);
      }
      res.rowsAndTagmapMs = +(performance.now() - t0).toFixed(0); res.tagsPerRow = +(tagsTotal / src.length).toFixed(1); res.distinctPieces = counters.size;
      const t1 = performance.now(); const keys: string[] = [], flds: string[] = [], ns: number[] = [];
      for (const [id, n] of counters) { const [f, kind, piece] = id.split('\u0000'); flds.push(f); keys.push(E(f, kind, piece)); ns.push(n); }
      for (let o = 0; o < keys.length; o += 20000) await q(`insert into ${S}.esc select $1, unnest($2::text[]), unnest($3::bigint[]), unnest($4::int[])`, [scopeA, flds.slice(o, o + 20000), keys.slice(o, o + 20000), ns.slice(o, o + 20000)]);
      res.escMs = +(performance.now() - t1).toFixed(0);
      const t2 = performance.now();
      await q(`create index rows_gin on ${S}.rows using gin (${fields.map(f => `t_${f}`).join(',')})`);
      await q(`create index tagmap_tag on ${S}.tagmap (scope_id, tag)`);
      for (const t of ['esc', 'rows', 'tagmap']) await q(`vacuum (analyze) ${S}.${t}`);
      res.indexMs = +(performance.now() - t2).toFixed(0);
      res.sizes = (await q(`select c.relname rel, pg_relation_size(c.oid) heap, pg_indexes_size(c.oid) idx, pg_total_relation_size(c.oid) total from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname=$1 order by 1`, [S])).rows;
      res.finishedAt = new Date().toISOString();
      writeFileSync(`${OUT}/m1-fable-d2-load.json`, JSON.stringify(res, null, 2) + '\n'); console.log(JSON.stringify(res, null, 1));
    } finally { unlock(); }
  } else if (phase === 'measure') {
    await lock('d2-measure'); const res: any = { startedAt: new Date().toISOString(), schema: S, K, warm: 2, rounds: 7, cases: [] as any[] };
    try {
      const selected = cases.filter(c => ['exact_common', 'exact_mid', 'exact_one', 'sub2_common', 'sub_mid', 'sub_rare', 'sub_long', 'sub_name_suffix', 'starts', 'ends', 'and2', 'and4', 'and6', 'or2', 'or3'].includes(c.name));
      for (const c of selected) {
        const pp: unknown[] = [scopeA]; const pw = plainWhere(c.node, pp);
        const plainN = Number((await q(`select count(*) n from bench_realistic_100k.customers where scope_id=$1 and ${pw}`, pp)).rows[0].n);
        const paths = ['plain', 'd2_gin', 'd2_tagmap'] as const; const samples: Record<string, number[]> = { plain: [], d2_gin: [], d2_tagmap: [] };
        const pg = plan(c.node, 'gin'), pt = plan(c.node, 'tagmap');
        for (let round = 0; round < 9; round++) {
          for (const p of round % 2 ? [...paths].reverse() : paths) {
            const t = performance.now(); let n: number;
            if (p === 'plain') n = Number((await q(`select count(*) n from bench_realistic_100k.customers where scope_id=$1 and ${pw}`, pp)).rows[0].n);
            else { const pl = p === 'd2_gin' ? pg : pt; n = Number((await q(countSql(pl), pl.params)).rows[0].n); }
            const ms = performance.now() - t;
            if (pg.windows && p !== 'plain') assert(n >= plainN, `${c.name} ${p}: ${n} < ${plainN}`); else assert.equal(n, plainN, `${c.name} ${p}: ${n} != ${plainN}`);
            if (round >= 2) samples[p].push(ms);
          }
        }
        const row = { name: c.name, plainCount: plainN, windows: pg.windows, ms: Object.fromEntries(paths.map(p => [p, +median(samples[p]).toFixed(1)])) };
        res.cases.push(row); console.log(JSON.stringify(row));
      }
      // tag counts for the leaves of and2 (how many tags the server enumerated)
      res.escSample = (await q(`select field, n from ${S}.esc where scope_id=$1 and field='company' order by n desc limit 3`, [scopeA])).rows;
      res.finishedAt = new Date().toISOString();
      writeFileSync(`${OUT}/m1-fable-d2-measure.json`, JSON.stringify(res, null, 2) + '\n');
    } finally { unlock(); }
  } else if (phase === 'write') {
    await lock('d2-write'); const res: any = { startedAt: new Date().toISOString(), schema: S, K };
    try {
      const src: Row[] = (await q(`select id::text id, ${fields.map(f => `${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id limit 300`)).rows;
      const ids = src.map(r => r.id);
      // remove the sample rows (their counters stay; a re-insert takes the next ordinal, as a real update would)
      await q(`delete from ${S}.rows where row_id = any($1::uuid[])`, [ids]); await q(`delete from ${S}.tagmap where row_id = any($1::uuid[])`, [ids]);
      const ms: number[] = []; let stmts = 0;
      for (const r of src) {
        const t = performance.now(); const client = await pool.connect();
        try {
          await client.query('begin');
          const flds: string[] = [], keys: string[] = [], meta: { f: Field; kind: string; piece: string }[] = [];
          for (const f of fields) for (const p of piecesOf(f, r[f])) { flds.push(f); keys.push(E(f, p.kind, p.piece)); meta.push({ f, kind: p.kind, piece: p.piece }); }
          // one statement: bump every counter (insert-or-increment) and read back the new ordinals
          const up = await client.query(`insert into ${S}.esc (scope_id, field, key, n) select $1, unnest($2::text[]), unnest($3::bigint[]), 1 on conflict (scope_id, field, key) do update set n = ${S}.esc.n + 1 returning field, key, n`, [scopeA, flds, keys]);
          const nOf = new Map(up.rows.map(x => [x.field + '|' + x.key, Number(x.n)]));
          const arrs: string[][] = fields.map(() => []); const mapTags: string[] = [];
          meta.forEach((m, i) => { const n = nOf.get(flds[i] + '|' + keys[i])!; const tg = tagOf(T(m.f, m.kind, m.piece), n); arrs[fields.indexOf(m.f)].push(tg); mapTags.push(tg); });
          await client.query(`insert into ${S}.rows (scope_id,row_id,${fields.map(f => `t_${f}`).join(',')}) values ($1,$2,${fields.map((_, i) => `$${i + 3}`).join(',')})`, [scopeA, r.id, ...arrs]);
          await client.query(`insert into ${S}.tagmap select $1, unnest($2::bigint[]), $3`, [scopeA, mapTags, r.id]);
          await client.query('commit'); stmts += 3;
        } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
        ms.push(performance.now() - t);
      }
      // reviewer finding: in PostgreSQL the upserted esc rows carry the inserting transaction's xmin, the same xmin as the new
      // rows/tagmap rows, so ONE snapshot links each piece counter to the last row that contained it. Mechanical check:
      const xm = (await q(`select count(*) filter (where e.xmin = r.xmin) linked, count(*) total from ${S}.rows r join ${S}.esc e on e.scope_id = r.scope_id where r.row_id = $1`, [src[src.length - 1].id])).rows[0];
      res.xminLink = { lastInsertedRow: src[src.length - 1].id, escRowsSharingXmin: Number(xm.linked), escRowsTotal: Number(xm.total), note: 'esc rows sharing xmin with the last inserted row = its piece counters (static snapshot linkage)' };
      res.insertRows = src.length; res.insertMsMedian = +median(ms).toFixed(2); res.insertMsP90 = +[...ms].sort((a, b) => a - b)[Math.floor(ms.length * 0.9)].toFixed(2); res.statementsPerInsert = 3;
      res.note = 'sequential single-row inserts; hot-counter contention under concurrency not measured (MongoDB splits counters by a contention factor)';
      res.finishedAt = new Date().toISOString();
      writeFileSync(`${OUT}/m1-fable-d2-write.json`, JSON.stringify(res, null, 2) + '\n'); console.log(JSON.stringify(res, null, 1));
    } finally { unlock(); }
  }
}
// Memory-only: cumulative exposure of D2 under a query workload. Every query on a piece reveals the equality class of
// that piece (all rows containing it) to a query observer, permanently. Compare with D1 (static = 100 % exposed).
function qsim() {
  const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter((x): x is string => !!x);
  const N = 50_000; const docs = lines.slice(0, N).map(v => { try { return Array.from(normalizeText(v, 'legacy-text-v1')); } catch { return [] as string[]; } }).filter(c => c.length >= 2);
  const refs = lines.slice(N, 2 * N).map(v => { try { return Array.from(normalizeText(v, 'legacy-text-v1')); } catch { return [] as string[]; } }).filter(c => c.length >= 2);
  const occ = new Map<string, number>(); let occTotal = 0; const rowPieces: string[][] = [];
  for (const c of docs) { const ps = new Set<string>(); for (let l = 2; l <= 4; l++) for (let i = 0; i + l <= c.length; i++) ps.add(c.slice(i, i + l).join('')); rowPieces.push([...ps]); for (const p of ps) { occ.set(p, (occ.get(p) ?? 0) + 1); occTotal++; } }
  // query distribution: proportional to piece frequency in the reference half (users search common things), lengths 2..4
  const qf = new Map<string, number>(); for (const c of refs) for (let l = 2; l <= 4; l++) for (let i = 0; i + l <= c.length; i++) { const p = c.slice(i, i + l).join(''); qf.set(p, (qf.get(p) ?? 0) + 1); }
  const items = [...qf]; const cum: number[] = []; let acc = 0; for (const [, f] of items) { acc += f; cum.push(acc); }
  let s = 20260928 >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const draw = () => { const x = rnd() * acc; let lo = 0, hi = cum.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; } return items[lo][0]; };
  const queried = new Set<string>(); const out: any[] = []; let exposedOcc = 0; const checkpoints = [10, 100, 1000, 10000, 100000];
  for (let qn = 1; qn <= 100000; qn++) {
    const p = draw(); if (!queried.has(p)) { queried.add(p); exposedOcc += occ.get(p) ?? 0; }
    if (checkpoints.includes(qn)) {
      let rowsAny = 0, rowsHalf = 0; for (const ps of rowPieces) { let k = 0; for (const x of ps) if (queried.has(x)) k++; if (k) rowsAny++; if (k * 2 >= ps.length) rowsHalf++; }
      out.push({ queries: qn, distinctQueried: queried.size, exposedOccPct: +(100 * exposedOcc / occTotal).toFixed(2), rowsWithAnyExposedPct: +(100 * rowsAny / rowPieces.length).toFixed(2), rowsHalfExposedPct: +(100 * rowsHalf / rowPieces.length).toFixed(2) });
      console.log(JSON.stringify(out.at(-1)));
    }
  }
  const res = { rows: docs.length, pieceLengths: '2..4', distinctPieces: occ.size, queryModel: 'pieces drawn proportional to frequency in a disjoint reference half (NSMC), lengths 2..4', checkpoints: out, d1Static: { exposedOccPct: 100 } };
  writeFileSync(`${OUT}/m1-fable-d2-qsim.json`, JSON.stringify(res, null, 2) + '\n');
}
try { await main(); } finally { await pool.end(); }

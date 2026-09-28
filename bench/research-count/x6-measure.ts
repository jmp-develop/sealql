/**
 * X6: cut the DB/transfer part of the exact client-verified count (X4 CBC+HMAC crypto path unchanged: x4-lib decide()).
 * Same research layout as X4 (research_count_x6), same candidate semantics (parent scope_id = $1 AND companion tokens match;
 * flags for OR leaves), exact count asserted every run. Varies only: wire encoding, query shape, fetch mode.
 *   enc:   b64obj (X4) | b64arr | hexarr (raw bytea, text hex) | bin (binary result format; needs a driver patch, see below)
 *          | pack64/packhex (one bytea per row: uuid_send(id) | flag bytes | int4 len | ct ...) | agghex/agg64 (string_agg of packed rows: 1 row)
 *   shape: in (X4) | in_ns (X5 fix: no companion scope_id) | exists | exists_ns | join | join_ns | lateral | ct1 (STORAGE VARIANT: ciphertext copy in companion)
 *   fetch: batch | stream (row events) | cursor N (DECLARE/FETCH N, pipelined)
 * Floors (NOT valid count paths, no verification): ids-only transfer, DB count(*) of candidates.
 * Usage: rtk proxy npx tsx bench/research-count/x6-measure.ts <explain|count>
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { combos, condition, plainWhere, type Case } from '../verify-native/r8-cases.js';
import { OUT, json, median } from './x2-lib.js';
import { makePlan, decide, prefixes, stats, vstats, check, ShapeError, type Plan, type Row } from './x4-lib.js';
import { now } from './x4-crypto.js';
import { SCHEMA6 as S, lock, unlock } from './x6-lib.js';

const { Pool, Query } = pg;
const phase = process.argv[2]; assert(['explain', 'count', 'focus'].includes(phase));
const OUTF = phase === 'focus' ? 'x6-focus.json' : 'x6-count.json';
const scopeA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 1, options: '-c default_transaction_read_only=on -c statement_timeout=600000' });
const wire = { n: 0 };
pool.on('connect', (c: any) => c.connection.stream.on('data', (b: Buffer) => { wire.n += b.length; }));
await assertDisposable(pool); assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
assert.equal((await pool.query('show default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');

// ---- binary result format: node-pg 8.23 / pg-protocol decodes every DataRow field with utf-8 (lossy for bytea).
// Research-only patch: while patch.on, DataRow fields are decoded latin1 (1 char = 1 byte, lossless) and rowMode 'array'
// parsers rebuild Buffers. Stands in for a driver with real binary support; not usable in product as is.
const req = createRequire(import.meta.url);
const BR = req('pg-protocol/dist/buffer-reader.js').BufferReader;
const patch = { on: false };
const origString = BR.prototype.string;
BR.prototype.string = function (len: number) { if (!patch.on) return origString.call(this, len); const r = this.buffer.toString('latin1', this.offset, this.offset + len); this.offset += len; return r; };
const binTypes = { getTypeParser: (oid: number, fmt: string) => {
  assert.equal(fmt, 'binary');
  if (oid === 16) return (v: string) => v.charCodeAt(0) === 1;
  return (v: string) => Buffer.from(v, 'latin1'); // uuid(2950), bytea(17)
} };

// ---- candidate SQL
type Shape = 'in' | 'in_ns' | 'exists' | 'exists_ns' | 'join' | 'join_ns' | 'lateral' | 'ct1';
type EncName = 'b64obj' | 'b64arr' | 'hexarr' | 'bin' | 'pack64' | 'packhex' | 'agghex' | 'agg64' | 'ids' | 'dbcount';
const packExpr = (p: Plan, T: string, idE: string) => [`uuid_send(${idE})`, ...p.flags.map(f => `set_byte('\\x00'::bytea,0,(${f.sql})::int)`),
  ...p.condFields.map(f => `coalesce(int4send(octet_length(${T}."${f}_ct"))||${T}."${f}_ct", int4send(-1))`)].join('||');
function sqlOf(p: Plan, shape: Shape, enc: EncName) {
  const noFlagShape = shape === 'in' || shape === 'in_ns' || shape === 'exists' || shape === 'exists_ns';
  assert(!(p.flags.length && noFlagShape), 'flags need companion columns in the select list');
  const T = shape === 'ct1' ? 'i' : 'p', idE = shape === 'ct1' ? 'i."row_id"' : 'p."id"';
  let sel: string;
  // floors keep the flag expressions so every bound parameter is referenced (or2)
  if (enc === 'ids') sel = [idE, ...p.flags.map(f => `${f.sql} as ${f.name}`)].join(',');
  else if (enc === 'dbcount') sel = ['count(*)::int n', ...p.flags.map(f => `bool_or(${f.sql}) as ${f.name}`)].join(',');
  else if (enc === 'pack64') sel = `encode(${packExpr(p, T, idE)},'base64') x`;
  else if (enc === 'packhex') sel = `${packExpr(p, T, idE)} x`;
  else if (enc === 'agghex') sel = `string_agg(${packExpr(p, T, idE)},''::bytea) x`;
  else if (enc === 'agg64') sel = `encode(string_agg(${packExpr(p, T, idE)},''::bytea),'base64') x`;
  else {
    const b64 = enc === 'b64obj' || enc === 'b64arr';
    sel = [`${idE} as id`, ...p.condFields.map(f => b64 ? `encode(${T}."${f}_ct",'base64') as "${f}"` : `${T}."${f}_ct" as "${f}"`), ...p.flags.map(f => `${f.sql} as ${f.name}`)].join(',');
  }
  const P = `"${S}"."customers" p`, I = `"${S}"."customers_seal_index" i`, W = p.where;
  const from = {
    in: `from ${P} where p."scope_id"=$1 and p."id" in (select i."row_id" from ${I} where i."scope_id"=$1 and ${W})`,
    in_ns: `from ${P} where p."scope_id"=$1 and p."id" in (select i."row_id" from ${I} where ${W})`,
    exists: `from ${P} where p."scope_id"=$1 and exists (select 1 from ${I} where i."row_id"=p."id" and i."scope_id"=$1 and ${W})`,
    exists_ns: `from ${P} where p."scope_id"=$1 and exists (select 1 from ${I} where i."row_id"=p."id" and ${W})`,
    join: `from ${P} join ${I} on i."scope_id"=$1 and i."row_id"=p."id" where p."scope_id"=$1 and ${W}`,
    join_ns: `from ${P} join ${I} on i."row_id"=p."id" where p."scope_id"=$1 and ${W}`,
    lateral: `from ${I} cross join lateral (select p."id", ${p.condFields.map(f => `p."${f}_ct"`).join(',')} from ${P} where p."id"=i."row_id" and p."scope_id"=$1 offset 0) p where ${W}`,
    ct1: `from "${S}"."customers_seal_index_ct" i where i."scope_id"=$1 and ${W}`,
  }[shape];
  return { text: `select ${sel} ${from}`, params: [...p.params] };
}

// ---- parse to X4 Row (same shape checks: uuid, no duplicates, flags boolean; packed: exact lengths, no trailing bytes)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidOf = (b: Uint8Array, o: number) => { const h = Buffer.from(b.buffer, b.byteOffset + o, 16).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
type Ctx = { p: Plan; seen: Set<string>; flagIdx: number[] }; // flagIdx[k] = leaf idx of flag k
function mkRow(ctx: Ctx, id: string, cts: (Uint8Array | null)[], flags: unknown[]): Row {
  if (ctx.seen.has(id)) throw new ShapeError('INVALID_CANDIDATE_SHAPE'); ctx.seen.add(id);
  const ct: Row['ct'] = {}; ctx.p.condFields.forEach((f, k) => { ct[f] = cts[k]; });
  const leaf = new Int8Array(ctx.p.leaves.length).fill(-1);
  flags.forEach((fl, k) => { if (typeof fl !== 'boolean') throw new ShapeError('INVALID_CANDIDATE_SHAPE'); if (!fl) leaf[ctx.flagIdx[k]] = 0; });
  return { id, ct, val: {}, leaf };
}
function unpack(ctx: Ctx, b: Uint8Array, out: Row[]) { // one or many packed records, must consume b exactly
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); const nf = ctx.p.flags.length, nc = ctx.p.condFields.length; let o = 0;
  while (o < b.length) {
    if (o + 16 + nf > b.length) throw new ShapeError('INVALID_CANDIDATE_SHAPE');
    const id = uuidOf(b, o); o += 16; const flags: boolean[] = [];
    for (let k = 0; k < nf; k++) { const v = b[o++]; if (v > 1) throw new ShapeError('INVALID_CANDIDATE_SHAPE'); flags.push(v === 1); }
    const cts: (Uint8Array | null)[] = [];
    for (let k = 0; k < nc; k++) {
      if (o + 4 > b.length) throw new ShapeError('INVALID_CANDIDATE_SHAPE');
      const len = dv.getInt32(o); o += 4;
      if (len === -1) { cts.push(null); continue; }
      if (len < 0 || o + len > b.length) throw new ShapeError('INVALID_CANDIDATE_SHAPE');
      cts.push(b.subarray(o, o + len)); o += len;
    }
    out.push(mkRow(ctx, id, cts, flags));
  }
}
function parser(enc: EncName, ctx: Ctx): (raw: any, out: Row[]) => void {
  const nc = ctx.p.condFields.length, flagNames = ctx.p.flags.map(f => f.name);
  const strId = (id: unknown) => { if (typeof id !== 'string' || !UUID.test(id)) throw new ShapeError('INVALID_CANDIDATE_SHAPE'); return id; };
  switch (enc) {
    case 'b64obj': return (r, out) => out.push(mkRow(ctx, strId(r.id), ctx.p.condFields.map(f => r[f] === null ? null : Buffer.from(r[f], 'base64')), flagNames.map(n => r[n])));
    case 'b64arr': return (r, out) => { const cts = new Array(nc); for (let k = 0; k < nc; k++) cts[k] = r[k + 1] === null ? null : Buffer.from(r[k + 1], 'base64'); out.push(mkRow(ctx, strId(r[0]), cts, r.slice(1 + nc))); };
    case 'hexarr': return (r, out) => out.push(mkRow(ctx, strId(r[0]), r.slice(1, 1 + nc), r.slice(1 + nc)));
    case 'bin': return (r, out) => { if (!(r[0] instanceof Uint8Array) || r[0].length !== 16) throw new ShapeError('INVALID_CANDIDATE_SHAPE'); out.push(mkRow(ctx, uuidOf(r[0], 0), r.slice(1, 1 + nc), r.slice(1 + nc))); };
    case 'pack64': case 'agg64': return (r, out) => { if (r[0] !== null) unpack(ctx, Buffer.from(r[0], 'base64'), out); };
    case 'packhex': case 'agghex': return (r, out) => { if (r[0] !== null) unpack(ctx, r[0], out); };
    default: throw Error(enc);
  }
}

// ---- one count run
type Fetch = { mode: 'batch' } | { mode: 'stream'; ch: number } | { mode: 'cursor'; n: number };
type Variant = { name: string; shape: Shape; enc: EncName; fetch: Fetch; valid: boolean; seqOff?: boolean }; // seqOff: SET LOCAL enable_seqscan=off in a read-only tx
async function run(c: Case, v: Variant) {
  Object.assign(stats, { macs: 0, decrypts: 0, cbcCalls: 0, macMs: 0, cbcMs: 0, decodeMs: 0 }); vstats.verifyMs = 0; vstats.rounds = 0;
  const t0 = now();
  const p = await makePlan(c.node); const pre = prefixes(scopeA);
  const { text, params } = sqlOf(p, v.shape, v.enc);
  const ctx: Ctx = { p, seen: new Set(), flagIdx: p.flags.map(f => p.leaves.find(l => l.flag === f.name)!.idx) };
  const cfg: any = { text, values: params };
  if (v.enc !== 'b64obj' && v.enc !== 'ids' && v.enc !== 'dbcount') cfg.rowMode = 'array';
  if (v.enc === 'bin') { cfg.binary = true; cfg.types = binTypes; }
  const cl = await pool.connect(); let count = 0, rowsN = 0, convMs = 0, dbS = 0, dbE = 0, bytes = 0, overlap = 0;
  const tx = v.seqOff && v.fetch.mode !== 'cursor';
  if (tx) { await cl.query('begin read only'); await cl.query('set local enable_seqscan = off'); }
  try {
    if (!v.valid) {
      const w0 = wire.n; dbS = now(); const r = await cl.query(cfg); dbE = now(); bytes = wire.n - w0;
      rowsN = r.rows.length; count = v.enc === 'dbcount' ? r.rows[0].n : r.rows.length;
    } else if (v.fetch.mode === 'batch') {
      const parse = parser(v.enc, ctx); const w0 = wire.n;
      patch.on = v.enc === 'bin'; dbS = now();
      let r; try { r = await cl.query(cfg); } finally { patch.on = false; }
      dbE = now(); bytes = wire.n - w0;
      const t = now(); const rows: Row[] = []; for (const x of r.rows) parse(x, rows); convMs = now() - t; rowsN = rows.length;
      const m = await decide(p, rows, pre); for (const b of m) count += b;
    } else if (v.fetch.mode === 'stream') {
      const parse = parser(v.enc, ctx); const CH = v.fetch.ch; let chunk: Row[] = []; let chain = Promise.resolve();
      const flush = () => { const k = chunk; chunk = []; chain = chain.then(async () => { const m = await decide(p, k, pre); for (const b of m) count += b; }); };
      const w0 = wire.n; dbS = now();
      dbE = await new Promise<number>((ok, bad) => { const q = new Query(cfg); q.on('row', (x: any) => { try { const t = now(); parse(x, chunk); convMs += now() - t; if (chunk.length >= CH) flush(); } catch (e) { bad(e); } }); q.on('end', () => ok(now())); q.on('error', bad); cl.query(q as any); });
      bytes = wire.n - w0; overlap = stats.decrypts; rowsN = ctx.seen.size; flush(); await chain;
    } else {
      const parse = parser(v.enc, ctx); const N = v.fetch.n; let chain = Promise.resolve();
      await cl.query('begin read only'); if (v.seqOff) await cl.query('set local enable_seqscan = off');
      try {
        const w0 = wire.n; dbS = now();
        await cl.query({ text: `declare x6c no scroll cursor for ${text}`, values: params });
        const fetch = () => cl.query({ text: `fetch ${N} from x6c`, rowMode: cfg.rowMode });
        let pending: Promise<any> | null = fetch();
        while (pending) {
          const r = await pending; pending = r.rows.length === N ? fetch() : null;
          const t = now(); const rows: Row[] = []; for (const x of r.rows) parse(x, rows); convMs += now() - t;
          chain = chain.then(async () => { const m = await decide(p, rows, pre); for (const b of m) count += b; });
        }
        dbE = now(); bytes = wire.n - w0; overlap = stats.decrypts; rowsN = ctx.seen.size;
        await chain;
      } finally { await cl.query('commit'); }
    }
  } finally { if (tx) await cl.query('commit'); cl.release(); }
  const t1 = now();
  return { value: count, totalMs: t1 - t0, preMs: dbS - t0, dbMs: dbE - dbS, convMs, postMs: t1 - dbE, rows: rowsN, wireBytes: bytes,
    macs: stats.macs, decrypts: stats.decrypts, macMs: stats.macMs, cbcMs: stats.cbcMs, decodeMs: stats.decodeMs, verifyMs: vstats.verifyMs, rounds: vstats.rounds, overlapDecrypts: overlap };
}
const plainArgs = (c: Case) => { const params: unknown[] = [scopeA]; return { where: plainWhere(c.node, params), params }; };
async function plainCount(c: Case) {
  const { where, params } = plainArgs(c); const t0 = now(); const w0 = wire.n;
  const n = Number((await pool.query(`select count(*) n from bench_realistic_100k.customers where scope_id=$1 and ${where}`, params)).rows[0].n);
  const ms = now() - t0; return { value: n, totalMs: ms, dbMs: ms, wireBytes: wire.n - w0 };
}

// ---- variants
const B: Fetch = { mode: 'batch' };
function focusVariants(hasFlags: boolean): Variant[] {
  const V = (name: string, shape: Shape, enc: EncName, fetch: Fetch = B, seqOff = false): Variant => ({ name, shape, enc, fetch, valid: true, seqOff });
  const S1: Fetch = { mode: 'stream', ch: 1024 }, C1: Fetch = { mode: 'cursor', n: 1024 };
  const base: Shape = hasFlags ? 'join' : 'in', ns: Shape = hasFlags ? 'join_ns' : 'in_ns';
  return [V('x4 (base, b64obj)', base, 'b64obj'), V('stream b64obj (x4 stream)', base, 'b64obj', S1),
    V(`${ns}/hexarr`, ns, 'hexarr'), V(`${ns} stream hexarr`, ns, 'hexarr', S1), V(`${ns} cursor 1024 hexarr`, ns, 'hexarr', C1), V(`${base} cursor 1024 hexarr`, base, 'hexarr', C1),
    V('ct1/hexarr', 'ct1', 'hexarr'), V('ct1 stream hexarr', 'ct1', 'hexarr', S1), V('ct1 cursor 1024 hexarr', 'ct1', 'hexarr', C1),
    ...(hasFlags ? [V('ct1/hexarr seqscan off', 'ct1', 'hexarr', B, true), V('ct1 stream hexarr seqscan off', 'ct1', 'hexarr', S1, true), V('ct1 cursor 1024 hexarr seqscan off', 'ct1', 'hexarr', C1, true)] : [])];
}
function variants(hasFlags: boolean): Variant[] {
  if (phase === 'focus') return focusVariants(hasFlags);
  const base: Shape = hasFlags ? 'join' : 'in';
  const V = (name: string, shape: Shape, enc: EncName, fetch: Fetch = B, valid = true): Variant => ({ name, shape, enc, fetch, valid });
  const out: Variant[] = [
    V('x4 (base, b64obj)', base, 'b64obj'),
    ...(['b64arr', 'hexarr', 'bin', 'pack64', 'packhex', 'agghex', 'agg64'] as EncName[]).map(e => V(`${base}/${e}`, base, e)),
  ];
  const shapes: Shape[] = hasFlags ? ['join_ns', 'lateral', 'ct1'] : ['in_ns', 'exists', 'exists_ns', 'join', 'join_ns', 'lateral', 'ct1'];
  for (const s of shapes) for (const e of ['hexarr', 'agghex'] as EncName[]) out.push(V(`${s}/${e}`, s, e));
  out.push(V('stream b64obj (x4 stream)', base, 'b64obj', { mode: 'stream', ch: 1024 }), V('stream hexarr', base, 'hexarr', { mode: 'stream', ch: 1024 }),
    V('stream packhex', base, 'packhex', { mode: 'stream', ch: 1024 }),
    V('cursor 1024 hexarr', base, 'hexarr', { mode: 'cursor', n: 1024 }), V('cursor 4096 hexarr', base, 'hexarr', { mode: 'cursor', n: 4096 }), V('cursor 16384 hexarr', base, 'hexarr', { mode: 'cursor', n: 16384 }),
    V('ct1 stream hexarr', 'ct1', 'hexarr', { mode: 'stream', ch: 1024 }),
    V('FLOOR ids only (not valid)', base, 'ids', B, false), V('FLOOR ct1 ids only (not valid)', 'ct1', 'ids', B, false),
    V('FLOOR DB count(*) of candidates (not valid)', base, 'dbcount', B, false));
  return out;
}

const KEYS = ['totalMs', 'preMs', 'dbMs', 'convMs', 'postMs', 'rows', 'wireBytes', 'macs', 'decrypts', 'macMs', 'cbcMs', 'decodeMs', 'verifyMs', 'rounds', 'overlapDecrypts'];
const summ = (xs: any[]) => Object.fromEntries(KEYS.filter(k => typeof xs[0][k] === 'number').map(k => [k, +median(xs.map(x => x[k])).toFixed(3)]));
const res: any = { startedAt: new Date().toISOString(), schema: S, method: 'first + 2 warm-up + 7 rotated, medians of the 7; count asserted == plaintext every run' };
const cases = combos.filter(c => c.name === 'and2' || c.name === 'or2');
const hasOr = (c: Case) => 'any' in c.node;
try {
  if (phase === 'explain') {
    await lock('explain'); try {
      res.rows = [];
      for (const c of cases) {
        const p = await makePlan(c.node);
        for (const v of variants(hasOr(c)).filter(v => v.fetch.mode === 'batch')) {
          const { text, params } = sqlOf(p, v.shape, v.enc); const t: number[] = []; let plan: any;
          for (let i = 0; i < 5; i++) { plan = (await pool.query(`explain (analyze, buffers, format json) ${text}`, params)).rows[0]['QUERY PLAN'][0]; if (i >= 2) t.push(plan['Execution Time']); }
          const nodes: string[] = []; const walk = (n: any) => { nodes.push(`${n['Node Type']}${n['Index Name'] ? `(${n['Index Name']})` : n['Relation Name'] ? `(${n['Relation Name']})` : ''}`); (n.Plans ?? []).forEach(walk); }; walk(plan.Plan);
          const x = { case: c.name, variant: v.name, serverExecMs: +median(t).toFixed(3), sharedHit: plan.Plan['Shared Hit Blocks'], sharedRead: plan.Plan['Shared Read Blocks'], nodes: nodes.join(' > '), sql: text };
          res.rows.push(x); console.log(`${c.name} ${v.name}: ${x.serverExecMs} ms  ${x.nodes}`);
        }
      }
      writeFileSync(`${OUT}/x6-explain.json`, json(res));
    } finally { unlock(); }
  }
  if (phase === 'count' || phase === 'focus') {
    // untimed: binary-format corruption demo without patch
    { const p = await makePlan(cases[0].node); const { text, params } = sqlOf(p, 'in', 'bin');
      const r = await pool.query({ text: text + ' limit 50', values: params, binary: true, rowMode: 'array', types: { getTypeParser: () => (v: any) => v } } as any);
      const q = (await pool.query({ text: sqlOf(p, 'in', 'hexarr').text + ' limit 50', values: params, rowMode: 'array' } as any)).rows;
      const byId = new Map(q.map((x: any) => [x[0], x[1]])); let ok = 0, bad = 0, idsBroken = 0;
      for (const x of r.rows) { const idB = Buffer.from(x[0], 'utf8'); if (idB.length !== 16) { idsBroken++; continue; } const want = byId.get(uuidOf(idB, 0)); const got = Buffer.from(x[1], 'utf8'); if (want && Buffer.compare(want, got) === 0) ok++; else bad++; }
      res.unpatchedBinaryBytea = { rows: r.rows.length, idsNot16Bytes: idsBroken, intactFirstCt: ok, corrupted: bad, note: 'pg-protocol decodes DataRow as utf-8; binary bytea/uuid is not recoverable without a driver change' };
      console.log(JSON.stringify(res.unpatchedBinaryBytea)); }
    // untimed: A3 fast verify == src verify on every new path
    check.enabled = true; for (const c of cases) { const truth = (await plainCount(c)).value; for (const v of variants(hasOr(c))) if (v.valid) assert.equal((await run(c, v)).value, truth, v.name); } res.a3Check = { compared: check.compared }; check.enabled = false;
    await lock('count'); try {
      res.rows = [];
      for (const c of cases) {
        const truth = (await plainCount(c)).value; const vs = variants(hasOr(c));
        const paths = [{ name: 'plain COUNT', run: () => plainCount(c), valid: true }, ...vs.map(v => ({ name: v.name, run: () => run(c, v), valid: v.valid }))];
        const first: any = {}; const runs: Record<string, any[]> = Object.fromEntries(paths.map(p => [p.name, []]));
        for (let i = 0; i < 10; i++) {
          const order = paths.map((_, k) => paths[(k + i) % paths.length]);
          for (const pth of order) {
            const m = await pth.run(); if (pth.valid) assert.equal(m.value, truth, `${c.name}/${pth.name}/${i}`);
            const { value, ...rest } = m as any; if (i === 0) first[pth.name] = rest; else if (i >= 3) runs[pth.name].push(rest);
          }
        }
        const s = Object.fromEntries(paths.map(p => [p.name, summ(runs[p.name])]));
        const plainMs = s['plain COUNT'].totalMs;
        console.log(`== ${c.name} (${truth}) plain ${plainMs}`);
        for (const p of paths) console.log(`${p.name.padEnd(44)} total ${String(s[p.name].totalMs).padStart(8)} db ${String(s[p.name].dbMs).padStart(8)} conv ${String(s[p.name].convMs ?? '').padStart(7)} bytes ${s[p.name].wireBytes}  x${(s[p.name].totalMs / plainMs).toFixed(2)}`);
        res.rows.push({ case: c.name, condition: condition(c.node), matches: truth, summary: s, first, runs });
        writeFileSync(`${OUT}/${OUTF}`, json(res));
      }
    } finally { unlock(); }
  }
  res.finishedAt = new Date().toISOString();
  if (phase !== 'explain') writeFileSync(`${OUT}/${OUTF}`, json(res));
} finally { unlock(); await pool.end(); }

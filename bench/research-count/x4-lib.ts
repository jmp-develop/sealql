/**
 * X4 combined prototype (Node): CBC+HMAC format (x4-crypto.ts, all X3 fixes) + X1 no-format techniques:
 *  A1  only needed fields, three-valued short-circuit evaluated in batched ROUNDS (each round = 1 MAC pass + 1 CBC call),
 *      per-leaf token flags only for leaves under OR (DB returns coalesce(tokens @> $, false); flag=false proves the leaf false).
 *  A2  low glue: no per-field Promise/objects, key-derived MAC states + per-call AAD prefix states (static AAD + scope absorbed once).
 *  A3  identity-normalization fast verify (fold/NFC are identity for ASCII w/o A-Z, precomposed Hangul, U+0020), else src verifySearch.
 *  count without ORDER BY (duplicates rejected by Set, scope bound by AAD), bytea as base64, optional row streaming.
 * Research only, not product code.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { codecId, codecParameters, codecVersion } from '../../src/core/field-codec.js';
import { frame, u32, utf8, concat } from '../../src/core/bytes.js';
import { verifySearch, type CompiledLeaf, type CompiledSearch } from '../../src/core/search-predicate.js';
import type { Node } from '../verify-native/r8-cases.js';
import { hkdf, ring, spec, scopeA, fields, compile, tokenWhere } from './x2-lib.js';
import { cbcKeys, macKey, prefix, openBatch, sealOne, stats, now, type Prefix, type Job } from './x4-crypto.js';

const { Query } = pg;
export const SCHEMA4 = 'research_count_x4';
export const HDR = 5;
export const encBytes = await hkdf('x4/cbc-hmac/enc/v1'), macBytes = await hkdf('x4/cbc-hmac/mac/v1');
export const cbc = await cbcKeys(encBytes);
export const mk = macKey(macBytes);
const staticA = new Map<string, Uint8Array>();
/** A without the rowId part: [HDR] | frame(10 parts) up to and including scope (count patched to 10; rowId appended per row). */
export function aPrefixBytes(field: string, scope: string): Uint8Array {
  let s = staticA.get(field);
  if (!s) {
    const f = frame(['sealql/aad/v3', new Uint8Array([HDR]), 'customers', field, codecId(spec), u32(codecVersion(spec)), codecParameters(spec), ring.keyScopeId]);
    s = new Uint8Array(1 + f.length); s[0] = HDR; s.set(f, 1); new DataView(s.buffer).setUint32(1, 10); staticA.set(field, s);
  }
  const sb = utf8(scope); return concat(s, u32(sb.length), sb);
}
/** Full A (for WebCrypto cross-checks): same bytes as [HDR] | frame(['sealql/aad/v3', [HDR], model, field, codec, ver, params, keyScope, scope, rowId]). */
export function fullA(field: string, scope: string, rowId: string) { return concat(aPrefixBytes(field, scope), u32(utf8(rowId).length), utf8(rowId)); }
/** Per-call prefix states (MAC key + schema + scope). Never kept past the call. */
export function prefixes(scope: string) { const m = new Map<string, Prefix>(); for (const f of fields) m.set(f, prefix(mk, aPrefixBytes(f, scope))); return m; }
export const sealValue = (pre: Map<string, Prefix>, field: string, rowId: string, value: string) => sealOne(cbc, mk, HDR, pre.get(field)!, rowId, utf8(value));
/** capture.jobs: when set, every opened job is recorded (anatomy only; untimed runs). */
export const capture: { jobs: Job[] | null } = { jobs: null };
export const open = (jobs: Job[]) => { if (capture.jobs) for (const j of jobs) capture.jobs.push(j); return openBatch(cbc, mk, HDR, jobs); };

// ---------------------------------------------------------------- lock
const LOCK = '.local/research/measure.lock';
export async function lock(name: string) {
  for (;;) {
    if (!existsSync(LOCK)) { try { writeFileSync(LOCK, `X4 ${name} ${new Date().toISOString()}\n`, { flag: 'wx' }); return; } catch { /* raced */ } }
    console.error(`measure.lock held: ${existsSync(LOCK) ? readFileSync(LOCK, 'utf8').trim() : '?'}; waiting`);
    await new Promise(r => setTimeout(r, 60_000));
  }
}
export function unlock() { if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('X4 ')) unlinkSync(LOCK); }

// ---------------------------------------------------------------- plan
type PLeaf = { kind: 'leaf'; c: CompiledLeaf; field: string; flag?: string; idx: number };
type PInner = { kind: 'and' | 'or'; kids: PNode[] };
type PNode = PLeaf | PInner;
export type Plan = { root: PNode; leaves: PLeaf[]; condFields: string[]; flags: { name: string; sql: string }[]; where: string; params: unknown[] };
export async function makePlan(n: Node, scope = scopeA): Promise<Plan> {
  const compiled = await compile(n, scope);
  const params: unknown[] = [scope]; const flags: Plan['flags'] = []; const leaves: PLeaf[] = []; const cond = new Set<string>();
  const build = (c: CompiledSearch, underOr: boolean): { node: PNode; where: string } => {
    if (c.op === 'leaf') {
      cond.add(c.leaf.node.field);
      const where = tokenWhere(c, params, 'i'); let flag: string | undefined;
      if (underOr) { flag = `f${flags.length}`; flags.push({ name: flag, sql: `coalesce(${tokenWhere(c, params, 'i')},false)` }); }
      const leaf: PLeaf = { kind: 'leaf', c: c.leaf, field: c.leaf.node.field, flag, idx: leaves.length }; leaves.push(leaf);
      return { node: leaf, where };
    }
    const kids = c.children.map(k => build(k, underOr || c.op === 'any'));
    return { node: { kind: c.op === 'all' ? 'and' : 'or', kids: kids.map(k => k.node) }, where: `(${kids.map(k => k.where).join(c.op === 'all' ? ' and ' : ' or ')})` };
  };
  const { node, where } = build(compiled, false);
  return { root: node, leaves, condFields: [...cond], flags, where, params };
}
export type SqlOpts = { cols: string[]; orderBy: boolean; limit?: number; after?: string; schema?: string };
export function planSql(p: Plan, o: SqlOpts) {
  const S = o.schema ?? SCHEMA4; const params = [...p.params];
  const sel = [`p."id"`, ...o.cols.map(f => `encode(p."${f}_ct",'base64') as "${f}"`), ...p.flags.map(f => `${f.sql} as ${f.name}`)].join(',');
  let extra = '';
  if (o.after !== undefined) { params.push(o.after); extra += ` and p."id" > $${params.length}::uuid`; }
  const tail = (o.orderBy ? ' order by p."id"' : '') + (o.limit !== undefined ? ` limit ${o.limit | 0}` : '');
  const text = p.flags.length
    ? `select ${sel} from "${S}"."customers" p join "${S}"."customers_seal_index" i on i."scope_id"=$1 and i."row_id"=p."id" where p."scope_id"=$1 and ${p.where}${extra}${tail}`
    : `select ${sel} from "${S}"."customers" p where p."scope_id"=$1${extra} and p."id" in (select i."row_id" from "${S}"."customers_seal_index" i where i."scope_id"=$1 and ${p.where})${tail}`;
  return { text, params };
}

// ---------------------------------------------------------------- A3 fast verify
const FAST = /^[\x20-\x40\x5b-\x7e가-힣]*$/;
function fastLeaf(leaf: CompiledLeaf, value: string | null): boolean | undefined {
  if (value === null) return false;
  const { node, profile, normalized } = leaf;
  if (profile.normalizer !== 'legacy-text-v1' || node.op === 'like' || node.respectWords || !FAST.test(value)) return undefined;
  const t = value.indexOf(' ') < 0 ? value : value.replaceAll(' ', '');
  switch (node.op) { case 'eq': return t === normalized; case 'contains': return t.includes(normalized as string);
    case 'startsWith': return t.startsWith(normalized as string); case 'endsWith': return t.endsWith(normalized as string); }
}
const srcLeaf = (leaf: CompiledLeaf, v: unknown) => verifySearch({ op: 'leaf', leaf }, () => Promise.resolve(v));
export const check = { enabled: false, compared: 0 };

// ---------------------------------------------------------------- rows + decision rounds
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type Row = { id: string; ct: Record<string, Uint8Array | null>; val: Record<string, string | null>; leaf: Int8Array };
export class ShapeError extends Error {}
export function toRow(raw: any, p: Plan, cols: string[], seen: Set<string>, lastId: { v: string } | null): Row {
  const id = raw.id; if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)) throw new ShapeError('INVALID_CANDIDATE_SHAPE');
  if (lastId) { if (id <= lastId.v) throw new ShapeError('INVALID_CANDIDATE_SHAPE'); lastId.v = id; }
  seen.add(id);
  const ct: Row['ct'] = {}; for (const f of cols) ct[f] = raw[f] === null ? null : Buffer.from(raw[f], 'base64');
  const leaf = new Int8Array(p.leaves.length).fill(-1);
  for (const l of p.leaves) if (l.flag !== undefined) { const fl = raw[l.flag]; if (typeof fl !== 'boolean') throw new ShapeError('INVALID_CANDIDATE_SHAPE'); if (!fl) leaf[l.idx] = 0; }
  return { id, ct, val: {}, leaf };
}
function eval3(n: PNode, r: Row): number { // 1 true, 0 false, -1 unknown
  if (n.kind === 'leaf') return r.leaf[n.idx];
  const want = n.kind === 'or' ? 1 : 0; let unk = false;
  for (const k of n.kids) { const v = eval3(k, r); if (v === want) return want; if (v < 0) unk = true; }
  return unk ? -1 : 1 - want;
}
function nextLeaf(n: PNode, r: Row): PLeaf { if (n.kind === 'leaf') return n; for (const k of n.kids) if (eval3(k, r) < 0) return nextLeaf(k, r); throw Error('unreachable'); }
export const vstats = { verifyMs: 0, rounds: 0 };
/** Sets a field value and resolves its leaves; returns false if some leaf needs the async src verify (then call setFieldSlow). */
function setField(p: Plan, r: Row, f: string, v: string | null): boolean {
  r.val[f] = v; let done = true;
  for (const l of p.leaves) if (l.field === f && r.leaf[l.idx] < 0) { const fast = fastLeaf(l.c, v); if (fast === undefined || check.enabled) done = false; else r.leaf[l.idx] = fast ? 1 : 0; }
  return done;
}
async function setFieldSlow(p: Plan, r: Row, f: string, v: string | null) {
  for (const l of p.leaves) if (l.field === f && r.leaf[l.idx] < 0) {
    const fast = fastLeaf(l.c, v); const res = await srcLeaf(l.c, v);
    if (check.enabled && fast !== undefined) { assert.equal(fast, res, 'A3 fast verify mismatch'); check.compared++; }
    r.leaf[l.idx] = res ? 1 : 0;
  }
}
/** Decide rows in batched short-circuit rounds. Returns per-row match. */
export async function decide(p: Plan, rows: Row[], pre: Map<string, Prefix>): Promise<Uint8Array> {
  const res = new Uint8Array(rows.length); let pending = rows.map((_, i) => i);
  while (pending.length) {
    const jobs: Job[] = [], jr: number[] = [], jf: string[] = [], still: number[] = [];
    for (const i of pending) {
      const r = rows[i]; let v = eval3(p.root, r);
      while (v < 0) {
        const l = nextLeaf(p.root, r); const ct = r.ct[l.field];
        if (ct === null) { if (!setField(p, r, l.field, null)) await setFieldSlow(p, r, l.field, null); v = eval3(p.root, r); continue; }
        jobs.push({ env: ct, rowId: r.id, pre: pre.get(l.field)! }); jr.push(i); jf.push(l.field); still.push(i); break;
      }
      if (v >= 0) res[i] = v;
    }
    if (!jobs.length) break;
    vstats.rounds++;
    const vals = await open(jobs);
    const t = now(); for (let k = 0; k < jobs.length; k++) if (!setField(p, rows[jr[k]], jf[k], vals[k])) await setFieldSlow(p, rows[jr[k]], jf[k], vals[k]); vstats.verifyMs += now() - t;
    pending = still;
  }
  return res;
}
/** Open projection fields not yet opened for the given rows (1 batch). */
export async function project(rows: Row[], pre: Map<string, Prefix>, scope: string) {
  const jobs: Job[] = [], jr: Row[] = [], jf: string[] = [];
  for (const r of rows) for (const f of fields) if (!(f in r.val)) { const ct = r.ct[f]; if (ct === null) r.val[f] = null; else { jobs.push({ env: ct, rowId: r.id, pre: pre.get(f)! }); jr.push(r); jf.push(f); } }
  const vals = await open(jobs); for (let k = 0; k < jobs.length; k++) jr[k].val[jf[k]] = vals[k];
  return rows.map(r => ({ id: r.id, scopeId: scope, ...Object.fromEntries(fields.map(f => [f, r.val[f]])) }));
}

// ---------------------------------------------------------------- runs (timed sections)
export type Timing = { value: any; totalMs: number; preMs: number; dbMs: number; betweenSqlMs: number; postMs: number; sqlCalls: number; candidateRows: number;
  macs: number; decrypts: number; cbcCalls: number; rounds: number; macMs: number; cbcMs: number; decodeMs: number; verifyMs: number; overlapDecrypts?: number };
type Client = pg.PoolClient;
function streamRows(cl: Client, text: string, params: unknown[], onRow: (raw: any) => void): Promise<number> {
  return new Promise((res, rej) => { const q = new Query({ text, values: params } as any); q.on('row', r => { try { onRow(r); } catch (e) { rej(e); } }); q.on('end', () => res(now())); q.on('error', rej); cl.query(q as any); });
}
function begin() { Object.assign(stats, { macs: 0, decrypts: 0, cbcCalls: 0, macMs: 0, cbcMs: 0, decodeMs: 0 }); vstats.verifyMs = 0; vstats.rounds = 0; }
function fin(t0: number, sqls: { s: number; e: number; rows: number }[], value: any, extra: object = {}): Timing {
  const t1 = now(); const dbMs = sqls.reduce((a, x) => a + x.e - x.s, 0); const preMs = sqls[0].s - t0, postMs = t1 - sqls.at(-1)!.e;
  return { value, totalMs: t1 - t0, preMs, dbMs, betweenSqlMs: t1 - t0 - preMs - dbMs - postMs, postMs, sqlCalls: sqls.length, candidateRows: sqls.reduce((a, x) => a + x.rows, 0),
    macs: stats.macs, decrypts: stats.decrypts, cbcCalls: stats.cbcCalls, rounds: vstats.rounds, macMs: stats.macMs, cbcMs: stats.cbcMs, decodeMs: stats.decodeMs, verifyMs: vstats.verifyMs, ...extra };
}
/** count: batch (all rows, then rounds) or stream (chunks of CH rows decided while later rows arrive). */
export async function x4Count(pool: pg.Pool | { connect(): Promise<Client> }, n: Node, stream: boolean, scope = scopeA, schema = SCHEMA4, CH = Number(process.env.X4_CH ?? 1024)): Promise<Timing> {
  begin(); const t0 = now();
  const p = await makePlan(n, scope); const pre = prefixes(scope); const cols = p.condFields;
  const { text, params } = planSql(p, { cols, orderBy: false, schema });
  const cl = await pool.connect(); const seen = new Set<string>(); let count = 0, received = 0; const sq = { s: 0, e: 0, rows: 0 };
  try {
    if (!stream) {
      sq.s = now(); const r = await cl.query({ text, values: params } as any); sq.e = now(); sq.rows = r.rows.length;
      const rows = r.rows.map((x: any) => toRow(x, p, cols, seen, null)); const m = await decide(p, rows, pre); for (const b of m) count += b;
    } else {
      let chunk: Row[] = []; let chain = Promise.resolve(); let decAtEnd = 0;
      const flush = () => { const c = chunk; chunk = []; chain = chain.then(async () => { const m = await decide(p, c, pre); for (const b of m) count += b; }); };
      sq.s = now();
      sq.e = await streamRows(cl, text, params, raw => { chunk.push(toRow(raw, p, cols, seen, null)); received++; if (chunk.length >= CH) flush(); });
      decAtEnd = stats.decrypts; sq.rows = received; flush(); await chain;
      return fin(t0, [sq], count, { overlapDecrypts: decAtEnd });
    }
  } finally { cl.release(); }
  return fin(t0, [sq], count);
}
/** findMany (all 6 fields, order by id). limit undefined = all candidates (1 SQL); limit N = keyset batches starting at N candidates, doubling. */
export async function x4Find(pool: pg.Pool | { connect(): Promise<Client> }, n: Node, limit: number | undefined, stream: boolean, scope = scopeA, schema = SCHEMA4, CH = Number(process.env.X4_CH ?? 1024)): Promise<Timing> {
  begin(); const t0 = now();
  const p = await makePlan(n, scope); const pre = prefixes(scope);
  const cl = await pool.connect(); const sqls: { s: number; e: number; rows: number }[] = []; const out: any[] = [];
  const seen = new Set<string>(); const last = { v: '' };
  try {
    if (limit === undefined) {
      const { text, params } = planSql(p, { cols: fields, orderBy: true, schema }); const sq = { s: now(), e: 0, rows: 0 }; sqls.push(sq);
      if (!stream) {
        const r = await cl.query({ text, values: params } as any); sq.e = now(); sq.rows = r.rows.length;
        const rows = r.rows.map((x: any) => toRow(x, p, fields, seen, last)); const m = await decide(p, rows, pre);
        out.push(...await project(rows.filter((_: Row, i: number) => m[i]), pre, scope));
      } else {
        let chunk: Row[] = []; let chain = Promise.resolve(); let received = 0;
        const flush = () => { const c = chunk; chunk = []; chain = chain.then(async () => { const m = await decide(p, c, pre); out.push(...await project(c.filter((_, i) => m[i]), pre, scope)); }); };
        sq.e = await streamRows(cl, text, params, raw => { chunk.push(toRow(raw, p, fields, seen, last)); received++; if (chunk.length >= CH) flush(); });
        sq.rows = received; flush(); await chain;
      }
    } else {
      let L = limit;
      for (;;) {
        const { text, params } = planSql(p, { cols: fields, orderBy: true, limit: L, after: last.v || undefined, schema });
        const sq = { s: now(), e: 0, rows: 0 }; sqls.push(sq);
        const r = await cl.query({ text, values: params } as any); sq.e = now(); sq.rows = r.rows.length;
        const rows: Row[] = r.rows.map((x: any) => toRow(x, p, fields, seen, last)); const m = await decide(p, rows, pre);
        const hit = rows.filter((_, i) => m[i]).slice(0, limit - out.length); out.push(...await project(hit, pre, scope));
        if (out.length >= limit || rows.length < L) break;
        L = Math.min(L * 2, 1 << 20);
      }
    }
  } finally { cl.release(); }
  return fin(t0, sqls, out);
}
export { stats, now, scopeA, fields };

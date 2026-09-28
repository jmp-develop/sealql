/**
 * X1 — count/findMany without changing stored format or leakage (read-only DB).
 * Compares plaintext, product (dist `sealql`) and prototype variants on the 5 R8 combos in both environments.
 *   P1 = A1: lazy per-row short-circuit + per-leaf token flags (only for leaves under OR) + in-call adaptive order. Product SQL shape,
 *        src Sealer.open + src verifySearch.
 *   P2 = P1 + A2 fast open (same HKDF keys/AAD/GCM, less glue) + A3 fast verify (identity-normalization fast path).
 *   P3 = P2 + bytea as base64 text (1.33x vs hex 2x on the wire; pg 8 has no binary result mode), no ORDER BY for count (dup check by Set).
 *   P4 = P3 + row streaming (decrypt overlaps transfer).
 * Usage: rtk proxy npx tsx bench/research-count/x1-proto.ts <count|find|explain|anatomy> [envIndex]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer as distSealer } from 'sealql';
import { createSealed as distSealed } from 'sealql/drizzle/v0.45';
import { createSealed as srcSealed } from '../../src/adapters/drizzle/v0.45/index.js';
import { registrationOf, type Registration } from '../../src/adapters/drizzle/v0.45/native.js';
import { createSealer, type CipherContext } from '../../src/core/field-cipher.js';
import { compileSearch, verifySearch, type CompiledLeaf, type CompiledSearch, type SearchNode } from '../../src/core/search-predicate.js';
import { profiles, type SearchTokenCache } from '../../src/core/search-tokens.js';
import { candidatePredicate } from '../../src/core/candidate-sql.js';
import { concat, frame, u32 } from '../../src/core/bytes.js';
import { codecId, codecParameters, codecVersion } from '../../src/core/field-codec.js';
import type { Fragment, Node as FNode } from '../../src/core/sql-fragment.js';
import { assertDisposable } from '../../test/disposable.js';
import { combos, condition, fields, plainWhere, type Case, type Node } from '../verify-native/r8-cases.js';

const { Client, Pool, Query } = pg;
const mode = process.argv[2] as 'count' | 'find' | 'explain' | 'anatomy';
assert(['count', 'find', 'explain', 'anatomy'].includes(mode));
const OUT = 'bench/results/2026-09-28-count-research';
const LOCK = '.local/research/measure.lock';
const KEY = new Uint8Array(32).fill(93);
const K = 64; // rows in flight (product: 64 fields in flight)
type Env = { name: string; schema: string; plainTable: string; scope: string };
const envs: Env[] = [
  { name: '10만 단독', schema: 'native_verify_main', plainTable: 'bench_realistic_100k.customers', scope: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { name: '1억 속 회사 B', schema: 'native_scale_100m', plainTable: 'native_scale_100m.customers_plain', scope: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
].filter((_, i) => process.argv[3] === undefined || String(i) === process.argv[3]);
const search = { exact: true, substring: { wordBoundary: true, skipGrams: true } } as const;
function columnsOf(sealed: any) {
  return { id: uuid('id').primaryKey(), scopeId: uuid('scope_id').notNull(),
    name: sealed.text('name', { search }), phone: sealed.text('phone', { search }), address: sealed.text('address', { search }),
    memo: sealed.text('memo', { search }), email: sealed.text('email', { search }), company: sealed.text('company', { search }) };
}
// ---- product (dist) with open counting ----
let opens = 0;
function countingSealer() {
  const s = distSealer({ key: KEY }); const o = s.open.bind(s);
  s.open = (...a: Parameters<typeof s.open>) => { opens++; return o(...a); };
  return s;
}
const product = new Map(envs.map(e => { const sealed = distSealed({ sealer: countingSealer });
  return [e.name, { sealed, reg: sealed.register(pgSchema(e.schema).table('customers', columnsOf(sealed)), { row: 'id', scope: 'scopeId' }) }]; }));
// ---- prototype registration (src) ----
const sealer = createSealer({ key: KEY });
const protoReg = new Map(envs.map(e => { const sealed = srcSealed({ sealer }); const t = pgSchema(e.schema).table('customers', columnsOf(sealed));
  return [e.name, registrationOf(sealed.register(t as any, { row: 'id', scope: 'scopeId' }))]; }));

const pool = new Pool({ host: '127.0.0.1', port: 56439, user: 'sealql_test', database: 'postgres', max: 4,
  options: '-c default_transaction_read_only=on -c statement_timeout=300000' });
const db = drizzle(pool);
// product SQL timing hook (same as r8-measure)
type Ev = { start: number; end: number; rows: number; sql: string; params: unknown[] };
let events: Ev[] | null = null;
const originalQuery = Client.prototype.query;
(Client.prototype as any).query = function (...args: any[]) {
  const start = performance.now();
  if (args[0] instanceof Query) return (originalQuery as any).apply(this, args);
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
  const params = (Array.isArray(args[1]) ? args[1] : args[0]?.values ?? []) as unknown[];
  const record = (r: any) => { events?.push({ start, end: performance.now(), rows: r?.rows?.length ?? 0, sql, params }); return r; };
  const cb = args.findIndex(x => typeof x === 'function');
  if (cb >= 0) { const old = args[cb]; args[cb] = (e: any, r: any) => { record(r); old(e, r); }; }
  const result = (originalQuery as any).apply(this, args);
  return cb < 0 && result?.then ? result.then(record, (e: any) => { record(null); throw e; }) : result;
};
// ---------------------------------------------------------------- prototype
const toCore = (n: Node): SearchNode => 'all' in n ? { op: 'all', children: n.all.map(toCore) } : 'any' in n ? { op: 'any', children: n.any.map(toCore) } : { op: n.op, field: n.field, value: n.value };
type PLeaf = { kind: 'leaf'; c: CompiledLeaf; key: string; flag?: string; evals: number; trues: number; cost: number };
type PInner = { kind: 'and' | 'or'; kids: PNode[]; evals: number; trues: number; cost: number };
type PNode = PLeaf | PInner;
type Plan = { root: PNode; compiled: CompiledSearch; condKeys: string[]; flagSql: { name: string; sql: string }[]; params: unknown[]; tokenWhere: string };
const ident = (...n: string[]) => n.map(x => `"${x.replace(/"/g, '""')}"`).join('.');
function render(f: Fragment, params: unknown[]) {
  const b = (n: FNode): string => n.kind === 'literal' ? n.text : n.kind === 'identifier' ? ident(...n.names)
    : n.kind === 'param' ? (params.push(Array.isArray(n.value) ? `{${n.value.join(',')}}` : n.value), `$${params.length}`) : n.nodes.map(b).join('');
  return b(f.node);
}
const tokenCache: SearchTokenCache = { profiles: new Map() };
async function plan(reg: Registration, scopeId: string, c: Case): Promise<Plan> {
  const stored = [...reg.fields].flatMap(([key, f]) => profiles(reg.model, f.spec.id ?? key, f.spec));
  const compiled = await compileSearch(toCore(c.node), reg.definition, stored, sealer.ring(reg.model), scopeId, tokenCache);
  const params: unknown[] = [scopeId]; const flagSql: Plan['flagSql'] = []; const condKeys = new Set<string>();
  const tokPred = (leaf: CompiledLeaf) => {
    const col = ident('i', reg.storage.index!.profiles![leaf.profile.indexId].tokens);
    params.push(leaf.profile.mode === 'exact' ? leaf.tokens[0] : `{${leaf.tokens.join(',')}}`);
    return leaf.profile.mode === 'exact' ? `(${col})[1]=$${params.length}::bigint` : `${col} @> $${params.length}::bigint[]`;
  };
  const build = (n: CompiledSearch, underOr: boolean): { node: PNode; where: string } => {
    if (n.op === 'leaf') {
      condKeys.add(n.leaf.node.field);
      const where = tokPred(n.leaf); let flag: string | undefined;
      if (underOr) { flag = `f${flagSql.length}`; flagSql.push({ name: flag, sql: `coalesce(${where},false)` }); }
      return { node: { kind: 'leaf', c: n.leaf, key: n.leaf.node.field, flag, evals: 0, trues: 0, cost: 0 }, where };
    }
    const kids = n.children.map(k => build(k, underOr || n.op === 'any'));
    return { node: { kind: n.op === 'all' ? 'and' : 'or', kids: kids.map(k => k.node), evals: 0, trues: 0, cost: 0 },
      where: `(${kids.map(k => k.where).join(n.op === 'all' ? ' and ' : ' or ')})` };
  };
  const { node, where } = build(compiled, false);
  return { root: node, compiled, condKeys: [...condKeys], flagSql, params, tokenWhere: where };
}
function resetStats(n: PNode) { n.evals = n.trues = n.cost = 0; if (n.kind !== 'leaf') n.kids.forEach(resetStats); }
function reorder(n: PNode) {
  if (n.kind === 'leaf') return;
  n.kids.forEach(reorder);
  const score = (k: PNode) => { const c = (k.evals ? k.cost / k.evals : 1) + 0.01, p = k.evals ? k.trues / k.evals : 0.5;
    return n.kind === 'and' ? c / Math.max(1 - p, 1e-3) : c / Math.max(p, 1e-3); };
  n.kids.sort((a, b) => score(a) - score(b));
}
/** A2: same keys (HKDF), same AAD, same AES-GCM check as Sealer.open, with per-call glue removed. */
class FastOpener {
  private f = new Map<string, { aad: Uint8Array; rowOff: number; keys: (CryptoKey | undefined)[]; pending: (Promise<CryptoKey> | undefined)[]; info: (s: number) => Uint8Array }>();
  private material: Promise<CryptoKey>;
  private td = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  constructor(private reg: Registration, scopeId: string) {
    this.material = crypto.subtle.importKey('raw', KEY, 'HKDF', false, ['deriveKey']);
    const ks = sealer.keyScopeId(reg.model), scope = new TextEncoder().encode(scopeId);
    for (const [key, b] of reg.fields) {
      const spec = b.spec; assert(spec.type === 'text' && spec.maxBytes === undefined);
      const fid = spec.id ?? key, codec = codecId(spec), cv = codecVersion(spec), par = codecParameters(spec);
      const stat = frame(['sealql/aad/v3', new Uint8Array([3]), reg.model, fid, codec, u32(cv), par, ks]);
      const prefix = concat(u32(10), stat.subarray(4));
      const aad = concat(prefix, u32(scope.length), scope, u32(36), new Uint8Array(36));
      this.f.set(key, { aad, rowOff: aad.length - 36, keys: [], pending: [],
        info: s => frame(['sealql/cipher/v3', reg.model, fid, codec, u32(cv), par, ks, new Uint8Array([s])]) });
    }
  }
  private derive(f: any, s: number) {
    return f.pending[s] ??= this.material.then(m => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-384', salt: new Uint8Array(), info: f.info(s) }, m,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt'])).then((k: CryptoKey) => (f.keys[s] = k));
  }
  async open(key: string, rowId: string, ct: Uint8Array): Promise<string> {
    if (!(ct.length >= 29 && ct[0] === 3)) throw Error('INVALID_CIPHERTEXT');
    const f = this.f.get(key)!;
    let h = 0x811c9dc5; const aad = f.aad.slice(), o = f.rowOff; // fresh per call: a shared buffer failed auth (Node does not copy AAD synchronously)
    for (let i = 0; i < 36; i++) h = Math.imul(h ^ rowId.charCodeAt(i), 0x01000193);
    const s = h & 0xff;
    const k = f.keys[s] ?? await this.derive(f, s);
    for (let i = 0; i < 36; i++) aad[o + i] = rowId.charCodeAt(i);
    let plain: Uint8Array;
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ct.subarray(1, 13), additionalData: aad, tagLength: 128 }, k, ct.subarray(13))); }
    catch { throw Error('AUTHENTICATION_FAILED'); }
    if (plain[0] === 0xef && plain[1] === 0xbb && plain[2] === 0xbf) throw Error('INVALID_CIPHERTEXT'); // product: BOM strip => canonical mismatch
    try { return this.td.decode(plain); } catch { throw Error('INVALID_CIPHERTEXT'); }
  }
}
/** A3: when fold+NFC are identity (ASCII w/o A-Z, precomposed Hangul, U+0020), legacy normalization = remove spaces. */
const FAST = /^[\x20-\x40\x5b-\x7e가-힣]*$/;
function fastLeaf(leaf: CompiledLeaf, value: unknown): boolean | undefined {
  if (value === null) return false;
  const { node, profile, normalized } = leaf;
  if (typeof value !== 'string' || profile.normalizer !== 'legacy-text-v1' || node.op === 'like' || node.respectWords || !FAST.test(value)) return undefined;
  const t = value.indexOf(' ') < 0 ? value : value.replaceAll(' ', '');
  switch (node.op) { case 'eq': return t === normalized; case 'contains': return t.includes(normalized as string);
    case 'startsWith': return t.startsWith(normalized as string); case 'endsWith': return t.endsWith(normalized as string); }
}
const srcLeaf = (leaf: CompiledLeaf, value: unknown) => verifySearch({ op: 'leaf', leaf }, () => Promise.resolve(value));
type Opts = { fast: boolean; b64: boolean; stream: boolean; orderBy: boolean; scopeCol: boolean; check?: boolean; find?: boolean };
type Row = { id: string; ct: Record<string, Uint8Array | null>; flags: Record<string, boolean>; opened: Record<string, Promise<unknown>>; decrypts: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function protoSql(e: Env, reg: Registration, p: Plan, o: Opts) {
  const params = [...p.params];
  const cols = (o.find ? [...reg.fields.keys()] : p.condKeys).map(k => { const c = `p.${ident(reg.fields.get(k)!.column.name)}`; return `${o.b64 ? `encode(${c},'base64')` : c} as ${ident(k)}`; });
  const sel = [`p."id" as "id"`, ...(o.scopeCol ? [`p."scope_id" as "scopeId"`] : []), ...cols,
    ...p.flagSql.map(f => `${f.sql} as ${f.name}`)].join(',');
  const parent = ident(e.schema, 'customers'), index = ident(e.schema, 'customers_seal_index');
  const order = o.orderBy ? ' order by p."id"' : '';
  // No flags: same semi-join as the product. Flags: join on the unique (scope_id,row_id) — same row set.
  const text = p.flagSql.length
    ? `select ${sel} from ${parent} p join ${index} i on i."scope_id"=$1 and i."row_id"=p."id" where p."scope_id"=$1 and ${p.tokenWhere}${order}`
    : `select ${sel} from ${parent} p where p."scope_id"=$1 and p."id" in (select i."row_id" from ${index} i where i."scope_id"=$1 and ${p.tokenWhere})${order}`;
  return { text, params };
}
type Stats = { value: any; totalMs: number; preMs: number; dbMs: number; betweenSqlMs: number; postMs: number; sqlCalls: number; candidateRows: number; openCount: number; decryptsBeforeDbEnd?: number };
async function protoRun(e: Env, c: Case, o: Opts, opener: FastOpener): Promise<Stats> {
  const t0 = performance.now();
  const reg = protoReg.get(e.name)!; const p = await plan(reg, e.scope, c); resetStats(p.root);
  const ring = sealer.ring(reg.model), ks = sealer.keyScopeId(reg.model);
  const { text, params } = protoSql(e, reg, p, o);
  const client = await pool.connect();
  let decrypts = 0, matched = 0, evaluated = 0, received = 0, tEnd = 0, decAtEnd = 0, lastId = '';
  const seen = new Set<string>(); const items: (Record<string, unknown> | undefined)[] = [];
  const open = (r: Row, key: string): Promise<unknown> => r.opened[key] ??= (() => {
    const ct = r.ct[key]; if (ct === null) return Promise.resolve(null);
    decrypts++; r.decrypts++;
    if (o.fast) return opener.open(key, r.id, ct);
    const spec = reg.fields.get(key)!.spec;
    const ctx: CipherContext = { modelId: reg.model, fieldId: spec.id ?? key, keyScopeId: ks, scopeId: e.scope, rowId: r.id, spec };
    return sealer.open(ct, ctx, ring);
  })();
  const evalNode = async (n: PNode, r: Row): Promise<boolean> => {
    const before = r.decrypts; let res: boolean;
    if (n.kind === 'leaf') {
      if (n.flag !== undefined && r.flags[n.flag] === false) res = false; // token absent => proven false (no false negatives)
      else {
        const v = await open(r, n.key);
        const f = o.fast ? fastLeaf(n.c, v) : undefined;
        res = f ?? await srcLeaf(n.c, v);
        if (o.check && f !== undefined) assert.equal(f, await srcLeaf(n.c, v), 'fast verify mismatch');
      }
    } else {
      res = n.kind === 'and';
      for (const k of [...n.kids]) if ((await evalNode(k, r)) !== (n.kind === 'and')) { res = !res; break; }
    }
    n.evals++; if (res) n.trues++; n.cost += r.decrypts - before;
    return res;
  };
  const toRow = (raw: any): Row => {
    const id = raw.id; if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)) throw Error('INVALID_CANDIDATE_SHAPE');
    if (o.orderBy && id <= lastId) throw Error('INVALID_CANDIDATE_SHAPE');
    if (o.scopeCol && raw.scopeId !== e.scope) throw Error('INVALID_CANDIDATE_SHAPE');
    seen.add(id); lastId = id;
    const ct: Row['ct'] = {}; for (const k of (o.find ? [...reg.fields.keys()] : p.condKeys)) ct[k] = raw[k] === null ? null : o.b64 ? Buffer.from(raw[k], 'base64') : raw[k];
    const flags: Row['flags'] = {}; for (const f of p.flagSql) flags[f.name] = raw[f.name];
    return { id, ct, flags, opened: {}, decrypts: 0 };
  };
  const handle = async (r: Row, index: number) => {
    const ok = await evalNode(p.root, r);
    if (++evaluated % 256 === 0) reorder(p.root);
    if (!ok) return;
    matched++;
    if (o.find) {
      const item: Record<string, unknown> = { id: r.id, scopeId: e.scope };
      await Promise.all([...reg.fields.keys()].map(async k => { item[k] = await open(r, k); }));
      items[index] = item;
    }
  };
  let tSend = 0;
  try {
    if (!o.stream) {
      tSend = performance.now();
      const res = await client.query({ text, values: params } as any);
      tEnd = performance.now(); received = res.rows.length;
      const rows = res.rows.map(toRow); let cur = 0;
      await Promise.all(Array.from({ length: Math.min(K, rows.length) }, async () => { while (cur < rows.length) { const i = cur++; await handle(rows[i], i); } }));
    } else {
      await new Promise<void>((resolve, reject) => {
        let inflight = 0, done = false, failed = false; const pending: [Row, number][] = []; let head = 0;
        const fail = (err: unknown) => { if (!failed) { failed = true; reject(err); } };
        const pump = () => {
          while (inflight < K && head < pending.length) { const [r, i] = pending[head]; pending[head++] = undefined as any; inflight++;
            handle(r, i).then(() => { inflight--; pump(); }, fail); }
          if (done && inflight === 0 && head === pending.length && !failed) resolve();
        };
        const q = new Query({ text, values: params } as any);
        q.on('row', (raw: any) => { try { pending.push([toRow(raw), received++]); pump(); } catch (err) { fail(err); } });
        q.on('end', () => { tEnd = performance.now(); decAtEnd = decrypts; done = true; pump(); });
        q.on('error', fail);
        tSend = performance.now();
        client.query(q as any);
      });
    }
  } finally { client.release(); }
  const t1 = performance.now();
  const value = o.find ? items.filter(Boolean).sort((a: any, b: any) => a.id < b.id ? -1 : 1) : matched;
  return { value, totalMs: t1 - t0, preMs: tSend - t0, dbMs: tEnd - tSend, betweenSqlMs: 0, postMs: t1 - tEnd, sqlCalls: 1,
    candidateRows: received, openCount: decrypts, ...(o.stream ? { decryptsBeforeDbEnd: decAtEnd } : {}) };
}
// ---------------------------------------------------------------- plain / product
function match(n: Node, m: any): any {
  if ('all' in n) return m.and(...n.all.map(x => match(x, m)));
  if ('any' in n) return m.or(...n.any.map(x => match(x, m)));
  return m[n.field][n.op](n.value);
}
async function plainCount(c: Case, e: Env) { const params: unknown[] = [e.scope]; const w = plainWhere(c.node, params);
  return Number((await pool.query(`select count(*) n from ${e.plainTable} where scope_id=$1 and ${w}`, params)).rows[0].n); }
async function plainFind(c: Case, e: Env) { const params: unknown[] = [e.scope]; const w = plainWhere(c.node, params);
  return (await pool.query(`select id,scope_id as "scopeId",${fields.map(f => `${f}_plain as ${f}`).join(',')} from ${e.plainTable} where scope_id=$1 and ${w} order by id`, params)).rows; }
async function timed(fn: () => Promise<any>): Promise<Stats> {
  const ev: Ev[] = []; events = ev; opens = 0; const t0 = performance.now(); let value: any;
  try { value = await fn(); } finally { events = null; }
  const t1 = performance.now(), dbMs = ev.reduce((s, x) => s + x.end - x.start, 0);
  const preMs = ev.length ? ev[0].start - t0 : t1 - t0, postMs = ev.length ? t1 - ev.at(-1)!.end : 0;
  return { value, totalMs: t1 - t0, preMs, dbMs, betweenSqlMs: t1 - t0 - preMs - dbMs - postMs, postMs, sqlCalls: ev.length,
    candidateRows: ev.reduce((s, x) => s + x.rows, 0), openCount: opens, sqlEvents: ev } as any;
}
const productCount = (c: Case, e: Env) => { const x = product.get(e.name)!; return x.sealed.count(db, x.reg, { scope: e.scope, match: (m: any) => match(c.node, m) } as any); };
const productFind = (c: Case, e: Env) => { const x = product.get(e.name)!;
  return x.sealed.findMany(db, x.reg, { scope: e.scope, match: (m: any) => match(c.node, m), columns: Object.fromEntries(fields.map(f => [f, true])) } as any).then((r: any) => r.items); };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const KEYS = ['totalMs', 'preMs', 'dbMs', 'betweenSqlMs', 'postMs', 'sqlCalls', 'candidateRows', 'openCount', 'decryptsBeforeDbEnd'] as const;
const summary = (xs: any[]) => Object.fromEntries(KEYS.filter(k => xs[0][k] !== undefined).map(k => [k, +median(xs.map(x => x[k])).toFixed(3)]));
const idHash = (xs: any[]) => createHash('sha256').update(xs.map(x => x.id).join('\n')).digest('hex');
function same(a: any, b: any, label: string) {
  if (typeof a === 'number') { assert.equal(b, a, label); return; }
  assert.equal(b.length, a.length, `${label} length`); assert.equal(idHash(b), idHash(a), `${label} id hash`);
  for (let i = 0; i < a.length; i++) for (const f of ['id', 'scopeId', ...fields]) assert.equal(b[i][f], a[i][f], `${label} ${f} ${i}`);
}
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 1) + '\n';
const VARIANTS: Record<string, Opts> = {
  P1: { fast: false, b64: false, stream: false, orderBy: true, scopeCol: true },
  P2: { fast: true, b64: false, stream: false, orderBy: true, scopeCol: true },
  P3: { fast: true, b64: true, stream: false, orderBy: false, scopeCol: false },
  P4: { fast: true, b64: true, stream: true, orderBy: false, scopeCol: false },
};
async function lock() {
  while (existsSync(LOCK)) { console.error('lock held:', readFileSync(LOCK, 'utf8')); await new Promise(r => setTimeout(r, 60000)); }
  writeFileSync(LOCK, `X1 ${mode} ${new Date().toISOString()}\n`);
}
// ---------------------------------------------------------------- main
try {
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port), 56439);
  assert.equal((await pool.query('show default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');
  await lock();
  const openers = new Map(envs.map(e => [e.name, new FastOpener(protoReg.get(e.name)!, e.scope)]));
  if (mode === 'count' || mode === 'find') {
    const find = mode === 'find'; const out: any[] = [];
    for (const e of envs) for (const c of combos) {
      const opener = openers.get(e.name)!;
      const expected = find ? await plainFind(c, e) : await plainCount(c, e);
      // one untimed self-check: fast verify == src verify on every evaluated leaf
      same(expected, (await protoRun(e, c, { ...VARIANTS.P4, check: true, find, orderBy: find }, opener)).value, 'check');
      const paths: Record<string, () => Promise<Stats>> = {
        plain: () => timed(() => find ? plainFind(c, e) : plainCount(c, e)),
        product: () => timed(() => find ? productFind(c, e) : productCount(c, e)),
        ...Object.fromEntries(Object.entries(VARIANTS).map(([k, o]) => [k, () => protoRun(e, c, { ...o, find, orderBy: find || o.orderBy }, opener)])),
      };
      const names = Object.keys(paths); const runs: Record<string, any[]> = Object.fromEntries(names.map(n => [n, []]));
      const first: Record<string, any> = {};
      for (let i = 0; i < 10; i++) { // 1 first + 2 warm-up + 7 rotated
        const order = names.map((_, j) => names[(j + i) % names.length]);
        for (const n of order) {
          const m = await paths[n](); same(expected, m.value, `${e.name}/${c.name}/${n}/${i}`);
          const { value, sqlEvents, ...rest } = m as any;
          if (i === 0) first[n] = rest; else if (i >= 3) runs[n].push(rest);
        }
      }
      const row = { case: c.name, condition: condition(c.node), environment: e.name, mode: find ? 'findMany 전부' : 'count',
        matches: find ? expected.length : expected, ...Object.fromEntries(names.map(n => [n, summary(runs[n])])), first, runs };
      out.push(row);
      console.log(JSON.stringify({ env: e.name, case: c.name, ...Object.fromEntries(names.map(n => [n, [row[n as keyof typeof row] as any].map((s: any) => `${s.totalMs}/${s.dbMs}/${s.postMs} o=${s.openCount}`)[0]])) }));
      writeFileSync(`${OUT}/x1-${mode}${process.argv[3] ?? ''}.json`, json({ startedAt: new Date().toISOString(), K, variants: VARIANTS, rows: out }));
    }
  }
  if (mode === 'explain') {
    const out: any[] = [];
    for (const e of envs) for (const c of combos) {
      const x = product.get(e.name)!; const ev: Ev[] = []; events = ev; await productCount(c, e); events = null;
      const prodSql = ev.find(v => /seal_idx/.test(v.sql))!;
      const reg = protoReg.get(e.name)!, p = await plan(reg, e.scope, c);
      const shapes: Record<string, { text: string; params: unknown[] }> = {
        product: { text: prodSql.sql, params: prodSql.params },
        protoOrdered: protoSql(e, reg, p, VARIANTS.P2), protoP4: protoSql(e, reg, p, VARIANTS.P4),
      };
      if (p.flagSql.length) { // same SQL without flag columns, to isolate the flag cost
        const noFlag = { ...p, flagSql: [] }; shapes.P4noFlags = protoSql(e, reg, noFlag, VARIANTS.P4);
      }
      const res: any = { case: c.name, environment: e.name, flags: p.flagSql.length };
      for (const [k, s] of Object.entries(shapes)) {
        const times: number[] = []; let last: any;
        for (let i = 0; i < 9; i++) { last = (await pool.query(`explain (analyze, buffers, format json) ${s.text}`, s.params)).rows[0]['QUERY PLAN'][0]; if (i >= 2) times.push(last['Execution Time']); }
        const top = last.Plan; const walk = (n: any): string => `${n['Node Type']}${n['Join Type'] ? `(${n['Join Type']})` : ''}${n.Plans ? `[${n.Plans.map(walk).join(',')}]` : ''}`;
        res[k] = { executionMsMedian: median(times), planningMs: last['Planning Time'], rows: top['Actual Rows'], sharedHit: top['Shared Hit Blocks'], sharedRead: top['Shared Read Blocks'], shape: walk(top), sql: s.text, plan: last };
      }
      out.push(res);
      console.log(JSON.stringify({ env: e.name, case: c.name, ...Object.fromEntries(Object.keys(shapes).map(k => [k, `${res[k].executionMsMedian.toFixed(1)}ms ${res[k].shape}`])) }));
    }
    writeFileSync(`${OUT}/x1-explain.json`, json(out));
  }
  if (mode === 'anatomy') {
    const out: any[] = [];
    for (const e of envs) for (const c of combos) {
      const reg = protoReg.get(e.name)!, p = await plan(reg, e.scope, c), opener = openers.get(e.name)!;
      const expected = await plainCount(c, e);
      const { text, params } = protoSql(e, reg, p, VARIANTS.P4);
      const time = async (fn: () => Promise<unknown>) => { const t: number[] = []; for (let i = 0; i < 9; i++) { const s = performance.now(); await fn(); if (i >= 2) t.push(performance.now() - s); } return +median(t).toFixed(3); };
      // DB only: base64 streamed fetch, no processing; text-format product-shape fetch (hex bytea parse) for comparison
      const dbB64Stream = await time(async () => { const cl = await pool.connect(); try { await new Promise<void>((res, rej) => {
        const q = new Query({ text, values: params } as any); q.on('row', () => {}); q.on('end', () => res()); q.on('error', rej); cl.query(q as any); }); } finally { cl.release(); } });
      const ordered = protoSql(e, reg, p, VARIANTS.P2);
      const dbTextOrdered = await time(() => pool.query(ordered.text, ordered.params));
      // rows + plaintext truth once
      const rows = (await pool.query({ text, values: params } as any)).rows.map((r: any) => { for (const k of p.condKeys) if (r[k] !== null) r[k] = Buffer.from(r[k], 'base64'); return r; });
      const leaves: PLeaf[] = []; const collect = (n: PNode) => n.kind === 'leaf' ? leaves.push(n) : n.kids.forEach(collect); collect(p.root);
      const plain = new Map<string, Record<string, string | null>>();
      for (const r of rows) { const v: Record<string, string | null> = {}; for (const k of p.condKeys) v[k] = r[k] === null ? null : await opener.open(k, r.id, r[k]); plain.set(r.id, v); }
      // minimal certificate per row (fields that must be authenticated given the DB's token info)
      const cert = async (n: PNode, r: any): Promise<{ ok: boolean; f: Set<string> }> => {
        if (n.kind === 'leaf') { if (n.flag !== undefined && r[n.flag] === false) return { ok: false, f: new Set() };
          const v = plain.get(r.id)![n.key]; if (v === null) return { ok: false, f: new Set() };
          return { ok: fastLeaf(n.c, v) ?? await srcLeaf(n.c, v), f: new Set([n.key]) }; }
        const ks = []; for (const k of n.kids) ks.push(await cert(k, r)); const want = n.kind === 'or';
        const hit = ks.filter(k => k.ok === want);
        if (hit.length) return { ok: want, f: hit.reduce((a, b) => b.f.size < a.f.size ? b : a).f };
        return { ok: !want, f: new Set(ks.flatMap(k => [...k.f])) };
      };
      const jobs: { key: string; id: string; ct: Uint8Array }[] = []; let trues = 0;
      for (const r of rows) { const x = await cert(p.root, r); if (x.ok) trues++; for (const k of x.f) jobs.push({ key: k, id: r.id, ct: r[k] }); }
      assert.equal(trues, expected, 'certificate truth');
      for (const l of leaves) assert(l.c.profile.normalizer === 'legacy-text-v1');
      // raw WebCrypto only (keys resolved, AAD prebuilt per job) = crypto floor
      const rawJobs = await Promise.all(jobs.map(async j => { const s0 = reg.fields.get(j.key)!.spec;
        const ks = sealer.keyScopeId(reg.model), fid = s0.id ?? j.key;
        const pre = concat(u32(10), frame(['sealql/aad/v3', new Uint8Array([3]), reg.model, fid, codecId(s0), u32(codecVersion(s0)), codecParameters(s0), ks]).subarray(4));
        const sc = new TextEncoder().encode(e.scope), rb = new TextEncoder().encode(j.id);
        let h = 0x811c9dc5; for (const b of rb) h = Math.imul(h ^ b, 0x01000193);
        await opener.open(j.key, j.id, j.ct); // ensure key derived
        const k = (opener as any).f.get(j.key).keys[h & 0xff] as CryptoKey;
        return { k, iv: j.ct.subarray(1, 13), data: j.ct.subarray(13), aad: concat(pre, u32(sc.length), sc, u32(rb.length), rb) }; }));
      const pool64 = async <T>(xs: T[], f: (x: T) => Promise<unknown>) => { let i = 0; await Promise.all(Array.from({ length: Math.min(64, xs.length) }, async () => { while (i < xs.length) await f(xs[i++]); })); };
      const rawDecrypt = await time(() => pool64(rawJobs, j => crypto.subtle.decrypt({ name: 'AES-GCM', iv: j.iv, additionalData: j.aad, tagLength: 128 }, j.k, j.data)));
      const fastOpen = await time(() => pool64(jobs, j => opener.open(j.key, j.id, j.ct)));
      const ks = sealer.keyScopeId(reg.model), ring = sealer.ring(reg.model);
      const srcOpen = await time(() => pool64(jobs, j => { const sp = reg.fields.get(j.key)!.spec;
        return sealer.open(j.ct, { modelId: reg.model, fieldId: sp.id ?? j.key, keyScopeId: ks, scopeId: e.scope, rowId: j.id, spec: sp }, ring); }));
      const leafOf = new Map(leaves.map(l => [l.key, l]));
      const vjobs = jobs.map(j => ({ l: leafOf.get(j.key)!, v: plain.get(j.id)![j.key] }));
      const fastVerify = await time(async () => { let n = 0; for (const x of vjobs) if (fastLeaf(x.l.c, x.v) ?? await srcLeaf(x.l.c, x.v)) n++; return n; });
      const srcVerify = await time(async () => { let n = 0; for (const x of vjobs) if (await srcLeaf(x.l.c, x.v)) n++; return n; });
      const slow = vjobs.filter(x => fastLeaf(x.l.c, x.v) === undefined).length;
      const res = { case: c.name, environment: e.name, candidates: rows.length, matches: expected, minCertificateDecrypts: jobs.length, fastPathMisses: slow,
        dbB64StreamMs: dbB64Stream, dbTextOrderedMs: dbTextOrdered, rawDecryptMs: rawDecrypt, fastOpenMs: fastOpen, srcOpenMs: srcOpen,
        fastVerifyMs: fastVerify, srcVerifyMs: srcVerify,
        floorSerialMs: +(dbB64Stream + rawDecrypt).toFixed(3), floorOverlapMs: Math.max(dbB64Stream, rawDecrypt),
        usPerRawDecrypt: jobs.length ? +(1000 * rawDecrypt / jobs.length).toFixed(2) : 0, usPerFastOpen: jobs.length ? +(1000 * fastOpen / jobs.length).toFixed(2) : 0,
        usPerSrcOpen: jobs.length ? +(1000 * srcOpen / jobs.length).toFixed(2) : 0 };
      out.push(res); console.log(JSON.stringify(res));
    }
    writeFileSync(`${OUT}/x1-anatomy.json`, json(out));
  }
} finally {
  Client.prototype.query = originalQuery;
  if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').startsWith('X1 ')) unlinkSync(LOCK);
  await pool.end();
}

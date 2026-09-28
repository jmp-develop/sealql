/**
 * In-memory false-positive anatomy with the product's own piece/token functions.
 * Splits candidate-but-false rows into (a) 16-bit token collision and (b) structure
 * (all genuine pieces present but predicate false: non-adjacency, start/end elsewhere, word edges).
 * Also counts field decryptions per strategy for AND/OR cases.
 * Usage: npx tsx bench/research-count/fp-sim.ts
 * Data: .local/research/r2-fixture.json (read once from bench_realistic_100k) and .local/ratings.txt (memory only).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hex } from '../../src/core/bytes.js';
import { profiles, searchPieces, searchTokens, normalizeText, normalizeWords, type SearchProfile } from '../../src/core/search-tokens.js';
import type { FieldSpec } from '../../src/core/field-codec.js';
import { cases, type Node, type Leaf } from '../verify-native/r8-cases.js';

const ring = { keyScopeId: 'global', key: new Uint8Array(32).fill(93) };
const scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const spec: FieldSpec = { type: 'text', search: { exact: true, substring: { wordBoundary: true, skipGrams: true } } };
let seed = 0x2468ace; const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const ws = new RegExp('[' + [[9, 13], [32, 32], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
const compact = (v: string) => normalizeText(v, 'legacy-text-v1').replace(ws, '');

type Space = { ids: Map<string, number>; post: number[][] };
const space = (): Space => ({ ids: new Map(), post: [] });
function add(s: Space, key: string, row: number) { let i = s.ids.get(key); if (i === undefined) { i = s.post.length; s.ids.set(key, i); s.post.push([]); } const p = s.post[i]; if (p[p.length - 1] !== row) p.push(row); }
function inter(s: Space, keys: string[]): number[] {
  const lists: number[][] = [];
  for (const k of new Set(keys)) { const i = s.ids.get(k); if (i === undefined) return []; lists.push(s.post[i]); }
  lists.sort((a, b) => a.length - b.length);
  let cur = lists[0] ?? [];
  for (const l of lists.slice(1)) { const set = new Set(l); cur = cur.filter(x => set.has(x)); if (!cur.length) break; }
  return cur;
}
const tokenCache = new Map<string, string>(); const profileCache = { profiles: new Map() };
async function tok(p: SearchProfile, piece: Uint8Array): Promise<string> {
  const k = p.indexId + ':' + hex(piece); let t = tokenCache.get(k);
  if (t === undefined) { const [s] = await searchTokens(ring, scope, p, [piece], profileCache); t = String(Number(BigInt(s) & 0xffffffffn) >>> 16); tokenCache.set(k, t); }
  return t;
}
type FieldIndex = { sub: SearchProfile; ex: SearchProfile; subTok: Space; subPiece: Space; exTok: Space; exPiece: Space; values: string[] };
async function buildField(field: string, values: string[]): Promise<FieldIndex> {
  const [ex, sub] = profiles('customers', field, spec);
  const f: FieldIndex = { sub, ex, subTok: space(), subPiece: space(), exTok: space(), exPiece: space(), values };
  for (let r = 0; r < values.length; r++) {
    const v = values[r];
    for (const piece of searchPieces(sub, v, 'write')) { const h = hex(piece); add(f.subPiece, h, r); add(f.subTok, await tok(sub, piece), r); }
    const [e] = searchPieces(ex, v, 'write'); add(f.exPiece, hex(e), r); add(f.exTok, await tok(ex, e), r);
  }
  return f;
}
type Q = { op: Leaf['op'] | 'like'; value: string; respectWords?: boolean };
function truthOf(f: FieldIndex, q: Q, v: string): boolean {
  const t = compact(v), n = compact(q.value);
  switch (q.op) {
    case 'eq': return normalizeText(v, 'legacy-text-v1') === normalizeText(q.value, 'legacy-text-v1');
    case 'contains': return q.respectWords ? normalizeWords(v).includes(normalizeWords(q.value)) : t.includes(n);
    case 'startsWith': return t.startsWith(n);
    case 'endsWith': return t.endsWith(n);
    default: throw Error('op');
  }
}
async function leaf(f: FieldIndex, q: Q) {
  let cand16: number[], candPiece: number[];
  if (q.op === 'eq') {
    const [e] = searchPieces(f.ex, q.value, 'write');
    cand16 = inter(f.exTok, [await tok(f.ex, e)]); candPiece = inter(f.exPiece, [hex(e)]);
  } else {
    const pieces = searchPieces(f.sub, q.value, q.op, q.respectWords);
    cand16 = inter(f.subTok, await Promise.all(pieces.map(p => tok(f.sub, p)))); candPiece = inter(f.subPiece, pieces.map(hex));
  }
  const truth = cand16.filter(r => truthOf(f, q, f.values[r]));
  const pieceSet = new Set(candPiece);
  for (const r of truth) if (!pieceSet.has(r)) throw Error('truth outside exact-piece candidates ' + JSON.stringify(q));
  return { cand16, candPiece, truth };
}
type Agg = { queries: number; cand16: number; candPiece: number; truth: number; exactQueries: number; collisionQueries: number; structureQueries: number };
const agg = (): Agg => ({ queries: 0, cand16: 0, candPiece: 0, truth: 0, exactQueries: 0, collisionQueries: 0, structureQueries: 0 });
function put(a: Agg, r: { cand16: number[]; candPiece: number[]; truth: number[] }) {
  a.queries++; a.cand16 += r.cand16.length; a.candPiece += r.candPiece.length; a.truth += r.truth.length;
  if (r.cand16.length === r.truth.length) a.exactQueries++;
  if (r.cand16.length > r.candPiece.length) a.collisionQueries++;
  if (r.candPiece.length > r.truth.length) a.structureQueries++;
}
function summary(a: Agg) {
  return { ...a, fpCollision: a.cand16 - a.candPiece, fpStructure: a.candPiece - a.truth,
    ratio: +(a.cand16 / Math.max(1, a.truth)).toFixed(4), exactQueryPct: +(100 * a.exactQueries / Math.max(1, a.queries)).toFixed(1) };
}
async function randomQueries(label: string, f: FieldIndex, perKind: number, out: Record<string, Agg>, words = false) {
  const kinds: [string, () => Q | undefined][] = [];
  const pick = () => f.values[Math.floor(rnd() * f.values.length)];
  for (const n of [2, 3, 4, 5, 6]) kinds.push([`contains ${n}`, () => { const a = Array.from(compact(pick())); if (a.length < n) return; const o = Math.floor(rnd() * (a.length - n + 1)); return { op: 'contains', value: a.slice(o, o + n).join('') }; }]);
  for (const n of [2, 3]) {
    kinds.push([`startsWith ${n}`, () => { const a = Array.from(compact(pick())); if (a.length < n) return; return { op: 'startsWith', value: a.slice(0, n).join('') }; }]);
    kinds.push([`endsWith ${n}`, () => { const a = Array.from(compact(pick())); if (a.length < n) return; return { op: 'endsWith', value: a.slice(-n).join('') }; }]);
  }
  kinds.push(['eq value', () => ({ op: 'eq', value: pick() })]);
  if (words) kinds.push(['two words (respectWords)', () => { const w = normalizeWords(pick()).split(' ').filter(Boolean); if (w.length < 2) return; const i = Math.floor(rnd() * (w.length - 1)); return { op: 'contains', value: `${w[i]} ${w[i + 1]}`, respectWords: true }; }]);
  for (const [kind, make] of kinds) {
    const a = out[`${label} | ${kind}`] ??= agg();
    let tries = 0;
    for (let k = 0; k < perKind && tries < perKind * 20; tries++) { const q = make(); if (!q) continue; put(a, await leaf(f, q)); k++; }
  }
}

// ---- boolean strategies for combos ----
type Ev = { field: string; cand: Set<number>; truth: Set<number>; tokenOnly?: boolean };
function evalRow(n: Node, row: number, L: Map<Leaf, Ev>, opened: Set<string>, useFlags: boolean): boolean {
  if ('all' in n) { for (const c of n.all) if (!evalRow(c, row, L, opened, useFlags)) return false; return true; }
  if ('any' in n) { for (const c of n.any) if (evalRow(c, row, L, opened, useFlags)) return true; return false; }
  const e = L.get(n)!;
  if (useFlags && !e.cand.has(row)) return false; // leaf tokens absent => provably false (no false negatives)
  opened.add(e.field);
  return e.truth.has(row);
}
function permutations<T>(xs: T[]): T[][] { return xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p])); }
function fieldsOf(n: Node): string[] { return 'all' in n ? n.all.flatMap(fieldsOf) : 'any' in n ? n.any.flatMap(fieldsOf) : [n.field]; }

async function main() {
  mkdirSync('bench/results/2026-09-28-count-research', { recursive: true });
  const out: any = { note: 'in-memory; product searchPieces/searchTokens; key fill(93); single scope', fixture: {}, ratings: {} };
  // ---------- fixture ----------
  const rows = JSON.parse(readFileSync('.local/research/r2-fixture.json', 'utf8')) as Record<string, string>[];
  const F = new Map<string, FieldIndex>();
  for (const field of ['name', 'phone', 'address', 'memo', 'email', 'company']) { F.set(field, await buildField(field, rows.map(r => r[field]))); console.error('built', field); }
  const caseRes: any[] = []; const leafEv = new Map<Leaf, Ev>();
  const walk = async (n: Node, rw?: boolean): Promise<Set<number>> => {
    if ('all' in n || 'any' in n) {
      const kids = await Promise.all(('all' in n ? n.all : n.any).map(c => walk(c, rw)));
      return 'all' in n ? kids.reduce((a, b) => new Set([...a].filter(x => b.has(x)))) : new Set(kids.flatMap(k => [...k]));
    }
    const r = await leaf(F.get(n.field)!, { ...n, respectWords: rw });
    leafEv.set(n, { field: n.field, cand: new Set(r.cand16), truth: new Set(r.truth) });
    caseRes.push({ leaf: `${n.field} ${n.op} "${n.value}"${rw ? ' (respectWords)' : ''}`, cand16: r.cand16.length, candPiece: r.candPiece.length, truth: r.truth.length,
      fpCollision: r.cand16.length - r.candPiece.length, fpStructure: r.candPiece.length - r.truth.length });
    return new Set(r.cand16);
  };
  const combos: any[] = [];
  for (const c of cases) {
    const cand = await walk(c.node, c.respectWords);
    if ('all' in c.node || 'any' in c.node) {
      const root = c.node;
      const truthRows = [...cand].filter(r => evalRow(root, r, leafEv, new Set(), false));
      const distinct = [...new Set(fieldsOf(root))];
      const count = (n: Node, useFlags: boolean) => { let d = 0; for (const r of cand) { const o = new Set<string>(); evalRow(n, r, leafEv, o, useFlags); d += o.size; } return d; };
      const kids = 'all' in root ? root.all : root.any;
      const reorder = (p: Node[]): Node => 'all' in root ? { all: p } : { any: p };
      let best = Infinity, bestOrder = '';
      for (const p of permutations(kids)) { const d = count(reorder(p), true); if (d < best) { best = d; bestOrder = p.map(x => 'field' in x ? x.field : '?').join(','); } }
      combos.push({ case: c.name, candidates: cand.size, truth: truthRows.length,
        decryptsCurrent: cand.size * distinct.length, decryptsShortCircuitWrittenOrder: count(root, false),
        decryptsLeafFlagsWrittenOrder: count(root, true), decryptsLeafFlagsBestOrder: best, bestOrder });
    }
  }
  out.fixture.cases = caseRes; out.fixture.combos = combos;
  const fixtureAgg: Record<string, Agg> = {};
  for (const field of ['name', 'phone', 'address', 'memo', 'email', 'company']) await randomQueries(`fixture ${field}`, F.get(field)!, 60, fixtureAgg, field === 'memo' || field === 'address');
  out.fixture.random = Object.fromEntries(Object.entries(fixtureAgg).map(([k, v]) => [k, summary(v)]));
  F.clear(); console.error('fixture done');
  // ---------- ratings (NSMC, memory only) ----------
  const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter(s => s && s.trim().length >= 2);
  const short = lines.slice(0, 100000);
  const long: string[] = []; for (let i = 0; i < 30000; i++) { let s = ''; while (s.length < 230) s += (s ? ' ' : '') + lines[Math.floor(rnd() * lines.length)]; long.push(s.slice(0, 250)); }
  for (const [label, vals] of [['ratings short 100k', short], ['ratings long(≈250자) 30k', long]] as const) {
    const f = await buildField('memo', vals as string[]); console.error('built', label);
    const a: Record<string, Agg> = {}; await randomQueries(label, f, 100, a, true);
    out.ratings[label] = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, summary(v)]));
  }
  writeFileSync('bench/results/2026-09-28-count-research/r2-fp-sim.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ combos, cases: caseRes }, null, 1));
  for (const [k, v] of Object.entries({ ...out.fixture.random, ...out.ratings['ratings short 100k'], ...out.ratings['ratings long(≈250자) 30k'] }) as [string, any][])
    console.log(`${k} | q=${v.queries} cand=${v.cand16} piece=${v.candPiece} truth=${v.truth} coll=${v.fpCollision} struct=${v.fpStructure} x${v.ratio} exactQ=${v.exactQueryPct}%`);
}
await main();

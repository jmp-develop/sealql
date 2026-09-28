// fable: in-memory only (no DB). Quantifies how much of the substring false-positive rate is
// STRUCTURAL (piece-set containment != substring) versus 16-bit truncation collision, on real
// Korean text (NSMC, .local/ratings.txt). Also checks whether identical piece SETS can come from
// distinct values (so `eq` via set equality cannot be exact) and verifies the constructive
// counterexamples used in verify-fable.md.
// Run: rtk proxy npx tsx bench/research-verify/fable-structural-fp.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { normalizeText } from '../../src/core/search-tokens.js';

const ROWS = 100_000, QUERIES_PER_CASE = 300, SEED = 20260928;
let s = SEED >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (n: number) => Math.floor(rnd() * n);

// Same piece construction as src/core/search-tokens.ts searchPieces (skipGrams on, wordBoundary off).
type Op = 'write' | 'contains' | 'startsWith' | 'endsWith';
function pieces(chars: string[], op: Op): string[] {
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add('a\0' + chars[i] + chars[i + 1]);
  if (op === 'write' || op === 'startsWith') out.add('s\0' + chars[0]);
  if (op === 'write' || op === 'endsWith') out.add('e\0' + chars[chars.length - 1]);
  for (let i = 0; i + 2 < chars.length; i++) out.add('k\0' + chars[i] + chars[i + 2]);
  return [...out];
}
const key = randomBytes(32);
const tokenCache = new Map<string, number>();
const token16 = (label: string) => { let t = tokenCache.get(label); if (t === undefined) { const d = createHmac('sha384', key).update(label).digest(); t = (d[0] << 8) | d[1]; tokenCache.set(label, t); } return t; };

// Load corpus.
const lines = readFileSync(new URL('../../.local/ratings.txt', import.meta.url), 'utf8').split('\n');
const docs: string[] = [];
for (let i = 1; i < lines.length && docs.length < ROWS; i++) {
  const raw = lines[i].split('\t')[1]; if (!raw) continue;
  let n: string; try { n = normalizeText(raw, 'legacy-text-v1'); } catch { continue; }
  if (Array.from(n).length >= 2) docs.push(n);
}
const docChars = docs.map(d => Array.from(d));

// Inverted indexes: exact labels (collision-free, "infinite bits") and 16-bit HMAC tokens (product width).
const postInf = new Map<string, number[]>();
const post16: number[][] = Array.from({ length: 65536 }, () => []);
const setKeyGroups = new Map<string, Set<string>>(); // piece-set fingerprint -> distinct normalized values
for (let id = 0; id < docs.length; id++) {
  const labels = pieces(docChars[id], 'write');
  const seen16 = new Set<number>();
  for (const label of labels) {
    let list = postInf.get(label); if (!list) postInf.set(label, list = []); list.push(id);
    const t = token16(label); if (!seen16.has(t)) { seen16.add(t); post16[t].push(id); }
  }
  const fp = createHash('sha256').update(labels.sort().join('\u0001')).digest('hex');
  let g = setKeyGroups.get(fp); if (!g) setKeyGroups.set(fp, g = new Set()); g.add(docs[id]);
}
function intersect(lists: number[][]): number[] {
  if (lists.some(l => l.length === 0)) return [];
  lists.sort((a, b) => a.length - b.length);
  let acc = lists[0];
  for (let k = 1; k < lists.length && acc.length; k++) {
    const b = lists[k], out: number[] = []; let i = 0, j = 0;
    while (i < acc.length && j < b.length) { if (acc[i] === b[j]) { out.push(acc[i]); i++; j++; } else if (acc[i] < b[j]) i++; else j++; }
    acc = out;
  }
  return acc;
}
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

type CaseResult = { op: Op; length: number; queries: number; trueTotal: number; candInf: number; cand16: number; fpQueriesInf: number; fpQueries16: number; ratioInfMedian: number; ratio16Median: number; structuralShare: number | null };
const cases: CaseResult[] = [];
for (const [op, length] of [['contains', 2], ['contains', 3], ['contains', 4], ['contains', 5], ['contains', 6], ['endsWith', 3], ['startsWith', 3], ['contains', 8]] as [Op, number][]) {
  const seen = new Set<string>(); const ratiosInf: number[] = [], ratios16: number[] = [];
  let trueTotal = 0, candInf = 0, cand16 = 0, fpQ = 0, fpQ16 = 0, tries = 0;
  while (seen.size < QUERIES_PER_CASE && tries++ < QUERIES_PER_CASE * 20) {
    const id = pick(docs.length), chars = docChars[id]; if (chars.length < length) continue;
    const start = op === 'startsWith' ? 0 : op === 'endsWith' ? chars.length - length : pick(chars.length - length + 1);
    const q = chars.slice(start, start + length); const qs = q.join(''); if (seen.has(qs)) continue; seen.add(qs);
    const labels = pieces(q, op);
    const cInf = intersect(labels.map(l => postInf.get(l) ?? []));
    const c16 = intersect([...new Set(labels.map(token16))].map(t => post16[t]));
    const truth = cInf.filter(d => op === 'contains' ? docs[d].includes(qs) : op === 'startsWith' ? docs[d].startsWith(qs) : docs[d].endsWith(qs)).length;
    trueTotal += truth; candInf += cInf.length; cand16 += c16.length;
    if (cInf.length > truth) fpQ++; if (c16.length > truth) fpQ16++;
    ratiosInf.push(cInf.length / truth); ratios16.push(c16.length / truth);
  }
  cases.push({ op, length, queries: seen.size, trueTotal, candInf, cand16, fpQueriesInf: fpQ, fpQueries16: fpQ16,
    ratioInfMedian: median(ratiosInf), ratio16Median: median(ratios16), structuralShare: cand16 > trueTotal ? (candInf - trueTotal) / (cand16 - trueTotal) : null });
}

// `eq` via piece-set equality: distinct values sharing one identical (collision-free) piece set.
let multiGroups = 0, sameLengthGroups = 0; const examples: string[][] = [];
for (const g of setKeyGroups.values()) if (g.size > 1) {
  multiGroups++; const vals = [...g]; const lens = new Set(vals.map(v => Array.from(v).length));
  if (lens.size < vals.length) sameLengthGroups++;
  if (examples.length < 8) examples.push(vals.slice(0, 3));
}

// Constructive counterexamples from the analysis (Latin and Korean shape).
const check = (v1: string, v2: string, q: string) => {
  const P = (x: string, op: Op) => new Set(pieces(Array.from(x), op));
  const p1 = P(v1, 'write'), p2 = P(v2, 'write'), pq = P(q, 'contains');
  return { v1, v2, q, sameLength: v1.length === v2.length, samePieceSet: p1.size === p2.size && [...p1].every(x => p2.has(x)),
    qPiecesInV1: [...pq].every(x => p1.has(x)), v1ContainsQ: v1.includes(q) };
};
const counterexamples = [check('abXcabYcabXc', 'abYcabXcabYc', 'XcabX'), check('가나다라가나마라가나다라', '가나마라가나다라가나마라', '다라가나다')];

const out = { rows: docs.length, distinctPieceLabels: postInf.size, queriesPerCase: QUERIES_PER_CASE, seed: SEED, cases,
  eqSetEquality: { pieceSetGroups: setKeyGroups.size, groupsWithDistinctValues: multiGroups, ofWhichSameLengthPairExists: sameLengthGroups, examples }, counterexamples,
  note: 'In-memory NSMC simulation; 16-bit tokens are HMAC-SHA-384 truncations with a random key (product width, no scope prefix). candInf uses collision-free piece labels, so candInf - true is purely structural.' };
mkdirSync(new URL('../results/2026-09-28-count-verify/', import.meta.url), { recursive: true });
writeFileSync(new URL('../results/2026-09-28-count-verify/fable-structural-fp.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`rows=${docs.length} labels=${postInf.size}`);
console.log('op\tlen\tq\ttrue\tcandInf\tcand16\tfpQ(inf)\tfpQ(16)\tmedInf\tmed16\tstructShare');
for (const c of cases) console.log([c.op, c.length, c.queries, c.trueTotal, c.candInf, c.cand16, c.fpQueriesInf, c.fpQueries16, c.ratioInfMedian.toFixed(3), c.ratio16Median.toFixed(3), c.structuralShare === null ? '-' : c.structuralShare.toFixed(3)].join('\t'));
console.log('eq set-equality groups with distinct values:', multiGroups, 'same-length:', sameLengthGroups);
for (const e of examples) console.log('  ', JSON.stringify(e));
for (const c of counterexamples) console.log(JSON.stringify(c));

/**
 * m1-fable E1: in-memory mechanical attack simulation (docs/attack-simulation.md) on a stolen token dump.
 * Compares STATIC-snapshot leakage of token designs that let PostgreSQL decide a substring / exact predicate exactly
 * against the current product design. No DB. Same data, same seed, same attacks for every design.
 *   cur16    : product pieces (adjacent bigram + start/end + skip-gram), 16-bit keyed truncation  (current product)
 *   curFull  : same pieces, full width (collision-free)                                            (isolates truncation)
 *   kgramK   : ALL substrings of length 2..K + prefixes/suffixes 1..K, full width                  (DB-exact for |q|<=K)
 * Attacks: A1 known-row count attack (Cash et al. CCS 2015 family) at 1/5/10 % known rows; A2 frequency ranking with a
 * same-kind reference corpus (Naveed et al. CCS 2015 family). Exact-token width (16 vs full) on short fixture fields.
 * Usage: rtk proxy node --max-old-space-size=8192 --import tsx bench/research-mission/m1-fable-leak.ts [nsmcRows]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';

const OUT = 'bench/results/2026-09-28-mission';
const SEED = 20260928, NSMC_ROWS = Number(process.argv[2] ?? 50_000);
let s = SEED >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const KEY = 'k:' + SEED + ':';
// keyed 16-bit token: collision structure of a truncated keyed hash (same approach as bench/standard-review/known-row-attack.ts)
const fnv16 = (label: string) => { let h = 0x811c9dc5; const x = KEY + label; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return 'T' + ((h >>> 0) & 0xffff); };

// A piece = label + the character span it covers (for coverage scoring). Positions in normalized chars.
type Piece = { label: string; from: number; to: number; skip?: boolean };
function curPieces(c: string[]): Piece[] {
  const out: Piece[] = [], seen = new Set<string>();
  const add = (label: string, from: number, to: number, skip = false) => { if (!seen.has(label)) { seen.add(label); out.push({ label, from, to, skip }); } };
  if (c.length < 2) return out;
  for (let i = 0; i + 1 < c.length; i++) add('a:' + c[i] + c[i + 1], i, i + 1);
  add('s:' + c[0], 0, 0); add('e:' + c[c.length - 1], c.length - 1, c.length - 1);
  for (let i = 0; i + 2 < c.length; i++) add('k:' + c[i] + c[i + 2], i, i + 2, true);
  return out;
}
function kgramPieces(c: string[], K: number): Piece[] {
  const out: Piece[] = [], seen = new Set<string>();
  const add = (label: string, from: number, to: number) => { if (!seen.has(label)) { seen.add(label); out.push({ label, from, to }); } };
  if (c.length < 2) return out;
  for (let l = 2; l <= K; l++) for (let i = 0; i + l <= c.length; i++) add('g:' + c.slice(i, i + l).join(''), i, i + l - 1);
  for (let l = 1; l <= Math.min(K, c.length); l++) { add('s:' + c.slice(0, l).join(''), 0, l - 1); add('e:' + c.slice(c.length - l).join(''), c.length - l, c.length - 1); }
  return out;
}
type Design = { name: string; pieces: (c: string[]) => Piece[]; token: (label: string) => string };
const designs: Design[] = [
  { name: 'cur16', pieces: curPieces, token: fnv16 },
  { name: 'curFull', pieces: curPieces, token: l => l },
  ...[3, 4, 6, 8].map(K => ({ name: `kgram${K}`, pieces: (c: string[]) => kgramPieces(c, K), token: (l: string) => l })),
];

function shuffled(n: number) { const a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const pct = (a: number, b: number) => b ? +(100 * a / b).toFixed(3) : 0;

type Score = { pieceOcc: number; decodedOcc: number; unknownRows: number; rows80: number; rows100: number; charsTotal: number; charsCovered: number; run8Rows: number; runFullRows: number; phrase4Rows: number; runMeanFrac: number };
function score(chars: string[][], d: Design, kn: Known, known: Set<number>): Score {
  const decoded = kn.decoded, groups = kn.groups;
  let pieceOcc = 0, decodedOcc = 0, unknownRows = 0, rows80 = 0, rows100 = 0, charsTotal = 0, charsCovered = 0, run8Rows = 0, runFullRows = 0, phrase4Rows = 0, runFracSum = 0;
  for (let r = 0; r < chars.length; r++) {
    const c = chars[r], ps = d.pieces(c); if (!ps.length) continue;
    const isKnown = known.has(r);
    let good = 0, phrase4 = false;
    const covered = new Uint8Array(c.length), linked = new Uint8Array(Math.max(0, c.length - 1));
    if (isKnown) continue;
    const toks = groups.size ? new Set(ps.map(p => d.token(p.label))) : null;
    for (const p of ps) {
      pieceOcc++;
      const t = d.token(p.label);
      if (decoded.get(t) !== p.label) { const g = toks ? groups.get(t) : undefined; if (!g || !g.every(x => toks!.has(x))) continue; }
      good++;
      if (p.to - p.from + 1 >= 4) phrase4 = true;
      if (p.skip) { covered[p.from] = 1; covered[p.to] = 1; continue; }
      for (let i = p.from; i <= p.to; i++) covered[i] = 1;
      for (let i = p.from; i < p.to; i++) linked[i] = 1;
    }
    decodedOcc += good;
    unknownRows++;
    if (good / ps.length >= 0.8) rows80++; if (good === ps.length) rows100++;
    charsTotal += c.length; let cov = 0; for (let i = 0; i < c.length; i++) cov += covered[i]; charsCovered += cov;
    let run = 1, best = 1; for (let i = 0; i < linked.length; i++) { run = linked[i] ? run + 1 : 1; if (run > best) best = run; }
    if (!covered.some(x => x)) best = 0;
    if (best >= 8) run8Rows++; if (best === c.length) runFullRows++; if (phrase4) phrase4Rows++;
    runFracSum += best / c.length;
  }
  return { pieceOcc, decodedOcc, unknownRows, rows80, rows100, charsTotal, charsCovered, run8Rows, runFullRows, phrase4Rows, runMeanFrac: unknownRows ? runFracSum / unknownRows : 0 };
}
function fmt(sc: Score) {
  return { decodedOccPct: pct(sc.decodedOcc, sc.pieceOcc), rows80Pct: pct(sc.rows80, sc.unknownRows), rows100Pct: pct(sc.rows100, sc.unknownRows), charCoveragePct: pct(sc.charsCovered, sc.charsTotal), run8Pct: pct(sc.run8Rows, sc.unknownRows), runFullPct: pct(sc.runFullRows, sc.unknownRows), phrase4Pct: pct(sc.phrase4Rows, sc.unknownRows), runMeanFracPct: +(100 * sc.runMeanFrac).toFixed(2) };
}
// A1: known-row attacks. (a) exact rule: token t decoded when its known-row set equals exactly one label's known-row set
// (naive; kept for comparison with earlier reports). (b) collision-aware rule (reviewer finding): for truncated tokens a
// token's known-row set is the UNION of its colliding labels' sets, so decode t as the label with the largest known-row set
// contained in t's set (ties -> undecided). (c) nested-group rule for full-width designs: labels sharing one identical
// known-row set (e.g. "abcdefg"/"abcdefgh") cannot be told apart, but an unknown row holding ALL their tokens holds all labels.
type Known = { decoded: Map<string, string>; groups: Map<string, string[]> };
function knownAttack(chars: string[][], d: Design, known: Set<number>, full: boolean): Known {
  const tokSig = new Map<string, number[]>(), labSig = new Map<string, number[]>(), rowToks = new Map<number, string[]>();
  for (const r of known) { const ts = new Set<string>(); for (const p of d.pieces(chars[r])) {
    const t = d.token(p.label); ts.add(t);
    let a = tokSig.get(t); if (!a) tokSig.set(t, a = []); if (a[a.length - 1] !== r) a.push(r);
    let b = labSig.get(p.label); if (!b) labSig.set(p.label, b = []); if (b[b.length - 1] !== r) b.push(r); } rowToks.set(r, [...ts]); }
  const decoded = new Map<string, string>(), groups = new Map<string, string[]>();
  if (full) {
    const bySig = new Map<string, string[]>();
    for (const [l, ids] of labSig) { const k = ids.join(','); let g = bySig.get(k); if (!g) bySig.set(k, g = []); g.push(l); }
    for (const [t, ids] of tokSig) { const g = bySig.get(ids.join(',')); if (g && g.length === 1) decoded.set(t, g[0]); else if (g) groups.set(t, g.map(l => d.token(l))); }
  } else {
    const tokSet = new Map<string, Set<number>>(); for (const [t, ids] of tokSig) tokSet.set(t, new Set(ids));
    const best = new Map<string, { l: string; n: number; tie: boolean }>();
    for (const [l, ids] of labSig) for (const t of rowToks.get(ids[0])!) {
      const S = tokSet.get(t)!; if (ids.length > S.size) continue; let sub = true; for (const r of ids) if (!S.has(r)) { sub = false; break; } if (!sub) continue;
      const b = best.get(t); if (!b || ids.length > b.n) best.set(t, { l, n: ids.length, tie: false }); else if (ids.length === b.n) b.tie = true;
    }
    for (const [t, b] of best) if (!b.tie) decoded.set(t, b.l);
  }
  return { decoded, groups };
}
function knownAttackExact(chars: string[][], d: Design, known: Set<number>): Known {
  const tokSig = new Map<string, number[]>(), labSig = new Map<string, number[]>();
  for (const r of known) for (const p of d.pieces(chars[r])) {
    const t = d.token(p.label);
    let a = tokSig.get(t); if (!a) tokSig.set(t, a = []); if (a[a.length - 1] !== r) a.push(r);
    let b = labSig.get(p.label); if (!b) labSig.set(p.label, b = []); if (b[b.length - 1] !== r) b.push(r);
  }
  const bySig = new Map<string, string[]>();
  for (const [l, ids] of labSig) { const k = ids.join(','); let g = bySig.get(k); if (!g) bySig.set(k, g = []); g.push(l); }
  const decoded = new Map<string, string>();
  for (const [t, ids] of tokSig) { const g = bySig.get(ids.join(',')); if (g && g.length === 1) decoded.set(t, g[0]); }
  return { decoded, groups: new Map() };
}
// A2: frequency ranking. Victim token frequencies (row basis) ranked against reference-corpus label frequencies.
function frequencyAttack(victim: string[][], reference: string[][], d: Design) {
  const tf = new Map<string, number>(), lf = new Map<string, number>();
  for (const c of victim) for (const p of d.pieces(c)) { const t = d.token(p.label); tf.set(t, (tf.get(t) ?? 0) + 1); }
  for (const c of reference) for (const p of d.pieces(c)) lf.set(p.label, (lf.get(p.label) ?? 0) + 1);
  const ob = (x: string) => fnv16('o:' + x) + fnv16('p:' + x); // opaque tie-break (labels are otherwise alphabetically aligned for full-width designs)
  const tr = [...tf].sort((a, b) => b[1] - a[1] || (ob(a[0]) < ob(b[0]) ? -1 : 1)), lr = [...lf].sort((a, b) => b[1] - a[1] || (ob(a[0]) < ob(b[0]) ? -1 : 1));
  const guess = new Map<string, string>(); for (let i = 0; i < tr.length && i < lr.length; i++) guess.set(tr[i][0], lr[i][0]);
  return { guess, distinctTokens: tf.size, distinctLabels: lf.size };
}
function dataset(name: string, victim: string[], reference: string[]) {
  const norm = (v: string) => { try { return Array.from(normalizeText(v, 'legacy-text-v1')); } catch { return [] as string[]; } };
  const vc = victim.map(norm).filter(c => c.length >= 2), rc = reference.map(norm).filter(c => c.length >= 2);
  const meanLen = vc.reduce((a, c) => a + c.length, 0) / vc.length;
  const order = shuffled(vc.length);
  const results: any[] = [];
  for (const d of designs) {
    const t0 = Date.now();
    let tokensPerRow = 0; for (const c of vc) tokensPerRow += d.pieces(c).length; tokensPerRow /= vc.length;
    const freq = frequencyAttack(vc, rc, d);
    const full = d.name !== 'cur16';
    const row: any = { design: d.name, tokensPerRow: +tokensPerRow.toFixed(1), distinctTokens: freq.distinctTokens, frequency: fmt(score(vc, d, { decoded: freq.guess, groups: new Map() }, new Set())), known: {} as any, knownExactRule: {} as any };
    for (const k of [1, 5, 10]) {
      const known = new Set(order.slice(0, Math.floor(vc.length * k / 100)));
      row.known[k] = fmt(score(vc, d, knownAttack(vc, d, known, full), known));
      row.knownExactRule[k] = fmt(score(vc, d, knownAttackExact(vc, d, known), known));
    }
    row.ms = Date.now() - t0; results.push(row);
    console.error(`${name} ${d.name} ${row.ms} ms`);
  }
  return { name, victimRows: vc.length, referenceRows: rc.length, meanLen: +meanLen.toFixed(1), results };
}
// Exact-token width on short fields: recover unknown rows whose (ciphertext length, exact token) matches exactly one known value.
function exactAttack(name: string, values: string[]) {
  const order = shuffled(values.length);
  const tokFull = (v: string) => 'V' + v, tok16 = (v: string) => fnv16('x:' + v);
  const out: any = { field: name, rows: values.length, distinctValues: new Set(values).size, width: {} as any };
  for (const [w, tok] of [['16', tok16], ['full', tokFull]] as const) {
    const byTok = new Map<string, Set<string>>(); for (const v of values) { const t = tok(v); let g = byTok.get(t); if (!g) byTok.set(t, g = new Set()); g.add(v); }
    const collisionBuckets = [...byTok.values()].filter(g => g.size > 1).length;
    const known: any = {};
    for (const k of [1, 5, 10]) {
      const ids = new Set(order.slice(0, Math.floor(values.length * k / 100)));
      const km = new Map<string, Set<string>>();
      for (const i of ids) { const key = Buffer.byteLength(values[i]) + '|' + tok(values[i]); let g = km.get(key); if (!g) km.set(key, g = new Set()); g.add(values[i]); }
      let recovered = 0, correct = 0, ambiguous = 0, unknown = 0;
      for (let i = 0; i < values.length; i++) { if (ids.has(i)) continue; unknown++; const g = km.get(Buffer.byteLength(values[i]) + '|' + tok(values[i])); if (g?.size === 1) { recovered++; if (g.has(values[i])) correct++; } else if (g) ambiguous++; }
      known[k] = { unknown, recovered, correct, ambiguous, correctPct: pct(correct, unknown) };
    }
    out.width[w] = { distinctTokens: byTok.size, collisionBuckets, known };
  }
  return out;
}

const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter((x): x is string => !!x);
const fixture: { name: string; company: string; address: string; memo: string; email: string; phone: string }[] = JSON.parse(readFileSync('.local/research/m1-fable-src/fixture-customers.json', 'utf8'));
const half = Math.floor(fixture.length / 2);
const out: any = { seed: SEED, generatedAt: new Date().toISOString(), designs: designs.map(d => d.name), datasets: [] as any[], exact: [] as any[],
  notes: ['In-memory simulation. 16-bit tokens reproduce the collision structure of a keyed truncated hash (FNV-1a keyed, as bench/standard-review/known-row-attack.ts); full-width tokens are collision-free labels.',
    'Attacks used (= lower bound): A1 known-row count attack (Cash et al. CCS 2015): known = collision-aware rule for truncated tokens (largest known-row set contained in the token set) plus nested-group rule for full-width tokens; knownExactRule = naive exact signature match (kept for comparison with earlier reports; biased in favour of truncated tokens). A2 frequency ranking (Naveed et al. CCS 2015) with a same-kind reference half and opaque tie-break. Not used: co-occurrence/IKK, substring-containment propagation, query observation, WAL.',
    'run*/charCoverage/phrase4 are attacker UPPER bounds computed with the true character order (ordering ambiguity of bigram sets is ignored); for kgram designs with K>=3 the bound is close to tight because pieces carry order.',
    'Fixture (template synthetic) over-represents low-vocabulary leakage; NSMC real reviews are the reference for natural text.'] };
out.datasets.push(dataset('nsmc-review', lines.slice(0, NSMC_ROWS), lines.slice(NSMC_ROWS, 2 * NSMC_ROWS)));
for (const f of ['memo', 'name', 'address'] as const) out.datasets.push(dataset('fixture-' + f, fixture.slice(0, half).map(r => r[f]), fixture.slice(half).map(r => r[f])));
for (const f of ['company', 'address', 'name', 'email', 'phone'] as const) out.exact.push(exactAttack(f, fixture.map(r => r[f])));
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/m1-fable-leak.json`, JSON.stringify(out, null, 2) + '\n');
for (const ds of out.datasets) {
  console.log(`\n## ${ds.name} victim=${ds.victimRows} ref=${ds.referenceRows} meanLen=${ds.meanLen}`);
  console.log('design\ttok/row\tfreq%\tk1 occ%\tk1 r80\tk1 r100\tk1 run8\tk1 full\tk5 occ%\tk5 r80\tk5 r100\tk5 cov%\tk5 run8\tk5 full\tk5 ph4\tk10 occ%\tk10 r80\tk10 r100\tk10 run8\tk10 full');
  for (const r of ds.results) { const k = r.known; console.log([r.design, r.tokensPerRow, r.frequency.decodedOccPct, k[1].decodedOccPct, k[1].rows80Pct, k[1].rows100Pct, k[1].run8Pct, k[1].runFullPct, k[5].decodedOccPct, k[5].rows80Pct, k[5].rows100Pct, k[5].charCoveragePct, k[5].run8Pct, k[5].runFullPct, k[5].phrase4Pct, k[10].decodedOccPct, k[10].rows80Pct, k[10].rows100Pct, k[10].run8Pct, k[10].runFullPct].join('\t')); }
}
console.log('\n## exact-token width (known rows -> unknown rows correctly recovered %)');
for (const e of out.exact) console.log(`${e.field}\tdistinct=${e.distinctValues}\t16bit: buckets=${e.width['16'].distinctTokens} coll=${e.width['16'].collisionBuckets} k1=${e.width['16'].known[1].correctPct} k5=${e.width['16'].known[5].correctPct} k10=${e.width['16'].known[10].correctPct}\tfull: k1=${e.width.full.known[1].correctPct} k5=${e.width.full.known[5].correctPct} k10=${e.width.full.known[10].correctPct}`);

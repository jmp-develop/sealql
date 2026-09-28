/**
 * Unified security comparison (m1-fable): what a thief of the DB BACKUP can recover from each design's stored search
 * artifacts, with realistic prior knowledge. Memory-only (docs/attack-simulation.md), same data, same seed, same attacks.
 *   A16 : current product candidate tokens (2-char adjacent + start/end + skip-grams), 16-bit keyed truncation.
 *         = B (row-stamp design): B adds per-(row,field) random salt + salted judgment tags, which carry no cross-row
 *         information, so B's backup artifacts equal A's for every attack here (measured in mission 1: identical values).
 *   D16 : ALL substrings of length 2..10 as 16-bit keyed deterministic candidate tokens (m2 combined design). Its row nonce
 *         + hmac64 verification values are per-row random and add nothing cross-row; only the candidate tokens matter.
 *   C   : MongoDB-style per-occurrence tags: no deterministic cross-row token in the backup (analytic: 0 for these attacks
 *         on a bulk-loaded snapshot; xmin last-writer linkage and the counter histogram are discussed in the report).
 *   full8 (reference): all substrings 2..8 full width (mission-1 numbers, cited, not rerun).
 * Attacks (lower bound): stage 1 known-row count attack (collision-aware rule) at 0.01/0.1/1/5/10 % rows, or public
 * corpus only (frequency ranking); stage 2 consistency propagation (A16: adjacent/skip votes; D16: substring-extension
 * votes), only at <= 1 %. Metrics on unknown rows: char coverage, rows with >= 8 consecutive recoverable chars (true
 * order assumed: upper bound), fully recoverable rows. Row linkage: rows sharing a token with exactly one other row and
 * the precision of that link (true shared label). Exact-value recovery for short fields (16-bit exact tokens = A/B/D).
 * Usage: rtk proxy node --max-old-space-size=12288 --import tsx bench/research-unified/u-fable-security.ts <A16|D16|link|exact>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';

const OUT = 'bench/results/2026-09-28-unified';
const SEED = 20260928, NSMC_ROWS = Number(process.env.ROWS ?? 50_000), KNOWN_PCT = [0.01, 0.1, 1, 5, 10]; // ROWS=5000: small-tenant scope (bucket saturation depends on rows per scope)
const SUFFIX = NSMC_ROWS === 50_000 ? '' : `-rows${NSMC_ROWS}`;
const MODE = process.argv[2] ?? 'A16';
let s = SEED >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const KEY = 'k:' + SEED + ':';
const fnvRaw = (x: string, h0 = 0x811c9dc5) => { let h = h0; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return h >>> 0; };
const fnv16 = (label: string) => 'T' + (fnvRaw(KEY + label) & 0xffff);

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
function subPieces(c: string[], K: number): Piece[] { // all substrings 2..K (D design candidate tokens)
  const out: Piece[] = [], seen = new Set<string>();
  const add = (label: string, from: number, to: number) => { if (!seen.has(label)) { seen.add(label); out.push({ label, from, to }); } };
  for (let l = 2; l <= K; l++) for (let i = 0; i + l <= c.length; i++) add('g:' + c.slice(i, i + l).join(''), i, i + l - 1);
  return out;
}
type Design = { name: string; pieces: (c: string[]) => Piece[]; token: (label: string) => string; family: 'cur' | 'sub' };
const designs: Record<string, Design> = {
  A16: { name: 'A16', pieces: curPieces, token: fnv16, family: 'cur' },
  D16: { name: 'D16', pieces: c => subPieces(c, 10), token: fnv16, family: 'sub' },
};
function shuffled(n: number) { const a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const pct = (a: number, b: number) => b ? +(100 * a / b).toFixed(3) : 0;
const norm = (v: string) => { try { return Array.from(normalizeText(v, 'legacy-text-v1')); } catch { return [] as string[]; } };

type Ctx = { chars: string[][]; pieces: Piece[][]; tokens: string[][]; dict: Set<string>; d: Design };
function buildCtx(chars: string[][], d: Design, dict: Set<string>): Ctx { const pieces = chars.map(c => d.pieces(c)); return { chars, pieces, tokens: pieces.map(ps => ps.map(p => d.token(p.label))), dict, d }; }
function score(ctx: Ctx, decoded: Map<string, string>, known: Set<number>) {
  let pieceOcc = 0, decodedOcc = 0, unknownRows = 0, charsTotal = 0, charsCovered = 0, run8Rows = 0, runFullRows = 0;
  for (let r = 0; r < ctx.chars.length; r++) {
    if (known.has(r)) continue; const c = ctx.chars[r], ps = ctx.pieces[r]; if (!ps.length) continue; unknownRows++; let good = 0;
    const covered = new Uint8Array(c.length), linked = new Uint8Array(Math.max(0, c.length - 1));
    for (let i = 0; i < ps.length; i++) { const p = ps[i]; pieceOcc++; if (decoded.get(ctx.tokens[r][i]) !== p.label) continue; good++; if (p.skip) { covered[p.from] = 1; covered[p.to] = 1; continue; } for (let k = p.from; k <= p.to; k++) covered[k] = 1; for (let k = p.from; k < p.to; k++) linked[k] = 1; }
    decodedOcc += good; charsTotal += c.length; let cov = 0; for (let k = 0; k < c.length; k++) cov += covered[k]; charsCovered += cov;
    let run = 1, best = 1; for (let k = 0; k < linked.length; k++) { run = linked[k] ? run + 1 : 1; if (run > best) best = run; } if (!covered.some(x => x)) best = 0;
    if (best >= 8) run8Rows++; if (best === c.length) runFullRows++;
  }
  return { decodedOccPct: pct(decodedOcc, pieceOcc), charCoveragePct: pct(charsCovered, charsTotal), run8Pct: pct(run8Rows, unknownRows), runFullPct: pct(runFullRows, unknownRows), unknownRows };
}
// Stage 1a: known-row count attack, collision-aware (token set = union of colliding labels' sets; pick the largest contained label set)
function knownAttack(ctx: Ctx, known: Set<number>, keepCandidates = true) {
  const tokSig = new Map<string, number[]>(), labSig = new Map<string, number[]>(), rowToks = new Map<number, string[]>();
  for (const r of known) { const ts = new Set<string>(); ctx.pieces[r].forEach((p, i) => { const t = ctx.tokens[r][i]; ts.add(t); let a = tokSig.get(t); if (!a) tokSig.set(t, a = []); if (a[a.length - 1] !== r) a.push(r); let b = labSig.get(p.label); if (!b) labSig.set(p.label, b = []); if (b[b.length - 1] !== r) b.push(r); }); rowToks.set(r, [...ts]); }
  const tokSet = new Map<string, Set<number>>(); for (const [t, ids] of tokSig) tokSet.set(t, new Set(ids));
  const best = new Map<string, { l: string; n: number; tie: boolean }>(); const candidates = new Map<string, string[]>();
  for (const [l, ids] of labSig) for (const t of rowToks.get(ids[0])!) {
    const S = tokSet.get(t)!; if (ids.length > S.size) continue; let sub = true; for (const r of ids) if (!S.has(r)) { sub = false; break; } if (!sub) continue;
    if (keepCandidates) { let c = candidates.get(t); if (!c) candidates.set(t, c = []); c.push(l); } // candidate lists are only needed for propagation (<= 1 %); they are huge for all-substring designs
    const b = best.get(t); if (!b || ids.length > b.n) best.set(t, { l, n: ids.length, tie: false }); else if (ids.length === b.n) b.tie = true;
  }
  const decoded = new Map<string, string>(); for (const [t, b] of best) if (!b.tie) decoded.set(t, b.l);
  return { decoded, candidates };
}
// Stage 1b: public corpus only (frequency ranking, opaque tie-break)
function frequencyAttack(ctx: Ctx, refFreq: Map<string, number>) {
  const tf = new Map<string, number>(); for (const ts of ctx.tokens) for (const t of new Set(ts)) tf.set(t, (tf.get(t) ?? 0) + 1);
  const ob = (x: string) => fnvRaw('o:' + x);
  const tr = [...tf].sort((a, b) => b[1] - a[1] || ob(a[0]) - ob(b[0])), lr = [...refFreq].sort((a, b) => b[1] - a[1] || ob(a[0]) - ob(b[0]));
  const decoded = new Map<string, string>(); for (let i = 0; i < tr.length && i < lr.length; i++) decoded.set(tr[i][0], lr[i][0]); return decoded;
}
// Stage 2: consistency votes. cur family: ab+bc -> a_c, a_c+ab -> bc, a_c+bc -> ab. sub family: a+b with a[1:]==b[:-1] -> a+last(b).
function propagate(ctx: Ctx, decoded0: Map<string, string>, candidates: Map<string, string[]> | null) {
  const decoded = new Map(decoded0); const rounds: number[] = [];
  for (let round = 0; round < 6; round++) {
    const votes = new Map<string, Map<string, number>>();
    for (let r = 0; r < ctx.tokens.length; r++) {
      const toks = ctx.tokens[r]; const dec = toks.map(t => decoded.get(t)).filter((x): x is string => !!x); if (dec.length < 2) continue;
      const implied = new Set<string>();
      if (ctx.d.family === 'cur') {
        const adj = dec.filter(x => x.startsWith('a:')).map(x => Array.from(x.slice(2))), skip = dec.filter(x => x.startsWith('k:')).map(x => Array.from(x.slice(2)));
        for (const ab of adj) for (const bc of adj) if (ab[1] === bc[0]) implied.add('k:' + ab[0] + bc[1]);
        for (const ac of skip) for (const ab of adj) if (ac[0] === ab[0]) implied.add('a:' + ab[1] + ac[1]);
        for (const ac of skip) for (const bc of adj) if (ac[1] === bc[1]) implied.add('a:' + ac[0] + bc[0]);
      } else {
        const byPrefix = new Map<string, string[]>();
        for (const l of dec) { const body = Array.from(l.slice(2)); const key = body.length + ':' + body.slice(0, -1).join(''); let a = byPrefix.get(key); if (!a) byPrefix.set(key, a = []); a.push(l.slice(2)); }
        for (const l of dec) { const body = Array.from(l.slice(2)); const key = body.length + ':' + body.slice(1).join(''); for (const b of byPrefix.get(key) ?? []) { const L = 'g:' + l.slice(2) + Array.from(b).slice(-1)[0]; if (Array.from(L.slice(2)).length <= 10) implied.add(L); } }
      }
      if (!implied.size) continue;
      for (const t of toks) { if (decoded.has(t)) continue; const cs = candidates ? (candidates.get(t) ?? []) : [...implied]; for (const l of cs) { if (!implied.has(l) || !ctx.dict.has(l)) continue; let v = votes.get(t); if (!v) votes.set(t, v = new Map()); v.set(l, (v.get(l) ?? 0) + 1); } }
    }
    let added = 0; for (const [t, v] of votes) { const ranked = [...v].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); if (ranked[0][1] >= 2 && ranked[0][1] >= (ranked[1]?.[1] ?? 0) + 2) { decoded.set(t, ranked[0][0]); added++; } }
    rounds.push(added); if (!added) break;
  }
  return { decoded, rounds };
}
function dataset(name: string, victim: string[], reference: string[], d: Design) {
  const vc = victim.map(norm).filter(c => c.length >= 2), rc = reference.map(norm).filter(c => c.length >= 2);
  const order = shuffled(vc.length); const t0 = Date.now();
  const refFreq = new Map<string, number>(); for (const c of rc) for (const p of d.pieces(c)) refFreq.set(p.label, (refFreq.get(p.label) ?? 0) + 1);
  const ctx = buildCtx(vc, d, new Set(refFreq.keys()));
  const tokensPerRow = +(ctx.pieces.reduce((a, p) => a + p.length, 0) / vc.length).toFixed(1);
  const row: any = { design: d.name, victimRows: vc.length, referenceRows: rc.length, meanLen: +(vc.reduce((a, c) => a + c.length, 0) / vc.length).toFixed(1), tokensPerRow, aux: {}, known: {} as any };
  const fa = frequencyAttack(ctx, refFreq); const fp = propagate(ctx, fa, null);
  row.aux = { stage1: score(ctx, fa, new Set()), stage2: score(ctx, fp.decoded, new Set()) };
  for (const k of KNOWN_PCT) {
    const n = Math.max(1, Math.round(vc.length * k / 100)); const known = new Set(order.slice(0, n));
    const ka = knownAttack(ctx, known, k <= 1); const kp = k <= 1 ? propagate(ctx, ka.decoded, ka.candidates) : { decoded: ka.decoded, rounds: [] as number[] };
    row.known[k] = { knownRows: n, stage1: score(ctx, ka.decoded, known), stage2: score(ctx, kp.decoded, known), rounds: kp.rounds };
    console.error(`${name} ${d.name} k=${k}% rows=${n} s1 run8=${row.known[k].stage1.run8Pct} s2 run8=${row.known[k].stage2.run8Pct} (${Date.now() - t0} ms)`);
  }
  return { name, ...row };
}
// Row linkage from the backup alone: tokens shared by exactly two rows, and whether the link is true (same label) — for truncated designs
function linkage(name: string, victim: string[], d: Design) {
  const vc = victim.map(norm).filter(c => c.length >= 2); const ctx = buildCtx(vc, d, new Set());
  const post = new Map<string, number[]>(); ctx.tokens.forEach((ts, r) => { for (const t of new Set(ts)) { let l = post.get(t); if (!l) post.set(t, l = []); l.push(r); } });
  const labelsOf = (r: number, t: string) => new Set(ctx.pieces[r].filter((_, i) => ctx.tokens[r][i] === t).map(p => p.label));
  let pairTokens = 0, truePairs = 0; const linkedRows = new Set<number>(), trueLinkedRows = new Set<number>();
  for (const [t, rows] of post) { if (rows.length !== 2) continue; pairTokens++; linkedRows.add(rows[0]); linkedRows.add(rows[1]); const a = labelsOf(rows[0], t), b = labelsOf(rows[1], t); let tru = false; for (const x of a) if (b.has(x)) { tru = true; break; } if (tru) { truePairs++; trueLinkedRows.add(rows[0]); trueLinkedRows.add(rows[1]); } }
  return { name, design: d.name, rows: vc.length, distinctTokens: post.size, tokensSharedByExactlyTwoRows: pairTokens, linkPrecisionPct: pct(truePairs, pairTokens), rowsLinkedToOneOtherPct: pct(linkedRows.size, vc.length), rowsTrulyLinkedPct: pct(trueLinkedRows.size, vc.length) };
}
// Exact-value recovery for short fields: unknown rows whose (ciphertext length, exact token) matches exactly one known value
function exactAttack(field: string, values: string[]) {
  const order = shuffled(values.length); const out: any = { field, rows: values.length, distinctValues: new Set(values).size, width: {} as any };
  for (const [w, tok] of [['16', (v: string) => fnv16('x:' + v)], ['full', (v: string) => 'V' + v]] as const) {
    const known: any = {};
    for (const k of KNOWN_PCT) {
      const n = Math.max(1, Math.round(values.length * k / 100)); const ids = new Set(order.slice(0, n)); const km = new Map<string, Set<string>>();
      for (const i of ids) { const key = Buffer.byteLength(values[i]) + '|' + tok(values[i]); let g = km.get(key); if (!g) km.set(key, g = new Set()); g.add(values[i]); }
      let correct = 0, unknown = 0; for (let i = 0; i < values.length; i++) { if (ids.has(i)) continue; unknown++; const g = km.get(Buffer.byteLength(values[i]) + '|' + tok(values[i])); if (g?.size === 1 && g.has(values[i])) correct++; }
      known[k] = { knownRows: n, correctPct: pct(correct, unknown) };
    }
    out.width[w] = known;
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter((x): x is string => !!x);
const fixture: Record<string, string>[] = JSON.parse(readFileSync('.local/research/m1-fable-src/fixture-customers.json', 'utf8'));
const half = Math.min(Math.floor(fixture.length / 2), NSMC_ROWS);
if (MODE === 'link') {
  const res = { datasets: [] as any[], note: 'Backup-only linkage through 16-bit tokens shared by exactly two rows; precision = share of such links where the two rows really share a label of that token.' };
  for (const d of [designs.A16, designs.D16]) { res.datasets.push(linkage('nsmc-review', lines.slice(0, NSMC_ROWS), d)); res.datasets.push(linkage('fixture-memo', fixture.slice(0, half).map(r => r.memo), d)); res.datasets.push(linkage('fixture-name', fixture.slice(0, half).map(r => r.name), d)); console.error(JSON.stringify(res.datasets.slice(-3))); }
  writeFileSync(`${OUT}/u-fable-link${SUFFIX}.json`, JSON.stringify(res, null, 2) + '\n');
} else if (MODE === 'exact') {
  const res = { knownPct: KNOWN_PCT, fields: ['company', 'address', 'name', 'email'].map(f => exactAttack(f, fixture.map(r => r[f]))), note: '16-bit exact tokens = A, B and D; full width = reference; C has no static equality class (0).' };
  writeFileSync(`${OUT}/u-fable-exact.json`, JSON.stringify(res, null, 2) + '\n'); console.log(JSON.stringify(res.fields.map(f => ({ field: f.field, distinct: f.distinctValues, k16: Object.fromEntries(Object.entries(f.width['16']).map(([k, v]: any) => [k, v.correctPct])), kFull: Object.fromEntries(Object.entries(f.width.full).map(([k, v]: any) => [k, v.correctPct])) }))));
} else {
  const d = designs[MODE]; if (!d) throw new Error('design?');
  const res: any = { seed: SEED, design: d.name, knownPct: KNOWN_PCT, datasets: [] as any[], notes: ['Backup-only attacker; stage 1 = starting clue (known rows: collision-aware count attack; or public corpus only: frequency ranking); stage 2 = consistency propagation (<= 1 % only). Only correct decodings count; run8/runFull assume the true character order (upper bound). 16-bit tokens: keyed truncated hash stand-in. One seed.'] };
  res.datasets.push(dataset('nsmc-review', lines.slice(0, NSMC_ROWS), lines.slice(NSMC_ROWS, 2 * NSMC_ROWS), d));
  res.datasets.push(dataset('fixture-memo', fixture.slice(0, half).map(r => r.memo), fixture.slice(half, 2 * half).map(r => r.memo), d));
  res.datasets.push(dataset('fixture-name', fixture.slice(0, half).map(r => r.name), fixture.slice(half, 2 * half).map(r => r.name), d));
  writeFileSync(`${OUT}/u-fable-leak-${d.name}${SUFFIX}.json`, JSON.stringify(res, null, 2) + '\n');
}

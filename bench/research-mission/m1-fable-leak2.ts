/**
 * m1-fable E1 v3 (owner premise update): snapshot-only attacker with REALISTIC prior knowledge.
 *   Stage 1 "starting clue": (a) known rows at 0.01 / 0.1 / 1 / 5 / 10 % (5 and 10 % = upper reference only), count attack
 *   with the collision-aware rule (truncated tokens) and nested-group rule (full width); (b) no known rows: public auxiliary
 *   corpus only (frequency ranking of tokens against a same-kind reference half).
 *   Stage 2 "propagation": one mechanical consistency step per design family, iterated to a fixpoint (max 6 rounds):
 *     full-width K-gram designs: an undecoded token X (posting >= 2) is decoded as L when L is in the public dictionary, both
 *       (|L|-1)-long sub-pieces of L are decoded and present in EVERY row holding X, and L is the only such candidate
 *       (substring-containment propagation);
 *     current-style designs (2-char adjacent + skip-gram): decoded 'ab'+'bc' imply skip 'a_c', decoded 'a_c'+'ab' imply 'bc',
 *       etc. (bench/verify-core/v2-attack.ts rule); an undecoded token in that row gets a vote for the implied label when it is
 *       among the token's candidates (labels whose known-row set is contained in the token's; with no known rows, any
 *       dictionary label); accepted at >= 2 votes and a margin >= 2 over the runner-up.
 *   Only CORRECT decodings count. Metrics on unknown rows: decoded piece occurrences, character coverage, rows with a
 *   recoverable run of >= 8 chars (true order assumed: upper bound, near-tight for K-grams), fully recoverable rows.
 * Designs: cur16 (current product tokens, 16-bit), curFull (same pieces, full width), kgram4, kgram8 (all substrings 2..K,
 * full width, DB-exact count design D1). NSMC 50k victim / 50k reference; fixture name and memo 50k / 50k.
 * Usage: rtk proxy node --max-old-space-size=12288 --import tsx bench/research-mission/m1-fable-leak2.ts <cur16|curFull|kgram4|kgram8>
 *   (run one design per process; merge the four JSON files with .local/research/m1-fable-src/leak2-table.mjs)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';

const OUT = 'bench/results/2026-09-28-mission';
const SEED = 20260928, NSMC_ROWS = 50_000;
const KNOWN_PCT = (process.env.KNOWN ?? '0.01,0.1,1,5,10').split(',').map(Number); // KNOWN=0.01,0.1,1 for kgram8 (5/10 % stage 1 is in m1-fable-leak.json)
const ONLY = process.argv[2]; // one design per process keeps the heap bounded; output m1-fable-leak2-<design>.json
let s = SEED >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const KEY = 'k:' + SEED + ':';
const fnvRaw = (x: string, h0 = 0x811c9dc5) => { let h = h0; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return h >>> 0; };
const fnv16 = (label: string) => 'T' + (fnvRaw(KEY + label) & 0xffff);
const opaque = (label: string) => 'H' + fnvRaw(KEY + label).toString(16) + fnvRaw(label + KEY, 0x12345678).toString(16);

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
  for (let l = 2; l <= Math.min(K, c.length); l++) { add('s:' + c.slice(0, l).join(''), 0, l - 1); add('e:' + c.slice(c.length - l).join(''), c.length - l, c.length - 1); }
  return out;
}
type Design = { name: string; full: boolean; K?: number; pieces: (c: string[]) => Piece[]; token: (label: string) => string };
const designs: Design[] = [
  { name: 'cur16', full: false, pieces: curPieces, token: fnv16 },
  { name: 'curFull', full: true, pieces: curPieces, token: opaque },
  { name: 'kgram4', full: true, K: 4, pieces: c => kgramPieces(c, 4), token: opaque },
  { name: 'kgram8', full: true, K: 8, pieces: c => kgramPieces(c, 8), token: opaque },
];
function shuffled(n: number) { const a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const pct = (a: number, b: number) => b ? +(100 * a / b).toFixed(3) : 0;

type Known = { decoded: Map<string, string>; groups: Map<string, string[]>; candidates: Map<string, string[]> | null };
type Ctx = { chars: string[][]; pieces: Piece[][]; tokens: string[][]; post: Map<string, number[]>; dict: Set<string>; d: Design };
function buildCtx(chars: string[][], d: Design, refPieces: Set<string>): Ctx {
  const pieces = chars.map(c => d.pieces(c)); const tokens = pieces.map(ps => ps.map(p => d.token(p.label)));
  const post = new Map<string, number[]>();
  tokens.forEach((ts, r) => { for (const t of new Set(ts)) { let l = post.get(t); if (!l) post.set(t, l = []); l.push(r); } });
  return { chars, pieces, tokens, post, dict: refPieces, d };
}
function score(ctx: Ctx, decodedOf: (r: number, p: Piece) => boolean, known: Set<number>) {
  let pieceOcc = 0, decodedOcc = 0, unknownRows = 0, rows80 = 0, charsTotal = 0, charsCovered = 0, run8Rows = 0, runFullRows = 0;
  for (let r = 0; r < ctx.chars.length; r++) {
    if (known.has(r)) continue;
    const c = ctx.chars[r], ps = ctx.pieces[r]; if (!ps.length) continue;
    unknownRows++; let good = 0;
    const covered = new Uint8Array(c.length), linked = new Uint8Array(Math.max(0, c.length - 1));
    for (const p of ps) { pieceOcc++; if (!decodedOf(r, p)) continue; good++; if (p.skip) { covered[p.from] = 1; covered[p.to] = 1; continue; } for (let i = p.from; i <= p.to; i++) covered[i] = 1; for (let i = p.from; i < p.to; i++) linked[i] = 1; }
    decodedOcc += good; if (good / ps.length >= 0.8) rows80++;
    charsTotal += c.length; let cov = 0; for (let i = 0; i < c.length; i++) cov += covered[i]; charsCovered += cov;
    let run = 1, best = 1; for (let i = 0; i < linked.length; i++) { run = linked[i] ? run + 1 : 1; if (run > best) best = run; } if (!covered.some(x => x)) best = 0;
    if (best >= 8) run8Rows++; if (best === c.length) runFullRows++;
  }
  return { decodedOccPct: pct(decodedOcc, pieceOcc), rows80Pct: pct(rows80, unknownRows), charCoveragePct: pct(charsCovered, charsTotal), run8Pct: pct(run8Rows, unknownRows), runFullPct: pct(runFullRows, unknownRows), unknownRows };
}
const okFn = (ctx: Ctx, kn: Known) => (r: number, p: Piece) => { const t = ctx.d.token(p.label); if (kn.decoded.get(t) === p.label) return true; const g = kn.groups.get(t); if (!g) return false; const toks = ctx.tokens[r]; return g.every(x => toks.includes(x)); };

// Stage 1a: known rows
function knownAttack(ctx: Ctx, known: Set<number>): Known {
  const d = ctx.d; const tokSig = new Map<string, number[]>(), labSig = new Map<string, number[]>(), rowToks = new Map<number, string[]>();
  for (const r of known) { const ts = new Set<string>(); ctx.pieces[r].forEach((p, i) => { const t = ctx.tokens[r][i]; ts.add(t);
    let a = tokSig.get(t); if (!a) tokSig.set(t, a = []); if (a[a.length - 1] !== r) a.push(r);
    let b = labSig.get(p.label); if (!b) labSig.set(p.label, b = []); if (b[b.length - 1] !== r) b.push(r); }); rowToks.set(r, [...ts]); }
  const decoded = new Map<string, string>(), groups = new Map<string, string[]>();
  if (d.full) {
    const bySig = new Map<string, string[]>();
    for (const [l, ids] of labSig) { const k = ids.join(','); let g = bySig.get(k); if (!g) bySig.set(k, g = []); g.push(l); }
    const groupTokens = new Map<string[], string[]>(); // one shared token array per signature group (per-token copies were O(G^2) memory)
    for (const [t, ids] of tokSig) { const g = bySig.get(ids.join(',')); if (g && g.length === 1) decoded.set(t, g[0]); else if (g) { let arr = groupTokens.get(g); if (!arr) groupTokens.set(g, arr = g.map(l => d.token(l))); groups.set(t, arr); } }
    return { decoded, groups, candidates: null };
  }
  const tokSet = new Map<string, Set<number>>(); for (const [t, ids] of tokSig) tokSet.set(t, new Set(ids));
  const best = new Map<string, { l: string; n: number; tie: boolean }>(); const candidates = new Map<string, string[]>();
  for (const [l, ids] of labSig) for (const t of rowToks.get(ids[0])!) {
    const S = tokSet.get(t)!; if (ids.length > S.size) continue; let sub = true; for (const r of ids) if (!S.has(r)) { sub = false; break; } if (!sub) continue;
    let c = candidates.get(t); if (!c) candidates.set(t, c = []); c.push(l);
    const b = best.get(t); if (!b || ids.length > b.n) best.set(t, { l, n: ids.length, tie: false }); else if (ids.length === b.n) b.tie = true;
  }
  for (const [t, b] of best) if (!b.tie) decoded.set(t, b.l);
  return { decoded, groups, candidates };
}
// Stage 1b: public auxiliary only (frequency ranking)
function frequencyAttack(ctx: Ctx, refFreq: Map<string, number>): Known {
  const tf = new Map<string, number>(); for (const ts of ctx.tokens) for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
  const ob = (x: string) => fnvRaw('o:' + x) ;
  const tr = [...tf].sort((a, b) => b[1] - a[1] || ob(a[0]) - ob(b[0])), lr = [...refFreq].sort((a, b) => b[1] - a[1] || ob(a[0]) - ob(b[0]));
  const decoded = new Map<string, string>(); for (let i = 0; i < tr.length && i < lr.length; i++) decoded.set(tr[i][0], lr[i][0]);
  return { decoded, groups: new Map(), candidates: null };
}
// Stage 2: propagation (mechanical, iterated). Returns the extended decoded map (may contain wrong guesses; only correct count).
function propagate(ctx: Ctx, kn: Known): { decoded: Map<string, string>; rounds: number[] } {
  const d = ctx.d; const decoded = new Map(kn.decoded); const rounds: number[] = [];
  const decodedLabels = () => { const m = new Set<string>(); for (const l of decoded.values()) m.add(l); return m; };
  for (let round = 0; round < 6; round++) {
    let added = 0;
    if (d.full) {
      // containment propagation for K-gram designs: X (undecoded, posting>=2) -> L if L in dict, both (|L|-1)-sub-pieces decoded and present in all rows of X, unique
      const labSet = decodedLabels();
      const rowDec: (Set<string> | null)[] = ctx.tokens.map(() => null);
      const rowDecoded = (r: number) => { let sset = rowDec[r]; if (!sset) { sset = new Set(); for (const t of ctx.tokens[r]) { const l = decoded.get(t); if (l) sset.add(l); } rowDec[r] = sset; } return sset; };
      for (const [X, rows] of ctx.post) {
        if (rows.length < 2 || decoded.has(X)) continue;
        // intersection of decoded labels over rows
        let inter: Set<string> | null = null;
        for (const r of rows) { const rs = rowDecoded(r); if (!inter) inter = new Set(rs); else for (const x of inter) if (!rs.has(x)) inter.delete(x); if (!inter.size) break; }
        if (!inter || !inter.size) continue;
        // candidates: pairs (a,b) of same-kind g: labels with a[1:]==b[:-1] -> L = a + last(b); also s:/e: extension
        const byPrefix = new Map<string, string[]>();
        for (const l of inter) { const kind = l.slice(0, 2), body = l.slice(2); if (kind !== 'g:') continue; const key = Array.from(body).slice(0, -1).join(''); let a = byPrefix.get(key); if (!a) byPrefix.set(key, a = []); a.push(body); }
        const cands = new Set<string>();
        for (const l of inter) { const kind = l.slice(0, 2), body = l.slice(2); if (kind !== 'g:') continue; const bc = Array.from(body); const key = bc.slice(1).join(''); for (const b of byPrefix.get(key) ?? []) { const L = 'g:' + body + Array.from(b).slice(-1)[0]; if (ctx.dict.has(L) && !labSet.has(L)) cands.add(L); } }
        if (cands.size === 1) { const L = [...cands][0]; decoded.set(X, L); labSet.add(L); added++; }
      }
    } else {
      // v2-attack consistency votes for adjacent/skip pieces
      const votes = new Map<string, Map<string, number>>();
      const cand = kn.candidates;
      for (let r = 0; r < ctx.tokens.length; r++) {
        const toks = ctx.tokens[r]; const dec = toks.map(t => decoded.get(t)).filter((x): x is string => !!x);
        const adj = dec.filter(x => x.startsWith('a:')).map(x => Array.from(x.slice(2))), skip = dec.filter(x => x.startsWith('k:')).map(x => Array.from(x.slice(2)));
        if (!adj.length) continue;
        const implied = new Set<string>();
        for (const ab of adj) for (const bc of adj) if (ab[1] === bc[0]) implied.add('k:' + ab[0] + bc[1]);
        for (const ac of skip) for (const ab of adj) if (ac[0] === ab[0]) implied.add('a:' + ab[1] + ac[1]);
        for (const ac of skip) for (const bc of adj) if (ac[1] === bc[1]) implied.add('a:' + ac[0] + bc[0]);
        if (!implied.size) continue;
        for (const t of toks) { if (decoded.has(t)) continue; const cs = cand ? (cand.get(t) ?? []) : [...implied]; for (const l of cs) { if (!implied.has(l) || !ctx.dict.has(l)) continue; let v = votes.get(t); if (!v) votes.set(t, v = new Map()); v.set(l, (v.get(l) ?? 0) + 1); } }
      }
      for (const [t, v] of votes) { const ranked = [...v].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); if (ranked[0][1] >= 2 && ranked[0][1] >= (ranked[1]?.[1] ?? 0) + 2) { decoded.set(t, ranked[0][0]); added++; } }
    }
    rounds.push(added); if (!added) break;
  }
  return { decoded, rounds };
}

function dataset(name: string, victim: string[], reference: string[]) {
  const norm = (v: string) => { try { return Array.from(normalizeText(v, 'legacy-text-v1')); } catch { return [] as string[]; } };
  const vc = victim.map(norm).filter(c => c.length >= 2), rc = reference.map(norm).filter(c => c.length >= 2);
  const order = shuffled(vc.length); const results: any[] = [];
  for (const d of designs) {
    if (ONLY && d.name !== ONLY) continue;
    const t0 = Date.now();
    const refFreq = new Map<string, number>(); for (const c of rc) for (const p of d.pieces(c)) refFreq.set(p.label, (refFreq.get(p.label) ?? 0) + 1);
    const ctx = buildCtx(vc, d, new Set(refFreq.keys()));
    const row: any = { design: d.name, tokensPerRow: +(ctx.pieces.reduce((a, p) => a + p.length, 0) / vc.length).toFixed(1), aux: {}, known: {} as any };
    const fa = frequencyAttack(ctx, refFreq); const fp = propagate(ctx, fa);
    row.aux = { stage1: score(ctx, okFn(ctx, fa), new Set()), stage2: score(ctx, okFn(ctx, { ...fa, decoded: fp.decoded }), new Set()), propagationRounds: fp.rounds };
    for (const k of KNOWN_PCT) {
      const n = Math.max(1, Math.round(vc.length * k / 100)); const known = new Set(order.slice(0, n));
      const ka = knownAttack(ctx, known);
      // propagation only at realistic knowledge (<= 1 %); 5 % and 10 % are upper-reference levels (stage 1 only), which also bounds the heap
      const kp = k <= 1 ? propagate(ctx, ka) : { decoded: ka.decoded, rounds: [] as number[] };
      row.known[k] = { knownRows: n, stage1: score(ctx, okFn(ctx, ka), known), stage2: score(ctx, okFn(ctx, { ...ka, decoded: kp.decoded }), known), propagationRounds: kp.rounds, stage1Decoded: ka.decoded.size, stage2Decoded: kp.decoded.size };
      console.error(`${name} ${d.name} k=${k}% rows=${n} s1 run8=${row.known[k].stage1.run8Pct} s2 run8=${row.known[k].stage2.run8Pct} (${Date.now() - t0} ms)`);
    }
    row.ms = Date.now() - t0; results.push(row);
  }
  return { name, victimRows: vc.length, referenceRows: rc.length, meanLen: +(vc.reduce((a, c) => a + c.length, 0) / vc.length).toFixed(1), results };
}
const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter((x): x is string => !!x);
const fixture: { name: string; memo: string }[] = JSON.parse(readFileSync('.local/research/m1-fable-src/fixture-customers.json', 'utf8'));
const half = Math.floor(fixture.length / 2);
const out: any = { seed: SEED, generatedAt: new Date().toISOString(), knownPct: KNOWN_PCT, designs: designs.map(d => d.name), datasets: [] as any[],
  notes: ['Snapshot-only attacker. Stage 1 = starting clue (known rows: count attack with collision-aware / nested-group rules; or public auxiliary corpus only: frequency ranking). Stage 2 = one mechanical propagation per design family iterated to a fixpoint (containment propagation for full-width K-grams; adjacent/skip consistency votes for current-style pieces). Only correct decodings are counted. run8/runFull assume the true character order (upper bound; near-tight for K-grams). 16-bit tokens: keyed truncated hash stand-in with the same collision structure. One seed.'] };
out.datasets.push(dataset('nsmc-review', lines.slice(0, NSMC_ROWS), lines.slice(NSMC_ROWS, 2 * NSMC_ROWS)));
out.datasets.push(dataset('fixture-name', fixture.slice(0, half).map(r => r.name), fixture.slice(half).map(r => r.name)));
out.datasets.push(dataset('fixture-memo', fixture.slice(0, half).map(r => r.memo), fixture.slice(half).map(r => r.memo)));
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/m1-fable-leak2${ONLY ? '-' + ONLY : ''}.json`, JSON.stringify(out, null, 2) + '\n');
for (const ds of out.datasets) {
  console.log(`\n## ${ds.name} victim=${ds.victimRows} ref=${ds.referenceRows} meanLen=${ds.meanLen}`);
  console.log('design\tknown%\trows\ts1 occ%\ts1 cov%\ts1 run8\ts1 full\ts2 occ%\ts2 cov%\ts2 run8\ts2 full');
  for (const r of ds.results) {
    console.log([r.design, 'aux', 0, r.aux.stage1.decodedOccPct, r.aux.stage1.charCoveragePct, r.aux.stage1.run8Pct, r.aux.stage1.runFullPct, r.aux.stage2.decodedOccPct, r.aux.stage2.charCoveragePct, r.aux.stage2.run8Pct, r.aux.stage2.runFullPct].join('\t'));
    for (const k of KNOWN_PCT) { const x = r.known[k]; console.log([r.design, k, x.knownRows, x.stage1.decodedOccPct, x.stage1.charCoveragePct, x.stage1.run8Pct, x.stage1.runFullPct, x.stage2.decodedOccPct, x.stage2.charCoveragePct, x.stage2.run8Pct, x.stage2.runFullPct].join('\t')); }
  }
}

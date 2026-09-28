// m2-fable: in-memory only (no DB). Snapshot-attacker recovery curve with REALISTIC prior knowledge on real Korean text
// (NSMC, .local/ratings.txt). Victim = 50,000 docs; auxiliary public corpus = the next 50,000 docs (disjoint).
// Attacker knows k victim rows' plaintext: k = 0.01% (5), 0.1% (50), 1% (500), 10% (5,000, upper reference), and/or the
// auxiliary piece-frequency distribution. Stage 1 = seeds (known-row labelling; aux frequency-rank matching of the top-M tokens).
// Stage 2 = propagation upper bound (a row whose 2-glyph tokens are all correctly labelled counts as reconstructed; its tokens
// then label others; iterate). Layouts: prod16 = product-like pieces (adjacent + start/end + skip-gram) at 16 bits, prod48 = same
// pieces at 48 bits (collision-free proxy), sub16/sub48 = every substring of length 2..10 (exact-count layout) at 16/48 bits.
// Per-occurrence tag layouts (MongoDB QE style) have no static token equality and are 0 by construction; their counter table
// leaks only piece frequencies = the "aux-only" seed stage of sub48 without any row linkage.
// Run: NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx tsx bench/research-mission/m2-fable-prior-curve.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { normalizeText } from '../../src/core/search-tokens.js';

const VICTIM = 50_000, AUX = 50_000, K = 10, TOPM = [100, 500];
const key = Buffer.alloc(32, 11);
const lines = readFileSync(new URL('../../.local/ratings.txt', import.meta.url), 'utf8').split('\n');
const all: string[][] = [];
for (let i = 1; i < lines.length && all.length < VICTIM + AUX; i++) {
  const raw = lines[i].split('\t')[1]; if (!raw) continue;
  let n: string; try { n = normalizeText(raw, 'legacy-text-v1'); } catch { continue; }
  const c = Array.from(n); if (c.length >= 2) all.push(c);
}
const victim = all.slice(0, VICTIM), aux = all.slice(VICTIM, VICTIM + AUX);
console.log('victim', victim.length, 'aux', aux.length);

// piece enumeration per layout: returns [label, code] where code lets us regenerate the label from the doc
type Layout = 'prod' | 'sub';
function enumerate(c: string[], layout: Layout): Array<[string, number]> {
  const out: Array<[string, number]> = []; const seen = new Set<string>();
  const push = (label: string, code: number) => { if (!seen.has(label)) { seen.add(label); out.push([label, code]); } };
  if (layout === 'prod') {
    for (let i = 0; i + 1 < c.length; i++) push('a\0' + c[i] + c[i + 1], 1_000_000 + i);
    push('s\0' + c[0], 2_000_000); push('e\0' + c[c.length - 1], 3_000_000);
    for (let i = 0; i + 2 < c.length; i++) push('k\0' + c[i] + c[i + 2], 4_000_000 + i);
  } else {
    for (let l = 2; l <= K; l++) for (let i = 0; i + l <= c.length; i++) push('s\0' + c.slice(i, i + l).join(''), l * 100_000 + i);
  }
  return out;
}
const isTwo = (layout: Layout, code: number) => layout === 'prod' ? code < 2_000_000 : Math.floor(code / 100_000) === 2;
const tok = (label: string, bits: 16 | 48) => { const d = createHmac('sha384', key).update(label).digest(); return bits === 16 ? d.readUInt16BE(0) : d.readUIntBE(0, 6); };

type Doc = { t: Float64Array; code: Uint32Array; labels: string[] };
function build(docs: string[][], layout: Layout, bits: 16 | 48): Doc[] {
  return docs.map(c => { const e = enumerate(c, layout); return { t: Float64Array.from(e.map(x => tok(x[0], bits))), code: Uint32Array.from(e.map(x => x[1])), labels: e.map(x => x[0]) }; });
}
function auxFreq(layout: Layout) { const f = new Map<string, number>(); for (const c of aux) for (const [l] of enumerate(c, layout)) f.set(l, (f.get(l) ?? 0) + 1); return [...f.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]); }

mkdirSync('bench/results/2026-09-28-mission', { recursive: true });
const results: any = { victim: victim.length, aux: aux.length, K, layouts: {} };
for (const layout of ['prod', 'sub'] as const) {
  const auxRank = auxFreq(layout);
  for (const bits of [16, 48] as const) {
    const name = layout + bits; const t0 = Date.now();
    const docs = build(victim, layout, bits);
    // victim token frequency (docs per token) for the aux-rank seed
    const vf = new Map<number, number>(); for (const d of docs) for (const t of d.t) vf.set(t, (vf.get(t) ?? 0) + 1);
    const vRank = [...vf.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const truth = new Map<number, Set<string>>(); for (const d of docs) d.t.forEach((t, i) => { let s = truth.get(t); if (!s) truth.set(t, s = new Set()); s.add(d.labels[i]); });
    const auxSeed: Record<string, unknown> = {};
    for (const M of TOPM) { let ok = 0; for (let r = 0; r < M && r < vRank.length && r < auxRank.length; r++) if (truth.get(vRank[r])?.has(auxRank[r])) ok++; auxSeed['top' + M + 'accuracy'] = +(ok / M).toFixed(3); }
    const conditions: Array<{ name: string; k: number; useAux: boolean }> = [
      { name: 'aux-only', k: 0, useAux: true }, { name: 'k=0.01%', k: 5, useAux: false }, { name: 'k=0.1%', k: 50, useAux: false },
      { name: 'k=1%', k: 500, useAux: false }, { name: 'k=10%', k: 5000, useAux: false }, { name: 'aux+k=0.1%', k: 50, useAux: true },
    ];
    const condOut: Record<string, unknown> = {};
    for (const cond of conditions) {
      const label = new Map<number, string>(); const known = new Set<number>();
      if (cond.useAux) for (let r = 0; r < 500 && r < vRank.length && r < auxRank.length; r++) label.set(vRank[r], auxRank[r]);
      if (cond.k) { const step = Math.floor(docs.length / cond.k); for (let i = 0; i < docs.length && known.size < cond.k; i += step) { known.add(i); const d = docs[i]; d.t.forEach((t, j) => label.set(t, d.labels[j])); } }
      const score = () => { let r80 = 0, full = 0, tot = 0, ok = 0, unk = 0; for (let i = 0; i < docs.length; i++) { if (known.has(i)) continue; unk++; const d = docs[i]; let n = 0; for (let j = 0; j < d.t.length; j++) if (label.get(d.t[j]) === d.labels[j]) n++; tot += d.t.length; ok += n; if (n >= 0.8 * d.t.length) r80++; if (n === d.t.length) full++; } return { tokensCorrectShare: +(ok / tot).toFixed(4), rows80share: +(r80 / unk).toFixed(4), rowsFullShare: +(full / unk).toFixed(4) }; };
      const seed = score();
      const done = new Set<number>(); let changed = true, rounds = 0;
      while (changed && rounds < 20) { changed = false; rounds++; for (let i = 0; i < docs.length; i++) { if (known.has(i) || done.has(i)) continue; const d = docs[i]; let allTwo = true, anyTwo = false; for (let j = 0; j < d.t.length; j++) { if (!isTwo(layout, d.code[j])) continue; anyTwo = true; if (label.get(d.t[j]) !== d.labels[j]) { allTwo = false; break; } } if (!anyTwo || !allTwo) continue; done.add(i); changed = true; d.t.forEach((t, j) => label.set(t, d.labels[j])); } }
      condOut[cond.name] = { knownRows: known.size, seed, propagated: { ...score(), rowsReconstructedShare: +(done.size / (docs.length - known.size)).toFixed(4), rounds } };
      console.log(name, cond.name, JSON.stringify(condOut[cond.name]));
    }
    results.layouts[name] = { distinctTokens: vf.size, tokensPerDoc: +(docs.reduce((s, d) => s + d.t.length, 0) / docs.length).toFixed(1), auxRankSeed: auxSeed, conditions: condOut, seconds: +((Date.now() - t0) / 1000).toFixed(0) };
    console.log(name, 'aux seed', JSON.stringify(auxSeed), 'distinct', vf.size, 'sec', (Date.now() - t0) / 1000);
  }
}
writeFileSync('bench/results/2026-09-28-mission/m2-fable-prior-curve.json', JSON.stringify(results, null, 1));

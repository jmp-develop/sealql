/**
 * Task 1 supplement (m1-fable): realistic log attack. The query log holds only piece keys k (opaque), never characters.
 * Attacker (backup + log, no known rows): for each k recomputes stamps in every row -> learns which rows hold that
 * 2-gram and (positional design) where. Guesses the characters of k by frequency ranking: keys sorted by victim row
 * count vs reference-corpus 2-gram frequency (opaque tie-break); only CORRECT guesses count. Then stitches positions
 * (positional design) -> coverage / run8 / full. Same guessing for B (presence only: no positions, no stitching).
 * w = 2 design (queries decomposed into 2-gram keys, so key length is known to be 2).
 * Usage: rtk proxy node --import tsx bench/research-task1/t1-fable-position-guess.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';
const OUT = 'bench/results/2026-09-29-task1'; mkdirSync(OUT, { recursive: true });
let s = 20260929 >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const fnv = (x: string) => { let h = 0x811c9dc5; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const norm = (v: string) => { try { return Array.from(normalizeText(v, 'legacy-text-v1')); } catch { return [] as string[]; } };
const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter((x): x is string => !!x);
const fixture: Record<string, string>[] = JSON.parse(readFileSync('.local/research/m1-fable-src/fixture-customers.json', 'utf8'));
const N = 20_000;
const sets: [string, string[], string[]][] = [['nsmc-review', lines.slice(0, N), lines.slice(N, 2 * N)], ['fixture-memo', fixture.slice(0, N).map(r => r.memo), fixture.slice(N, 2 * N).map(r => r.memo)], ['fixture-address', fixture.slice(0, N).map(r => r.address), fixture.slice(N, 2 * N).map(r => r.address)]];
const res: any = { rows: N, design: 'positional stamps w=2 (queries decomposed into 2-gram keys) vs B (presence only)', attack: [] };
for (const [name, victim, reference] of sets) {
  const docs = victim.map(norm).filter(c => c.length >= 2), refs = reference.map(norm).filter(c => c.length >= 2);
  // reference 2-gram frequency (row basis) = attacker's public auxiliary distribution
  const refFreq = new Map<string, number>(); for (const c of refs) { const seen = new Set<string>(); for (let i = 0; i + 2 <= c.length; i++) seen.add(c[i] + c[i + 1]); for (const g of seen) refFreq.set(g, (refFreq.get(g) ?? 0) + 1); }
  const refRank = [...refFreq].sort((a, b) => b[1] - a[1] || fnv('r' + a[0]) - fnv('r' + b[0])).map(x => x[0]);
  // victim 2-gram row counts (what the attacker computes from stamps for a known key)
  const vicRows = new Map<string, number>(); for (const c of docs) { const seen = new Set<string>(); for (let i = 0; i + 2 <= c.length; i++) seen.add(c[i] + c[i + 1]); for (const g of seen) vicRows.set(g, (vicRows.get(g) ?? 0) + 1); }
  // query model: frequency-proportional pieces of length 2..4 from the reference half; keys = their 2-grams
  const qf = new Map<string, number>(); for (const c of refs) for (let l = 2; l <= 4; l++) for (let i = 0; i + l <= c.length; i++) { const p = c.slice(i, i + l).join(''); qf.set(p, (qf.get(p) ?? 0) + 1); }
  const items = [...qf]; const cum: number[] = []; let acc = 0; for (const [, f] of items) { acc += f; cum.push(acc); }
  const draw = () => { const x = rnd() * acc; let lo = 0, hi = cum.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; } return items[lo][0]; };
  const keys = new Set<string>(); const out: any[] = [];
  const evalNow = (Q: number) => {
    // attacker: rank observed keys by victim row count, map to reference rank (same count of labels); correct if equal
    const ks = [...keys].filter(k => vicRows.has(k)).sort((a, b) => (vicRows.get(b)! - vicRows.get(a)!) || fnv('v' + a) - fnv('v' + b));
    const guess = new Map<string, string>(); ks.forEach((k, i) => { if (i < refRank.length) guess.set(k, refRank[i]); });
    let correct = 0; for (const [k, g] of guess) if (k === g) correct++;
    const correctSet = new Set([...guess].filter(([k, g]) => k === g).map(([k]) => k));
    // upper bound (characters known) and realistic (only correct guesses), stitched by exact positions (positional design)
    const stitch = (known: Set<string>) => { let charsTotal = 0, cov = 0, run8 = 0, full = 0, anyRow = 0; for (const c of docs) { const covered = new Uint8Array(c.length); for (let i = 0; i + 2 <= c.length; i++) if (known.has(c[i] + c[i + 1])) { covered[i] = 1; covered[i + 1] = 1; } charsTotal += c.length; let k = 0, run = 0, best = 0; for (let i = 0; i < c.length; i++) { k += covered[i]; run = covered[i] ? run + 1 : 0; if (run > best) best = run; } cov += k; if (best >= 8) run8++; if (k === c.length) full++; if (k) anyRow++; } return { charCoveragePct: +(100 * cov / charsTotal).toFixed(2), run8Pct: +(100 * run8 / docs.length).toFixed(2), fullPct: +(100 * full / docs.length).toFixed(3), rowsWithAnyPct: +(100 * anyRow / docs.length).toFixed(2) }; };
    out.push({ queries: Q, keysObserved: ks.length, correctlyGuessedKeys: correct, correctPct: +(100 * correct / Math.max(1, ks.length)).toFixed(2), positional_upperBound_charsKnown: stitch(keys), positional_realistic_frequencyGuess: stitch(correctSet), B_presenceOnly_realistic: { rowsWithCorrectlyGuessedPiecePct: stitch(correctSet).rowsWithAnyPct, run8Pct: 0, fullPct: 0, note: 'B/D/C reveal the row set per key but no position: correctly guessed pieces are known to be present, not where' } });
  };
  for (let qn = 1; qn <= 10000; qn++) { const q = Array.from(draw()); for (let i = 0; i + 2 <= q.length; i++) keys.add(q[i] + q[i + 1]); if (qn === 100 || qn === 1000 || qn === 10000) evalNow(qn); }
  res.attack.push({ dataset: name, rows: docs.length, checkpoints: out }); console.log(name, JSON.stringify(out));
}
writeFileSync(`${OUT}/t1-fable-position-guess.json`, JSON.stringify(res, null, 2) + '\n');

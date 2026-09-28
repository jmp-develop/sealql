/**
 * m1-fable E1d: for queries LONGER than K (D1 fallback), how many candidates does "all K-length windows present"
 * admit beyond the true substring matches? Memory-only, NSMC 100k rows, collision-free labels (structural only),
 * K in {4,6,8}, query lengths K+1..K+8 sampled from the corpus. Also the same for the current product pieces
 * (2-char adjacent + skip, collision-free) as reference. Candidate/true ratio = verification burden for the fallback.
 * Usage: rtk proxy node --max-old-space-size=8192 --import tsx bench/research-mission/m1-fable-window-fp.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';
const OUT = 'bench/results/2026-09-28-mission';
let s = 20260928 >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter((x): x is string => !!x);
const docs: string[] = []; for (const l of lines) { let n: string; try { n = normalizeText(l, 'legacy-text-v1'); } catch { continue; } if (Array.from(n).length >= 2) docs.push(n); if (docs.length >= 100000) break; }
const chars = docs.map(d => Array.from(d));
function intersect(lists: number[][]): number[] { if (lists.some(l => !l.length)) return []; lists.sort((a, b) => a.length - b.length); let acc = lists[0]; for (let k = 1; k < lists.length && acc.length; k++) { const b = lists[k], o: number[] = []; let i = 0, j = 0; while (i < acc.length && j < b.length) { if (acc[i] === b[j]) { o.push(acc[i]); i++; j++; } else if (acc[i] < b[j]) i++; else j++; } acc = o; } return acc; }
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
const out: any = { rows: docs.length, queriesPerCase: 300, cases: [] as any[] };
for (const K of [4, 6, 8]) {
  const post = new Map<string, number[]>();
  chars.forEach((c, id) => { const seen = new Set<string>(); for (let i = 0; i + K <= c.length; i++) { const w = c.slice(i, i + K).join(''); if (!seen.has(w)) { seen.add(w); let l = post.get(w); if (!l) post.set(w, l = []); l.push(id); } } });
  for (const extra of [1, 2, 4, 8]) {
    const L = K + extra; const seen = new Set<string>(); let trueTotal = 0, cand = 0, fpQ = 0, tries = 0; const ratios: number[] = [];
    while (seen.size < 300 && tries++ < 6000) {
      const id = Math.floor(rnd() * docs.length), c = chars[id]; if (c.length < L) continue;
      const st = Math.floor(rnd() * (c.length - L + 1)); const q = c.slice(st, st + L); const qs = q.join(''); if (seen.has(qs)) continue; seen.add(qs);
      const wins = new Set<string>(); for (let i = 0; i + K <= q.length; i++) wins.add(q.slice(i, i + K).join(''));
      const cands = intersect([...wins].map(w => post.get(w) ?? []));
      const truth = cands.filter(d => docs[d].includes(qs)).length;
      trueTotal += truth; cand += cands.length; if (cands.length > truth) fpQ++; ratios.push(cands.length / truth);
    }
    out.cases.push({ K, queryLength: L, queries: seen.size, trueTotal, candidates: cand, queriesWithFalsePositives: fpQ, ratioMedian: +median(ratios).toFixed(3), ratioTotal: +(cand / trueTotal).toFixed(4) });
    console.log(JSON.stringify(out.cases.at(-1)));
  }
}
writeFileSync(`${OUT}/m1-fable-window-fp.json`, JSON.stringify(out, null, 2) + '\n');

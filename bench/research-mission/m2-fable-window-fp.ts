// m2-fable: in-memory only (no DB). If a DB stores EXACT (collision-free) tokens for every substring of
// length 2..K (MongoDB substringPreview style), queries of length <= K are exact in the DB. For queries
// longer than K, the DB can only AND the K-length windows; this measures how often that AND is NOT exact
// (structural false positives) on real Korean text (NSMC, .local/ratings.txt).
// Run: rtk proxy npx tsx bench/research-mission/m2-fable-window-fp.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';

const ROWS = 100_000, QUERIES = 300, SEED = 20260928;
let s = SEED >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (n: number) => Math.floor(rnd() * n);

const lines = readFileSync(new URL('../../.local/ratings.txt', import.meta.url), 'utf8').split('\n');
const docs: string[] = [];
for (let i = 1; i < lines.length && docs.length < ROWS; i++) {
  const raw = lines[i].split('\t')[1]; if (!raw) continue;
  let n: string; try { n = normalizeText(raw, 'legacy-text-v1'); } catch { continue; }
  if (Array.from(n).length >= 2) docs.push(n);
}
const chars = docs.map(d => Array.from(d));
const lens = chars.map(c => c.length).sort((a, b) => a - b);
const pct = (p: number) => lens[Math.min(lens.length - 1, Math.floor(p * lens.length))];
console.log(`docs=${docs.length} len p50=${pct(0.5)} p90=${pct(0.9)} p99=${pct(0.99)} max=${lens[lens.length - 1]}`);

// substrings per doc for lengths 2..K (dedup within doc) — the write amplification of the exact-substring layout
function subCount(c: string[], K: number) { const set = new Set<string>(); for (let l = 2; l <= K; l++) for (let i = 0; i + l <= c.length; i++) set.add(c.slice(i, i + l).join('')); return set.size; }
const amp: Record<string, number> = {};
for (const K of [4, 6, 8, 10]) { let tot = 0; for (const c of chars) tot += subCount(c, K); amp[`K${K}`] = +(tot / chars.length).toFixed(1); }
let bigrams = 0; for (const c of chars) bigrams += subCount(c, 2); amp.bigramOnly = +(bigrams / chars.length).toFixed(1);
console.log('avg distinct substrings per doc', JSON.stringify(amp));

const out: any = { docs: docs.length, lenPct: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99) }, amp, cases: [] as any[] };
for (const K of [4, 6, 8, 10]) {
  // posting lists for exactly-K-length substrings only (what the window AND uses)
  const post = new Map<string, number[]>();
  for (let id = 0; id < chars.length; id++) { const c = chars[id]; const seen = new Set<string>();
    for (let i = 0; i + K <= c.length; i++) { const w = c.slice(i, i + K).join(''); if (seen.has(w)) continue; seen.add(w); let l = post.get(w); if (!l) post.set(w, l = []); l.push(id); } }
  for (const L of [K + 1, K + 2, K + 4, 2 * K]) {
    let q = 0, fpQueries = 0, sumCand = 0, sumTrue = 0, worst = 0; const ratios: number[] = [];
    let guard = 0;
    while (q < QUERIES && guard++ < QUERIES * 50) {
      const id = pick(chars.length); const c = chars[id]; if (c.length < L) continue;
      const st = pick(c.length - L + 1); const query = c.slice(st, st + L);
      const windows: string[] = []; for (let i = 0; i + K <= L; i++) windows.push(query.slice(i, i + K).join(''));
      const lists = windows.map(w => post.get(w) ?? []); if (lists.some(l => l.length === 0)) continue; // cannot happen (doc id has it)
      lists.sort((a, b) => a.length - b.length);
      let acc = lists[0]; for (let k = 1; k < lists.length && acc.length; k++) { const b = lists[k], o: number[] = []; let i = 0, j = 0; while (i < acc.length && j < b.length) { if (acc[i] === b[j]) { o.push(acc[i]); i++; j++; } else if (acc[i] < b[j]) i++; else j++; } acc = o; }
      const qs = query.join(''); let tr = 0; for (const cid of acc) if (docs[cid].includes(qs)) tr++;
      q++; sumCand += acc.length; sumTrue += tr; if (acc.length > tr) fpQueries++; ratios.push(acc.length / tr); worst = Math.max(worst, acc.length / tr);
    }
    ratios.sort((a, b) => a - b);
    const row = { K, L, queries: q, queriesWithFp: fpQueries, candTotal: sumCand, trueTotal: sumTrue, fpShare: +((sumCand - sumTrue) / Math.max(1, sumCand)).toFixed(4), ratioMedian: +ratios[Math.floor(ratios.length / 2)].toFixed(3), ratioP90: +ratios[Math.floor(ratios.length * 0.9)].toFixed(3), ratioMax: +worst.toFixed(3) };
    out.cases.push(row); console.log(JSON.stringify(row));
  }
}
mkdirSync('bench/results/2026-09-28-mission', { recursive: true });
writeFileSync('bench/results/2026-09-28-mission/m2-fable-window-fp.json', JSON.stringify(out, null, 1));

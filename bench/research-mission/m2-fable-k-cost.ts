// m2-fable: in-memory. Distinct substrings (lengths 2..K) per memo for the fixture (r2-fixture.json, normalized like memo_norm),
// i.e. the tags per row per field of the exact-substring layout, for K = 4, 6, 8, 10, 12; plus prefixes/suffixes 1..K for startsWith/endsWith.
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';
const rows: { memo: string; company: string }[] = JSON.parse(readFileSync('.local/research/r2-fixture.json', 'utf8'));
const out: any = { rows: rows.length };
for (const K of [4, 6, 8, 10, 12]) {
  let subs = 0, affix = 0, cur = 0;
  for (const r of rows) {
    const c = Array.from(normalizeText(r.memo, 'legacy-text-v1')); const set = new Set<string>();
    for (let l = 2; l <= K; l++) for (let i = 0; i + l <= c.length; i++) set.add(c.slice(i, i + l).join(''));
    subs += set.size; affix += 2 * Math.min(K, c.length);
    if (K === 4) { const cs = new Set<string>(); for (let i = 0; i + 2 <= c.length; i++) cs.add('a' + c[i] + c[i + 1]); for (let i = 0; i + 3 <= c.length; i++) cs.add('k' + c[i] + c[i + 2]); cs.add('s' + c[0]); cs.add('e' + c[c.length - 1]); cur += cs.size; }
  }
  out['K' + K] = { substringsPerMemo: +(subs / rows.length).toFixed(1), withAffixes: +((subs + affix) / rows.length).toFixed(1) };
  if (K === 4) out.currentPiecesPerMemo = +(cur / rows.length).toFixed(1);
}
console.log(JSON.stringify(out)); writeFileSync('bench/results/2026-09-28-mission/m2-fable-k-cost.json', JSON.stringify(out, null, 1));

/**
 * Task 2 (m1-fable): attacker-INSERTED rows against B (= A backup: same value -> same 16-bit exact token; same piece ->
 * same 16-bit substring token) versus MongoDB QE (per-occurrence tags: an inserted row's tags never equal another
 * document's tags — checked mechanically on the real dump in t2-fable-mongo-dump.mjs). Memory only, fixture 100k rows.
 *   exact fields: the attacker inserts one row per candidate value from a public list (company: all 16 names;
 *   address / name / phone: the K most frequent values of the public reference half) -> recovers every row whose
 *   16-bit token matches an inserted value (collisions counted as wrong).
 *   substring: the attacker inserts memo text containing chosen pieces -> finds all rows holding those pieces
 *   (16-bit candidate class incl. false positives; exactness of membership needs the judgment key, which the backup
 *   lacks, so recovery = candidate rows that truly contain the piece).
 * Usage: rtk proxy node --import tsx bench/research-task2/t2-fable-insert-attack.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';
const OUT = 'bench/results/2026-09-29-mongo2'; mkdirSync(OUT, { recursive: true });
const KEY = 'k:20260929:';
const fnv16 = (label: string) => { let h = 0x811c9dc5; const x = KEY + label; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) & 0xffff; };
const norm = (v: string) => { try { return normalizeText(v, 'legacy-text-v1'); } catch { return ''; } };
const fixture: Record<string, string>[] = JSON.parse(readFileSync('.local/research/m1-fable-src/fixture-customers.json', 'utf8'));
const half = Math.floor(fixture.length / 2); const victim = fixture.slice(0, half), reference = fixture.slice(half);
const res: any = { victimRows: victim.length, referenceRows: reference.length, exact: [], substring: [] };
for (const [field, Ks] of [['company', [16]], ['address', [10, 100, 1000, 5994]], ['name', [100, 1000]], ['phone', [100, 1000]]] as [string, number[]][]) {
  const freq = new Map<string, number>(); for (const r of reference) { const v = norm(r[field]); freq.set(v, (freq.get(v) ?? 0) + 1); }
  const ranked = [...freq].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const byTok = new Map<number, Map<string, number>>(); for (const r of victim) { const v = norm(r[field]); const t = fnv16('x:' + field + ':' + v); let g = byTok.get(t); if (!g) byTok.set(t, g = new Map()); g.set(v, (g.get(v) ?? 0) + 1); }
  for (const K of Ks) {
    const inserted = ranked.slice(0, K); const tokOf = new Map<number, string>(); for (const v of inserted) tokOf.set(fnv16('x:' + field + ':' + v), v);
    let recovered = 0, wrong = 0; for (const r of victim) { const v = norm(r[field]); const guess = tokOf.get(fnv16('x:' + field + ':' + v)); if (guess === undefined) continue; if (guess === v) recovered++; else wrong++; }
    res.exact.push({ field, insertedRows: inserted.length, distinctValuesInVictim: new Set(victim.map(r => norm(r[field]))).size, recoveredPct: +(100 * recovered / victim.length).toFixed(2), wrongGuessPct: +(100 * wrong / victim.length).toFixed(3), mongoQE: 0, note: 'B/A: rows whose 16-bit exact token equals an inserted value token; MongoDB QE: inserted document tags are unique (0)' });
  }
}
// substring: chosen pieces inserted in a memo; rows whose 16-bit candidate tokens contain the piece tokens (adjacent 2-grams + skip) and truly contain it
const pieces = (s: string) => { const c = Array.from(s); const out: string[] = []; for (let i = 0; i + 1 < c.length; i++) out.push('a:' + c[i] + c[i + 1]); for (let i = 0; i + 2 < c.length; i++) out.push('k:' + c[i] + c[i + 2]); return out; };
const rowTok = victim.map(r => new Set(pieces(norm(r.memo)).map(fnv16)));
for (const target of ['푸른달', '서비스', '상담', '희귀표식', '빠른회신']) {
  const need = pieces(target).map(fnv16); const cand: number[] = []; rowTok.forEach((s, i) => { if (need.every(t => s.has(t))) cand.push(i); });
  const truth = cand.filter(i => norm(victim[i].memo).includes(target)).length; const total = victim.filter(r => norm(r.memo).includes(target)).length;
  res.substring.push({ piece: target, insertedRows: 1, candidateRows: cand.length, trueRows: truth, allTrueRowsInVictim: total, recoveredPct: +(100 * truth / victim.length).toFixed(2), precisionPct: +(100 * truth / Math.max(1, cand.length)).toFixed(1), mongoQE: 0 });
}
writeFileSync(`${OUT}/t2-fable-insert-attack.json`, JSON.stringify(res, null, 2) + '\n');
console.log(JSON.stringify(res.exact)); console.log(JSON.stringify(res.substring));

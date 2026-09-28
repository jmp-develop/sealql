/**
 * Task 3 (m1-fable): exact-match token designs for low-cardinality fields under a BACKUP-ONLY attacker. Memory only.
 *   1 B16      : 16-bit truncated keyed hash of the value (current B / A)
 *   2 coarse k : k-bit hash (k = 2, 3, 4) -> several values share one token; DB filters false candidates with the stamps
 *   3 contention m : each row stores one of m per-value tokens chosen at random (m = 4, 8); a search sends all m
 * Attacks: (a) random known rows 0.01 / 0.1 / 1 %; (b) attacker-inserted rows: r rows per candidate value (r = 1, m, 3m)
 * for all 16 companies / top-K addresses; (c) public frequency ranking (tokens by victim count vs values by reference
 * frequency; for contention the attacker assumes m is known and assigns m tokens per value in frequency order).
 * Metrics on unknown rows: full value recovery % and wrong-guess % (guess only when the token maps to exactly one
 * learned value). Victim = first 50k fixture rows (one scope), reference = other 50k.
 * Usage: rtk proxy node --import tsx bench/research-task3/t3-fable-exact-designs.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';
const OUT = 'bench/results/2026-09-29-task3'; mkdirSync(OUT, { recursive: true });
let s = 20260929 >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const fnv = (x: string) => { let h = 0x811c9dc5; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return h >>> 0; };
const norm = (v: string) => { try { return normalizeText(v, 'legacy-text-v1'); } catch { return ''; } };
const fixture: Record<string, string>[] = JSON.parse(readFileSync('.local/research/m1-fable-src/fixture-customers.json', 'utf8'));
const half = Math.floor(fixture.length / 2);
type Design = { name: string; bits: number; m: number };
const designs: Design[] = [{ name: 'B16', bits: 16, m: 1 }, { name: 'coarse2', bits: 2, m: 1 }, { name: 'coarse3', bits: 3, m: 1 }, { name: 'coarse4', bits: 4, m: 1 }, { name: 'contention4', bits: 16, m: 4 }, { name: 'contention8', bits: 16, m: 8 }];
const tokenOf = (d: Design, field: string, v: string, j: number) => (fnv('k:' + field + ':' + v + ':' + (d.m > 1 ? j : 0)) & ((1 << d.bits) - 1)) | (d.m > 1 ? (j << 20) : 0); // contention variants are distinct tokens
const pct = (a: number, b: number) => +(100 * a / b).toFixed(2);
const res: any = { victimRows: half, fields: [] };
for (const field of ['company', 'address']) {
  const victim = fixture.slice(0, half).map(r => norm(r[field])), reference = fixture.slice(half).map(r => norm(r[field]));
  const refFreq = new Map<string, number>(); for (const v of reference) refFreq.set(v, (refFreq.get(v) ?? 0) + 1);
  const refRank = [...refFreq].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const fieldRes: any = { field, distinctValues: new Set(victim).size, designs: [] };
  for (const d of designs) {
    // stored token per victim row (contention: random variant per row)
    const rowTok = victim.map(v => tokenOf(d, field, v, d.m > 1 ? 1 + Math.floor(rnd() * d.m) : 0));
    const out: any = { design: d.name, distinctTokensStored: new Set(rowTok).size, known: {}, inserted: {}, frequency: {} };
    const guessEval = (learned: Map<number, Set<string>>, skip: Set<number>) => { let correct = 0, wrong = 0, unknown = 0; for (let i = 0; i < victim.length; i++) { if (skip.has(i)) continue; unknown++; const g = learned.get(rowTok[i]); if (!g || g.size !== 1) continue; if (g.has(victim[i])) correct++; else wrong++; } return { recoveredPct: pct(correct, unknown), wrongPct: pct(wrong, unknown) }; };
    // (a) random known rows
    const order = Array.from({ length: victim.length }, (_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const k of [0.01, 0.1, 1]) { const n = Math.max(1, Math.round(victim.length * k / 100)); const ids = new Set(order.slice(0, n)); const learned = new Map<number, Set<string>>(); for (const i of ids) { let g = learned.get(rowTok[i]); if (!g) learned.set(rowTok[i], g = new Set()); g.add(victim[i]); } out.known[k] = { knownRows: n, ...guessEval(learned, ids) }; }
    // (b) attacker-inserted rows: r rows per candidate value (each insertion reveals the token stored for that row)
    const Ks = field === 'company' ? [16] : [100, 1000, 5994];
    for (const K of Ks) for (const r of [1, d.m, 3 * d.m].filter((x, i, a) => a.indexOf(x) === i)) {
      const values = refRank.slice(0, K); const learned = new Map<number, Set<string>>(); let inserts = 0;
      for (const v of values) for (let t = 0; t < r; t++) { inserts++; const tok = tokenOf(d, field, v, d.m > 1 ? 1 + Math.floor(rnd() * d.m) : 0); let g = learned.get(tok); if (!g) learned.set(tok, g = new Set()); g.add(v); }
      out.inserted[`K${K}_r${r}`] = { candidateValues: K, rowsPerValue: r, insertedRows: inserts, ...guessEval(learned, new Set()) };
    }
    // (c) public frequency ranking: tokens by victim count desc; values by reference frequency desc; contention: m tokens per value
    const tf = new Map<number, number>(); for (const t of rowTok) tf.set(t, (tf.get(t) ?? 0) + 1);
    const tr = [...tf].sort((a, b) => b[1] - a[1]).map(x => x[0]); const learned = new Map<number, Set<string>>();
    tr.forEach((t, i) => { const v = refRank[Math.floor(i / d.m)]; if (v !== undefined) learned.set(t, new Set([v])); });
    out.frequency = guessEval(learned, new Set());
    fieldRes.designs.push(out); console.log(field, JSON.stringify(out));
  }
  res.fields.push(fieldRes);
}
writeFileSync(`${OUT}/t3-fable-exact-designs.json`, JSON.stringify(res, null, 2) + '\n');

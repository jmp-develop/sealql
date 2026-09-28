/**
 * Task 1 (m1-fable): positional stamps ("개선 B") — memory only, no DB.
 *  (1) exactness of window stitching for w = 2,3,4,8 against plaintext `includes` (random 2..20-char queries from the
 *      corpus + the 45-char repeated phrase), NSMC real sentences and fixture memo/address;
 *  (2) stamps per row for lengths 15 / 28 / 500 / 1000 vs B (all substrings 2..8 + prefix/suffix);
 *  (3) attacker with backup + query log: the log gives k_s for queried pieces; per-row salts are in the backup, so the
 *      attacker recomputes stamp(k_s, salt, p) for every p and learns the exact POSITIONS of every queried piece in every
 *      row -> stitches them. Queries: frequency-proportional 2..4-char pieces from a disjoint reference half, Q = 100 /
 *      1,000 / 10,000. Metrics on all rows: char coverage, rows with >= 8 consecutive chars recovered, fully recovered rows.
 *      (B / D / C reveal only presence of the queried piece per row, not its position: stitching not possible.)
 * Usage: rtk proxy node --max-old-space-size=8192 --import tsx bench/research-task1/t1-fable-position.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';
const OUT = 'bench/results/2026-09-29-task1'; mkdirSync(OUT, { recursive: true });
let s = 20260929 >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const norm = (v: string) => { try { return Array.from(normalizeText(v, 'legacy-text-v1')); } catch { return [] as string[]; } };
const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter((x): x is string => !!x);
const fixture: Record<string, string>[] = JSON.parse(readFileSync('.local/research/m1-fable-src/fixture-customers.json', 'utf8'));
const N = 20_000;
const sets: [string, string[], string[]][] = [['nsmc-review', lines.slice(0, N), lines.slice(N, 2 * N)], ['fixture-memo', fixture.slice(0, N).map(r => r.memo), fixture.slice(N, 2 * N).map(r => r.memo)], ['fixture-address', fixture.slice(0, N).map(r => r.address), fixture.slice(N, 2 * N).map(r => r.address)]];
const res: any = { rows: N, exactness: [], capacity: [], attack: [] };

// ---- (1) exactness: positional stamps for windows of length w at every position; queries shorter than w use lengths 2..w-1 stamps
function stampSet(c: string[], w: number): Set<string> { const st = new Set<string>(); for (let l = 2; l <= w; l++) for (let p = 0; p + l <= c.length; p++) st.add(l + ':' + p + ':' + c.slice(p, p + l).join('')); return st; }
function matchPos(st: Set<string>, n: number, q: string[], w: number): boolean { // exists p: all windows of q (overlapping, step 1) at p+j
  const L = q.length; if (L < 2) return false;
  if (L <= w) { for (let p = 0; p + L <= n; p++) if (st.has(L + ':' + p + ':' + q.join(''))) return true; return false; }
  for (let p = 0; p + L <= n; p++) { let ok = true; for (let j = 0; j + w <= L; j++) if (!st.has(w + ':' + (p + j) + ':' + q.slice(j, j + w).join(''))) { ok = false; break; } if (ok) return true; }
  return false;
}
function matchStep(st: Set<string>, n: number, q: string[], w: number): boolean { // non-overlapping windows step w + last window aligned to the end
  const L = q.length; if (L <= w) return matchPos(st, n, q, w);
  const offs: number[] = []; for (let j = 0; j + w <= L; j += w) offs.push(j); if (offs[offs.length - 1] !== L - w) offs.push(L - w);
  for (let p = 0; p + L <= n; p++) { let ok = true; for (const j of offs) if (!st.has(w + ':' + (p + j) + ':' + q.slice(j, j + w).join(''))) { ok = false; break; } if (ok) return true; }
  return false;
}
for (const [name, victim] of process.env.SKIP_EXACT ? [] : sets) {
  const docs = victim.map(norm).filter(c => c.length >= 2); const txt = docs.map(c => c.join(''));
  const queries: string[][] = []; const seen = new Set<string>();
  while (queries.length < 400) { const c = docs[Math.floor(rnd() * docs.length)]; const L = 2 + Math.floor(rnd() * 19); if (c.length < L) continue; const p = Math.floor(rnd() * (c.length - L + 1)); const q = c.slice(p, p + L); const k = q.join(''); if (seen.has(k)) continue; seen.add(k); queries.push(q); }
  queries.push(Array.from('상세안내와확인내용'.repeat(5))); // 45-char repeated phrase
  for (const w of [2, 3, 4, 8]) {
    const stamps = docs.map(c => stampSet(c, w)); let checked = 0, mismatchPos = 0, mismatchStep = 0, trueTotal = 0, longQueries = 0;
    for (const q of queries) { const qs = q.join(''); if (q.length > w) longQueries++; for (let i = 0; i < docs.length; i++) { const truth = txt[i].includes(qs); trueTotal += truth ? 1 : 0; checked++; if (matchPos(stamps[i], docs[i].length, q, w) !== truth) mismatchPos++; if (matchStep(stamps[i], docs[i].length, q, w) !== truth) mismatchStep++; } }
    const r45 = txt.filter(t => t.includes('상세안내와확인내용'.repeat(5))).length;
    res.exactness.push({ dataset: name, w, queries: queries.length, longQueries, rowQueryPairs: checked, trueMatches: trueTotal, mismatchesOverlap: mismatchPos, mismatchesStep: mismatchStep, repeated45charMatches: r45 });
    console.log(JSON.stringify(res.exactness.at(-1)));
  }
}
// ---- (2) capacity (stamps per row for one field): 개선 B with short-query support (lengths 2..w at every position) vs w-only vs B
for (const n of [15, 28, 500, 1000]) {
  const B = Math.max(0, 7 * n - 28) + Math.min(14, 2 * Math.max(0, n - 1)); // all substrings 2..8 + prefixes/suffixes 2..8
  const row: any = { length: n, B_stamps: B, B_bytes: B * 8 };
  for (const w of [2, 3, 4, 8]) { let full = 0; for (let l = 2; l <= w; l++) full += Math.max(0, n - l + 1); const only = Math.max(0, n - w + 1); row[`w${w}_stamps_lengths2to${w}`] = full; row[`w${w}_bytes_with_position`] = full * 10; row[`w${w}_stamps_wOnly`] = only; }
  res.capacity.push(row);
}
// ---- (3) backup + query log attack: positions of queried pieces known per row (positional stamps); stitch
for (const [name, victim, reference] of process.env.SKIP_ATTACK ? [] : sets) {
  const docs = victim.map(norm).filter(c => c.length >= 2); const refs = reference.map(norm).filter(c => c.length >= 2);
  const qf = new Map<string, number>(); for (const c of refs) for (let l = 2; l <= 4; l++) for (let i = 0; i + l <= c.length; i++) { const p = c.slice(i, i + l).join(''); qf.set(p, (qf.get(p) ?? 0) + 1); }
  const items = [...qf]; const cum: number[] = []; let acc = 0; for (const [, f] of items) { acc += f; cum.push(acc); }
  const draw = () => { const x = rnd() * acc; let lo = 0, hi = cum.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; } return items[lo][0]; };
  const queried = new Set<string>(); const out: any[] = [];
  const evalNow = (Q: number) => {
    let charsTotal = 0, charsCovered = 0, run8 = 0, full = 0, anyRow = 0, presenceRows = 0;
    for (const c of docs) { const covered = new Uint8Array(c.length); let present = false;
      for (let l = 2; l <= 4; l++) for (let i = 0; i + l <= c.length; i++) { const p = c.slice(i, i + l).join(''); if (queried.has(p)) { present = true; for (let k = i; k < i + l; k++) covered[k] = 1; } }
      charsTotal += c.length; let cov = 0, run = 0, best = 0; for (let k = 0; k < c.length; k++) { cov += covered[k]; run = covered[k] ? run + 1 : 0; if (run > best) best = run; }
      charsCovered += cov; if (best >= 8) run8++; if (cov === c.length) full++; if (cov) anyRow++; if (present) presenceRows++;
    }
    out.push({ queries: Q, distinctQueried: queried.size, positional_charCoveragePct: +(100 * charsCovered / charsTotal).toFixed(2), positional_run8Pct: +(100 * run8 / docs.length).toFixed(2), positional_fullPct: +(100 * full / docs.length).toFixed(3), rowsWithAnyQueriedPiecePct: +(100 * presenceRows / docs.length).toFixed(2), presenceOnly_run8Pct: 0, note: 'presence-only designs (B, D, C, A±FP) reveal the set of rows containing each queried piece but no position: stitching is not possible; the positional design also reveals where.' });
  };
  for (let qn = 1; qn <= 10000; qn++) { queried.add(draw()); if (qn === 100 || qn === 1000 || qn === 10000) evalNow(qn); }
  res.attack.push({ dataset: name, rows: docs.length, queryModel: 'pieces drawn proportional to frequency in a disjoint reference half, lengths 2..4', checkpoints: out });
  console.log(JSON.stringify(res.attack.at(-1)));
}
res.notes = ['Backup-only: positional stamps are salted per (row, field) and carry no cross-row information; the retained 16-bit candidate tokens leak exactly as A/B (mission-1 and unified numbers apply). Known rows do not help the log attack (piece keys stay secret), so the positional attack is independent of the 0.01/0.1/1 % levels.', 'Stamps modeled as collision-free labels (64-bit sha256 truncation: per-check collision 2^-64).'];
writeFileSync(`${OUT}/t1-fable-position${process.env.SKIP_EXACT ? '-attack' : process.env.SKIP_ATTACK ? '-exact' : ''}.json`, JSON.stringify(res, null, 2) + '\n');
console.log(JSON.stringify(res.capacity));

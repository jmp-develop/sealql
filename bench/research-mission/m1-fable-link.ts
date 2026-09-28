/**
 * m1-fable E1c: static linkage leak with NO attacker knowledge (T1 snapshot only), memory-only.
 * For a design whose token for a piece is deterministic and full-width, the snapshot shows which rows share a piece.
 * Metric per piece length L: share of rows that share at least one L-length piece with exactly one other row (a
 * "rare-phrase link"), and with 2..10 other rows. Current design (2-char pieces, 16-bit tokens): the same metric on
 * its tokens (a shared 16-bit token is shared by many rows, so rare links are rare).
 * Usage: rtk proxy node --max-old-space-size=8192 --import tsx bench/research-mission/m1-fable-link.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';
const OUT = 'bench/results/2026-09-28-mission';
const KEY = 'k:20260928:';
const fnv16 = (label: string) => { let h = 0x811c9dc5; const x = KEY + label; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) & 0xffff; };
const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter((x): x is string => !!x);
const fixture: Record<string, string>[] = JSON.parse(readFileSync('.local/research/m1-fable-src/fixture-customers.json', 'utf8'));
const norm = (v: string) => { try { return Array.from(normalizeText(v, 'legacy-text-v1')); } catch { return [] as string[]; } };
function analyze(name: string, values: string[]) {
  const docs = values.map(norm).filter(c => c.length >= 2);
  const out: any = { name, rows: docs.length, byLength: {} as any };
  for (const L of [2, 3, 4, 6, 8]) {
    const post = new Map<string, number>(); const rowPieces: string[][] = [];
    for (const c of docs) { const s = new Set<string>(); for (let i = 0; i + L <= c.length; i++) s.add(c.slice(i, i + L).join('')); const a = [...s]; rowPieces.push(a); for (const p of a) post.set(p, (post.get(p) ?? 0) + 1); }
    let link1 = 0, link10 = 0, unique = 0;
    for (const ps of rowPieces) { let l1 = false, l10 = false, u = true; for (const p of ps) { const n = post.get(p)!; if (n === 2) l1 = true; if (n >= 2 && n <= 11) l10 = true; if (n > 1) u = false; } if (l1) link1++; if (l10) link10++; if (u) unique++; }
    out.byLength[L] = { distinctPieces: post.size, rowsLinkedToExactlyOneOtherRowPct: +(100 * link1 / docs.length).toFixed(2), rowsWithPieceSharedBy2to11RowsPct: +(100 * link10 / docs.length).toFixed(2), rowsWithNoSharedPiecePct: +(100 * unique / docs.length).toFixed(2) };
  }
  // current design: 2-char adjacent + skip pieces, 16-bit tokens
  const post = new Map<number, number>(); const rowToks: number[][] = [];
  for (const c of docs) { const s = new Set<number>(); for (let i = 0; i + 1 < c.length; i++) s.add(fnv16('a:' + c[i] + c[i + 1])); for (let i = 0; i + 2 < c.length; i++) s.add(fnv16('k:' + c[i] + c[i + 2])); const a = [...s]; rowToks.push(a); for (const t of a) post.set(t, (post.get(t) ?? 0) + 1); }
  let link1 = 0, link10 = 0; for (const ts of rowToks) { let l1 = false, l10 = false; for (const t of ts) { const n = post.get(t)!; if (n === 2) l1 = true; if (n >= 2 && n <= 11) l10 = true; } if (l1) link1++; if (l10) link10++; }
  out.cur16 = { distinctTokens: post.size, rowsLinkedToExactlyOneOtherRowPct: +(100 * link1 / docs.length).toFixed(2), rowsWithTokenSharedBy2to11RowsPct: +(100 * link10 / docs.length).toFixed(2) };
  console.log(JSON.stringify(out));
  return out;
}
const res = { datasets: [analyze('nsmc-review', lines.slice(0, 50000)), analyze('fixture-memo', fixture.map(r => r.memo)), analyze('fixture-name', fixture.map(r => r.name))],
  note: 'T1 snapshot only, no known rows. A row "linked to exactly one other row" shares a full-width piece whose posting list has size 2; with 16-bit 2-char tokens the same event needs a token shared by exactly two rows.' };
writeFileSync(`${OUT}/m1-fable-link.json`, JSON.stringify(res, null, 2) + '\n');

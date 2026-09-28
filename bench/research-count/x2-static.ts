/**
 * Static leakage of R1-B (all-substring tag arrays): the array cardinality = number of distinct substrings (len >= 2)
 * is visible without the key. Mechanical attack (same rules as attack-sim.ts): victims = even rows, attacker dictionary
 * = odd rows; guess the most frequent dictionary value in the same observable class. Memory only (fixture dump + NSMC).
 * Classes compared: GCM length | GCM length + R1-B count | CBC+HMAC length (49+16k) | CBC+HMAC length + R1-B count.
 * R1-A adds nothing observable per row (fixed 16 B nonce + 32 B tag). Lower bounds, not proofs.
 * Usage: rtk proxy npx tsx bench/research-count/x2-static.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { OUT, normSub, substrings, json } from './x2-lib.js';

const bytes = (v: string) => Buffer.byteLength(v, 'utf8');
const lenGcm = (v: string) => `${bytes(v) + 29}`;
const lenCH = (v: string) => `${49 + 16 * Math.ceil((bytes(v) + 1) / 16)}`;
function run(label: string, values: string[]) {
  const cnt = new Map<string, number>(); const sc = (v: string) => { let c = cnt.get(v); if (c === undefined) { c = substrings(normSub(v)).length; cnt.set(v, c); } return c; };
  const victims = values.filter((_, i) => i % 2 === 0); const dict = new Map<string, number>(); values.forEach((v, i) => { if (i % 2) dict.set(v, (dict.get(v) ?? 0) + 1); });
  const attack = (cls: (v: string) => string) => {
    const best = new Map<string, { v: string; c: number }>();
    for (const [v, c] of dict) { const k = cls(v), b = best.get(k); if (!b || c > b.c) best.set(k, { v, c }); }
    let hit = 0; const classes = new Set<string>(); for (const v of victims) { const k = cls(v); classes.add(k); if (best.get(k)?.v === v) hit++; }
    return { classes: classes.size, recoveredPct: +(100 * hit / victims.length).toFixed(3) };
  };
  return { label, victims: victims.length, distinctValues: new Set(values).size,
    gcmLength: attack(lenGcm), gcmLengthPlusR1bCount: attack(v => `${lenGcm(v)}/${sc(v)}`),
    cbchLength: attack(lenCH), cbchLengthPlusR1bCount: attack(v => `${lenCH(v)}/${sc(v)}`) };
}
const out: any[] = [];
const fx = JSON.parse(readFileSync('.local/research/r2-fixture.json', 'utf8')) as Record<string, string>[];
for (const f of ['name', 'phone', 'email', 'company', 'address', 'memo']) out.push(run(`fixture ${f}`, fx.map(r => r[f])));
const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter(s => s && s.trim().length >= 2);
out.push(run('NSMC reviews 100k (memory only)', lines.slice(0, 100000)));
writeFileSync(`${OUT}/x2-static.json`, json(out));
for (const r of out) console.log(JSON.stringify(r));

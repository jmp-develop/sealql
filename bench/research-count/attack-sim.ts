/**
 * Mechanical leakage comparison for storage changes proposed in r2-verify-min (docs/attack-simulation.md rules):
 *  - B1/D: add a row-bound tag per exact field  (tag = PRF_K(rowId, normalized value)).
 *  - B3: replace GCM (length = utf8+29) with EtM(AES-CBC, PMAC) (length = 33 + 16*ceil((utf8+1)/16)).
 * Attacks (all lower bounds): (1) equal-tag grouping / frequency ranking, (2) known-row propagation (5% known),
 * (3) length + public dictionary (attacker knows the value distribution from a disjoint half), measured on
 * NSMC reviews (memory only) and fixture fields.
 * Usage: npx tsx bench/research-count/attack-sim.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';

let seed = 0x1357; const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const K = randomBytes(32);
const tag = (row: string, v: string) => createHmac('sha256', K).update(row + '\0' + v).digest('hex').slice(0, 32); // model of any PRF(row, v)
const bytes = (v: string) => Buffer.byteLength(v, 'utf8');
const lenGcm = (v: string) => bytes(v) + 29;
const lenB3 = (v: string) => 33 + 16 * Math.ceil((bytes(v) + 1) / 16);

function run(label: string, values: string[]) {
  const n = values.length, ids = values.map((_, i) => `row-${i}`);
  // victims = even rows, attacker's public dictionary = odd rows (disjoint, same distribution)
  const victims = values.map((v, i) => ({ v, id: ids[i] })).filter((_, i) => i % 2 === 0);
  const dict = new Map<string, number>(); values.forEach((v, i) => { if (i % 2) dict.set(v, (dict.get(v) ?? 0) + 1); });
  // (1) equal-tag groups
  const tagGroups = new Map<string, number>(); for (const x of victims) { const t = tag(x.id, x.v); tagGroups.set(t, (tagGroups.get(t) ?? 0) + 1); }
  const rowsInSharedTagGroups = [...tagGroups.values()].filter(c => c > 1).reduce((a, c) => a + c, 0);
  // (2) known-row propagation: attacker knows 5% victims' plaintext+tag; recovers any other row with an equal tag
  const known = victims.filter(() => rnd() < 0.05); const knownTags = new Map(known.map(x => [tag(x.id, x.v), x.v]));
  const knownSet = new Set(known.map(x => x.id));
  let propagated = 0; for (const x of victims) if (!knownSet.has(x.id) && knownTags.has(tag(x.id, x.v))) propagated++;
  // (3) length + dictionary: guess the most frequent dictionary value in the same length class
  const attack = (len: (v: string) => number) => {
    const best = new Map<number, { v: string; c: number }>();
    for (const [v, c] of dict) { const l = len(v), b = best.get(l); if (!b || c > b.c) best.set(l, { v, c }); }
    let hit = 0; const classes = new Set<number>(); for (const x of victims) { classes.add(len(x.v)); if (best.get(len(x.v))?.v === x.v) hit++; }
    return { lengthClasses: classes.size, recoveredPct: +(100 * hit / victims.length).toFixed(3) };
  };
  return { label, victims: victims.length, distinctValues: new Set(values).size,
    tagAdded: { rowsInSharedTagGroups, knownRowPropagated: propagated },
    lengthDictionary: { gcmExact: attack(lenGcm), b3Padded16: attack(lenB3) } };
}
const out: any[] = [];
const lines = readFileSync('.local/ratings.txt', 'utf8').split('\n').slice(1).map(l => l.split('\t')[1]).filter(s => s && s.trim().length >= 2);
out.push(run('NSMC reviews 100k', lines.slice(0, 100000)));
const fx = JSON.parse(readFileSync('.local/research/r2-fixture.json', 'utf8')) as Record<string, string>[];
for (const f of ['company', 'name', 'phone', 'address', 'memo', 'email']) out.push(run(`fixture ${f}`, fx.map(r => r[f])));
writeFileSync('bench/results/2026-09-28-count-research/r2-attack-sim.json', JSON.stringify(out, null, 1));
for (const r of out) console.log(JSON.stringify(r));

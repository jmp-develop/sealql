/**
 * Task 5 auxiliary: inherited FNV simulator, company 16 values, seeds 1..200, 2/3/4/16 bits.
 * Backup-only attacker; scope = first 50k fixture rows; reference distribution = other 50k. Designs: B16 (current 16-bit)
 * and coarse2 (2-bit). Attacks: random known rows 0.01/0.1/1 %; attacker-inserted rows (16 values x 1 / x 3);
 * public frequency ranking. Metrics: full value recovery % and wrong-guess % on unknown rows; min–max over seeds.
 * Also reports, per seed, how the 16 companies fall into the 2-bit buckets (a singleton bucket = that company exposed).
 * Usage: rtk proxy node --import tsx bench/research-task5/security-fnv.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeText } from '../../src/core/search-tokens.js';
const OUT = 'bench/results/2026-09-29-task5'; mkdirSync(OUT, { recursive: true });
const norm = (v: string) => { try { return normalizeText(v, 'legacy-text-v1'); } catch { return ''; } };
const fixture: Record<string, string>[] = JSON.parse(readFileSync('.local/research/m1-fable-src/fixture-customers.json', 'utf8'));
const half = Math.floor(fixture.length / 2);
const victim = fixture.slice(0, half).map(r => norm(r.company)), reference = fixture.slice(half).map(r => norm(r.company));
const refFreq = new Map<string, number>(); for (const v of reference) refFreq.set(v, (refFreq.get(v) ?? 0) + 1);
const refRank = [...refFreq].sort((a, b) => b[1] - a[1]).map(x => x[0]);
const vicFreq = new Map<string, number>(); for (const v of victim) vicFreq.set(v, (vicFreq.get(v) ?? 0) + 1);
const pct = (a: number, b: number) => +(100 * a / b).toFixed(2);
const res: any = { victimRows: half, distinctValues: vicFreq.size, valueShares: [...vicFreq].sort((a, b) => b[1] - a[1]).map(([v, n]) => [v, pct(n, half)]), seeds: [], range: {} };
for (const seed of Array.from({length:200},(_,i)=>i+1)) {
  let s = seed >>> 0; const rnd = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const fnv = (x: string) => { let h = 0x811c9dc5; const y = 'seed' + seed + ':' + x; for (let i = 0; i < y.length; i++) { h ^= y.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return h >>> 0; };
  const order = Array.from({ length: half }, (_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const seedRes: any = { seed, designs: {} };
  for (const [name, bits] of [['B16', 16], ['coarse2', 2], ['coarse3', 3], ['coarse4', 4]] as [string, number][]) {
    const tok = (v: string) => fnv('x:company:' + v) & ((1 << bits) - 1);
    const rowTok = victim.map(tok);
    const buckets = new Map<number, Set<string>>(); for (const v of vicFreq.keys()) { let g = buckets.get(tok(v)); if (!g) buckets.set(tok(v), g = new Set()); g.add(v); }
    const guessEval = (learned: Map<number, Set<string>>, skip: Set<number>) => { let correct = 0, wrong = 0, unknown = 0; for (let i = 0; i < half; i++) { if (skip.has(i)) continue; unknown++; const g = learned.get(rowTok[i]); if (!g || g.size !== 1) continue; if (g.has(victim[i])) correct++; else wrong++; } return { recoveredPct: pct(correct, unknown), wrongPct: pct(wrong, unknown) }; };
    const out: any = { bucketsUsed: buckets.size, valuesPerBucket: [...buckets.values()].map(g => g.size).sort((a, b) => b - a), singletonBucketRowsPct: pct([...buckets.values()].filter(g => g.size === 1).reduce((a, g) => a + (vicFreq.get([...g][0]) ?? 0), 0), half), known: {}, inserted: {}, frequency: {} };
    for (const k of [0.01, 0.1, 1]) { const n = Math.max(1, Math.round(half * k / 100)); const ids = new Set(order.slice(0, n)); const learned = new Map<number, Set<string>>(); for (const i of ids) { let g = learned.get(rowTok[i]); if (!g) learned.set(rowTok[i], g = new Set()); g.add(victim[i]); } out.known[k] = { knownRows: n, ...guessEval(learned, ids) }; }
    for (const r of [1, 3]) { const learned = new Map<number, Set<string>>(); for (const v of refRank.slice(0, 16)) for (let t = 0; t < r; t++) { let g = learned.get(tok(v)); if (!g) learned.set(tok(v), g = new Set()); g.add(v); } out.inserted[`16x${r}`] = { insertedRows: 16 * r, ...guessEval(learned, new Set()) }; }
    const tf = new Map<number, number>(); for (const t of rowTok) tf.set(t, (tf.get(t) ?? 0) + 1);
    const tr = [...tf].sort((a, b) => b[1] - a[1]).map(x => x[0]); const learned = new Map<number, Set<string>>(); tr.forEach((t, i) => { if (refRank[i] !== undefined) learned.set(t, new Set([refRank[i]])); });
    out.frequency = guessEval(learned, new Set());
    out.bucketComposition=[...buckets].map(([token,g])=>({token,values:[...g].map(v=>({value:v,rows:vicFreq.get(v)}))}));
    out.dominant80 = out.bucketComposition.some((b:any)=>Math.max(...b.values.map((v:any)=>v.rows))/b.values.reduce((n:number,v:any)=>n+v.rows,0)>=0.8);
    out.hasSingleton = [...buckets.values()].some(g=>g.size===1);
    out.formulaInsertedPct = 100*[...buckets.values()].filter(g=>g.size===1).reduce((n,g)=>n+(vicFreq.get([...g][0])??0),0)/half;
    if(Math.abs(out.formulaInsertedPct-out.inserted['16x1'].recoveredPct)>0.00501)throw Error('formula mismatch');
    seedRes.designs[name] = out;
  }
  res.seeds.push(seedRes); if(seed%25===0)console.log("seeds",seed);
}

const quant=(xs:number[])=>{xs=[...xs].sort((a,b)=>a-b);return {min:xs[0],median:(xs[99]+xs[100])/2,p90:xs[179],max:xs[199]};};
for(const name of ['B16','coarse2','coarse3','coarse4']){
 res.range[name]={};
 for(const attack of ['known0.01','known0.1','known1','inserted1','inserted3','frequency']){
  const get=(d:any)=>attack.startsWith('known')?d.known[attack.slice(5)]:attack.startsWith('inserted')?d.inserted['16x'+attack.slice(8)]:d.frequency;
  res.range[name][attack]={recoveredPct:quant(res.seeds.map((s:any)=>get(s.designs[name]).recoveredPct)),wrongPct:quant(res.seeds.map((s:any)=>get(s.designs[name]).wrongPct))};
 }
 res.range[name].singletonRows=quant(res.seeds.map((s:any)=>s.designs[name].singletonBucketRowsPct));
 res.range[name].singletonLayoutPct=100*res.seeds.filter((s:any)=>s.designs[name].hasSingleton).length/200;
 res.range[name].dominant80LayoutPct=100*res.seeds.filter((s:any)=>s.designs[name].dominant80).length/200;
}
res.method={seeds:200,token:'seeded FNV avalanche; inherited simulator, key proxy only',p90:'nearest rank 180/200',known:'same random row order across bit widths in each seed',dominance:'at least one nonempty bucket has >=80% rows from one company; includes singleton',formula:'sum row counts in singleton buckets / victim rows'};
writeFileSync(OUT+'/security-fnv.json',JSON.stringify(res,null,2)); console.log(JSON.stringify(res.range,null,2));

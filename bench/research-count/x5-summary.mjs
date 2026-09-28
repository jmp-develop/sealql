// X5: fold EXPLAIN JSON files into one summary table (first run vs median of later runs).
import { readFileSync, writeFileSync } from 'node:fs';
const dir = 'bench/results/2026-09-28-count-research';
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const bufs = p => { let hit = 0, read = 0; const w = n => { if (n['Node Type'] && n['Relation Name'] === 'customers_seal_index') { hit += n['Shared Hit Blocks']; read += n['Shared Read Blocks']; } (n.Plans ?? []).forEach(w); }; w(p); return { companionHit: hit, companionRead: read }; };
const rows = [];
for (const f of ['x5-explain-variants-av.json', 'x5-explain-force-btree-av.json']) for (const r of JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))) {
  const last = r.runs[r.runs.length - 1];
  const warm = [...r.runs.slice(1).map(x => x['Execution Time']), +r.text4.match(/Execution Time: ([\d.]+)/)[1]];
  rows.push({ key: r.key, variant: r.variant, firstMs: +r.execMs[0].toFixed(2), warmMedianMs: +med(warm).toFixed(2), topEstRows: last.Plan['Plan Rows'], topActualRows: last.Plan['Actual Rows'], topCost: last.Plan['Total Cost'], ...bufs(last.Plan), autovacuumWorkers: r.autovacuumWorkers });
}
for (const r of JSON.parse(readFileSync(`${dir}/x5-regress-av.json`, 'utf8')))
  rows.push({ key: `${r.case}|${r.env}|count-shape`, variant: r.variant, firstMs: +r.execMs[0].toFixed(2), warmMedianMs: +med([...r.execMs.slice(1), +r.text4.match(/Execution Time: ([\d.]+)/)[1]]).toFixed(2), topActualRows: r.rows, autovacuumWorkers: r.autovacuumWorkers });
writeFileSync(`${dir}/x5-summary.json`, JSON.stringify({ note: 'EXPLAIN ANALYZE server execution time; firstMs = first run in session order, warmMedianMs = median of later 3 runs; not the docs/measurement.md 2+7 protocol', rows }, null, 1) + '\n');
for (const r of rows) console.log(r.key.padEnd(40), r.variant.padEnd(16), String(r.firstMs).padStart(8), String(r.warmMedianMs).padStart(8), r.companionRead ?? '', r.topCost ?? '');

import { readFileSync, writeFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('bench/results/2026-09-28-r8-remeasure/results.json','utf8'));
const out={};
for (const row of r.rows) {
  if (!['and4','and6','and2'].includes(row.case)) continue;
  const ev = row.first.product.sqlEvents;
  console.log(row.case,row.environment,row.mode,'db',row.product.dbMs.toFixed(1),'cand',row.product.candidateRows, ev.length, Object.keys(ev[0]));
  out[`${row.case}|${row.environment}|${row.mode}`]=ev.map(e=>({sql:e.sql,params:e.params}));
}
writeFileSync('bench/results/2026-09-28-count-research/x5-recorded-sql.json',JSON.stringify(out,null,1));
const k=Object.keys(out).find(k=>k.startsWith('and4|1억')&&k.includes('count'));
console.log(k, out[k][0].sql); console.log(JSON.stringify(out[k][0].params));
const k2=Object.keys(out).find(k=>k.startsWith('and4|1억')&&k.includes('200'));
console.log(k2, out[k2]?.[0].sql); console.log(JSON.stringify(out[k2]?.[0].params));

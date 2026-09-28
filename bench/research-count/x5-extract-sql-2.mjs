import { readFileSync, writeFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('bench/results/2026-09-28-r8-remeasure/results.json','utf8'));
const out = JSON.parse(readFileSync('bench/results/2026-09-28-count-research/x5-recorded-sql.json','utf8'));
for (const row of r.rows) if (['exact_one','exact_common','or3','sub_mid'].includes(row.case)) {
  const ev=row.first.product.sqlEvents[0]; out[`${row.case}|${row.environment}|${row.mode}`]=[{sql:ev.sql,params:ev.params}];
  if (row.environment.startsWith('1억')) { console.log(row.case,row.mode,'db',row.product.dbMs.toFixed(2)); console.log(ev.sql.slice(0,900)); console.log(JSON.stringify(ev.params).slice(0,300)); }
}
writeFileSync('bench/results/2026-09-28-count-research/x5-recorded-sql.json',JSON.stringify(out,null,1));

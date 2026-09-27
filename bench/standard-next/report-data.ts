import { readFile } from 'node:fs/promises';
const dir='bench/results/2026-09-27-standard-next';
const next=JSON.parse(await readFile(`${dir}/matrix.json`,'utf8'));
const old=JSON.parse(await readFile(`${dir}/old-matrix.json`,'utf8'));
const names=['exact_common','exact_mid','exact_one','exact_zero','sub2_common','sub_mid','sub_mid_space','sub_rare','sub_long','sub_name_suffix','sub_zero','starts','ends','and2','and4','and6','or2','or3','drain101'];
const indexes=[0,1,2,3,5,6,7,8,9,10,11,13,14,15,17,18,20,21,22];
const map=new Map(names.map((n,i)=>[n,old[indexes[i]]]));
const f=(v:number)=>v.toFixed(2);
console.log('| Case | Rows | Plain ms | Old ms | Next ms (SQL ms) | Skip ms | Next SQL / candidates / opens |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for(const row of next){const o=map.get(row.case),s=row.summary;
  console.log(`| ${row.case} | ${row.rows} | ${f(s.plain.totalMs)} | ${o?f(o.encMs):'—'} | ${f(s.next.totalMs)} (${f(s.next.sqlMs)}) | ${f(s.skip.totalMs)} | ${s.next.sqlCalls} / ${s.next.candidates} / ${s.next.authenticatedFields} |`);
}

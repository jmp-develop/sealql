import { writeFile } from 'node:fs/promises';
import { binding, guard, pool, schema, source, tables } from './common.js';

try{
  await guard();const rows=[];
  for(const table of tables){
    for(const variant of ['old','next','skip'] as const){
      const b=variant==='old'?undefined:binding(table,variant==='skip');
      const parent=variant==='old'?`${source}.${table}`:`${schema}.${table}${variant==='skip'?'_skip':''}`;
      const companion=variant==='old'?`${source}.${table}_std_comp_idx`:`${schema}.${b!.storage.index!.name}`;
      const p=(await pool.query('select pg_total_relation_size(to_regclass($1)) bytes',[parent])).rows[0].bytes;
      const c=(await pool.query('select pg_total_relation_size(to_regclass($1)) bytes',[companion])).rows[0].bytes;
      rows.push({table,variant,parentBytes:Number(p),companionBytes:Number(c)});
    }
  }
  await writeFile('bench/results/2026-09-27-standard-next/storage.json',JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify(rows));
}finally{await pool.end();}

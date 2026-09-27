import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { binding, fields, guard, pool, schema, scopeId, sealer, source, tables } from './common.js';

const result:any={tables:{},sampleIds:[],fieldAuthentications:0};
const selected=process.argv[2]?tables.filter(t=>t===process.argv[2]):tables;
if(!selected.length)throw new Error('Unknown table');
try{
  await guard();
  for(const table of selected){
    const b=binding(table),ring=sealer.ring(b.model.id);let after='00000000-0000-0000-0000-000000000000',seen=0;
    const started=performance.now();
    while(true){
      const rows=(await pool.query(`select p.id,${fields.map(f=>`p.${f}_plain,s.${f}_ct`).join(',')} from ${source}.${table} p join ${schema}.${table} s on s.scope_id=p.scope_id and s.id=p.id where p.scope_id=$1 and p.id>$2 order by p.id limit 500`,[scopeId,after])).rows;
      if(!rows.length)break;
      const tasks=rows.flatMap(row=>fields.map(f=>({row,f})));let cursor=0;
      await Promise.all(Array.from({length:32},async()=>{while(cursor<tasks.length){
        const {row,f}=tasks[cursor++];
        const value=await sealer.open(row[`${f}_ct`],{modelId:b.model.id,fieldId:f,keyScopeId:ring.keyScopeId,scopeId,rowId:row.id,spec:b.model.fields[f]},ring);
        assert.equal(value,row[`${f}_plain`],`${table}/${row.id}/${f}`);result.fieldAuthentications++;
      }}));
      seen+=rows.length;after=rows.at(-1).id;
      if(seen%10000===0)console.log(JSON.stringify({table,verified:seen}));
    }
    const counts=await pool.query(`select (select count(*) from ${source}.${table} where scope_id=$1) source,(select count(*) from ${schema}.${table} where scope_id=$1) next,(select count(*) from ${schema}.${table}_skip where scope_id=$1) skip`,[scopeId]);
    assert.equal(Number(counts.rows[0].source),100000);assert.equal(Number(counts.rows[0].next),100000);assert.equal(Number(counts.rows[0].skip),100000);
    assert.equal(seen,100000);
    const different=await pool.query(`select count(*) n from ${schema}.${table} a join ${schema}.${table}_skip b using(scope_id,id) where ${fields.map(f=>`a.${f}_ct is distinct from b.${f}_ct`).join(' or ')}`);
    assert.equal(Number(different.rows[0].n),0);
    result.tables[table]={rows:seen,elapsedMs:performance.now()-started,skipCiphertextMismatches:0};
  }
  await writeFile(`bench/results/2026-09-27-standard-next/verify-${selected.join('-')}.json`,JSON.stringify(result,null,2)+'\n');
}finally{await pool.end();}

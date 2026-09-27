/** Verify the deterministic new UUID prefix cannot merge different source IDs. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const report=[];
  for(const table of ['customers','tickets']){
    const x=(await pool.query(`select count(*) n,count(distinct substring(id::text from 9)) suffixes,
      count(distinct substring(id::text from 1 for 8)) prefixes
      from bench_realistic_100k.${table}`)).rows[0];
    assert.equal(Number(x.n),100000);assert.equal(Number(x.suffixes),100000);
    const entry={table,rows:Number(x.n),distinctSuffixes:Number(x.suffixes),sourcePrefixes:Number(x.prefixes)};
    report.push(entry);console.log(JSON.stringify(entry));
  }
  const out='bench/results/2026-09-27-native-scale-100m';await mkdir(out,{recursive:true});
  await writeFile(`${out}/id-check.json`,JSON.stringify(report,null,2)+'\n');
}finally{await pool.end();}

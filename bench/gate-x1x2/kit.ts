/** Run drizzle-kit only against a verified, disposable schema. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { guard, pool } from '../standard-next/common.js';
const schema='gate_x1x2_kit', out='bench/results/2026-09-27-gate-x1x2';
const run=(...args:string[])=>{const r=spawnSync(process.execPath,['node_modules/drizzle-kit/bin.cjs',...args],{encoding:'utf8',timeout:120000});return {stdout:r.stdout,stderr:r.stderr,status:r.status};};
let created=false;
try{
  await guard();assert.equal((await pool.query('show port')).rows[0].port,'56439');
  assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
  await pool.query(`create schema "${schema}"`);created=true;
  await pool.query(`create table "${schema}"."sealed"(id uuid primary key,memo_ct text,memo_tok_s bigint[])`);
  await pool.query(`create index gate_hidden_tok on "${schema}"."sealed" using gin(memo_tok_s)`);
  await mkdir(out,{recursive:true});
  const generated=run('generate','--config=bench/gate-x1x2/kit-generate-config.ts');
  const pushed=run('push','--config=bench/gate-x1x2/kit-config.ts','--force');
  const cols=(await pool.query('select table_name,column_name from information_schema.columns where table_schema=$1 order by table_name,column_name',[schema])).rows;
  const idx=(await pool.query('select indexname from pg_indexes where schemaname=$1 order by indexname',[schema])).rows;
  const result={generated,pushed,columns:cols,indexes:idx,hiddenColumnRetained:cols.some(r=>r.table_name==='sealed'&&r.column_name==='memo_tok_s'),hiddenIndexRetained:idx.some(r=>r.indexname==='gate_hidden_tok'),plainCreated:cols.some(r=>r.table_name==='plain'),pushSafe:pushed.status===0&&!pushed.stderr.includes('error:')};
  await writeFile(`${out}/kit.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{if(created)await pool.query(`drop schema "${schema}" cascade`);await pool.end();}

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId } from './schema.js';
import { fieldProfiles, recompute, tokenColumn } from './tokens.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
const out='bench/results/2026-09-27-native-verification/v2';
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  await mkdir(out,{recursive:true});
  const profiles=fields.flatMap(f=>fieldProfiles('customers',f).map(p=>({field:f,col:tokenColumn(p.indexId),mode:p.mode})));
  const known=(await pool.query("select column_name from information_schema.columns where table_schema='native_verify_main' and table_name='customers_seal_index'")).rows.map(x=>x.column_name);
  for(const p of profiles)assert(known.includes(p.col),`${p.field}/${p.mode} physical column`);
  let checked=0,missing=0,extra=0;const sample=10000;
  for(let offset=0;offset<sample;offset+=1000){
    const rows=(await pool.query(`select p.id,${fields.map(f=>`p.${f}_plain`).join(',')},${profiles.map(p=>`i."${p.col}"`).join(',')}
      from bench_realistic_100k.customers p join native_verify_main.customers_seal_index i
      on i.row_id=p.id and i.scope_id=p.scope_id where p.scope_id=$1 order by p.id limit 1000 offset $2`,[scopeId,offset])).rows;
    assert.equal(rows.length,1000);
    for(const row of rows){
      for(const f of fields){const expected=await recompute('customers',f,scopeId,row[`${f}_plain`]);
        for(const [col,tokens] of Object.entries(expected)){
          const e=new Set<string>(tokens),a=new Set<string>((row[col]??[]).map(String));
          for(const t of e)if(!a.has(t))missing++;
          for(const t of a)if(!e.has(t))extra++;
        }
      }
      checked++;
    }
    console.log(JSON.stringify({checked,missing,extra}));
  }
  assert.equal(missing,0);assert.equal(extra,0);
  await writeFile(`${out}/tokens.json`,JSON.stringify({schema:'native_verify_main',sample,fields,profileColumns:profiles,checked,missing,extra},null,2)+'\n');
}finally{await pool.end();}

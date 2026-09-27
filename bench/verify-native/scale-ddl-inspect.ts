import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  for(const schema of ['native_verify_main','bench_realistic_100k']){
    const tables=schema==='native_verify_main'?['customers','customers_seal_index']:['customers'];
    const indexes=(await pool.query(`select tablename,indexname,indexdef from pg_indexes where schemaname=$1 and tablename=any($2) order by tablename,indexname`,[schema,tables])).rows;
    const columns=(await pool.query(`select table_name,column_name,data_type,udt_name from information_schema.columns where table_schema=$1 and table_name=any($2) order by table_name,ordinal_position`,[schema,tables])).rows;
    const constraints=(await pool.query(`select c.conrelid::regclass::text relation,c.conname,pg_get_constraintdef(c.oid) definition
      from pg_constraint c join pg_namespace n on n.oid=(select relnamespace from pg_class where oid=c.conrelid)
      where n.nspname=$1 and c.conrelid::regclass::text=any($2) order by relation,c.conname`,[schema,tables.map(t=>`${schema}.${t}`)])).rows;
    console.log(JSON.stringify({schema,indexes,columns,constraints},null,2));
  }
}finally{await pool.end();}

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';

const mode=process.argv[2];assert(['before','after'].includes(mode),'Pass before or after');
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
const targets=[
  {schema:'native_verify_main',table:'customers_seal_index'},
  {schema:'bench_standard_next_100k',table:'customers_skip_product_multi_seal_index'},
];
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const pgstattuple=(await pool.query("select extname from pg_extension where extname='pgstattuple'")).rowCount===1;
  const result:any={mode,pgstattuple,targets:[]};
  for(const target of targets){
    const indexes=(await pool.query(`select indexname,indexdef,pg_relation_size((quote_ident(schemaname)||'.'||quote_ident(indexname))::regclass) bytes
      from pg_indexes where schemaname=$1 and tablename=$2 order by indexname`,[target.schema,target.table])).rows;
    assert(indexes.length>0,`${target.schema}.${target.table} indexes`);
    const gin=indexes.filter(x=>/using gin/i.test(x.indexdef));assert.equal(gin.length,1);
    const stats=(await pool.query(`select relname,n_live_tup,n_dead_tup,last_vacuum,last_autovacuum,last_analyze,last_autoanalyze,
      vacuum_count,autovacuum_count,analyze_count,autoanalyze_count from pg_stat_all_tables where schemaname=$1 and relname=$2`,
      [target.schema,target.table])).rows[0];
    const ginStats=pgstattuple?(await pool.query('select * from pgstatginindex($1::regclass)',[`${target.schema}.${gin[0].indexname}`])).rows[0]:null;
    result.targets.push({...target,tableBytes:Number((await pool.query('select pg_relation_size($1::regclass) bytes',[
      `${target.schema}.${target.table}`])).rows[0].bytes),indexes:indexes.map(x=>({...x,bytes:Number(x.bytes)})),stats,ginStats});
  }
  await writeFile(`bench/results/2026-09-27-native-verification/v3/gin-${mode}.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{await pool.end();}

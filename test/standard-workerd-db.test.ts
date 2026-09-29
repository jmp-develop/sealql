import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import postgres from 'postgres';
import {drizzle as postgresDrizzle} from 'drizzle-orm/postgres-js';
import {getTableColumns} from 'drizzle-orm';
import {getTableConfig,PgDialect} from 'drizzle-orm/pg-core';
import {assertDisposable} from './disposable.js';
import {driverFlow,driverSchema} from './r9-driver-flow.js';

test('Node pg, postgres-js and local workerd pg execute the complete public DB flow',async()=>{
  const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
  const schema=`test_r9_driver_${process.pid}`;let created=false,mf:Miniflare|undefined;
  try {
    await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
    const fixture=(await pool.query('select id,scope_id,memo_plain from bench_realistic_100k.customers order by id limit 1')).rows[0];
    assert.ok(fixture);
    const {sealed,seal}=driverSchema(schema),config=getTableConfig(seal),dialect=new PgDialect();
    await pool.query(`create schema ${schema}`);created=true;
    await pool.query(`create table ${schema}.rows(id uuid primary key,scope_id uuid not null,body_ct bytea not null)`);
    const cols=Object.values(getTableColumns(seal)).map(c=>`"${c.name}" ${c.getSQLType()}${c.notNull?' not null':''}`).join(',');
    await pool.query(`create table ${schema}.rows_seal_index(${cols},unique(scope_id,row_id),foreign key(row_id) references ${schema}.rows(id) on delete cascade)`);
    for(const check of config.checks)await pool.query(`alter table ${schema}.rows_seal_index add constraint "${check.name}" check (${dialect.sqlToQuery(check.value).sql})`);
    for(const sql of sealed.extraMigrationSql(seal))await pool.query(sql);
    const nodeResult=await driverFlow(drizzle(pool),schema,fixture);assert.equal(nodeResult.ok,true);console.log('Node pg flow',JSON.stringify(nodeResult));
    const client=postgres({host:'127.0.0.1',port:56439,username:'sealql_test',database:'postgres',max:1});
    try {
      const result=await driverFlow(postgresDrizzle(client),schema,fixture);
      assert.equal(result.ok,true);console.log('postgres-js flow',JSON.stringify(result));
    } finally {await client.end();}
    const modules=['events','util','util/types','stream','crypto','dns','path','fs','net','tls','string_decoder','buffer','assert','url'];
    const banner=modules.map((name,i)=>`import * as n${i} from 'node:${name}';`).join('\n')+'\n'+
      `const require=(name)=>({${modules.map((name,i)=>`['${name}']:n${i},['node:${name}']:n${i}`).join(',')}})[name]??(()=>{throw Error('unsupported require '+name)})();`;
    const bundle=await build({entryPoints:['test/r9-workerd-db-entry.ts'],bundle:true,write:false,platform:'node',format:'esm',target:'es2022',conditions:['workerd'],external:['cloudflare:sockets'],banner:{js:banner}});
    mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],bindings:{
      SCHEMA:schema,FIXTURE:JSON.stringify(fixture),DATA_DIRECTORY:(await pool.query('show data_directory')).rows[0].data_directory,
    }});
    const response=await mf.dispatchFetch('https://sealql.test'),result=await response.json() as {ok:boolean};
    assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.ok,true,JSON.stringify(result));
    console.log('workerd pg flow',JSON.stringify(result));
  } finally {await mf?.dispose();if(created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}
});

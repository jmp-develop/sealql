/** Run after compiling f9005bd and a15f85a into isolated folders; caller must own the measurement lock. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {getTableColumns} from 'drizzle-orm';
import {getTableConfig,PgDialect,pgSchema,uuid} from 'drizzle-orm/pg-core';
import {assertDisposable} from '../../test/disposable.js';
const owner='r9-review-impl task_5488e89a7f87 ctx_c242d343601f';
assert.equal(readFileSync('.local/research/measure.lock','utf8'),owner);
const variants=[['pre-r9','../../.local/r9-baseline/dist'],['r9-before','../../.local/r9-review-before/dist'],['r9-after','../../dist']] as const;
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1});
await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
const fields=['name','phone','address','memo','email','company'],created:string[]=[],handles:any[]=[];
const out='bench/results/2026-09-29-r9-review';mkdirSync(out,{recursive:true});
try{
 const source=(await pool.query(`select id,scope_id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id limit 100`)).rows;
 assert.equal(source.length,100);
 for(const [name,path]of variants){
  const {createSealer}=await import(path+'/index.js'),{createSealed,registrationOf}=await import(path+'/adapters/drizzle/v0.45/native.js');
  const schema=`test_r9_review_cost_${name.replaceAll('-','_')}_${process.pid}`;
  assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
  const sealed=createSealed({sealer:createSealer({key:new Uint8Array(32).fill(93)})}),cols:any={id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull()};
  for(const f of fields)cols[f]=sealed.text(f,{search:{exact:true,substring:{wordBoundary:true}}});
  const table=pgSchema(schema).table('customers',cols),seal=sealed.register(table,{row:'id',scope:'scopeId'}),reg=registrationOf(seal),config=getTableConfig(seal);
  await pool.query(`create schema ${schema}`);created.push(schema);
  await pool.query(`create table ${schema}.customers(id uuid primary key,scope_id uuid not null,${fields.map(f=>`${f}_ct bytea not null`).join(',')})`);
  await pool.query(`create table ${schema}.customers_seal_index(${Object.values(getTableColumns(seal)).map(c=>`"${c.name}" ${c.getSQLType()}${c.notNull?' not null':''}`).join(',')},foreign key(row_id) references ${schema}.customers(id) on delete cascade)`);
  for(const c of config.checks)await pool.query(`alter table ${schema}.customers_seal_index add constraint "${c.name}" check (${new PgDialect().sqlToQuery(c.value).sql})`);
  await pool.query(`create unique index scope_row on ${schema}.customers_seal_index(scope_id,row_id)`);
  if(name!=='pre-r9')await pool.query(`create unique index row_only on ${schema}.customers_seal_index(row_id)`);
  const profiles=Object.values(reg.storage.index.profiles) as any[];
  for(const p of profiles.filter(p=>p.mode==='exact'))await pool.query(`create index "${p.tokens}_bt" on ${schema}.customers_seal_index(scope_id,("${p.tokens}"[1]),row_id${p.exact?`,"${p.exact.salt}","${p.exact.stamp}","${p.tokens}"`:''})`);
  await pool.query(`create index subs on ${schema}.customers_seal_index using gin(${profiles.filter(p=>p.mode==='substring').map(p=>`"${p.tokens}"`).join(',')})`);
  for(const sql of sealed.extraMigrationSql(seal))await pool.query(sql);
  handles.push({name,schema,sealed,seal,table,runs:{insert:[],reindex:[]}});
 }
 const inputs=source.map(r=>({id:r.id,scopeId:r.scope_id,...Object.fromEntries(fields.map(f=>[f,r[f]]))})),db=drizzle(pool);
 for(let round=-2;round<7;round++)for(const h of [...handles.slice((round+2)%3),...handles.slice(0,(round+2)%3)]){
  await pool.query(`delete from ${h.schema}.customers`);
  let start=performance.now();await h.sealed.insert(db,h.seal,inputs);const insertMs=performance.now()-start;
  start=performance.now();assert.deepEqual(await h.sealed.reindex(db,h.seal,{batch:100}),{rows:100});const reindexMs=performance.now()-start;
  const rows=await h.sealed.open(await db.select().from(h.table).orderBy(h.table.id));assert.deepEqual(rows,inputs);
  if(round>=0){h.runs.insert.push(insertMs/100);h.runs.reindex.push(reindexMs/100);}
  console.log(JSON.stringify({round,name:h.name,insertMsPerRow:insertMs/100,reindexMsPerRow:reindexMs/100}));
 }
 const median=(xs:number[])=>xs.slice().sort((a,b)=>a-b)[xs.length>>1];
 const result={protocol:'Same 100 original fixture rows, six fields, exact16 + words substring, one transaction/batch100, two warmups and seven alternating rounds; measured end-to-end ms per row, own schema per version with declared indexes.',versions:handles.map(h=>({name:h.name,runs:h.runs,insertMsPerRow:median(h.runs.insert),reindexMsPerRow:median(h.runs.reindex)}))};
 writeFileSync(`${out}/write-costs.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{for(const schema of created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}

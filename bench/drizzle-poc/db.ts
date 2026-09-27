import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, or, eq, sql, relations } from 'drizzle-orm';
import { assertDisposable } from '../../test/disposable.js';
import * as schema from './schema.js';

const { Pool } = pg;
const pool = new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
const out = new URL('../results/2026-09-27-drizzle-poc/', import.meta.url);
await mkdir(out,{recursive:true});
const result:any = {versions:{},h3:{},h5:{},h7:{},cleanup:false};
const sealed = { contains:(col:any, value:string) => sql`(${col} -> 'tokens') @> ${JSON.stringify([value])}::jsonb` };
try {
  await assertDisposable(pool);
  assert.equal((await pool.query('show port')).rows[0].port,'56439');
  await pool.query('create schema drizzle_poc');
  await pool.query('create table drizzle_poc.items(id integer primary key, public_text text, sealed jsonb)');
  await pool.query("create index items_tokens_gin on drizzle_poc.items using gin ((sealed -> 'tokens'))");
  await pool.query('create table drizzle_poc.children(id integer primary key, item_id integer references drizzle_poc.items(id), note jsonb)');
  await pool.query('create table drizzle_poc.driver_items(id integer primary key, secret text)');
  const db = drizzle({client:pool,schema});
  result.h3.insert = await db.insert(schema.items).values([{id:1,publicText:'public',sealed:'abc'},{id:2,publicText:'other',sealed:'xyz'}]).returning();
  result.h3.whereSql = db.select().from(schema.items).where(or(and(eq(schema.items.publicText,'public'),sealed.contains(schema.items.sealed,'ab')),eq(schema.items.publicText,'none'))).toSQL();
  result.h3.whereRows = await db.select().from(schema.items).where(or(and(eq(schema.items.publicText,'public'),sealed.contains(schema.items.sealed,'ab')),eq(schema.items.publicText,'none')));
  result.h3.update = await db.update(schema.items).set({sealed:'abcd'}).where(eq(schema.items.id,1)).returning();
  result.h3.conflict = await db.insert(schema.items).values({id:1,publicText:'upsert',sealed:'abcde'}).onConflictDoUpdate({target:schema.items.id,set:{sealed:'abcde'}}).returning();
  result.h3.prepared = await db.select().from(schema.items).where(eq(schema.items.id,sql.placeholder('id'))).prepare('poc_find').execute({id:1});
  result.h3.raw = (await db.execute(sql`select sealed from drizzle_poc.items where id = 1`)).rows;
  result.h3.transaction = await db.transaction(async tx => (await tx.insert(schema.items).values({id:3,publicText:'tx',sealed:'transaction'}).returning())[0]);
  await db.insert(schema.children).values({id:1,itemId:1,note:'nested'});
  result.h7.relational = await db.query.items.findMany({with:{children:true}});
  result.h7.directChild = await db.select().from(schema.children);
  const metadata = await pool.query("select a.attnum, c.oid as tableid from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='drizzle_poc' and c.relname='driver_items' and a.attname='secret'");
  const {attnum,tableid} = metadata.rows[0]; result.h5.catalog = {tableID:tableid,columnID:attnum};
  const events:any[]=[];
  async function mappedQuery(client:any, query:any, values?:any[]) {
    const q = typeof query === 'string' ? {text:query} : query;
    const vs = await Promise.all((values??[]).map(async (v:any) => typeof v === 'string' && v.startsWith('ENC:') ? `cipher:${Buffer.from(v.slice(4)).toString('base64')}` : v));
    const res = await client.query(query,vs);
    const hits = res.fields?.map((f:any,i:number) => ({i, name:f.name,tableID:f.tableID,columnID:f.columnID,match:f.tableID===tableid && f.columnID===attnum}))??[];
    for (const row of res.rows) for (const f of hits.filter((x:any)=>x.match)) {
      const v = Array.isArray(row)?row[f.i]:row[f.name];
      if (typeof v==='string' && v.startsWith('cipher:')) {
        const p=Buffer.from(v.slice(7),'base64').toString(); if(Array.isArray(row))row[f.i]=p;else row[f.name]=p;
      }
    }
    events.push({text:q.text,transformed:vs.some((v:any,i:number)=>v!==values?.[i]),fields:hits});
    return res;
  }
  class ProxyPool { constructor(public inner:any){} query(q:any,v?:any[]){return mappedQuery(this.inner,q,v)} async connect(){const c=await this.inner.connect();return {query:(q:any,v?:any[])=>mappedQuery(c,q,v),release:()=>c.release()}} }
  const driver = drizzle({client:new ProxyPool(pool) as any});
  await driver.execute(sql`insert into drizzle_poc.driver_items(id, secret) values (1, ${'ENC:hello'})`);
  result.h5.rawSelect = (await driver.execute(sql`select id, secret from drizzle_poc.driver_items where id=1`)).rows;
  result.h5.aliasSelect = (await driver.execute(sql`select secret as alias from drizzle_poc.driver_items where id=1`)).rows;
  result.h5.expressionSelect = (await driver.execute(sql`select upper(secret) as secret from drizzle_poc.driver_items where id=1`)).rows;
  result.h5.transaction = await driver.transaction(async tx => {await tx.execute(sql`insert into drizzle_poc.driver_items(id,secret) values (2, ${'ENC:tx'})`);return (await tx.execute(sql`select secret from drizzle_poc.driver_items where id=2`)).rows;});
  result.h5.returning = await driver.insert(schema.driverItems).values({id:3,secret:'ENC:returning'}).returning();
  result.h5.mappedSelect = await driver.select().from(schema.driverItems).where(eq(schema.driverItems.id,3));
  result.h5.prepared = await driver.select().from(schema.driverItems).where(eq(schema.driverItems.id,sql.placeholder('id'))).prepare('proxy_find').execute({id:3});
  result.h5.events = events;
  result.h5.stored = (await pool.query('select secret from drizzle_poc.driver_items where id=1')).rows;
  assert.equal(result.h3.whereRows[0].sealed,'abc');
  assert.equal(result.h3.raw[0].sealed.ct,'abcde');
  assert.equal(result.h7.relational.find((x:any)=>x.id===1).children[0].note,'nested');
  assert.equal(result.h5.returning[0].secret,'returning');
  assert.equal(result.h5.prepared[0].secret,'returning');
  assert.equal(result.h5.stored[0].secret,'cipher:aGVsbG8=');
  assert(events.some((e:any)=>e.fields.some((f:any)=>f.name==='alias' && f.match)));
  assert(events.some((e:any)=>e.fields.some((f:any)=>f.name==='secret' && f.tableID===0)));
} catch (e:any) { result.error = {message:e.message,stack:e.stack}; }
finally {
  try { await assertDisposable(pool); await pool.query('drop schema if exists drizzle_poc cascade'); result.cleanup=true; }
  catch(e:any) {result.cleanupError=e.message;}
  await pool.end();
  await writeFile(new URL('db.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if (result.error || !result.cleanup) process.exitCode=1;
}

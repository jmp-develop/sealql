import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { assertDisposable } from '../../test/disposable.js';
import { sealed } from './schema.js';

const s=pgSchema('native_verify_main');
const ordinary=s.table('ordinary',{id:uuid('id').primaryKey(),value:text('value').notNull()});
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
const before=drizzle(pool), after=drizzle(pool);
void sealed;
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[a.length>>1];
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const exists=(await pool.query("select to_regclass('native_verify_main.ordinary') rel")).rows[0].rel;
  if(!exists)await pool.query('create table native_verify_main.ordinary(id uuid primary key,value text not null)');
  const fixture=(await pool.query('select id,name_plain from bench_realistic_100k.customers order by id limit 1')).rows[0];
  const selectBefore=before.select().from(ordinary).where(eq(ordinary.id,fixture.id));
  const selectAfter=after.select().from(ordinary).where(eq(ordinary.id,fixture.id));
  assert.deepEqual(selectBefore.toSQL(),selectAfter.toSQL());
  const insertBefore=before.insert(ordinary).values({id:fixture.id,value:fixture.name_plain}).onConflictDoUpdate({target:ordinary.id,set:{value:fixture.name_plain}});
  const insertAfter=after.insert(ordinary).values({id:fixture.id,value:fixture.name_plain}).onConflictDoUpdate({target:ordinary.id,set:{value:fixture.name_plain}});
  assert.deepEqual(insertBefore.toSQL(),insertAfter.toSQL());
  const paths={before:async()=>{await insertBefore;return selectBefore;},after:async()=>{await insertAfter;return selectAfter;}};
  for(let i=0;i<2;i++)for(const fn of Object.values(paths))await fn();
  const runs:{before:number[];after:number[]}={before:[],after:[]};
  for(let i=0;i<7;i++)for(const name of (i%2?['after','before']:['before','after']) as ('before'|'after')[]){
    const t=performance.now(),rows=await paths[name]();assert.equal(rows.length,1);assert.equal(rows[0].value,fixture.name_plain);
    runs[name].push(performance.now()-t);
  }
  const result={sqlIdentical:true,plainSelectInsert:true,warmup:2,alternatingRuns:7,
    summary:{beforeMs:median(runs.before),afterMs:median(runs.after)},runs};
  await writeFile('bench/results/2026-09-27-native-verification/v3/ordinary.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result.summary));
}finally{await pool.end();}

/** Rebind exactly one existing 100k-row clone copy to scope B through managed writes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId as scopeA } from './schema.js';
import { cloneId, scaleCustomers, scaleCustomersSeal, scaleSealed } from './scale-schema.js';

const scopeB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const copy=999, batchSize=1000;
const lower=`${(0x20000000+copy).toString(16)}-0000-0000-0000-000000000000`;
const upper=`${(0x20000001+copy).toString(16)}-0000-0000-0000-000000000000`;
const plain=pgSchema('native_scale_100m').table('customers_plain',{
  id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),
});
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:2,
  options:'-c statement_timeout=600000'});
const db=drizzle(pool);
const outDir='bench/results/2026-09-27-native-scale-100m/scope-b';
const count=async(table:string,key:string,scope:string)=>Number((await pool.query(
  `select count(*) n from native_scale_100m.${table} where ${key} >= $1 and ${key} < $2 and scope_id=$3`,
  [lower,upper,scope])).rows[0].n);
try{
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_scale_100m.progress')).rows[0].n),1000);
  await mkdir(outDir,{recursive:true});
  const source=(await pool.query(`select id,${fields.map(f=>`${f}_plain`).join(',')}
    from bench_realistic_100k.customers where scope_id=$1 order by id`,[scopeA])).rows;
  assert.equal(source.length,100000);
  const before={
    parentA:await count('customers','id',scopeA),parentB:await count('customers','id',scopeB),
    indexA:await count('customers_seal_index','row_id',scopeA),indexB:await count('customers_seal_index','row_id',scopeB),
    plainA:await count('customers_plain','id',scopeA),plainB:await count('customers_plain','id',scopeB),
  };
  for(const key of Object.keys(before) as (keyof typeof before)[])assert.equal(before[key],key.endsWith('A')?100000:0,`before/${key}`);
  await writeFile(`${outDir}/replace-progress.json`,JSON.stringify({copy,before,batchesDone:0},null,2)+'\n');
  for(let i=0;i<source.length;i+=batchSize){
    const chunk=source.slice(i,i+batchSize);
    const rows=chunk.map(r=>({id:cloneId(r.id,copy),scopeId:scopeB,
      ...Object.fromEntries(fields.map(f=>[f,r[`${f}_plain`]]))}));
    const ids=rows.map(r=>r.id);
    await db.transaction(async tx=>{
      const deleted=await tx.delete(scaleCustomers).where(and(inArray(scaleCustomers.id,ids),eq(scaleCustomers.scopeId,scopeA))).returning({id:scaleCustomers.id});
      assert.equal(deleted.length,chunk.length,`delete batch ${i/batchSize}`);
      await scaleSealed.insert(tx,scaleCustomersSeal,rows as any);
      const changed=await tx.update(plain).set({scopeId:scopeB}).where(and(inArray(plain.id,ids),eq(plain.scopeId,scopeA))).returning({id:plain.id});
      assert.equal(changed.length,chunk.length,`plain batch ${i/batchSize}`);
    });
    const batchesDone=i/batchSize+1;
    await writeFile(`${outDir}/replace-progress.json`,JSON.stringify({copy,before,batchesDone,rowsDone:i+chunk.length},null,2)+'\n');
    if(batchesDone%10===0)console.log(JSON.stringify({copy,batchesDone,rowsDone:i+chunk.length}));
  }
  const after={
    parentA:await count('customers','id',scopeA),parentB:await count('customers','id',scopeB),
    indexA:await count('customers_seal_index','row_id',scopeA),indexB:await count('customers_seal_index','row_id',scopeB),
    plainA:await count('customers_plain','id',scopeA),plainB:await count('customers_plain','id',scopeB),
  };
  for(const key of Object.keys(after) as (keyof typeof after)[])assert.equal(after[key],key.endsWith('B')?100000:0,`after/${key}`);
  await writeFile(`${outDir}/replace.json`,JSON.stringify({copy,rows:100000,scopeA,scopeB,before,after},null,2)+'\n');
  console.log(JSON.stringify({copy,after}));
}finally{await pool.end();}

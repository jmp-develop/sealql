/** Derive a current public-API encrypted fixture from the read-only plaintext fixture. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from 'sealql';
import {createSealed} from 'sealql/drizzle/v0.45';
import {disposablePool,schemaIdentifier} from './db.js';

const argument=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const schema=argument('--schema')??'bench_product_100k',quoted=schemaIdentifier(schema),drop=process.argv.includes('--drop');
const fields=['name','phone','address','memo','email','company'] as const;
const cipher=createSealer({key:new Uint8Array(32).fill(93)}),sealed=createSealed({sealer:cipher});
const columns:any={id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull()};
for(const field of fields)columns[field]=sealed.text(field,{search:{exact:field==='company'?{bits:2}:true,substring:true}});
const customers=pgSchema(schema).table('customers',columns),customersSeal=sealed.register(customers,{row:'id',scope:'scopeId'});
const pool=await disposablePool(4),db=drizzle(pool);let created=false,loaded=0;
try{
  assert.equal((await pool.query('select to_regnamespace($1) name',[schema])).rows[0].name,null,'Target schema already exists; refusing to overwrite it');
  const source=(await pool.query(`select id,scope_id as "scopeId",${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id`)).rows;
  assert.equal(source.length,100000,'The protected source fixture must contain 100,000 customers');
  const sourceHash=createHash('sha256').update(JSON.stringify(source)).digest('hex');
  await pool.query(`create schema ${quoted}`);created=true;
  const migration=await generateMigration(generateDrizzleJson({}),generateDrizzleJson({customers,customersSeal}));
  for(const sql of migration)await pool.query(sql);
  for(const sql of sealed.extraMigrationSql(customersSeal))await pool.query(sql);
  for(let offset=0;offset<source.length;offset+=2000){
    await Promise.all(Array.from({length:4},(_,worker)=>sealed.insert(db,customersSeal,source.slice(offset+worker*500,offset+(worker+1)*500))));
    loaded=Math.min(offset+2000,source.length);console.log(JSON.stringify({schema,loaded}));
  }
  for(const table of ['customers','customers_seal_index']){
    const count=(await pool.query(`select count(*)::int count from ${quoted}."${table}"`)).rows[0].count;
    assert.equal(count,100000);await pool.query(`analyze ${quoted}."${table}"`);
  }
  const opened=await sealed.open(await db.select().from(customers).orderBy(customers.id).limit(100));
  for(let i=0;i<opened.length;i++)for(const field of fields)assert.equal((opened[i] as any)[field],source[i][field]);
  console.log(JSON.stringify({complete:true,schema,loaded,sourceHash,roundtripFields:opened.length*fields.length,dropped:drop}));
}finally{
  if(created&&drop)await pool.query(`drop schema ${quoted} cascade`);
  await pool.end();
}

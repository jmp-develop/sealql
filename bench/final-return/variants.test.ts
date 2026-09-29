import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {and,eq,getTableColumns} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid,primaryKey,text} from 'drizzle-orm/pg-core';
import {createSealer} from '../../src/index.js';
import {createSealed} from '../../src/adapters/drizzle/v0.45/index.js';
import {assertDisposable} from '../../test/disposable.js';
import {prepareVariants,researchFallback,functionVariant,storageVariant,exactTailVariant,type Query} from './variants.js';

test('benchmark variants preserve plaintext scope, transactions, deletes and Boolean pages',async()=>{
 assert.equal(readFileSync('.local/research/measure.lock','utf8'),'r9-final-return');
 const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'}),schema=`test_final_variants_${process.pid}`;
 let created=false;
 try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const fixture=(await pool.query('select id,scope_id,memo_plain,company_plain from bench_realistic_100k.customers order by id limit 16')).rows;
  const scopes=[fixture[0].scope_id,fixture[0].id];
  assert.notEqual(scopes[0],scopes[1]);assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
  const sealer=createSealer({key:new Uint8Array(32).fill(61)}),sealed=createSealed({sealer});
  const table=pgSchema(schema).table('rows',{id:uuid('id').notNull(),scopeId:uuid('scope_id').notNull(),status:text('status').notNull(),
   body:sealed.text('body',{nullable:true,search:{substring:true}}),company:sealed.text('company',{nullable:true,search:{exact:{bits:2}}})},t=>[primaryKey({columns:[t.scopeId,t.id]})]);
  const seal=sealed.register(table,{row:'id',scope:'scopeId'});
  await pool.query(`create schema ${schema}`);created=true;
  await pool.query(`create table ${schema}.rows(id uuid not null,scope_id uuid not null,status text not null,body_ct bytea,company_ct bytea,primary key(scope_id,id))`);
  const columns=Object.values(getTableColumns(seal)).map(c=>`"${c.name}" ${c.getSQLType()}${c.notNull?' not null':''}`).join(',');
  await pool.query(`create table ${schema}.rows_seal_index(${columns},unique(scope_id,row_id),foreign key(scope_id,row_id) references ${schema}.rows(scope_id,id) on delete cascade)`);
  for(const sql of sealed.extraMigrationSql(seal))await pool.query(sql);
  for(const sql of storageVariant(seal,'EXTENDED'))await pool.query(sql);
  for(const sql of exactTailVariant(seal,false))await pool.query(sql);
  const logs:Query[]=[],db=drizzle(pool,{logger:{logQuery(text,params){logs.push({text,params});}}});
  const rows=scopes.flatMap((scopeId,si)=>fixture.map((r,i)=>({id:r.id,scopeId,status:'ready',body:si&&i%2?null:r.memo_plain,company:si&&i%2?null:r.company_plain})));
  await sealed.insert(db,seal,rows);
  const norm=(s:string)=>s.normalize('NFC').replace(/\s/g,'').toLowerCase();
  const pair=Array.from(norm(fixture[0].memo_plain)).slice(0,2).join(''),company=fixture[0].company_plain;
  const cases=[{any:[{field:'body',op:'contains',value:pair},{field:'company',op:'eq',value:company}]},
   {all:[{field:'body',op:'contains',value:pair},{any:[{field:'company',op:'eq',value:company},{field:'body',op:'like',value:`%${pair}%`}]}]}] as const;
  const match=(n:any,m:any):any=>n.all?m.and(...n.all.map((c:any)=>match(c,m))):n.any?m.or(...n.any.map((c:any)=>match(c,m))):m[n.field][n.op](n.value);
  const truth=(n:any,r:any):boolean=>n.all?n.all.every((c:any)=>truth(c,r)):n.any?n.any.some((c:any)=>truth(c,r)):r[n.field]!==null&&(n.op==='eq'?norm(r[n.field])===norm(n.value):norm(r[n.field]).includes(pair));
  const modes=[functionVariant(schema,'checks-off'),functionVariant(schema,'qualified-no-set')];
  for(const mode of modes)for(const sql of mode.statements)await pool.query(sql);
  const verify=async()=>{
   for(const scope of scopes)for(const node of cases){
    const expected=rows.filter(r=>r.scopeId===scope&&truth(node,r)).map(r=>r.id).sort();
    const prepared=await prepareVariants(seal,sealer,scope,node as any);
    assert.equal(Number((await pool.query(prepared.count.text,prepared.count.params)).rows[0].count),expected.length);
    assert.equal(await sealed.count(db,seal,{scope,match:m=>match(node,m)}),expected.length);
    for(const mode of modes){const q=mode.rewrite(prepared.count);assert.equal(Number((await pool.query(q.text,q.params)).rows[0].count),expected.length);}
    let cursor:string|undefined;const actual:string[]=[];
    do{
     const page=await sealed.findMany(db,seal,{scope,match:m=>match(node,m),columns:{id:true},limit:7,cursor});
     const q=logs.at(-1)!;
     // Force fallback with a tiny probe to exercise both Boolean roots on this small fixture.
     const tiny={text:q.text,params:[...q.params]},probe=/with sample as materialized \([\s\S]*?limit \$(\d+)/.exec(q.text);
     assert.ok(probe);tiny.params[Number(probe[1])-1]=1;
     const d=researchFallback(tiny,prepared.coarse),found=(await pool.query(d.text,d.params)).rows.map(r=>r.id);
     assert.deepEqual(found,page.items.map(r=>r.id));
     for(const mode of modes){const b=mode.rewrite(d);assert.deepEqual((await pool.query(b.text,b.params)).rows.map(r=>r.id),found);}
     actual.push(...found);cursor=page.nextCursor??undefined;
    }while(cursor);
    assert.deepEqual(actual,expected);
   }
  };
  await verify();
  const target=rows[0];
  await assert.rejects(db.transaction(async tx=>{await sealed.update(tx,seal,{id:target.id,scopeId:target.scopeId},{body:null,company:null});throw Error('rollback');}),/rollback/);
  await verify();
  await Promise.all([sealed.update(db,seal,{id:target.id,scopeId:target.scopeId},{body:null}),sealed.update(db,seal,{id:target.id,scopeId:target.scopeId},{company:null})]);
  target.body=null;target.company=null;await verify();
  await db.delete(table).where(and(eq(table.id,target.id),eq(table.scopeId,target.scopeId)));rows.splice(rows.indexOf(target),1);await verify();
  await sealed.reindex(db,seal,{batch:5});await verify();
  // Parent predicates still select rows whose searchable values are null.
  assert.equal(await sealed.count(db,seal,{scope:scopes[1],match:m=>m.sql(eq(table.status,'ready'))}),16);
  assert.equal(await sealed.count(db,seal,{scope:scopes[1],where:eq(table.status,'ready')}),16);
 }finally{if(created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}
});

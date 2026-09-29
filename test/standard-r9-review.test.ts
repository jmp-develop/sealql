import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {getTableColumns,eq} from 'drizzle-orm';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../src/index.js';
import {createSealed} from '../src/adapters/drizzle/v0.45/index.js';
import {registrationOf} from '../src/adapters/drizzle/v0.45/native.js';
import {compactText} from '../src/core/search-tokens.js';
import {assertDisposable} from './disposable.js';

test('large final-match pages, root OR fallback and keysets match plaintext; repeated near misses terminate',async()=>{
  const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=45000'});
  const schema=`test_r9_review_${process.pid}`;let created=false;
  try {
    await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
    const fixture=(await pool.query('select id,scope_id,memo_plain from bench_realistic_100k.customers order by id limit 640')).rows;
    assert.equal(fixture.length,640);assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
    const sealed=createSealed({sealer:createSealer({key:new Uint8Array(32).fill(67)})});
    const table=pgSchema(schema).table('rows',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),body:sealed.text('body',{search:{exact:{bits:2},substring:true}})});
    const seal=sealed.register(table,{row:'id',scope:'scopeId'}),reg=registrationOf(seal),scope=fixture[0].scope_id;
    await pool.query(`create schema ${schema}`);created=true;
    await pool.query(`create table ${schema}.rows(id uuid primary key,scope_id uuid not null,body_ct bytea not null)`);
    const cols=Object.values(getTableColumns(seal)).map(c=>`"${c.name}" ${c.getSQLType()}${c.notNull?' not null':''}`).join(',');
    await pool.query(`create table ${schema}.rows_seal_index(${cols},unique(scope_id,row_id),foreign key(row_id) references ${schema}.rows(id) on delete cascade)`);
    for(const sql of sealed.extraMigrationSql(seal))await pool.query(sql);
    const base=String(fixture[0].memo_plain),normalized=compactText(base,{normalizer:'legacy-text-v1'}),pair=Array.from(normalized).slice(0,2).join('');
    const rows=fixture.map((r,i)=>({id:r.id as string,scopeId:scope,body:i<400?base:base.repeat(2)})),db=drizzle(pool);
    await sealed.insert(db,seal,rows);
    for(const explicitOrder of [false,true])for(const [limit,rootOr]of [[201,false],[201,true],[100,true]] as const){
      const expected=rows.filter(r=>rootOr?r.body===base.repeat(2):compactText(r.body,{normalizer:'legacy-text-v1'}).includes(pair));
      const result:typeof rows=[];let cursor:string|undefined;
      do {
        const page=await sealed.findMany(db,seal,{scope,limit,cursor,...(explicitOrder?{orderBy:{column:table.id,direction:'asc' as const}}:{}),match:m=>rootOr?m.or(m.body.eq(base.repeat(2)),m.body.contains(base.repeat(3))):m.body.contains(pair)});
        result.push(...page.items);cursor=page.nextCursor??undefined;
      }while(cursor);
      assert.deepEqual(result,expected,`limit=${limit}, rootOr=${rootOr}, explicitOrder=${explicitOrder}`);
    }
    // Derive a near miss from two existing fixture characters; every coarse query piece exists.
    const [a,b]=[...new Set(Array.from(normalized))],needle=a+b+b+a;
    const hay=(a+b).repeat(1000)+b+b+(a+b).repeat(1000);
    assert.equal(hay.includes(needle),false);
    await sealed.update(db,seal,{id:rows[0].id,scopeId:scope},{body:hay});
    const longNeedle=(a+b).repeat(128)+needle;
    for(const term of [needle,longNeedle]){
      assert.equal(hay.includes(term),false);
      assert.equal(await sealed.count(db,seal,{scope,where:eq(table.id,rows[0].id),match:m=>m.body.contains(term)}),0);
      assert.equal(await sealed.count(db,seal,{scope,where:eq(table.id,rows[0].id),match:m=>m.body.like(`%${term}%`)}),0);
    }
    await assert.rejects(sealed.count(db,seal,{scope,where:eq(table.id,rows[0].id),match:m=>m.body.like(`%${a+b}%${b}%`)}),{code:'QUERY_TOO_BROAD'});
    assert.equal(await sealed.count(db,seal,{scope,where:eq(table.id,rows[0].id),match:m=>m.body.like(`%${a+b}%${b+b}%`)}),1);
    const proof=reg.storage.index!.profiles!['body/substring'].positions!;
    const saved=(await pool.query(`select "${proof.offsets}" offsets from ${schema}.rows_seal_index where row_id=$1`,[rows[0].id])).rows[0].offsets as number[];
    for(const bad of [null,-1,hay.length]){
      await pool.query(`update ${schema}.rows_seal_index set "${proof.offsets}"=array_fill($2::integer,array[cardinality("${proof.offsets}")]) where row_id=$1`,[rows[0].id,bad]);
      for(const mode of ['contains','like']as const)await assert.rejects(sealed.count(db,seal,{scope,where:eq(table.id,rows[0].id),match:m=>mode==='contains'?m.body.contains(a+b):m.body.like(`%${a+b}%`)}),{code:'DATABASE_ERROR'});
    }
    await pool.query(`update ${schema}.rows_seal_index set "${proof.offsets}"=$2::integer[] where row_id=$1`,[rows[0].id,saved]);
  }finally{if(created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}
});

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { createSealer } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { customers, customersSeal, probe, probeSeal, sealed, scopeId } from './schema.js';
import { fieldProfiles, recompute, tokenColumn } from './tokens.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:8,options:'-c statement_timeout=120000'});
const db=drizzle(pool),out='bench/results/2026-09-27-native-verification/v1';
async function opened(id:string){return (await sealed.open(await db.select().from(probe).where(eq(probe.id,id))))[0];}
async function searchName(value:string,scope=scopeId){return (await sealed.findMany(db,probeSeal,{scope,match:m=>m.name.eq(value)})).items;}
async function reconcile(label:string){
  const plain=await sealed.open(await db.select().from(probe));
  for(const row of plain){
    const stored=(await pool.query('select * from native_verify_main.probe_seal_index where row_id=$1 and scope_id=$2',[row.id,row.scopeId])).rows[0];
    assert(stored,`${label}/companion/${row.id}`);
    for(const f of ['name','memo'] as const){
      const expected=row[f]===null?null:await recompute('probe',f,row.scopeId,row[f]);
      if(expected===null){
        for(const profile of fieldProfiles('probe',f))
          assert.equal((stored[tokenColumn(profile.indexId)]??[]).length,0,`${label}/${row.id}/${f}/null`);
        continue;
      }
      for(const [column,tokens] of Object.entries(expected))
        assert.deepEqual(new Set((stored[column]??[]).map(String)),new Set(tokens),`${label}/${row.id}/${f}/${column}`);
    }
  }
  return plain.length;
}
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  await mkdir(out,{recursive:true});
  for(const table of ['probe','probe_seal_index'])assert.equal(Number((await pool.query(`select count(*) n from native_verify_main.${table}`)).rows[0].n),0);
  const rows=(await pool.query('select id,scope_id,name_plain,memo_plain from bench_realistic_100k.customers where scope_id=$1 order by id limit 5',[scopeId])).rows;
  assert.equal(rows.length,5);const otherScope=rows[2].id as string;
  const report:any={derivedRows:rows.map(r=>r.id),checks:[]};
  const record=(name:string,details?:unknown)=>{report.checks.push({name,verdict:'통과',details});console.log(name);};
  await sealed.insert(db,probeSeal,{id:rows[0].id,scopeId,name:rows[0].name_plain,memo:rows[0].memo_plain});
  assert.equal((await searchName(rows[0].name_plain)).length,1);record('insert and search');
  await sealed.insert(db,probeSeal,[{id:rows[1].id,scopeId,name:rows[1].name_plain,memo:rows[1].memo_plain},
    {id:rows[2].id,scopeId:otherScope,name:rows[2].name_plain,memo:rows[2].memo_plain}]);
  assert.equal((await searchName(rows[2].name_plain,otherScope)).length,1);
  assert.equal((await searchName(rows[2].name_plain,scopeId)).length,0);record('array and tenant isolation');
  const raw=await db.execute(sql`select ${probe.id} as id,${probe.scopeId} as scope_id,${probe.name} as name_ct from ${probe} where ${probe.id}=${rows[0].id}`);
  assert.equal((await sealed.openRaw(probeSeal,raw.rows as any,{columns:{id:'id',scopeId:'scope_id',name:'name_ct'},scope:scopeId}))[0].name_ct,rows[0].name_plain);
  await assert.rejects(sealed.open(await db.select({name:probe.name}).from(probe)),{code:'ROW_CONTEXT_MISSING'});
  await assert.rejects(sealed.open(await db.select({id:probe.id,name:probe.name}).from(probe)),{code:'ROW_CONTEXT_MISSING'});
  await assert.rejects(sealed.openRaw(probeSeal,raw.rows as any,{columns:{name:'name_ct'}} as any),{code:'INVALID_VALUE'});
  record('open, openRaw, missing identity and scope');
  const cipherRows=(await pool.query('select id,scope_id,name_ct from native_verify_main.probe where id=any($1)',[[rows[0].id,rows[1].id]])).rows;
  const first=cipherRows.find(r=>r.id===rows[0].id),second=cipherRows.find(r=>r.id===rows[1].id);assert(first&&second);
  await pool.query('update native_verify_main.probe set name_ct=$2 where id=$1',[rows[0].id,second.name_ct]);
  await assert.rejects(opened(rows[0].id),{code:'AUTHENTICATION_FAILED'});
  await pool.query('update native_verify_main.probe set name_ct=$2 where id=$1',[rows[0].id,first.name_ct]);record('ciphertext moved to another row rejected');
  await pool.query('update native_verify_main.probe set scope_id=$2 where id=$1',[rows[0].id,otherScope]);
  await assert.rejects(opened(rows[0].id),{code:'AUTHENTICATION_FAILED'});
  await pool.query('update native_verify_main.probe set scope_id=$2 where id=$1',[rows[0].id,scopeId]);record('ciphertext moved to another tenant rejected');
  await pool.query('update native_verify_main.probe set name_ct=set_byte(name_ct,octet_length(name_ct)-1,get_byte(name_ct,octet_length(name_ct)-1)#1) where id=$1',[rows[0].id]);
  await assert.rejects(opened(rows[0].id),{code:'AUTHENTICATION_FAILED'});
  await pool.query('update native_verify_main.probe set name_ct=$2 where id=$1',[rows[0].id,first.name_ct]);record('one-byte tamper rejected');
  const wrong=createSealer({key:new Uint8Array(32).fill(94)});
  await assert.rejects(wrong.open(first.name_ct,{modelId:'probe',fieldId:'name',keyScopeId:'global',scopeId,rowId:rows[0].id,
    spec:{type:'text',search:{exact:true,substring:{wordBoundary:true,skipGrams:true}}}},wrong.ring('probe')),{code:'AUTHENTICATION_FAILED'});
  record('wrong key rejected');
  await sealed.upsert(db,probeSeal,{id:rows[0].id,scopeId,name:rows[1].name_plain,memo:rows[0].memo_plain});
  assert.equal((await opened(rows[0].id)).name,rows[1].name_plain);record('upsert');
  await sealed.update(db,probeSeal,{id:rows[0].id,scopeId},{memo:null});
  assert.equal((await opened(rows[0].id)).memo,null);
  await sealed.update(db,probeSeal,{id:rows[0].id,scopeId},{memo:rows[1].memo_plain});
  assert.equal((await opened(rows[0].id)).memo,rows[1].memo_plain);record('update value and null');
  await assert.rejects(db.transaction(async tx=>{
    await sealed.insert(tx,probeSeal,[{id:rows[3].id,scopeId,name:rows[3].name_plain,memo:rows[3].memo_plain},
      {id:rows[4].id,scopeId,name:rows[4].name_plain,memo:rows[4].memo_plain}]);throw Error('rollback');
  }),/rollback/);
  assert.equal((await pool.query('select count(*) n from native_verify_main.probe where id=any($1)',[[rows[3].id,rows[4].id]])).rows[0].n,'0');
  assert.equal((await searchName(rows[3].name_plain)).length,0);record('transaction rollback');
  await Promise.all([sealed.update(db,probeSeal,{id:rows[0].id,scopeId},{name:rows[0].name_plain}),
    sealed.update(db,probeSeal,{id:rows[0].id,scopeId},{name:rows[1].name_plain})]);
  await reconcile('same-field concurrent update');record('same-field concurrent update');
  await Promise.all([sealed.update(db,probeSeal,{id:rows[0].id,scopeId},{name:rows[2].name_plain}),
    sealed.update(db,probeSeal,{id:rows[0].id,scopeId},{memo:rows[2].memo_plain})]);
  await reconcile('different-field concurrent update');record('different-field concurrent update');
  const raced=await Promise.allSettled([sealed.update(db,probeSeal,{id:rows[1].id,scopeId},{name:rows[2].name_plain}),
    db.delete(probe).where(eq(probe.id,rows[1].id))]);
  assert.equal((await pool.query('select count(*) n from native_verify_main.probe_seal_index where row_id=$1',[rows[1].id])).rows[0].n,'0');
  await reconcile('update-delete race');record('update-delete race',raced.map(x=>x.status));
  await Promise.all([sealed.reindex(db,probeSeal,{scope:scopeId,batch:1}),
    sealed.update(db,probeSeal,{id:rows[0].id,scopeId},{memo:rows[0].memo_plain})]);
  await reconcile('reindex-update race');record('reindex-update race');
  await writeFile(`${out}/integrity.json`,JSON.stringify(report,null,2)+'\n');
}finally{
  await pool.query('delete from native_verify_main.probe');
  await pool.end();
}

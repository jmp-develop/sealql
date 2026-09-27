/** Isolated derived-row V1 integrity and managed-write probes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createSealer } from '../../src/index.js';
import { binding, fields, guard, pool, schema, scopeId, source } from '../standard-next/common.js';
const out='bench/results/2026-09-27-core-verification/v1';
const table='core_verify_probe';
const q=(s:string)=>`"${s.replaceAll('"','""')}"`;
const full=(s:string)=>`${q(schema)}.${q(s)}`;
const cases:any[]=[];
async function reject(label:string,fn:()=>Promise<unknown>,expectedCode:string){
  try{await fn();cases.push({label,verdict:'결함',actual:'accepted'});}
  catch(e:any){assert.equal(e.code,expectedCode,label);cases.push({label,verdict:'통과',actual:e.code});}
}
try{
  await guard();await mkdir(out,{recursive:true});
  process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE=table;
  const b=binding('customers',true),repo=b.repo;
  assert.equal(b.ddl.filter(s=>/using gin\(/i.test(s.text)).length,1);
  if(!(await pool.query('select to_regclass($1) rel',[`${schema}.${table}`])).rows[0].rel)
    for(const stmt of b.ddl)await pool.query(stmt.text,stmt.values);
  const ids=(await pool.query(`select id from ${full('customers_skip_product_multi')} where scope_id=$1 order by id limit 5`,[scopeId])).rows.map(r=>r.id as string);
  assert.equal(ids.length,5);
  // Reset only our isolated derived fixture; the 100k source and product fixture remain read-only.
  await pool.query(`delete from ${full(table)} where scope_id=$1`,[scopeId]);
  const parentCols=['scope_id','id','revision',...fields.map(f=>`${f}_ct`)];
  const idxCols=['scope_id','row_id',...Object.values(b.storage.index!.profiles!).map(p=>p.tokens)];
  await pool.query(`insert into ${full(table)} (${parentCols.map(q).join(',')}) select ${parentCols.map(q).join(',')} from ${full('customers_skip_product_multi')} where scope_id=$1 and id=any($2)`,[scopeId,ids.slice(0,3)]);
  await pool.query(`insert into ${full(`${table}_seal_index`)} (${idxCols.map(q).join(',')}) select ${idxCols.map(q).join(',')} from ${full('customers_skip_product_multi_seal_index')} where scope_id=$1 and row_id=any($2)`,[scopeId,ids.slice(0,3)]);
  const sourceRows=(await pool.query(`select id,${fields.map(f=>`${f}_plain`).join(',')} from ${q(source)}.customers where scope_id=$1 and id=any($2) order by id`,[scopeId,ids])).rows;
  const first=sourceRows[0],second=sourceRows[1];
  const findName=(name:string)=>repo.findMany({match:f=>f.name.eq(name),limit:20});
  assert((await findName(first.name_plain)).items.some(x=>x.id===first.id));
  const physical=(await pool.query(`select * from ${full(table)} where scope_id=$1 and id=$2`,[scopeId,first.id])).rows[0];
  const ct=Uint8Array.from(physical.name_ct as Buffer),bad=Uint8Array.from(ct);bad[bad.length-1]^=1;
  await pool.query(`update ${full(table)} set name_ct=$3 where scope_id=$1 and id=$2`,[scopeId,first.id,Buffer.from(bad)]);
  await reject('ciphertext-byte-tamper',()=>repo.get({id:first.id}),'AUTHENTICATION_FAILED');
  await pool.query(`update ${full(table)} set name_ct=$3 where scope_id=$1 and id=$2`,[scopeId,first.id,ct]);
  await pool.query(`update ${full(table)} set name_ct=$3 where scope_id=$1 and id=$2`,[scopeId,first.id,second.name_ct??(await pool.query(`select name_ct from ${full(table)} where id=$1`,[second.id])).rows[0].name_ct]);
  await reject('ciphertext-other-row',()=>repo.get({id:first.id}),'AUTHENTICATION_FAILED');
  await pool.query(`update ${full(table)} set name_ct=$3 where scope_id=$1 and id=$2`,[scopeId,first.id,ct]);
  await pool.query(`update ${full(table)} set memo_ct=$3 where scope_id=$1 and id=$2`,[scopeId,first.id,ct]);
  await reject('ciphertext-other-field',()=>repo.get({id:first.id}),'AUTHENTICATION_FAILED');
  await pool.query(`update ${full(table)} set memo_ct=$3 where scope_id=$1 and id=$2`,[scopeId,first.id,physical.memo_ct]);
  const wrongSealer=createSealer({key:new Uint8Array(32).fill(94)});
  await reject('wrong-root-key',()=>wrongSealer.open(ct,{modelId:b.model.id,fieldId:'name',keyScopeId:'global',scopeId,rowId:first.id,spec:b.model.fields.name},wrongSealer.ring(b.model.id)),'AUTHENTICATION_FAILED');
  const modelKey=createSealer({key:new Uint8Array(32).fill(93),models:{[b.model.id]:{key:new Uint8Array(32).fill(94)}}});
  const modelRing=modelKey.ring(b.model.id);
  await reject('wrong-model-key',()=>modelKey.open(ct,{modelId:b.model.id,fieldId:'name',keyScopeId:modelRing.keyScopeId,scopeId,rowId:first.id,spec:b.model.fields.name},modelRing),'AUTHENTICATION_FAILED');
  const page=await repo.findMany({match:f=>f.any(f.name.eq(first.name_plain),f.name.eq(second.name_plain)),limit:1});
  if(page.nextCursor){
    await reject('cursor-tampered',()=>repo.findMany({match:f=>f.any(f.name.eq(first.name_plain),f.name.eq(second.name_plain)),limit:1,cursor:page.nextCursor!.slice(0,-1)+'x'}),'CURSOR_INVALID');
    await reject('cursor-other-query',()=>repo.findMany({match:f=>f.name.eq(first.name_plain),limit:1,cursor:page.nextCursor!}),'CURSOR_INVALID');
  }else cases.push({label:'cursor',verdict:'한계',actual:'no second page'});
  const tokenCol=b.storage.index!.profiles!['name/exact'].tokens;
  await pool.query(`update ${full(`${table}_seal_index`)} set ${q(tokenCol)}=null where scope_id=$1 and row_id=$2`,[scopeId,first.id]);
  const missing=!(await findName(first.name_plain)).items.some(x=>x.id===first.id);
  cases.push({label:'database-omission',verdict:missing?'한계(설계상)':'결함',actual:missing?'token removed; result silently missing':'result remained'});
  await pool.query(`update ${full(`${table}_seal_index`)} as t set ${q(tokenCol)}=s.${q(tokenCol)} from ${full('customers_skip_product_multi_seal_index')} as s where t.scope_id=s.scope_id and t.row_id=s.row_id and t.row_id=$1`,[first.id]);
  // Reuse plaintext from existing rows for all managed writes.
  const fourth=sourceRows[3],fifth=sourceRows[4];
  await repo.insert({id:fourth.id,data:Object.fromEntries(fields.map(f=>[f,fourth[`${f}_plain`]])) as any});
  assert((await findName(fourth.name_plain)).items.some(x=>x.id===fourth.id));
  cases.push({label:'managed-insert-visible',verdict:'통과'});
  const before=(await pool.query(`select * from ${full(`${table}_seal_index`)} where scope_id=$1 and row_id=$2`,[scopeId,fourth.id])).rows[0];
  await repo.update({id:fourth.id,expectedRevision:1n,patch:{memo:fifth.memo_plain}});
  const after=(await pool.query(`select * from ${full(`${table}_seal_index`)} where scope_id=$1 and row_id=$2`,[scopeId,fourth.id])).rows[0];
  assert.deepEqual(after[tokenCol],before[tokenCol]);
  assert((await repo.findMany({match:f=>f.memo.eq(fifth.memo_plain),limit:20})).items.some(x=>x.id===fourth.id));
  cases.push({label:'partial-update-preserves-other-token',verdict:'통과'});
  const concurrent=await Promise.allSettled([
    repo.update({id:fourth.id,expectedRevision:2n,patch:{memo:first.memo_plain}}),
    repo.update({id:fourth.id,expectedRevision:2n,patch:{memo:second.memo_plain}}),
  ]);
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(concurrent.filter(x=>x.status==='rejected').length,1);
  cases.push({label:'same-row-CAS-concurrency',verdict:'통과',rejection:String((concurrent.find(x=>x.status==='rejected') as PromiseRejectedResult).reason)});
  await repo.insert({id:fifth.id,data:Object.fromEntries(fields.map(f=>[f,fifth[`${f}_plain`]])) as any});
  const disjoint=await Promise.allSettled([
    repo.update({id:fourth.id,expectedRevision:3n,patch:{address:first.address_plain}}),
    repo.update({id:fifth.id,expectedRevision:1n,patch:{address:second.address_plain}}),
  ]);
  assert(disjoint.every(x=>x.status==='fulfilled'));
  cases.push({label:'different-row-concurrency',verdict:'통과'});
  const parentBefore=(await pool.query(`select revision,memo_ct from ${full(table)} where scope_id=$1 and id=$2`,[scopeId,first.id])).rows[0];
  const indexBefore=(await pool.query(`select * from ${full(`${table}_seal_index`)} where scope_id=$1 and row_id=$2`,[scopeId,first.id])).rows[0];
  await pool.query(`create or replace function ${full('core_verify_reject')}() returns trigger language plpgsql as 'begin raise exception ''probe rejection''; end'`);
  await pool.query(`create trigger core_verify_reject before update on ${full(`${table}_seal_index`)} for each row execute function ${full('core_verify_reject')}()`);
  await reject('transaction-companion-failure',()=>repo.update({id:first.id,expectedRevision:1n,patch:{memo:second.memo_plain}}),'DATABASE_ERROR');
  await pool.query(`drop trigger core_verify_reject on ${full(`${table}_seal_index`)}`);
  await pool.query(`drop function ${full('core_verify_reject')}()`);
  assert.deepEqual((await pool.query(`select revision,memo_ct from ${full(table)} where scope_id=$1 and id=$2`,[scopeId,first.id])).rows[0],parentBefore);
  assert.deepEqual((await pool.query(`select * from ${full(`${table}_seal_index`)} where scope_id=$1 and row_id=$2`,[scopeId,first.id])).rows[0],indexBefore);
  cases.push({label:'transaction-parent-companion-rollback',verdict:'통과'});
  await repo.delete({id:fourth.id,expectedRevision:4n});
  await repo.delete({id:fifth.id,expectedRevision:2n});
  assert.equal((await pool.query(`select count(*) n from ${full(`${table}_seal_index`)} where row_id=$1`,[fourth.id])).rows[0].n,'0');
  cases.push({label:'managed-delete-cascade',verdict:'통과'});
  await writeFile(`${out}/integrity-write.json`,JSON.stringify({fixture:table,cases},null,2)+'\n');
  console.log(JSON.stringify(cases.map(x=>({label:x.label,verdict:x.verdict}))));
}finally{await pool.end();}

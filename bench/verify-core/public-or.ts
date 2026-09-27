/** User-facing findMany public-column OR encrypted-predicate reproduction. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { bindSealed, definePostgresStorage, defineSealedModel, pgSql } from '../../src/adapters/postgres/sealed-index.js';
import { executor, guard, pool, schema, scopeId, sealer, source } from '../standard-next/common.js';
const out='bench/results/2026-09-27-core-verification/v1';
const name='core_verify_public_or';
const q=(s:string)=>`"${s.replaceAll('"','""')}"`;
const full=(s:string)=>`${q(schema)}.${q(s)}`;
const model=defineSealedModel({id:'core-verify-public-or',identity:{scope:'uuid',row:'uuid',revision:'bigint'},
  fields:{body:{type:'text',nullable:false,search:{exact:true,substring:true}}},
  public:{tag:{type:'text',nullable:false,maxBytes:256}}});
const mapped=definePostgresStorage(model,{schema,table:name,identity:{scope:'scope_id',row:'id',revision:'revision'},fields:{body:'body_ct'},public:{tag:'tag'}});
try{
  await guard();await mkdir(out,{recursive:true});
  if(!(await pool.query('select to_regclass($1) rel',[`${schema}.${name}`])).rows[0].rel)
    for(const stmt of mapped.ddl)await pool.query(stmt.text,stmt.values);
  const repo=bindSealed({sealer,definition:mapped.definition,storage:mapped.storage,executor:executor()}).forScope({scopeId});
  const stale=(await pool.query(`select id,revision from ${full(name)} where scope_id=$1`,[scopeId])).rows;
  for(const row of stale)await repo.delete({id:row.id,expectedRevision:BigInt(row.revision)});
  const rows=(await pool.query(`select id,memo_plain,email_plain from ${q(source)}.customers where scope_id=$1 order by id limit 2`,[scopeId])).rows;
  assert.equal(rows.length,2);assert.notEqual(rows[0].memo_plain,rows[1].memo_plain);assert.notEqual(rows[0].email_plain,rows[1].email_plain);
  for(const row of rows)await repo.insert({id:row.id,data:{body:row.memo_plain,tag:row.email_plain}});
  const encryptedOnly=(await repo.findMany({match:f=>f.body.eq(rows[0].memo_plain),limit:10})).items.map(x=>x.id);
  const publicWhere=pgSql`"tag" = ${rows[1].email_plain}`;
  const publicOnly=(await repo.findMany({where:publicWhere,limit:10})).items.map(x=>x.id);
  const combined=(await repo.findMany({match:f=>f.body.eq(rows[0].memo_plain),where:publicWhere,limit:10})).items.map(x=>x.id);
  let attemptedOr='';
  try{await repo.findMany({match:f=>f.any(f.body.eq(rows[0].memo_plain),publicWhere as any),limit:10});attemptedOr='accepted';}
  catch(e:any){attemptedOr=e.code??String(e);}
  assert.deepEqual(encryptedOnly,[rows[0].id]);assert.deepEqual(publicOnly,[rows[1].id]);assert.deepEqual(combined,[]);
  assert.equal(attemptedOr,'INVALID_VALUE');
  const expectedOr=[rows[0].id,rows[1].id];
  const report={fixture:`${schema}.${name}`,source:`${source}.customers`,publicField:'tag',encryptedField:'body',expectedOr,encryptedOnly,publicOnly,combinedAsMatchPlusWhere:combined,attemptedMatchAnyWithPublicFragment:attemptedOr,verdict:'한계(설계상)'};
  await writeFile(`${out}/public-or.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  for(const row of rows)await repo.delete({id:row.id,expectedRevision:1n});
}finally{await pool.end();}

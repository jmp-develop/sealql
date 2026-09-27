/** Derived-row nullable, long-text, and maxBytes checks on disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { definePostgresStorage, defineSealedModel, bindSealed } from '../../src/adapters/postgres/sealed-index.js';
import { normalizeText } from '../../src/core/search-tokens.js';
import { executor, guard, pool, schema, scopeId, sealer, source } from '../standard-next/common.js';

const out='bench/results/2026-09-27-core-verification/v1';
const name='core_verify_boundary';
const q=(s:string)=>`"${s.replaceAll('"','""')}"`;
const full=(s:string)=>`${q(schema)}.${q(s)}`;
const report:any={fixture:`${schema}.${name}`,source:`${source}.customers`,cases:[]};
const model=defineSealedModel({id:'core-verify-boundary',identity:{scope:'uuid',row:'uuid',revision:'bigint'},fields:{
  body:{type:'text',nullable:false,search:{exact:true,substring:true}},
  optional:{type:'text',nullable:true,search:{exact:true,substring:true}},
  bounded:{type:'text',nullable:false,maxBytes:16,search:{exact:true,substring:true}},
}});
const mapped=definePostgresStorage(model,{schema,table:name,identity:{scope:'scope_id',row:'id',revision:'revision'},
  fields:{body:'body_ct',optional:'optional_ct',bounded:'bounded_ct'}});
try{
  await guard();await mkdir(out,{recursive:true});
  if(!(await pool.query('select to_regclass($1) rel',[`${schema}.${name}`])).rows[0].rel)
    for(const stmt of mapped.ddl)await pool.query(stmt.text,stmt.values);
  const rows=(await pool.query(`select id,memo_plain,email_plain from ${q(source)}.customers where scope_id=$1 order by id limit 2`,[scopeId])).rows;
  assert.equal(rows.length,2);
  const id=rows[0].id as string;
  const repo=bindSealed({sealer,definition:mapped.definition,storage:mapped.storage,executor:executor()}).forScope({scopeId});
  const stale=(await pool.query(`select id,revision from ${full(name)} where scope_id=$1`,[scopeId])).rows;
  for(const row of stale)await repo.delete({id:row.id,expectedRevision:BigInt(row.revision)});
  const base=normalizeText(rows[0].memo_plain,'legacy-text-v1');assert(base.length>0);
  const long=Array.from(base.repeat(Math.ceil(2049/base.length))).slice(0,2048).join('');
  assert.equal(Array.from(long).length,2048);
  const term=Array.from(long).slice(1021,1027).join('');
  const bounded16=Array.from(rows[0].email_plain).slice(0,16).join('');
  const bounded17=Array.from(rows[0].email_plain).slice(0,17).join('');
  assert.equal(Buffer.byteLength(bounded16),16);assert.equal(Buffer.byteLength(bounded17),17);
  const optionalValue=rows[1].email_plain as string;
  await repo.insert({id,data:{body:long,optional:null,bounded:bounded16}});
  const inserted=await repo.get({id});assert.equal(inserted?.body,long);assert.equal(inserted?.optional,null);assert.equal(inserted?.bounded,bounded16);
  const bodyHit=await repo.findMany({match:f=>f.body.contains(term),limit:10});
  assert.deepEqual(bodyHit.items.map(x=>x.id),[id]);assert.equal(bodyHit.items[0].optional,null);
  report.cases.push({name:'2048-char-derived-insert-get-search',verdict:'통과',characters:2048,utf8Bytes:Buffer.byteLength(long),term,returned:bodyHit.items.length});
  const idx=full(mapped.storage.index!.name),tokens=mapped.storage.index!.profiles!;
  const before=(await pool.query(`select * from ${idx} where scope_id=$1 and row_id=$2`,[scopeId,id])).rows[0];
  assert.equal(before[tokens['optional/exact'].tokens],null);assert.equal(before[tokens['optional/substring'].tokens],null);
  await repo.update({id,expectedRevision:1n,patch:{optional:optionalValue}});
  assert.deepEqual((await repo.findMany({match:f=>f.optional.eq(optionalValue),limit:10})).items.map(x=>x.id),[id]);
  const valueTokens=(await pool.query(`select * from ${idx} where scope_id=$1 and row_id=$2`,[scopeId,id])).rows[0];
  assert(valueTokens[tokens['optional/exact'].tokens]?.length>0);assert(valueTokens[tokens['optional/substring'].tokens]?.length>0);
  assert.deepEqual(valueTokens[tokens['body/exact'].tokens],before[tokens['body/exact'].tokens]);
  report.cases.push({name:'nullable-null-to-value-search',verdict:'통과',revision:'1→2'});
  await repo.update({id,expectedRevision:2n,patch:{optional:null}});
  assert.equal((await repo.findMany({match:f=>f.optional.eq(optionalValue),limit:10})).items.length,0);
  const nulled=(await pool.query(`select * from ${idx} where scope_id=$1 and row_id=$2`,[scopeId,id])).rows[0];
  assert.equal(nulled[tokens['optional/exact'].tokens],null);assert.equal(nulled[tokens['optional/substring'].tokens],null);
  assert.equal((await repo.get({id}))?.optional,null);
  assert.deepEqual((await repo.findMany({match:f=>f.body.contains(term),limit:10})).items.map(x=>x.id),[id]);
  report.cases.push({name:'nullable-value-to-null-search',verdict:'통과',revision:'2→3'});
  assert.deepEqual((await repo.findMany({match:f=>f.bounded.eq(bounded16),limit:10})).items.map(x=>x.id),[id]);
  let error='';
  try{await repo.update({id,expectedRevision:3n,patch:{bounded:bounded17}});}catch(e:any){error=e.code;}
  assert.equal(error,'LIMIT_EXCEEDED');
  assert.equal((await repo.get({id}))?.revision,3n);
  assert.deepEqual((await repo.findMany({match:f=>f.bounded.eq(bounded16),limit:10})).items.map(x=>x.id),[id]);
  report.cases.push({name:'maxBytes-16-vs-17-db',verdict:'통과',maxBytes:16,error,revisionUnchanged:true});
  const tooLong=long+Array.from(base)[0];
  let longError='';
  try{await repo.update({id,expectedRevision:3n,patch:{body:tooLong}});}catch(e:any){longError=e.code;}
  assert.equal(longError,'LIMIT_EXCEEDED');
  report.cases.push({name:'2049-char-write-rejected',verdict:'통과',error:longError});
  await repo.delete({id,expectedRevision:3n});
  await writeFile(`${out}/boundary-db.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await pool.end();}

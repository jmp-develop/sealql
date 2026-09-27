/** Search-page authentication behavior when a token-selected ciphertext is modified. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { binding, fields, guard, pool, schema, scopeId, source } from '../standard-next/common.js';
const out='bench/results/2026-09-27-core-verification/v1';
const name='core_verify_candidate';
const q=(s:string)=>`"${s.replaceAll('"','""')}"`;
const full=(s:string)=>`${q(schema)}.${q(s)}`;
try{
  await guard();await mkdir(out,{recursive:true});
  process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE=name;
  const b=binding('customers',true),repo=b.repo;
  if(!(await pool.query('select to_regclass($1) rel',[`${schema}.${name}`])).rows[0].rel)
    for(const stmt of b.ddl)await pool.query(stmt.text,stmt.values);
  const ids=(await pool.query(`select id from ${q(source)}.customers where scope_id=$1 and company_norm like '%서울서비스%' order by id limit 2`,[scopeId])).rows.map(r=>r.id as string);
  assert.equal(ids.length,2);
  await pool.query(`delete from ${full(name)} where scope_id=$1`,[scopeId]);
  const parentCols=['scope_id','id','revision',...fields.map(f=>`${f}_ct`)];
  const tokenCols=['scope_id','row_id',...Object.values(b.storage.index!.profiles!).map(x=>x.tokens)];
  await pool.query(`insert into ${full(name)} (${parentCols.map(q).join(',')}) select ${parentCols.map(q).join(',')} from ${full('customers_skip_product_multi')} where scope_id=$1 and id=any($2)`,[scopeId,ids]);
  await pool.query(`insert into ${full(`${name}_seal_index`)} (${tokenCols.map(q).join(',')}) select ${tokenCols.map(q).join(',')} from ${full('customers_skip_product_multi_seal_index')} where scope_id=$1 and row_id=any($2)`,[scopeId,ids]);
  const match=(cursor?:string)=>repo.findMany({match:f=>f.company.contains('서울서비스'),select:{company:true},limit:1,cursor});
  const first=await match();assert.deepEqual(first.items.map(x=>x.id),[ids[0]]);assert(first.nextCursor);
  const second=await match(first.nextCursor);assert.deepEqual(second.items.map(x=>x.id),[ids[1]]);
  const original=(await pool.query(`select company_ct from ${full(name)} where scope_id=$1 and id=$2`,[scopeId,ids[1]])).rows[0].company_ct as Buffer;
  const bad=Buffer.from(original);bad[bad.length-1]^=1;
  let actual='';
  try{
    await pool.query(`update ${full(name)} set company_ct=$3 where scope_id=$1 and id=$2`,[scopeId,ids[1],bad]);
    try{await match(first.nextCursor);actual='accepted';}catch(e:any){actual=e.code??String(e);}
  }finally{
    await pool.query(`update ${full(name)} set company_ct=$3 where scope_id=$1 and id=$2`,[scopeId,ids[1],original]);
  }
  assert.equal(actual,'AUTHENTICATION_FAILED');
  assert.deepEqual((await match(first.nextCursor)).items.map(x=>x.id),[ids[1]]);
  const report={fixture:`${schema}.${name}`,source:`${schema}.customers_skip_product_multi`,term:'서울서비스',pageLimit:1,firstId:ids[0],tamperedNextId:ids[1],mutation:'last ciphertext byte XOR 1; companion untouched',actual,restored:true,verdict:'통과'};
  await writeFile(`${out}/candidate-tamper.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await pool.end();}

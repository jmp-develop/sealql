/** Whole-result cursor and count comparison for broad predicates on product DDL. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { binding, guard, pool, schema, scopeId, source } from '../standard-next/common.js';

const out='bench/results/2026-09-27-core-verification/v1';
const cases=[
  {name:'address-sejong',field:'address' as const,term:'세종대로'},
  {name:'company-service',field:'company' as const,term:'서울서비스'},
];
const digest=(ids:string[])=>createHash('sha256').update(ids.join('\n')).digest('hex');
const report:any={database:'127.0.0.1:56439',source:`${source}.customers`,encrypted:`${schema}.customers_skip_product_multi`,pageLimit:200,cases:[]};
try{
  await guard();await mkdir(out,{recursive:true});
  process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE='customers_skip_product_multi';
  const repo=binding('customers',true).repo;
  for(const c of cases){
    const plain=(await pool.query(`select id from "${source}".customers where scope_id=$1 and ${c.field}_norm like '%'||$2||'%' order by id`,[scopeId,c.term])).rows.map(r=>String(r.id));
    assert(plain.length>=1000,`${c.name} must be broad`);
    const ids:string[]=[];let cursor:string|undefined;let pages=0;let stopReason='';
    while(true){
      const page=await repo.findMany({match:f=>f[c.field].contains(c.term),limit:200,cursor,budgets:{maxCandidates:20000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024,resultBytes:32*1024*1024,deadlineMs:30000}});
      ids.push(...page.items.map(r=>String(r.id)));pages++;stopReason=page.stopReason;
      if(!page.nextCursor)break;
      assert.notEqual(page.nextCursor,cursor);cursor=page.nextCursor;
      assert(pages<1000,'cursor did not exhaust');
    }
    assert.equal(new Set(ids).size,ids.length,`${c.name} duplicate`);
    assert.deepEqual(ids,plain,`${c.name} full ID order`);
    const count=await repo.count({match:f=>f[c.field].contains(c.term),maxCandidates:100000,budgets:{fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024,deadlineMs:30000}});
    assert.equal(count,plain.length);
    let budgetCode='';
    try{await repo.count({match:f=>f[c.field].contains(c.term),maxCandidates:100});}
    catch(e:any){budgetCode=e.code;}
    assert.equal(budgetCode,'LIMIT_EXCEEDED');
    const item={name:c.name,field:c.field,term:c.term,plainCount:plain.length,encryptedCount:ids.length,count,pages,stopReason,plainIdSha256:digest(plain),encryptedIdSha256:digest(ids),uniqueIds:new Set(ids).size,smallBudgetCode:budgetCode,verdict:'통과'};
    report.cases.push(item);console.log(JSON.stringify(item));
    await writeFile(`${out}/wide.json`,JSON.stringify(report,null,2)+'\n');
  }
}finally{await pool.end();}

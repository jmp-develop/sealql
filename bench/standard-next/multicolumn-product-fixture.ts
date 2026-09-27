/** Copy the existing 100k skip-gram fixture into tables created by current product DDL. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { compileSearch } from '../../src/core/search-predicate.js';
import { profiles } from '../../src/core/search-tokens.js';
import { candidateStatement } from '../../src/adapters/postgres/search-sql.js';
import { binding, fields, guard, pool, schema, scopeId, sealer } from './common.js';

const name='customers_skip_product_multi';
const original='customers_skip';
const q=(s:string)=>`"${s.replaceAll('"','""')}"`;
const full=(s:string)=>`${q(schema)}.${q(s)}`;
const output='bench/results/2026-09-27-product-multicolumn-gin';
try {
  await guard();
  await mkdir(output,{recursive:true});
  // Resolve the model and mapping with the override disabled for the source and enabled for the target.
  delete process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE;
  const source=binding('customers',true);
  process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE=name;
  const target=binding('customers',true);
  const ddl=target.ddl;
  const gin=ddl.filter(s=>/using gin\(/i.test(s.text));
  assert.equal(gin.length,1);
  assert.equal((gin[0].text.match(/tokens_[a-f0-9]{16}/g)??[]).length,fields.length);
  const exists=(await pool.query('select to_regclass($1) rel',[`${schema}.${name}`])).rows[0].rel;
  if(!exists){await pool.query(ddl[0].text,ddl[0].values);await pool.query(ddl[1].text,ddl[1].values);}
  const parentCols=['scope_id','id','revision',...fields.map(f=>`${f}_ct`)];
  const tokenCols=['scope_id','row_id',...Object.values(target.storage.index!.profiles!).map(p=>p.tokens)];
  const count=async(table:string)=>Number((await pool.query(`select count(*) n from ${full(table)} where scope_id=$1`,[scopeId])).rows[0].n);
  const targetParent=await count(name);assert([0,100000].includes(targetParent));
  if(targetParent===0)await pool.query(`insert into ${full(name)} (${parentCols.map(q).join(',')}) select ${parentCols.map(q).join(',')} from ${full(original)} where scope_id=$1`,[scopeId]);
  const targetIndex=await count(`${name}_seal_index`);assert([0,100000].includes(targetIndex));
  if(targetIndex===0)await pool.query(`insert into ${full(`${name}_seal_index`)} (${tokenCols.map(q).join(',')}) select ${tokenCols.map(q).join(',')} from ${full(source.storage.index!.name)} where scope_id=$1`,[scopeId]);
  for(const stmt of ddl.slice(2)){
    if(/^create index /i.test(stmt.text)){
      const indexName=stmt.text.match(/^create index\s+"([^"]+)"/i)?.[1];assert(indexName);
      if((await pool.query('select to_regclass($1) rel',[`${schema}.${indexName}`])).rows[0].rel)continue;
    }
    await pool.query(stmt.text,stmt.values);
  }
  await pool.query(`analyze ${full(`${name}_seal_index`)}`);
  assert.equal(await count(original),100000);
  assert.equal(await count(source.storage.index!.name),100000);
  assert.equal(await count(name),100000);
  assert.equal(await count(`${name}_seal_index`),100000);
  const indexes=(await pool.query('select indexname,indexdef from pg_indexes where schemaname=$1 and tablename=$2 order by indexname',[schema,`${name}_seal_index`])).rows;
  assert.equal(indexes.filter(i=>/using gin/i.test(i.indexdef)).length,1);
  const stored=Object.entries(target.model.fields).flatMap(([field,spec])=>profiles(target.model.id,field,spec));
  const searches=[
    {name:'and4',node:{op:'all' as const,children:[{op:'eq' as const,field:'company',value:'서울서비스 담당'},{op:'contains' as const,field:'address',value:'서울'},{op:'contains' as const,field:'memo',value:'상담'},{op:'contains' as const,field:'email',value:'service'}]}},
    {name:'and6',node:{op:'all' as const,children:[{op:'contains' as const,field:'name',value:'민서'},{op:'contains' as const,field:'phone',value:'-5'},{op:'contains' as const,field:'address',value:'서울'},{op:'contains' as const,field:'memo',value:'서비스'},{op:'contains' as const,field:'email',value:'test'},{op:'eq' as const,field:'company',value:'서울서비스 담당'}]}},
  ];
  const explain=[];
  for(const item of searches){
    const compiled=await compileSearch(item.node,target.definition,stored,sealer.ring(target.model.id),scopeId);
    const statement=candidateStatement(target.definition,target.storage,scopeId,compiled);
    const sql=`select id from ${full(name)} where scope_id=$1 and ${statement.text} order by id limit 27`;
    const plan=(await pool.query(`explain (analyze,buffers,format json) ${sql}`,statement.values)).rows[0]['QUERY PLAN'][0];
    const walk=(node:any):any[]=>[node,...(node.Plans??[]).flatMap(walk)];
    const ginName=indexes.find(i=>/using gin/i.test(i.indexdef))!.indexname;
    assert(walk(plan.Plan).some(node=>node['Index Name']===ginName),`${item.name} must use product multicolumn GIN`);
    explain.push({case:item.name,statement,plan});
  }
  await writeFile(`${output}/explain.json`,JSON.stringify(explain,null,2)+'\n');
  const result={host:'127.0.0.1',port:56439,schema,name,sourceParent:original,sourceIndex:source.storage.index!.name,rows:100000,ddl:ddl.map(s=>s.text),indexes};
  await writeFile(`${output}/fixture.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({name,rows:100000,gin:indexes.filter(i=>/using gin/i.test(i.indexdef)).map(i=>i.indexname)}));
} finally { await pool.end(); }

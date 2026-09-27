/** V1 read-only 100k product-DDL search oracle. Run with node --import tsx. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { binding, fields, guard, pool, schema, scopeId, source } from '../standard-next/common.js';
import { normalizeText, normalizeWords } from '../../src/core/search-tokens.js';

const out = 'bench/results/2026-09-27-core-verification/v1';
const table = 'customers_skip_product_multi';
const fieldNames = ['name','phone','address','memo','email','company'] as const;
type Field = typeof fieldNames[number];
type Leaf = { field: Field; op: 'eq'|'contains'|'startsWith'|'endsWith'|'like'; value: string; respectWords?: boolean };
type Node = Leaf | { all: Node[] } | { any: Node[] };
type Plain = { id: string; _raw?: Record<Field,string> } & Record<Field,string>;
const norm = (s:string) => normalizeText(s,'legacy-text-v1');
const q = (s:string) => `"${s.replaceAll('"','""')}"`;
let seed=21027;
function rng(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;}
function normalizeLike(pattern:string){return norm(pattern).replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/%/g,'.*').replace(/_/g,'.');}
function matches(row:Plain,node:Node):boolean{
  if('all' in node)return node.all.every(n=>matches(row,n));
  if('any' in node)return node.any.some(n=>matches(row,n));
  const value=row[node.field], term=norm(node.value);
  if(node.op==='eq')return value===term;
  if(node.op==='startsWith')return value.startsWith(term);
  if(node.op==='endsWith')return value.endsWith(term);
  if(node.op==='like')return new RegExp(`^${normalizeLike(node.value)}$`,'u').test(value);
  if(node.respectWords)return normalizeWords(row._raw?.[node.field]??row[node.field]).includes(normalizeWords(node.value));
  return value.includes(term);
}
function compile(node:Node,f:any):any{
  if('all' in node)return f.all(...node.all.map(n=>compile(n,f)));
  if('any' in node)return f.any(...node.any.map(n=>compile(n,f)));
  return node.op==='contains'&&node.respectWords?f[node.field].contains(node.value,{respectWords:true}):f[node.field][node.op](node.value);
}
function expected(rows:Plain[],node:Node){return rows.filter(r=>matches(r,node)).map(r=>r.id);}
async function actual(repo:ReturnType<typeof binding>['repo'],node:Node){
  const ids:string[]=[];let cursor:string|undefined;
  for(let pageNo=0;pageNo<200;pageNo++){
    const page=await repo.findMany({match:f=>compile(node,f),limit:37,cursor,budgets:{maxCandidates:20000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024,resultBytes:32*1024*1024,deadlineMs:30000}});
    ids.push(...page.items.map(r=>String(r.id)));
    if(!page.nextCursor)return {ids,pages:pageNo+1,stopReason:page.stopReason};
    assert.notEqual(page.nextCursor,cursor,'cursor must advance');cursor=page.nextCursor;
  }
  throw Error('pagination exceeded 200 pages');
}
function fixedCases(rows:Plain[]):{name:string;node:Node}[]{
  const pick=(field:Field,op:Leaf['op'])=>{
    for(let i=0;i<50;i++){
      const value=rows[i][field];
      if(value.length<6)continue;
      const term=op==='endsWith'?value.slice(-20):op==='eq'?value:value.slice(0,20);
      const leaf:Leaf={field,op,value:term};
      if(expected(rows,leaf).length>0&&expected(rows,leaf).length<=100)return term;
    }
    throw Error(`no rare ${field}/${op} term`);
  };
  const memo=pick('memo','contains'),email=pick('email','endsWith'),name=pick('name','eq');
  return [
    {name:'eq',node:{field:'name',op:'eq',value:name}},
    {name:'contains',node:{field:'memo',op:'contains',value:memo}},
    {name:'startsWith',node:{field:'memo',op:'startsWith',value:memo}},
    {name:'endsWith',node:{field:'email',op:'endsWith',value:email}},
    {name:'like-prefix',node:{field:'memo',op:'like',value:`${memo}%`}},
    {name:'like-suffix',node:{field:'email',op:'like',value:`%${email}`}},
    {name:'like-infix',node:{field:'memo',op:'like',value:`%${memo}%`}},
    {name:'respectWords',node:{field:'memo',op:'contains',value:rows[0]._raw!.memo,respectWords:true}},
    {name:'nested',node:{all:[{any:[{field:'memo',op:'contains',value:memo},{field:'name',op:'eq',value:name}]},{field:'email',op:'endsWith',value:email}]}},
    {name:'mixed-exact-substring',node:{all:[{field:'name',op:'eq',value:name},{field:'memo',op:'contains',value:memo}]}},
  ];
}
const report:any={fixture:{source:`${source}.customers`,encrypted:`${schema}.${table}`,index:`${schema}.${table}_seal_index`,rows:0,gin:[]},seed:21027,fixed:[],random:{requested:1000,passed:0,failed:[],skippedBroad:0},count:[]};
try{
  await guard();await mkdir(out,{recursive:true});
  const count=(await pool.query(`select count(*) n from ${q(schema)}.${q(table)}`)).rows[0].n;
  assert.equal(Number(count),100000,'product fixture must contain 100k');
  const gin=(await pool.query('select indexname,indexdef from pg_indexes where schemaname=$1 and tablename=$2 and indexdef ilike $3',[schema,`${table}_seal_index`,'%using gin%'])).rows;
  assert.equal(gin.length,1,'product fixture must have one GIN');assert.equal((gin[0].indexdef.match(/tokens_[a-f0-9]{16}/g)??[]).length,6);
  report.fixture.rows=Number(count);report.fixture.gin=gin;
  process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE=table;
  const repo=binding('customers',true).repo;
  const rawRows=(await pool.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from ${q(source)}.customers where scope_id=$1 order by id`,[scopeId])).rows as Plain[];
  const rows=rawRows.map(raw=>({...raw,...Object.fromEntries(fields.map(f=>[f,norm(raw[f])])),_raw:raw}));
  assert.equal(rows.length,100000);
  for(const item of fixedCases(rows)){
    const e=expected(rows,item.node),a=await actual(repo,item.node);assert.deepEqual(a.ids,e,item.name);
    report.fixed.push({name:item.name,expected:e.length,actual:a.ids.length,pages:a.pages,verdict:'통과'});
    if(e.length<=1000){const n=await repo.count({match:f=>compile(item.node,f),maxCandidates:20000});assert.equal(n,e.length);report.count.push({name:item.name,expected:e.length,actual:n});}
    console.log(JSON.stringify({fixed:item.name,rows:e.length,pages:a.pages}));
    await writeFile(`${out}/search.json`,JSON.stringify(report,null,2)+'\n');
  }
  let attempts=0;
  while(report.random.passed<1000&&attempts<10000){
    attempts++;
    const leaves:Leaf[]=[];
    for(let i=0;i<(rng()<.55?1:2);i++){
      const row=rows[Math.floor(rng()*rows.length)],field=fieldNames[Math.floor(rng()*fieldNames.length)];
      const chars=Array.from(norm(row[field]));if(chars.length<2)continue;
      const width=Math.min(chars.length,2+Math.floor(rng()*5));const start=Math.floor(rng()*(chars.length-width+1));
      leaves.push({field,op:'contains',value:chars.slice(start,start+width).join('')});
    }
    if(!leaves.length)continue;
    const node:Node=leaves.length===1?leaves[0]:rng()<.5?{all:leaves}:{any:leaves};
    const e=expected(rows,node);if(e.length>150){report.random.skippedBroad++;continue;}
    try{const a=await actual(repo,node);assert.deepEqual(a.ids,e);report.random.passed++;}
    catch(error){report.random.failed.push({attempt:attempts,node,expected:e,actual:String(error)});break;}
    if(report.random.passed%50===0){console.log(JSON.stringify({random:report.random.passed,attempts}));await writeFile(`${out}/search.json`,JSON.stringify(report,null,2)+'\n');}
  }
  report.random.attempts=attempts;
  assert.equal(report.random.passed,1000,'random target');
  await assert.rejects(repo.count({match:f=>f.company.contains('서비'),maxCandidates:1}),(e:any)=>e.code==='LIMIT_EXCEEDED');
  report.count.push({name:'budget',maxCandidates:1,verdict:'LIMIT_EXCEEDED'});
  await writeFile(`${out}/search.json`,JSON.stringify(report,null,2)+'\n');
}finally{await pool.end();}
